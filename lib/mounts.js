/**
 * Mount table + JSON store.
 *
 * A *mount* binds a real local directory (the "anchor") to a remote directory:
 *   anchor  C:\Users\me\.dsh\remote-workspaces\box\srv\app   (exists locally, empty on purpose)
 *   remote  /srv/app                                         (the real files, over SFTP)
 *
 * The anchor is what the workspace registry and session cwd point at, because
 * `next/workspace` insists on a real host directory. The provider
 * (`lib/index.js`) routes every path under an anchor to the remote host instead
 * of the local disk, so listing/reading the anchor shows the remote tree.
 *
 * The store is the source of truth at runtime; the panel writes to it and the
 * provider re-reads it when its mtime changes.
 *
 * @module dsh-remote-workstation/mounts
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expandHome, hostContains, hostRelative, joinRemote, normalizeRemote, remoteContains } from './paths.js'

/**
 * @typedef {{ id: string, host: string, remote: string, anchor: string, createdAt: number }} Mount
 * @typedef {{ version: 1, hosts: import('./ssh/pool.js').HostRecord[], mounts: Mount[] }} Store
 */

const DEFAULT_ANCHOR_DIR_NAME = 'remote-workspaces'
const DEFAULT_HOSTS_FILE_NAME = 'remote-workspaces-hosts.json'

/**
 * @param {string} value
 * @returns {string} a filesystem-safe single path segment
 */
function safeSegment(value) {
  const cleaned = String(value).replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[\\/]+/g, '_').replace(/^\.+$/, '_')
  return cleaned.length === 0 ? '_' : cleaned.slice(0, 80)
}

/**
 * Read a JSON file, returning `undefined` when it does not exist.
 * @param {string} filePath
 * @returns {Promise<any | undefined>}
 */
async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Write JSON atomically (unique temp file + rename).
 * @param {string} filePath
 * @param {unknown} value
 */
async function writeJsonAtomic(filePath, value, options = {}) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const mode = options.mode
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', ...(mode ? { mode } : {}) })
  if (mode) {
    try {
      await chmod(temp, mode)
    } catch {
      // best effort: chmod is a no-op on Windows
    }
  }
  await rename(temp, filePath)
}

/**
 * Normalize a host record coming from either store file.
 * @param {any} raw
 * @returns {import('./ssh/pool.js').HostRecord | undefined}
 */
function normalizeHost(raw) {
  if (!raw || typeof raw.alias !== 'string' || typeof raw.host !== 'string') return undefined
  const auth = raw.auth && typeof raw.auth === 'object'
    ? raw.auth.kind === 'key'
      ? { kind: 'key', keyPath: raw.auth.keyPath, ...(raw.auth.passphrase ? { passphrase: raw.auth.passphrase } : {}) }
      : { kind: 'password', ...(raw.auth.password ? { password: raw.auth.password } : {}) }
    : undefined
  return {
    alias: raw.alias,
    host: raw.host,
    port: typeof raw.port === 'number' ? raw.port : 22,
    user: typeof raw.user === 'string' ? raw.user : 'root',
    ...(auth ? { auth } : {}),
  }
}

/**
 * Keep only the host identity: credentials belong to the dsh-ssh store.
 * @param {import('./ssh/pool.js').HostRecord | undefined} host
 * @returns {import('./ssh/pool.js').HostRecord | undefined}
 */
function stripSecrets(host) {
  if (!host) return undefined
  const { auth: _auth, ...identity } = host
  return identity
}

export class MountTable {
  #storePath
  #hostsPath
  #sshHostsPath
  #anchorRoot
  #staticMounts
  #pool
  /** @type {Store} */
  #store = { version: 1, hosts: [], mounts: [] }
  /** @type {Set<string>} aliases defined in this plugin's own host store */
  #ownAliases = new Set()
  #loaded = false
  #loadPromise = undefined
  #stamp = ''
  #sshStamp = ''
  #hostsStamp = ''
  #writeChain = Promise.resolve()

  /**
   * @param {{
   *   storePath: string,
   *   hostsPath?: string,
   *   sshHostsPath?: string,
   *   staticMounts?: Array<{ host: string, remote: string, anchor?: string }>,
   *   anchorRoot?: string,
   *   pool: import('./ssh/pool.js').SshPool,
   * }} options
   */
  constructor(options) {
    const home = os.homedir()
    this.#storePath = path.resolve(expandHome(options.storePath, home))
    this.#hostsPath = path.resolve(
      expandHome(options.hostsPath ?? path.join(home, '.dsh', DEFAULT_HOSTS_FILE_NAME), home),
    )
    this.#sshHostsPath = options.sshHostsPath ? path.resolve(expandHome(options.sshHostsPath, home)) : undefined
    this.#staticMounts = Array.isArray(options.staticMounts) ? options.staticMounts : []
    this.#anchorRoot = path.resolve(expandHome(options.anchorRoot ?? path.join(home, '.dsh', DEFAULT_ANCHOR_DIR_NAME), home))
    this.#pool = options.pool
  }

  /** @returns {string} absolute path of the JSON store */
  get storePath() {
    return this.#storePath
  }

  /** @returns {string} absolute path of this plugin's own host store (holds credentials) */
  get hostsPath() {
    return this.#hostsPath
  }

  /** @returns {string} absolute anchor root */
  get anchorRoot() {
    return this.#anchorRoot
  }

  /** Load the store once (creates it when missing). */
  async ready() {
    if (this.#loaded) return
    if (!this.#loadPromise) {
      this.#loadPromise = this.#load().finally(() => {
        this.#loadPromise = undefined
      })
    }
    await this.#loadPromise
  }

  /**
   * Re-read the store when the file changed since the last load.
   * Cheap enough to call at the start of every filesystem operation.
   */
  async refresh() {
    await this.ready()
    let info
    try {
      info = await stat(this.#storePath)
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return
      throw error
    }
    const stamp = `${info.mtimeMs}:${info.size}`
    const sshStamp = await this.#sshFileStamp()
    const hostsStamp = await this.#hostsFileStamp()
    if (stamp === this.#stamp && sshStamp === this.#sshStamp && hostsStamp === this.#hostsStamp) return
    await this.#load()
  }

  /**
   * Look up a host's live credentials. This plugin's own host store wins, then
   * the optional dsh-ssh import. Never cached: the files are re-read per call.
   * @param {string} alias
   * @returns {Promise<import('./ssh/pool.js').HostRecord | undefined>}
   */
  async liveHost(alias) {
    for (const host of await this.#readOwnHosts()) {
      if (host.alias === String(alias)) return host
    }
    if (!this.#sshHostsPath) return undefined
    const ssh = await readJson(this.#sshHostsPath)
    if (!ssh || !Array.isArray(ssh.hosts)) return undefined
    for (const raw of ssh.hosts) {
      const host = normalizeHost(raw)
      if (host && host.alias === String(alias)) return host
    }
    return undefined
  }

  /** @returns {Promise<import('./ssh/pool.js').HostRecord[]>} hosts from the plugin's own store */
  async #readOwnHosts() {
    const raw = await readJson(this.#hostsPath)
    if (!raw || !Array.isArray(raw.hosts)) return []
    return raw.hosts.map(normalizeHost).filter(Boolean)
  }

  /** @returns {Promise<string>} change stamp of this plugin's host store */
  async #hostsFileStamp() {
    try {
      const info = await stat(this.#hostsPath)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return ''
    }
  }

  /** @returns {Promise<string>} change stamp of the dsh-ssh store */
  async #sshFileStamp() {
    if (!this.#sshHostsPath) return ''
    try {
      const info = await stat(this.#sshHostsPath)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return ''
    }
  }

  /** @returns {Mount[]} a copy of the mount list */
  mounts() {
    return this.#store.mounts.map((mount) => ({ ...mount }))
  }

  /** @returns {import('./ssh/pool.js').HostRecord[]} */
  hosts() {
    return this.#store.hosts.map((host) => ({
      ...host,
      ...(host.auth ? { auth: { ...host.auth } } : {}),
      source: this.#ownAliases.has(host.alias) ? 'plugin' : 'dsh-ssh',
    }))
  }

  /**
   * Add or update a host in this plugin's own store (credentials included).
   * @param {{ alias?: string, host?: string, port?: number, user?: string,
   *   authKind?: 'password' | 'key' | 'none', password?: string, keyPath?: string,
   *   passphrase?: string, previousAlias?: string }} input
   * @returns {Promise<import('./ssh/pool.js').HostRecord>}
   */
  async saveHost(input) {
    await this.ready()
    const alias = String(input?.alias ?? '').trim()
    const address = String(input?.host ?? '').trim()
    if (!alias) throw new Error('a host needs an alias')
    if (!address) throw new Error(`host "${alias}" needs an address`)
    const port = input?.port === undefined || input.port === '' ? 22 : Number(input.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`host "${alias}": port must be an integer between 1 and 65535`)
    const user = String(input?.user ?? 'root').trim() || 'root'
    const kind = input?.authKind === 'key' ? 'key' : input?.authKind === 'password' ? 'password' : input?.authKind === 'none' ? 'none' : undefined
    let auth
    if (kind === 'key') {
      const keyPath = String(input?.keyPath ?? '').trim()
      if (!keyPath) throw new Error(`host "${alias}": key authentication needs a private key path`)
      auth = { kind: 'key', keyPath: expandHome(keyPath, os.homedir()), ...(input?.passphrase ? { passphrase: String(input.passphrase) } : {}) }
    } else if (kind === 'password') {
      const password = input?.password === undefined ? '' : String(input.password)
      if (!password) throw new Error(`host "${alias}": password authentication needs a password`)
      auth = { kind: 'password', password }
    }
    const record = { alias, host: address, port, user, ...(auth ? { auth } : {}) }
    const previousAlias = String(input?.previousAlias ?? '').trim()
    const raw = await readJson(this.#hostsPath)
    const existing = raw && Array.isArray(raw.hosts) ? raw.hosts : []
    const records = existing.filter((entry) => {
      const name = entry && typeof entry.alias === 'string' ? entry.alias : undefined
      return name !== undefined && name !== alias && name !== previousAlias
    })
    records.push(record)
    await writeJsonAtomic(this.#hostsPath, { version: 1, hosts: records }, { mode: 0o600 })
    await this.#load()
    return record
  }

  /**
   * Remove a host from this plugin's own store.
   * @param {string} alias
   * @returns {Promise<boolean>} whether a host was removed
   */
  async removeHost(alias) {
    await this.ready()
    const name = String(alias ?? '').trim()
    if (!name) throw new Error('a host alias is required')
    const raw = await readJson(this.#hostsPath)
    const hosts = raw && Array.isArray(raw.hosts) ? raw.hosts : []
    const next = hosts.filter((entry) => !(entry && entry.alias === name))
    if (next.length === hosts.length) return false
    await writeJsonAtomic(this.#hostsPath, { ...(raw ?? {}), version: 1, hosts: next }, { mode: 0o600 })
    await this.#load()
    return true
  }

  /**
   * Merge the configured static mounts on top of the stored ones.
   * @param {Store} store
   * @returns {Store}
   */
  #withStaticMounts(store) {
    const mounts = [...store.mounts]
    for (const entry of this.#staticMounts) {
      if (!entry || typeof entry.host !== 'string' || typeof entry.remote !== 'string') continue
      const remote = normalizeRemote(entry.remote)
      if (mounts.some((mount) => mount.host === entry.host && mount.remote === remote)) continue
      mounts.push({
        id: `static:${entry.host}:${remote}`,
        host: entry.host,
        remote,
        anchor: entry.anchor ? path.resolve(expandHome(entry.anchor, os.homedir())) : this.anchorFor(entry.host, remote),
        createdAt: 0,
      })
    }
    return { ...store, mounts }
  }

  /** @returns {Promise<void>} */
  async #load() {
    /** @type {Store} */
    let store = { version: 1, hosts: [], mounts: [] }
    const raw = await readJson(this.#storePath)
    let persisted = false
    // Credentials live in this plugin's own host store (preferred) and,
    // optionally, in the dsh-ssh store. The mount store keeps identities only.
    const own = await this.#readOwnHosts()
    this.#ownAliases = new Set(own.map((host) => host.alias))
    const live = new Map()
    for (const host of own) live.set(host.alias, host)
    if (this.#sshHostsPath) {
      const ssh = await readJson(this.#sshHostsPath)
      if (ssh && Array.isArray(ssh.hosts)) {
        for (const host of ssh.hosts.map(normalizeHost)) {
          if (host && !live.has(host.alias)) live.set(host.alias, host)
        }
      }
    }
    if (raw && typeof raw === 'object') {
      store = {
        version: 1,
        hosts: Array.isArray(raw.hosts) ? raw.hosts.map(normalizeHost).filter(Boolean) : [],
        mounts: Array.isArray(raw.mounts)
          ? raw.mounts
            .filter((mount) => mount && typeof mount.host === 'string' && typeof mount.remote === 'string' && typeof mount.anchor === 'string')
            .map((mount) => ({
              id: typeof mount.id === 'string' ? mount.id : `mount:${mount.host}:${normalizeRemote(mount.remote)}`,
              host: mount.host,
              remote: normalizeRemote(mount.remote),
              anchor: path.resolve(mount.anchor),
              createdAt: typeof mount.createdAt === 'number' ? mount.createdAt : Date.now(),
            }))
          : [],
      }
    } else {
      // First run: record host identities only; credentials stay in the host stores.
      store.hosts = [...live.values()].map(stripSecrets).filter(Boolean)
      await this.#persist(store)
      persisted = true
    }
    // The host list is derived from the live stores (own store first, then the
    // optional dsh-ssh import). Credentials never reach the mount store.
    store.hosts = [...live.values()]
    const identityOnly = store.hosts.map(stripSecrets).filter(Boolean)
    const previousIdentities = raw && Array.isArray(raw.hosts) ? raw.hosts : []
    const hadSecrets = previousIdentities.some((entry) => entry && typeof entry === 'object' && entry.auth !== undefined)
    const identitiesChanged = previousIdentities.length !== identityOnly.length || previousIdentities.some((entry, index) => {
      const next = identityOnly[index]
      return !next || !entry || entry.alias !== next.alias || entry.host !== next.host || entry.port !== next.port || entry.user !== next.user
    })
    if (!persisted && (hadSecrets || identitiesChanged)) {
      await this.#persist({ ...store, hosts: identityOnly })
    }
    this.#store = this.#withStaticMounts(store)
    this.#pool.setHosts(this.#store.hosts)
    try {
      const info = await stat(this.#storePath)
      this.#stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      this.#stamp = ''
    }
    this.#sshStamp = await this.#sshFileStamp()
    this.#hostsStamp = await this.#hostsFileStamp()
    this.#loaded = true
  }

  /**
   * @param {Store} store
   * @returns {Promise<void>}
   */
  async #persist(store) {
    const write = async () => {
      const { version, mounts } = store
      const hosts = store.hosts.map(stripSecrets).filter(Boolean)
      await writeJsonAtomic(this.#storePath, { version, hosts, mounts })
      try {
        const info = await stat(this.#storePath)
        this.#stamp = `${info.mtimeMs}:${info.size}`
      } catch {
        this.#stamp = ''
      }
    }
    this.#writeChain = this.#writeChain.then(write, write)
    return this.#writeChain
  }

  /**
   * Deterministic local anchor directory for a (host, remote) pair.
   * @param {string} host
   * @param {string} remote
   * @returns {string} absolute host path (not created)
   */
  anchorFor(host, remote) {
    const normalized = normalizeRemote(remote)
    const segments = normalized.split('/').filter(Boolean).map(safeSegment)
    return path.join(this.#anchorRoot, safeSegment(host), ...segments)
  }

  /**
   * Register a mount and create its anchor directory.
   * @param {{ host: string, remote: string, anchor?: string }} request
   * @returns {Promise<Mount>}
   */
  async addMount(request) {
    await this.ready()
    const host = String(request.host ?? '').trim()
    const remote = normalizeRemote(request.remote ?? '/')
    if (!host) throw new Error('a mount needs a host')
    const anchor = path.resolve(request.anchor ?? this.anchorFor(host, remote))
    const existing = this.#store.mounts.find((mount) => mount.host === host && mount.remote === remote)
    if (existing) {
      await mkdir(existing.anchor, { recursive: true })
      return { ...existing }
    }
    const mount = { id: `mount:${host}:${remote}:${Date.now()}`, host, remote, anchor, createdAt: Date.now() }
    this.#store = { ...this.#store, mounts: [...this.#store.mounts, mount] }
    await mkdir(anchor, { recursive: true })
    await this.#persist({ version: 1, hosts: this.#store.hosts, mounts: this.#store.mounts.filter((entry) => entry.createdAt > 0) })
    return { ...mount }
  }

  /**
   * Forget a mount (the anchor directory itself is left in place).
   * @param {string} idOrAnchor mount id or anchor path
   * @returns {Promise<boolean>} whether a mount was removed
   */
  async removeMount(idOrAnchor) {
    await this.ready()
    const mount = this.#store.mounts.find((entry) => entry.id === idOrAnchor || entry.anchor === path.resolve(String(idOrAnchor)))
    if (!mount) return false
    this.#store = { ...this.#store, mounts: this.#store.mounts.filter((entry) => entry.id !== mount.id) }
    await this.#persist({ version: 1, hosts: this.#store.hosts, mounts: this.#store.mounts.filter((entry) => entry.createdAt > 0) })
    return true
  }

  /**
   * Remember a host definition in the store.
   * @param {import('./ssh/pool.js').HostRecord} host
   */
  async upsertHost(host) {
    await this.ready()
    const records = this.#store.hosts.filter((entry) => entry.alias !== host.alias)
    records.push(host)
    this.#store = { ...this.#store, hosts: records }
    await this.#persist({ version: 1, hosts: records, mounts: this.#store.mounts.filter((entry) => entry.createdAt > 0) })
  }

  /**
   * Find the mount that owns a host (local) path.
   * @param {string} hostPath absolute host path
   * @returns {Mount | undefined} the longest matching mount
   */
  matchLocal(hostPath) {
    let best
    for (const mount of this.#store.mounts) {
      if (!hostContains(mount.anchor, hostPath)) continue
      if (!best || mount.anchor.length > best.anchor.length) best = mount
    }
    return best
  }

  /**
   * Find the mount that owns a remote path.
   * @param {string} remotePath absolute remote path
   * @param {string} [hostRef] restrict to one host
   * @returns {Mount | undefined} the longest matching mount
   */
  matchRemote(remotePath, hostRef) {
    let best
    for (const mount of this.#store.mounts) {
      if (hostRef !== undefined && mount.host !== hostRef) continue
      if (!remoteContains(mount.remote, remotePath)) continue
      if (!best || mount.remote.length > best.remote.length) best = mount
    }
    return best
  }

  /**
   * Translate an anchor path to its remote coordinate.
   * @param {string} hostPath
   * @returns {{ mount: Mount, remotePath: string } | undefined}
   */
  toRemote(hostPath) {
    const mount = this.matchLocal(hostPath)
    if (!mount) return undefined
    return { mount, remotePath: joinRemote(mount.remote, hostRelative(mount.anchor, hostPath)) }
  }

  /**
   * Translate a remote coordinate back to its anchor path.
   * @param {string} hostRef
   * @param {string} remotePath
   * @returns {{ mount: Mount, hostPath: string } | undefined}
   */
  toHost(hostRef, remotePath) {
    const mount = this.matchRemote(remotePath, hostRef)
    if (!mount) return undefined
    const rel = normalizeRemote(remotePath).slice(mount.remote === '/' ? 1 : mount.remote.length + 1)
    return { mount, hostPath: path.join(mount.anchor, ...rel.split('/').filter(Boolean)) }
  }
}
