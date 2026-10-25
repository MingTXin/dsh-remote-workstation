/**
 * Shared implementation of the remote shell executors.
 *
 * The host's shell service is a swappable Cordis service: on POSIX the mounted
 * executor is the sandboxed bash executor, on Windows it is the sandboxed pwsh
 * executor. Both extend a *local* executor whose public `execute(spec)` spawns
 * the command on the host. This factory builds the remote variant for either
 * base class:
 *
 * - a command whose `workdir` lies inside a mount anchor is executed on the SSH
 *   host that anchor stands in for, by spawning `ssh-exec-helper.mjs` as a host
 *   subprocess (so timeout, output caps, spill and background jobs stay the
 *   host's), which itself pipes the command over SFTP's exec channel;
 * - every other command keeps the stock local behaviour.
 *
 * Remote commands cannot be confined by the host sandbox, so they are only
 * routed when the per-call sandbox policy already allows unconfined execution
 * (`danger-full-access`). Otherwise the executor refuses and tells the model how
 * to escalate, which goes through the host's normal approval flow.
 *
 * @module dsh-remote-workstation/shell-remote-core
 */

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { expandHome } from './paths.js'
import { getSharedState, releaseSharedState } from './state.js'

/** Helper spawned per remote command. */
const HELPER_PATH = fileURLToPath(new URL('./ssh-exec-helper.mjs', import.meta.url))

/** Modes that leave the command unconfined on the host. */
const UNCONFINED_MODE = 'danger-full-access'

/**
 * Build a remote executor for one stock sandboxed executor class.
 * @template {new (ctx: any, config: any) => any} T
 * @param {T} BaseClass
 * @param {Record<string, any>} [extraFields] platform-specific config fields the base class expects
 * @returns {T}
 */
export function createRemoteShellExecutor(BaseClass, extraFields = {}) {
  return class RemoteShellExecutor extends BaseClass {
    static Config = z.object({
      /** Base directory for relative workdirs (stock behaviour). */
      cwd: z.string().volatile(),
      /** Default command timeout (stock bash/pwsh config). */
      timeoutMs: z.number().default(120000).volatile(),
      /** Hard timeout ceiling (stock config). */
      maxTimeoutMs: z.number().default(600000).volatile(),
      /** Per-stream capture cap (stock config). */
      maxOutputBytes: z.number().default(64000).volatile(),
      /** Spill cap for overflowed output (stock config). */
      maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
      /** SIGTERM to SIGKILL grace period (stock config). */
      graceMs: z.number().default(3000).volatile(),
      /** Runtime mount/host store shared with the fs provider. */
      storePath: z.string().default('~/.dsh/remote-workspaces.json'),
      /** This plugin's own SSH host store. */
      hostsPath: z.string().default(''),
      /** Optional read-only import of the dsh-ssh plugin's host list. */
      sshHostsPath: z.string().default(''),
      /** Directory that holds anchor directories. */
      anchorRoot: z.string().default(''),
      /** SSH connection timeout in milliseconds. */
      connectTimeoutMs: z.number().default(15000),
      ...extraFields,
    })

    /** @type {any} */
    settings
    /** @type {{ key: string, pool: any, table: any, users: number }} */
    remoteState

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
      this.settings = { storePath, hostsPath, sshHostsPath, anchorRoot }
      this.remoteState = getSharedState({
        storePath,
        hostsPath,
        sshHostsPath,
        anchorRoot,
        connectTimeoutMs: config.connectTimeoutMs,
      })
      this.remoteState.users += 1
      ctx.on('dispose', () => {
        releaseSharedState(this.remoteState)
      })
    }

    /**
     * Execute a resolved spec, routing anchor workdirs to their SSH host.
     * @param {any} spec
     * @returns {Promise<any>}
     */
    async execute(spec) {
      const target = await this.routeRemote(spec)
      if (target === undefined) return super.execute(spec)
      const mode = spec.sandboxPolicy?.mode ?? this.sandboxMode ?? UNCONFINED_MODE
      if (mode !== UNCONFINED_MODE) {
        throw new Error(
          `cannot run "${spec.command}" in ${target.displayPath}: this session runs in "${mode}" mode, and a command on "${target.mount.host}" cannot be confined by the host sandbox. ` +
            `Retry once with sandbox_permissions: "${UNCONFINED_MODE}" and a one-sentence justification so the user can approve this single command, ` +
            'or use the remote_exec tool for remote-only work.',
        )
      }
      return this.executeRemote(spec, target)
    }

    /**
     * Map a spec's workdir onto a mount, when it is inside an anchor.
     * @param {any} spec
     * @returns {Promise<{ mount: any, remotePath: string, displayPath: string } | undefined>}
     */
    async routeRemote(spec) {
      const workdir = spec?.workdir
      if (typeof workdir !== 'string' || workdir === '') return undefined
      const table = this.remoteState.table
      await table.ready()
      const translated = table.toRemote(path.resolve(workdir))
      if (translated === undefined) return undefined
      return {
        mount: translated.mount,
        remotePath: translated.remotePath,
        displayPath: translated.mount.anchor,
      }
    }

    /**
     * Run the command on the remote host through the helper subprocess.
     * @param {any} spec
     * @param {{ mount: any, remotePath: string }} target
     * @returns {Promise<any>}
     */
    async executeRemote(spec, target) {
      const argv = [
        process.execPath,
        HELPER_PATH,
        '--host',
        target.mount.host,
        '--workdir',
        target.remotePath,
        '--command',
        spec.command,
        '--store',
        this.settings.storePath,
        '--ssh-hosts',
        this.settings.sshHostsPath ?? '',
        '--hosts-store',
        this.settings.hostsPath,
        '--anchor-root',
        this.settings.anchorRoot,
      ]
      const execution = await this.executeArgv(spec, argv, () => {})
      return this.constructor.decorateResult(execution, (result) => ({
        ...result,
        sandbox: { mode: UNCONFINED_MODE, denied: false },
      }))
    }
  }
}
