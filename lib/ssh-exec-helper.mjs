#!/usr/bin/env node
/**
 * Run one command on a remote host and stream its output back.
 *
 * The remote shell executor spawns this file as a host subprocess so the host
 * keeps its own timeout, output cap, spill and background-job semantics while
 * the command itself runs over SSH.
 *
 * Usage (all flags required unless noted):
 *   --host <alias> --workdir <remote-path> --command <string>
 *   --store <path> --ssh-hosts <path> [--hosts-store <path>] [--anchor-root <path>]
 *
 * @module dsh-remote-workstation/ssh-exec-helper
 */

import { MountTable } from './mounts.js'
import { SshPool, shellQuote } from './ssh/pool.js'

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (typeof flag !== 'string' || !flag.startsWith('--')) {
      throw new Error(`dsh-remote-workstation: unexpected argument "${String(flag)}"`)
    }
    const value = argv[index + 1]
    if (value === undefined) {
      throw new Error(`dsh-remote-workstation: missing value for "${flag}"`)
    }
    parsed[flag.slice(2)] = value
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = args.host
  const workdir = args.workdir
  const command = args.command
  if (host === undefined || host === '') throw new Error('dsh-remote-workstation: --host is required')
  if (workdir === undefined || workdir === '') throw new Error('dsh-remote-workstation: --workdir is required')
  if (command === undefined) throw new Error('dsh-remote-workstation: --command is required')

  /** @type {MountTable | undefined} */
  let table
  const pool = new SshPool({
    connectTimeoutMs: 20000,
    resolveAuth: (alias) => table?.liveHost(alias) ?? Promise.resolve(undefined),
  })

  table = new MountTable({
    storePath: args.store,
    hostsPath: args['hosts-store'],
    sshHostsPath: args['ssh-hosts'],
    anchorRoot: args['anchor-root'],
    pool,
  })
  await table.ready()

  const client = await pool.client(host)
  /** @type {import('ssh2').ClientChannel} */
  const channel = await new Promise((resolve, reject) => {
    client.exec(`cd ${shellQuote(workdir)} && ${command}`, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })

  let finished = false
  /** @param {number} code */
  const finish = (code) => {
    if (finished) return
    finished = true
    pool.close()
    process.exit(code)
  }

  channel.on('error', () => {})
  channel.on('data', (chunk) => process.stdout.write(chunk))
  channel.stderr.on('error', () => {})
  channel.stderr.on('data', (chunk) => process.stderr.write(chunk))
  process.stdin.on('error', () => {})
  process.stdin.pipe(channel.stdin)
  channel.on('close', (code, signal) => finish(typeof code === 'number' ? code : signal === undefined ? 1 : 128))

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ]) {
    process.on(signal, () => {
      try {
        channel.close()
      } catch {}
      finish(code)
    })
  }
}

main().catch((error) => {
  process.stderr.write(`dsh-remote-workstation: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
