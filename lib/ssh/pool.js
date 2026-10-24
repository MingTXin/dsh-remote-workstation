/**
 * SSH connection pool (ssh2) shared by the filesystem provider and the Remote
 * Explorer panel. One TCP connection per host reference, one lazily opened SFTP
 * session per connection, transparently re-established after a drop.
 *
 * @module dsh-remote-workstation/ssh/pool
 */

import { readFile } from 'node:fs/promises'
import { Client } from 'ssh2'
import { FsError } from '@deepseek-ai/dsh-fs'

/** Host references this pool can talk to: an alias, `user@host`, or `user@host:port`. */
const HOST_REF = /^(?:(?<user>[^@/]+)@)?(?<host>[^@/:]+)(?::(?<port>\d+))?$/

/**
 * Split a host reference into its parts.
 * @param {string} ref
 * @returns {{ user?: string, host: string, port?: number }}
 */
export function parseHostRef(ref) {
  const match = HOST_REF.exec(String(ref ?? '').trim())
  if (!match?.groups) {
    throw new FsError(`remote workspace: invalid ssh host reference "${String(ref)}"`, 'FS_IO_ERROR')
  }
  const port = match.groups.port === undefined ? undefined : Number(match.groups.port)
  return { user: match.groups.user, host: match.groups.host, port }
}

/**
 * @typedef {{ alias: string, host: string, port?: number, user?: string,
 *   auth?: { kind: 'password', password?: string } | { kind: 'key', keyPath?: string, passphrase?: string } }} HostRecord
 */

export class SshPool {
  /** @type {Map<string, HostRecord>} */
  #hosts = new Map()
  /** @type {Map<string, { client: Client, sftp: any, connecting?: Promise<any> }>} */
  #connections = new Map()
  #connectTimeoutMs
  #resolveAuth
  #closed = false

  /**
   * @param {{ connectTimeoutMs?: number, resolveAuth?: (alias: string) => Promise<HostRecord | undefined> }} [options]
   *   `resolveAuth` is consulted when a host record carries no credentials, so a
   *   rotated password or a freshly added host never needs a reload.
   */
  constructor(options = {}) {
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15000
    this.#resolveAuth = options.resolveAuth
  }

  /**
   * Replace the known host table (called on every store reload).
   * @param {HostRecord[]} hosts
   */
  setHosts(hosts) {
    this.#hosts = new Map(hosts.map((host) => [host.alias, host]))
  }

  /** @returns {HostRecord[]} */
  hosts() {
    return [...this.#hosts.values()].map((host) => ({ ...host, auth: host.auth ? { ...host.auth } : undefined }))
  }

  /**
   * @param {string} ref alias or user@host[:port]
   * @returns {HostRecord}
   */
  hostRecord(ref) {
    const known = this.#hosts.get(String(ref))
    if (known) return known
    const parsed = parseHostRef(ref)
    return {
      alias: String(ref),
      host: parsed.host,
      port: parsed.port ?? 22,
      user: parsed.user ?? 'root',
      auth: undefined,
    }
  }

  /**
   * Open (or reuse) the connection for a host reference.
   * @param {string} ref
   * @returns {Promise<any>} the ssh2 SFTP session
   */
  async sftp(ref) {
    if (this.#closed) throw new FsError('remote workspace: ssh pool is closed', 'FS_IO_ERROR')
    const alias = String(ref)
    const existing = this.#connections.get(alias)
    if (existing?.sftp) return existing.sftp
    if (existing?.connecting) return existing.connecting
    const record = this.hostRecord(alias)
    const connecting = this.#open(record).then((entry) => {
      this.#connections.set(alias, entry)
      return entry.sftp
    }, (error) => {
      this.#connections.delete(alias)
      throw error
    })
    this.#connections.set(alias, { client: undefined, sftp: undefined, connecting })
    return connecting
  }

  /**
   * Run one operation against a host's SFTP session.
   * @template T
   * @param {string} ref
   * @param {(sftp: any) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async withSftp(ref, operation) {
    const sftp = await this.sftp(ref)
    try {
      return await operation(sftp)
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'FS_IO_ERROR' && /connection|socket|closed/i.test(String(error.message))) {
        this.#drop(String(ref))
      }
      throw error
    }
  }

  /** Close every connection (provider disposal). */
  close() {
    this.#closed = true
    for (const entry of this.#connections.values()) {
      try {
        entry.sftp?.end?.()
      } catch {
        /* ignore */
      }
      try {
        entry.client?.end()
      } catch {
        /* ignore */
      }
    }
    this.#connections.clear()
  }

  /** @param {string} alias */
  #drop(alias) {
    const entry = this.#connections.get(alias)
    if (!entry) return
    this.#connections.delete(alias)
    try {
      entry.client?.end()
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {HostRecord} record
   * @returns {Promise<{ client: Client, sftp: any }>}
   */
  async #open(initial) {
    const record = await this.#withLiveAuth(initial)
    const auth = await this.#authFor(record)
    const client = new Client()
    const label = `${record.user ?? 'root'}@${record.host}:${record.port ?? 22}`
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        cleanup()
        client.end()
        rejectPromise(new FsError(`cannot connect to "${record.alias}" (${label}): connection timed out after ${this.#connectTimeoutMs} ms`, 'FS_IO_ERROR'))
      }, this.#connectTimeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        client.removeListener('ready', onReady)
        client.removeListener('error', onError)
      }
      const onReady = () => {
        cleanup()
        resolvePromise(undefined)
      }
      const onError = (error) => {
        cleanup()
        client.end()
        rejectPromise(new FsError(`cannot connect to "${record.alias}" (${label}): ${error?.message ?? String(error)}`, 'FS_IO_ERROR', { cause: error }))
      }
      client.once('ready', onReady)
      client.once('error', onError)
      try {
        client.connect({
          host: record.host,
          port: record.port ?? 22,
          username: record.user ?? 'root',
          keepaliveInterval: 20000,
          keepaliveCountMax: 3,
          readyTimeout: this.#connectTimeoutMs,
          ...auth,
        })
      } catch (error) {
        cleanup()
        rejectPromise(new FsError(`cannot connect to "${record.alias}" (${label}): ${error?.message ?? String(error)}`, 'FS_IO_ERROR', { cause: error }))
      }
    })
    client.on('error', () => {
      this.#drop(record.alias)
    })
    client.on('close', () => {
      this.#drop(record.alias)
    })
    const sftp = await new Promise((resolvePromise, rejectPromise) => {
      client.sftp((error, session) => {
        if (error) {
          client.end()
          rejectPromise(new FsError(`cannot open an SFTP session on "${record.alias}": ${error.message}`, 'FS_IO_ERROR', { cause: error }))
        } else {
          resolvePromise(session)
        }
      })
    })
    return { client, sftp }
  }

  /**
   * Fill in credentials from the live ssh store when the cached record has none.
   * @param {HostRecord} record
   * @returns {Promise<HostRecord>}
   */
  async #withLiveAuth(record) {
    if (record.auth || !this.#resolveAuth) return record
    let live
    try {
      live = await this.#resolveAuth(record.alias)
    } catch {
      return record
    }
    if (!live?.auth) return record
    const merged = { ...record, auth: live.auth }
    this.#hosts.set(record.alias, merged)
    return merged
  }

  /**
   * @param {HostRecord} record
   * @returns {Promise<Record<string, unknown>>} ssh2 connect credentials
   */
  async #authFor(record) {
    const auth = record.auth
    if (auth?.kind === 'password') {
      if (!auth.password) {
        throw new FsError(`remote workspace: host "${record.alias}" needs a password`, 'FS_IO_ERROR')
      }
      return { password: auth.password }
    }
    if (auth?.kind === 'key') {
      if (!auth.keyPath) {
        throw new FsError(`remote workspace: host "${record.alias}" needs a private key path`, 'FS_IO_ERROR')
      }
      let privateKey
      try {
        privateKey = await readFile(auth.keyPath)
      } catch (error) {
        throw new FsError(`remote workspace: cannot read the private key "${auth.keyPath}": ${error?.message ?? String(error)}`, 'FS_IO_ERROR', { cause: error })
      }
      return auth.passphrase ? { privateKey, passphrase: auth.passphrase } : { privateKey }
    }
    // Fall back to the SSH agent / default keys so an existing ~/.ssh setup just works.
    if (process.env.SSH_AUTH_SOCK) return { agent: process.env.SSH_AUTH_SOCK, tryKeyboard: false }
    throw new FsError(
      `remote workspace: no credentials for host "${record.alias}" — add a password or a private key for it in the DSH SSH host store (~/.dsh/dsh-ssh.json, 侧栏「远程」→ 主机列表来自该文件)`,
      'FS_IO_ERROR',
    )
  }
}
