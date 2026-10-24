/**
 * `ctx.fs` provider for remote workspaces.
 *
 * It extends the stock sandboxed local provider, so every non-anchor path keeps
 * exactly the local behaviour (realpath identity, guarded writes, chokidar
 * watching). Only paths inside a *mount anchor* 閳?a real local directory that
 * stands in for a remote directory 閳?are routed to the SSH/SFTP connection
 * described by `lib/mounts.js`.
 *
 * Target keys look like `rw://<hostRef>/<absolute remote path>`. Consumers treat
 * them as opaque; this module is the only place that parses them.
 *
 * @module dsh-remote-workstation
 */

import { constants as bufferConstants } from 'node:buffer'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import {
  decodeTargetKey,
  encodeTargetKey,
  expandHome,
  hostContains,
  isRemoteAbsolute,
  joinRemote,
  normalizeRemote,
  remoteContains,
} from './paths.js'
import { RemoteWorkspaceExplorer } from './explorer.js'
import { getSharedState, releaseSharedState } from './state.js'
import * as sftp from './ssh/sftp.js'

/** Bytes sampled for the NUL-byte binary sniff, matching the local backend's spirit. */
const BINARY_SAMPLE_BYTES = 64 * 1024

/** Minimum interval between mount-store refreshes (milliseconds). */
const STORE_REFRESH_MS = 1000

/**
 * Opaque freshness token derived from SFTP attributes.
 * @param {any} attrs
 * @returns {FsVersion}
 */
function versionOf(attrs) {
  const mtimeMs = Math.round(Number(attrs?.mtime ?? 0) * 1000)
  const ctimeMs = Math.round(Number(attrs?.ctime ?? attrs?.mtime ?? 0) * 1000)
  const size = Number(attrs?.size ?? 0)
  return FsVersion(`${Number(attrs?.dev ?? 0)}:${Number(attrs?.ino ?? 0)}:${size}:${mtimeMs}:${ctimeMs}`)
}

/**
 * @param {any} attrs
 * @returns {{ size?: number }}
 */
function sizeOf(attrs) {
  return attrs && attrs.size !== undefined ? { size: Number(attrs.size) } : {}
}

/**
 * Decode UTF-8 strictly.
 * @param {Uint8Array} raw
 * @param {string} displayPath
 * @returns {string}
 */
function decodeUtf8(raw, displayPath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new FsError(`cannot read "${displayPath}": not valid UTF-8`, 'FS_NOT_TEXT')
  }
}

/**
 * @param {Uint8Array} sample
 * @param {string} displayPath
 */
function rejectBinary(sample, displayPath) {
  if (sample.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
}

/**
 * Collapse CRLF to LF (the diff and edit view uses LF internally).
 * @param {string} text
 * @returns {string}
 */
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Apply one literal string replacement with the local backend's error surface.
 * @param {string} content
 * @param {string} oldString
 * @param {string} newString
 * @param {boolean} replaceAll
 * @param {string} displayPath
 * @returns {string}
 */
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString must not be empty`, 'FS_EDIT_NOT_FOUND')
  }
  if (oldString === newString) {
    throw new FsError(`cannot edit "${displayPath}": oldString and newString are identical`, 'FS_AMBIGUOUS_EDIT')
  }
  let occurrences = 0
  let index = content.indexOf(oldString)
  while (index !== -1) {
    occurrences += 1
    index = content.indexOf(oldString, index + oldString.length)
  }
  if (occurrences === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString was not found`, 'FS_EDIT_NOT_FOUND')
  }
  if (occurrences > 1 && !replaceAll) {
    throw new FsError(`cannot edit "${displayPath}": oldString occurs ${occurrences} times (pass replaceAll to change all of them)`, 'FS_AMBIGUOUS_EDIT')
  }
  return replaceAll ? content.split(oldString).join(newString) : content.slice(0, content.indexOf(oldString)) + newString + content.slice(content.indexOf(oldString) + oldString.length)
}

/**
 * Host-path containment check (case-insensitive on Windows).
 * @param {string} candidate
 * @param {string} root
 * @returns {boolean}
 */
function isUnder(candidate, root) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value))
  const target = normalize(candidate)
  const base = normalize(root)
  if (target === base) return true
  const relative = path.relative(base, target)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export class RemoteWorkspaceFileSystem extends SandboxedFileSystem {
  static Config = z.object({
    /** Base directory for relative paths (unchanged local behaviour). */
    cwd: z.string().default(process.cwd()),
    /** Exclusive diff-basis cap inherited from the local backend. */
    diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
    /** Runtime mount/host store managed by the Remote Explorer panel. */
    storePath: z.string().default('~/.dsh/remote-workspaces.json'),
    /** This plugin's own SSH host store (holds credentials, written mode 0600). */
    hostsPath: z.string().default(''),
    /** Optional read-only import of the dsh-ssh plugin's host list. */
    sshHostsPath: z.string().default(''),
    /** Directory that holds anchor directories; defaults to `~/.dsh/remote-workspaces`. */
    anchorRoot: z.string().default(''),
    /** Static mounts, merged over the runtime store. */
    mounts: z.array(z.object({
      host: z.string(),
      remote: z.string(),
      anchor: z.string().default(''),
    })).default([]),
    /** SSH connection timeout in milliseconds. */
    connectTimeoutMs: z.number().default(15000),
    /** Phase gate: force remote targets read-only regardless of other settings. */
    remoteReadOnly: z.boolean().default(false),
    /** Cap on a whole-file `readText` over SFTP. */
    maxReadTextBytes: z.number().default(32 * 1024 * 1024),
  })

  /** @type {any} */
  settings
  /** @type {{ key: string, pool: any, table: any, users: number }} */
  remoteState
  /** Per-target mutation locks (FIFO), mirroring the local backend. */
  remoteLocks = new Map()
  _lastRefresh = 0

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {any} config
   */
  constructor(ctx, config) {
    super(ctx, config)
    const home = os.homedir()
    const storePath = path.resolve(expandHome(config.storePath || '~/.dsh/remote-workspaces.json', home))
    const hostsPath = config.hostsPath
      ? path.resolve(expandHome(config.hostsPath, home))
      : path.join(home, '.dsh', 'remote-workspaces-hosts.json')
    const sshHostsPath = config.sshHostsPath ? path.resolve(expandHome(config.sshHostsPath, home)) : undefined
    const anchorRoot = config.anchorRoot
      ? path.resolve(expandHome(config.anchorRoot, home))
      : path.join(home, '.dsh', 'remote-workspaces')
    const maxReadTextBytes = config.maxReadTextBytes
    if (!Number.isSafeInteger(maxReadTextBytes) || maxReadTextBytes <= 0 || maxReadTextBytes > bufferConstants.MAX_LENGTH) {
      throw new Error('dsh-remote-workstation: maxReadTextBytes must be a positive safe integer within the Buffer limit')
    }
    this.settings = { storePath, hostsPath, sshHostsPath, anchorRoot, maxReadTextBytes, remoteReadOnly: config.remoteReadOnly }
    this.remoteState = getSharedState({
      storePath,
      hostsPath,
      sshHostsPath,
      anchorRoot,
      mounts: config.mounts,
      connectTimeoutMs: config.connectTimeoutMs,
    })
    this.remoteState.users += 1
    ctx.on('dispose', () => {
      releaseSharedState(this.remoteState)
    })
  }

  /** @returns {any} the shared mount table */
  get mounts() {
    return this.remoteState.table
  }

  //
  // Mount management 閳?the Remote Explorer panel drives these; they are also
  // the smallest API a script or test needs to set a mount up.
  //

  /** @returns {Promise<Array<{ id: string, host: string, remote: string, anchor: string, createdAt: number }>>} */
  async listMounts() {
    await this._ready()
    return this.remoteState.table.mounts()
  }

  /** @returns {Promise<Array<import('./ssh/pool.js').HostRecord>>} */
  async listHosts() {
    await this._ready()
    return this.remoteState.table.hosts()
  }

  /**
   * Bind a remote directory to a fresh local anchor directory.
   * @param {string} host
   * @param {string} remote
   * @returns {Promise<{ id: string, host: string, remote: string, anchor: string, createdAt: number }>}
   */
  async addMount(host, remote) {
    const mount = await this.remoteState.table.addMount({ host, remote })
    this._lastRefresh = Date.now()
    return mount
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async removeMount(id) {
    const removed = await this.remoteState.table.removeMount(id)
    this._lastRefresh = Date.now()
    return removed
  }

  /**
   * Refresh the mount store at most once per {@link STORE_REFRESH_MS}.
   * @returns {Promise<void>}
   */
  async _ready() {
    const table = this.remoteState.table
    await table.ready()
    const now = Date.now()
    if (now - this._lastRefresh < STORE_REFRESH_MS) return
    this._lastRefresh = now
    await table.refresh()
  }

  /**
   * Run an SFTP operation, mapping transport failures onto `FsError`.
   * @template T
   * @param {{ hostRef: string, remotePath: string }} remote
   * @param {(session: any) => Promise<T>} operation
   * @param {string} verb
   * @param {string} displayPath
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<T>}
   */
  async _call(remote, operation, verb, displayPath, signal) {
    try {
      return await this.remoteState.pool.withSftp(remote.hostRef, operation)
    } catch (error) {
      if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED', { cause: error })
      if (error instanceof FsError) throw error
      throw sftp.mapSftpError(error, verb, displayPath, signal)
    }
  }

  /**
   * Resolve the remote coordinates of a host path, if it sits under a mount.
   * @param {string} hostPath
   * @returns {{ hostRef: string, remotePath: string } | undefined}
   */
  _remoteOfHostPath(hostPath) {
    const mapped = this.remoteState.table.toRemote(hostPath)
    if (!mapped) return undefined
    return { hostRef: mapped.mount.host, remotePath: mapped.remotePath }
  }

  /**
   * Resolve a remote-namespace path (`/x/y`) against the mounted hosts.
   * @param {string} remotePath
   * @param {string} [hostRef]
   * @returns {{ hostRef: string, remotePath: string } | undefined}
   */
  _remoteOfRemotePath(remotePath, hostRef) {
    const normalized = normalizeRemote(remotePath)
    const mount = this.remoteState.table.matchRemote(normalized, hostRef)
    if (mount) return { hostRef: mount.host, remotePath: normalized }
    return undefined
  }

  /** @returns {string | undefined} a host to use for unmounted remote-namespace probes */
  _defaultHostRef() {
    const hosts = this.remoteState.table.hosts()
    return hosts.length > 0 ? hosts[0].alias : undefined
  }

  /**
   * @param {string} input
   * @param {{ cwd?: string } | undefined} opts
   * @returns {string} absolute host path
   */
  _hostPath(input, opts) {
    return path.isAbsolute(input) ? path.resolve(input) : path.resolve(opts?.cwd ?? this.config.cwd, input)
  }

  //
  // FileSystem contract
  //

  async resolve(path, opts) {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    await this._ready()
    if (isRemoteAbsolute(path)) {
      const remote = this._remoteOfRemotePath(path)
      const hostRef = remote?.hostRef ?? this._defaultHostRef()
      if (!hostRef) {
        throw new FsError(`cannot resolve "${path}": no remote host is configured`, 'FS_NOT_FOUND')
      }
      const remotePath = remote?.remotePath ?? normalizeRemote(path)
      return { targetKey: encodeTargetKey(hostRef, remotePath), displayPath: remotePath }
    }
    const remote = this._remoteOfHostPath(this._hostPath(path, opts))
    if (remote) {
      return { targetKey: encodeTargetKey(remote.hostRef, remote.remotePath), displayPath: remote.remotePath }
    }
    return super.resolve(path, opts)
  }

  processPath(target) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.processPath(target)
    const mapped = this.remoteState.table.toHost(decoded.hostRef, decoded.remotePath)
    return mapped ? mapped.hostPath : decoded.remotePath
  }

  processPathFromHostPath(hostPath) {
    if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) return undefined
    const remote = this._remoteOfHostPath(path.resolve(hostPath))
    return remote ? remote.remotePath : super.processPathFromHostPath(hostPath)
  }

  fileUrl(target) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.fileUrl(target)
    return `file://${decoded.hostRef}${decoded.remotePath}`
  }

  contains(parent, child) {
    const a = decodeTargetKey(parent.targetKey)
    const b = decodeTargetKey(child.targetKey)
    if (a && b) return a.hostRef === b.hostRef && remoteContains(a.remotePath, b.remotePath)
    if (a || b) return hostContains(this.processPath(parent), this.processPath(child))
    return super.contains(parent, child)
  }

  async stat(target, signal) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.stat(target, signal)
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    await this._ready()
    const attrs = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'stat', target.displayPath, signal)
    if (!attrs) return undefined
    return { version: versionOf(attrs), type: sftp.entryType(attrs), ...sizeOf(attrs) }
  }

  async lstat(path, opts, signal) {
    await this._ready()
    const remote = isRemoteAbsolute(path)
      ? this._remoteOfRemotePath(path) ?? (() => {
        const hostRef = this._defaultHostRef()
        return hostRef ? { hostRef, remotePath: normalizeRemote(path) } : undefined
      })()
      : this._remoteOfHostPath(this._hostPath(path, opts))
    if (!remote) return super.lstat(path, opts, signal)
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    const attrs = await this._call(remote, (session) => sftp.stat(session, remote.remotePath), 'lstat', path, signal)
    if (!attrs) return undefined
    const type = sftp.isSymlink(attrs) ? 'symlink' : sftp.entryType(attrs)
    return { version: versionOf(attrs), type, ...sizeOf(attrs) }
  }

  async listDir(target, signal) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.listDir(target, signal)
    if (signal?.aborted) throw new FsError('listDir aborted', 'FS_ABORTED')
    await this._ready()
    const attrs = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'list', target.displayPath, signal)
    if (!attrs) {
      throw new FsError(`cannot list "${target.displayPath}": no such file or directory`, 'FS_NOT_FOUND')
    }
    if (!sftp.isDirectory(attrs)) {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    }
    const entries = await this._call(decoded, (session) => sftp.readdir(session, decoded.remotePath), 'list', target.displayPath, signal)
    return entries.map((entry) => {
      const childPath = joinRemote(decoded.remotePath, entry.name)
      return {
        name: entry.name,
        type: sftp.entryType(entry.attrs),
        target: { targetKey: encodeTargetKey(decoded.hostRef, childPath), displayPath: childPath },
        version: versionOf(entry.attrs),
        ...sizeOf(entry.attrs),
      }
    })
  }

  async readText(target, signal) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.readText(target, signal)
    await this._ready()
    const attrs = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'read', target.displayPath, signal)
    if (!attrs) throw new FsError(`cannot read "${target.displayPath}": no such file or directory`, 'FS_NOT_FOUND')
    if (!sftp.isFile(attrs)) {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const size = Number(attrs.size ?? 0)
    if (size > this.settings.maxReadTextBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${size} bytes exceeds the ${this.settings.maxReadTextBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const raw = await this._call(decoded, (session) => sftp.readFile(session, decoded.remotePath), 'read', target.displayPath, signal)
    rejectBinary(raw, target.displayPath)
    return decodeUtf8(raw, target.displayPath)
  }

  async *streamText(target, signal) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) {
      yield* super.streamText(target, signal)
      return
    }
    await this._ready()
    const attrs = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'read', target.displayPath, signal)
    if (!attrs) throw new FsError(`cannot read "${target.displayPath}": no such file or directory`, 'FS_NOT_FOUND')
    if (!sftp.isFile(attrs)) {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const stream = await this._call(decoded, async (session) => sftp.createReadStream(session, decoded.remotePath), 'read', target.displayPath, signal)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let sniffed = 0
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
        if (sniffed < BINARY_SAMPLE_BYTES) {
          rejectBinary(chunk, target.displayPath)
          sniffed += Math.min(chunk.length, BINARY_SAMPLE_BYTES)
        }
        let text
        try {
          text = decoder.decode(chunk, { stream: true })
        } catch {
          throw new FsError(`cannot read "${target.displayPath}": not valid UTF-8`, 'FS_NOT_TEXT')
        }
        if (text.length > 0) yield text
      }
      const tail = decoder.decode()
      if (tail.length > 0) yield tail
    } finally {
      stream.destroy?.()
    }
  }

  async readBytes(target, signal, maxBytes) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.readBytes(target, signal, maxBytes)
    await this._ready()
    const attrs = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'read', target.displayPath, signal)
    if (!attrs) throw new FsError(`cannot read "${target.displayPath}": no such file or directory`, 'FS_NOT_FOUND')
    if (!sftp.isFile(attrs)) {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const size = Number(attrs.size ?? 0)
    if (size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const stream = await this._call(decoded, async (session) => sftp.createReadStream(session, decoded.remotePath, { end: maxBytes }), 'read', target.displayPath, signal)
    const chunks = []
    let bytes = 0
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
        bytes += chunk.length
        if (bytes > maxBytes) {
          throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
        }
        chunks.push(Buffer.from(chunk))
      }
    } finally {
      stream.destroy?.()
    }
    return new Uint8Array(Buffer.concat(chunks, bytes))
  }

  async readByteRange(target, range, signal) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.readByteRange(target, range, signal)
    await this._ready()
    const attrs = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'read', target.displayPath, signal)
    if (!attrs) throw new FsError(`cannot read "${target.displayPath}": no such file or directory`, 'FS_NOT_FOUND')
    if (!sftp.isFile(attrs)) {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (range.length === 0) return new Uint8Array(0)
    const stream = await this._call(
      decoded,
      async (session) => sftp.createReadStream(session, decoded.remotePath, { start: range.offset, end: range.offset + range.length - 1 }),
      'read',
      target.displayPath,
      signal,
    )
    const chunks = []
    let bytes = 0
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
        chunks.push(Buffer.from(chunk))
        bytes += chunk.length
      }
    } finally {
      stream.destroy?.()
    }
    return new Uint8Array(Buffer.concat(chunks, bytes))
  }

  async watch(target, changed, signal) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.watch(target, changed, signal)
    void changed
    signal?.throwIfAborted?.()
    throw new FsError('Remote directories cannot be watched yet (scheduled for phase 3).', 'FS_IO_ERROR')
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.writeText(target, content, expected, signal, sandboxPolicy)
    return this._writeRemote(target, decoded, String(content), expected, signal, sandboxPolicy)
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    const decoded = decodeTargetKey(target.targetKey)
    if (!decoded) return super.editText(target, edit, expected, signal, sandboxPolicy)
    return this._editRemote(target, decoded, edit, expected, signal, sandboxPolicy)
  }

  /**
   * Full-content write over SFTP, mirroring the local backend's semantics:
   * a per-target lock, the same write-intent kinds, the same fresh-version
   * guard, and a diff basis when the previous content is small enough.
   *
   * @param {any} target
   * @param {{ hostRef: string, remotePath: string }} decoded
   * @param {string} content
   * @param {any} expected
   * @param {AbortSignal | undefined} signal
   * @param {any} sandboxPolicy
   * @returns {Promise<any>}
   */
  async _writeRemote(target, decoded, content, expected, signal, sandboxPolicy) {
    await this._ready()
    this._fenceRemoteWrite(target, sandboxPolicy, 'write')
    return this._withRemoteLock(target.targetKey, async () => {
      const before = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'write', target.displayPath, signal)
      if (before && !sftp.isFile(before)) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!before) {
          throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        }
        if (String(expected.version) !== String(versionOf(before))) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && before) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      let diffBefore = null
      if (before && Number(before.size ?? 0) < this.config.diffBasisMaxBytes) {
        try {
          const raw = await this._call(decoded, (session) => sftp.readFile(session, decoded.remotePath), 'write', target.displayPath, signal)
          diffBefore = normalizeLineEndings(decodeUtf8(raw, target.displayPath))
        } catch {
          diffBefore = null
        }
      }
      const buffer = Buffer.from(content, 'utf8')
      await this._call(decoded, (session) => sftp.writeFile(session, decoded.remotePath, buffer), 'write', target.displayPath, signal)
      const after = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'write', target.displayPath, signal)
      return {
        operation: before ? 'update' : 'create',
        version: versionOf(after ?? before ?? {}),
        before: diffBefore,
        after: normalizeLineEndings(content),
      }
    })
  }

  /**
   * Literal read-match-write edit over SFTP with the local backend's error
   * surface (`FS_NOT_TEXT`, `FS_EDIT_NOT_FOUND`, `FS_AMBIGUOUS_EDIT`,
   * `FS_STALE_VERSION`) and its line-ending preservation.
   *
   * @param {any} target
   * @param {{ hostRef: string, remotePath: string }} decoded
   * @param {{ oldString: string, newString: string, replaceAll?: boolean }} edit
   * @param {any} expected
   * @param {AbortSignal | undefined} signal
   * @param {any} sandboxPolicy
   * @returns {Promise<any>}
   */
  async _editRemote(target, decoded, edit, expected, signal, sandboxPolicy) {
    await this._ready()
    this._fenceRemoteWrite(target, sandboxPolicy, 'edit')
    const targetKey = target.targetKey
    return this._withRemoteLock(targetKey, async () => {
      const info = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'edit', target.displayPath, signal)
      if (!info) {
        throw new FsError(`cannot edit "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      }
      if (!sftp.isFile(info)) {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.version !== undefined && String(expected.version) !== String(versionOf(info))) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const size = Number(info.size ?? 0)
      if (size > this.settings.maxReadTextBytes) {
        throw new FsError(`cannot edit "${target.displayPath}": ${size} bytes exceeds the ${this.settings.maxReadTextBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      const raw = await this._call(decoded, (session) => sftp.readFile(session, decoded.remotePath), 'edit', target.displayPath, signal)
      rejectBinary(raw, target.displayPath)
      const original = decodeUtf8(raw, target.displayPath)
      const lineEndings = original.includes('\r\n') ? '\r\n' : '\n'
      const content = normalizeLineEndings(original)
      const edited = applyLiteralEdit(content, edit.oldString, edit.newString, Boolean(edit.replaceAll), target.displayPath)
      const out = lineEndings === '\r\n' ? edited.replace(/\n/g, '\r\n') : edited
      const buffer = Buffer.from(out, 'utf8')
      await this._call(decoded, (session) => sftp.writeFile(session, decoded.remotePath, buffer), 'edit', target.displayPath, signal)
      const after = await this._call(decoded, (session) => sftp.statFollow(session, decoded.remotePath), 'edit', target.displayPath, signal)
      return {
        version: versionOf(after ?? info),
        before: original,
        after: out,
      }
    })
  }

  /**
   * Apply the sandbox fence to a remote mutation.
   *
   * Remote writes are allowed by the same three modes the local backend
   * enforces; because a remote target's canonical identity lives on another
   * machine, containment is checked against the target's *anchor* host path.
   *
   * @param {{ displayPath: string, targetKey: string }} target
   * @param {any} sandboxPolicy
   * @param {string} verb
   * @returns {void}
   */
  _fenceRemoteWrite(target, sandboxPolicy, verb) {
    if (this.settings.remoteReadOnly) {
      throw new FsError(`cannot ${verb} "${target.displayPath}": remote workspaces are read-only in this build`, 'FS_SANDBOX_DENIED')
    }
    let policy
    try {
      policy = sandboxPolicy ?? this.ctx.sandboxPolicy?.resolve?.()
    } catch {
      policy = undefined
    }
    const mode = policy?.mode ?? this.sandboxMode ?? 'danger-full-access'
    if (mode === 'danger-full-access') return
    const denied = () => new FsError(`cannot ${verb} "${target.displayPath}": file access denied under ${mode} mode`, 'FS_SANDBOX_DENIED')
    if (mode === 'read-only') throw denied()
    const anchor = this.processPath(target)
    const roots = [policy?.workspaceRoot, '/tmp', os.tmpdir()].filter((root) => typeof root === 'string' && root.length > 0)
    if (roots.some((root) => isUnder(anchor, root))) return
    throw denied()
  }

  /**
   * Serialize mutations per target, like the local backend's FIFO lock.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  _withRemoteLock(key, operation) {
    const previous = this.remoteLocks.get(key) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    this.remoteLocks.set(key, run.then(() => {}, () => {}))
    return run
  }
}

/**
 * Plugin entry: one loader row mounts both halves.
 *
 * `RemoteWorkspaceFileSystem` replaces the stock sandboxed provider (the bundle
 * patch disables `fs-sandbox`), and `RemoteWorkspaceExplorer` serves the
 * Remote Explorer panel's JSON API. Both share one SSH pool and mount store.
 *
 * @module dsh-remote-workstation
 */

export const name = 'remote-workspace'

export const inject = []

/** Loader row configuration; see {@link RemoteWorkspaceFileSystem.Config}. */
export const Config = RemoteWorkspaceFileSystem.Config

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  ctx.plugin(RemoteWorkspaceFileSystem, config)
  ctx.plugin(RemoteWorkspaceExplorer, config)
}
