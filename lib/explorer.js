/**
 * Host half of the Remote Explorer panel.
 *
 * The panel cannot talk to `ctx.fs` directly (that lives on the host), so this
 * service exposes a tiny JSON API over the existing web server:
 *
 *   POST /api/remote-workspace/hosts    -> [{ alias, host, port, user }]
 *   POST /api/remote-workspace/mounts   -> [{ id, host, remote, anchor, createdAt }]
 *   POST /api/remote-workspace/home     -> { host, path }          remote $HOME
 *   POST /api/remote-workspace/list     -> { host, path, parent, entries }
 *   POST /api/remote-workspace/mount    -> { mount }              creates the anchor
 *   POST /api/remote-workspace/unmount  -> { removed }
 *
 * The API is deliberately dumb: it browses over SFTP and manages the mount
 * store. Turning an anchor into a workspace is the client's job (it calls
 * `ctx.workspaces.create`), because the workspace registry is a host service the
 * client already has a typed interface for.
 *
 * @module dsh-remote-workstation/explorer
 */

import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'
import { expandHome, normalizeRemote } from './paths.js'
import * as sftp from './ssh/sftp.js'
import { shellQuote } from './ssh/pool.js'
import { getSharedState, releaseSharedState } from './state.js'
import { createRemoteTools } from './tools.js'

/** Where the panel talks to this service. */
export const API_PREFIX = '/api/remote-workspace'

/** Reject request bodies larger than this. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** @param {string} remotePath */
function remoteParent(remotePath) {
  if (remotePath === '/') return null
  const parent = path.posix.dirname(remotePath)
  return parent === '.' ? '/' : parent
}

export class RemoteWorkspaceExplorer extends Service {
  static inject = ['webServer']

  static Config = z.object({
    storePath: z.string().default('~/.dsh/remote-workspaces.json'),
    hostsPath: z.string().default(''),
    sshHostsPath: z.string().default(''),
    anchorRoot: z.string().default(''),
    mounts: z.array(z.object({
      host: z.string(),
      remote: z.string(),
      anchor: z.string().default(''),
    })).default([]),
    connectTimeoutMs: z.number().default(15000),
    /** Register the remote_exec / remote_search model tools when `tools` exists. */
    enableTools: z.boolean().default(true),
  })

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {any} config
   */
  constructor(ctx, config) {
    super(ctx, 'remoteWorkspaceExplorer')
    const home = os.homedir()
    this.remoteState = getSharedState({
      storePath: path.resolve(expandHome(config.storePath || '~/.dsh/remote-workspaces.json', home)),
      hostsPath: config.hostsPath ? path.resolve(expandHome(config.hostsPath, home)) : undefined,
      sshHostsPath: config.sshHostsPath ? path.resolve(expandHome(config.sshHostsPath, home)) : undefined,
      anchorRoot: config.anchorRoot ? path.resolve(expandHome(config.anchorRoot, home)) : undefined,
      mounts: config.mounts,
      connectTimeoutMs: config.connectTimeoutMs,
    })
    this.remoteState.users += 1
    this.config = config
    ctx.on('dispose', () => {
      releaseSharedState(this.remoteState)
    })
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => this.#handle(req, res),
      })
      return () => dispose()
    }, 'remote-workspace: explorer api')
    if (config.enableTools !== false) {
      ctx.inject(['tools'], (toolCtx) => {
        const engine = {
          exec: (host, command, options) => this.execRemote(host, command, options),
          search: (request) => this.searchRemote(request),
        }
        const disposers = createRemoteTools(engine).map((tool) => toolCtx.tools.register(tool))
        toolCtx.effect(() => () => {
          for (const dispose of disposers) dispose()
        }, 'remote-workspace: remote tools')
      })
    }
  }

  /** @returns {import('./ssh/pool.js').SshPool} */
  get pool() {
    return this.remoteState.pool
  }

  /** @returns {import('./mounts.js').MountTable} */
  get table() {
    return this.remoteState.table
  }

  /**
   * @param {string} host
   * @param {(session: any) => Promise<any>} operation
   * @returns {Promise<any>}
   */
  #remote(host, operation) {
    return this.pool.withSftp(host, operation)
  }

  /** @returns {Array<{ alias: string, host: string, port: number, user: string, source: string }>} */
  #publicHosts() {
    return this.table.hosts().map((host) => ({
      alias: host.alias,
      host: host.host,
      port: host.port,
      user: host.user,
      source: host.source,
    }))
  }

  /**
   * Run a shell command on a remote host (also the `remote_exec` tool backend).
   * @param {string | undefined} host host alias; defaults to the first known host
   * @param {string} command
   * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async execRemote(host, command, options = {}) {
    await this.table.ready()
    const alias = this.#hostAlias(host)
    if (typeof command !== 'string' || command.trim().length === 0) throw new Error('exec needs a command')
    return this.pool.exec(alias, command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
  }

  /**
   * grep text files under a remote directory (also the `remote_search` backend).
   * @param {{ host?: string, path?: string, pattern?: string, glob?: string, maxResults?: number, ignoreCase?: boolean, signal?: AbortSignal }} request
   */
  async searchRemote(request = {}) {
    await this.table.ready()
    const alias = this.#hostAlias(request.host)
    const remotePath = normalizeRemote(request.path ?? '/')
    const pattern = String(request.pattern ?? '')
    if (pattern.length === 0) throw new Error('search needs a pattern')
    const limit = Number.isSafeInteger(request.maxResults) && request.maxResults > 0
      ? Math.min(request.maxResults, 2000)
      : 200
    const args = ['-rInE', '--color=never', '--binary-files=without-match', '--exclude-dir=.git']
    if (request.ignoreCase) args.push('-i')
    if (typeof request.glob === 'string' && request.glob.length > 0) args.push(`--include=${shellQuote(request.glob)}`)
    const command = `grep ${args.join(' ')} ${shellQuote(pattern)} . 2>/dev/null | head -n ${limit}`
    const result = await this.pool.exec(alias, command, { cwd: remotePath, timeoutMs: 120000, signal: request.signal })
    const lines = result.stdout.split('\n').filter((line) => line.length > 0)
    const stderr = result.stderr.trim()
    return {
      count: lines.length,
      truncated: lines.length >= limit,
      exitCode: lines.length > 0 ? 0 : 1,
      matches: lines,
      ...(stderr.length > 0 ? { stderr: stderr.slice(0, 2000) } : {}),
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(API_PREFIX.length).replace(/^\//, '') || 'ping'
    try {
      if (req.method !== 'POST' && action !== 'ping') {
        sendJson(res, 405, { ok: false, error: { code: 'method', message: `use POST for ${action}` } })
        return
      }
      const body = action === 'ping' ? {} : await readJsonBody(req)
      const value = await this.#dispatch(action, body)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: { code: error?.code ?? 'error', message } })
    }
  }

  /**
   * @param {string} action
   * @param {any} body
   * @returns {Promise<unknown>}
   */
  async #dispatch(action, body) {
    await this.table.ready()
    switch (action) {
      case 'ping':
        return { service: 'remote-workspace', mounts: this.table.mounts().length }
      case 'hosts':
        return this.#publicHosts()
      case 'hostSave': {
        const saved = await this.table.saveHost(body ?? {})
        return { host: { alias: saved.alias, host: saved.host, port: saved.port, user: saved.user, source: 'plugin' }, hosts: this.#publicHosts() }
      }
      case 'hostRemove': {
        const alias = String(body?.alias ?? '').trim()
        if (!alias) throw new Error('hostRemove needs a host alias')
        const removed = await this.table.removeHost(alias)
        if (!removed) throw new Error(`host "${alias}" is not defined in this plugin's own host store (dsh-ssh hosts can only be removed there)`)
        return { removed, hosts: this.#publicHosts() }
      }
      case 'hostTest': {
        const alias = this.#hostAlias(body?.alias)
        const started = Date.now()
        const home = await this.#remote(alias, (session) => sftp.realpath(session, '.'))
        return { alias, home, ms: Date.now() - started }
      }
      case 'mounts':
        return this.table.mounts()
      case 'home': {
        const host = this.#hostAlias(body.host)
        const cwd = await this.#remote(host, (session) => sftp.realpath(session, '.'))
        return { host, path: cwd }
      }
      case 'list': {
        const host = this.#hostAlias(body.host)
        const remotePath = normalizeRemote(body.path ?? '/')
        const attrs = await this.#remote(host, (session) => sftp.statFollow(session, remotePath))
        if (!attrs) throw new Error(`cannot browse "${remotePath}": no such directory`)
        if (!sftp.isDirectory(attrs)) throw new Error(`cannot browse "${remotePath}": not a directory`)
        const entries = await this.#remote(host, (session) => sftp.readdir(session, remotePath))
        const rows = entries.map((entry) => ({
          name: entry.name,
          type: sftp.entryType(entry.attrs),
          size: Number(entry.attrs.size ?? 0),
        }))
        rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
        return { host, path: remotePath, parent: remoteParent(remotePath), entries: rows }
      }
      case 'read': {
        const fs = this.ctx.reflect.get('fs', false)
        if (fs === undefined) throw new Error('ctx.fs is not mounted')
        const target = await fs.resolve(String(body.path))
        const text = await fs.readText(target)
        return {
          path: target.displayPath,
          targetKey: String(target.targetKey),
          bytes: Buffer.byteLength(text, 'utf8'),
          head: text.split('\n').slice(0, 2).join('\n'),
        }
      }
      case 'exec': {
        return this.execRemote(body.host, String(body.command ?? ''), {
          cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
          timeoutMs: Number.isSafeInteger(body.timeoutMs) ? body.timeoutMs : undefined,
        })
      }
      case 'search': {
        return this.searchRemote(body)
      }
      case 'mount': {
        const host = this.#hostAlias(body.host)
        const remotePath = normalizeRemote(body.path ?? '/')
        const mount = await this.table.addMount({ host, remote: remotePath })
        return { mount }
      }
      case 'unmount': {
        if (typeof body.id !== 'string') throw new Error('unmount needs a mount id')
        return { removed: await this.table.removeMount(body.id) }
      }
      default:
        throw new Error(`unknown remote-workspace action "${action}"`)
    }
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  #hostAlias(value) {
    const hosts = this.table.hosts()
    if (typeof value === 'string' && value.length > 0) {
      if (!hosts.some((host) => host.alias === value)) throw new Error(`unknown host "${value}"`)
      return value
    }
    if (hosts.length === 0) throw new Error('no SSH hosts are configured yet — add one in the 远程 panel or in ~/.dsh/dsh-ssh.json')
    return hosts[0].alias
  }
}

export default RemoteWorkspaceExplorer
