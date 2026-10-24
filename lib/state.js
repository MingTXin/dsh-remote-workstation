/**
 * Process-wide shared state for the remote-workspace plugin.
 *
 * Both entry points (`lib/index.js`, the filesystem provider, and
 * `lib/explorer.js`, the panel backend) run inside the same DSH process and
 * share one SSH pool and one mount table. They are created on first use and
 * keyed by their store configuration so an isolated profile gets its own state.
 *
 * @module dsh-remote-workstation/state
 */

import { MountTable } from './mounts.js'
import { SshPool } from './ssh/pool.js'

/** @type {Map<string, { key: string, pool: SshPool, table: MountTable, users: number }>} */
const registry = new Map()

/**
 * @param {{
 *   storePath: string,
 *   hostsPath?: string,
 *   sshHostsPath?: string,
 *   anchorRoot?: string,
 *   mounts?: Array<{ host: string, remote: string, anchor?: string }>,
 *   connectTimeoutMs?: number,
 * }} config
 * @returns {{ key: string, pool: SshPool, table: MountTable, users: number }}
 */
export function getSharedState(config) {
  const key = JSON.stringify({
    storePath: config.storePath,
    hostsPath: config.hostsPath ?? null,
    sshHostsPath: config.sshHostsPath ?? null,
    anchorRoot: config.anchorRoot ?? null,
  })
  let state = registry.get(key)
  if (!state) {
    /** @type {MountTable | undefined} */
    let table
    const pool = new SshPool({
      connectTimeoutMs: config.connectTimeoutMs,
      resolveAuth: (alias) => table?.liveHost(alias) ?? Promise.resolve(undefined),
    })
    table = new MountTable({
      storePath: config.storePath,
      hostsPath: config.hostsPath,
      sshHostsPath: config.sshHostsPath,
      anchorRoot: config.anchorRoot,
      staticMounts: config.mounts,
      pool,
    })
    state = { key, pool, table, users: 0 }
    registry.set(key, state)
  }
  return state
}

/**
 * Release one user of a shared state; closes the pool when nobody is left.
 * @param {{ key: string }} state
 */
export function releaseSharedState(state) {
  const current = registry.get(state.key)
  if (!current) return
  current.users -= 1
  if (current.users <= 0) {
    current.pool.close()
    registry.delete(current.key)
  }
}
