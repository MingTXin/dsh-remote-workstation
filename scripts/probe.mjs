/**
 * Manual transport probe: connect to a configured host and exercise the SFTP
 * primitives the provider relies on.
 *
 * Run with `npm run probe -- <alias> [path]`, where <alias> is a host in
 * `~/.dsh/dsh-ssh.json` (or set DSH_RW_REMOTE_HOST instead).
 */
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SshPool } from '../lib/ssh/pool.js'
import * as sftp from '../lib/ssh/sftp.js'

const alias = process.argv[2] ?? process.env.DSH_RW_REMOTE_HOST ?? ''
const remoteDir = process.argv[3] ?? process.env.DSH_RW_REMOTE_DIR ?? '/'
const storePath = path.join(os.homedir(), '.dsh', 'dsh-ssh.json')

if (!alias) {
  console.error('usage: npm run probe -- <alias> [remote-path]   (or set DSH_RW_REMOTE_HOST)')
  console.error(`hosts are read from ${storePath}`)
  process.exit(1)
}

const store = JSON.parse(await readFile(storePath, 'utf8'))
const host = store.hosts.find((entry) => entry.alias === alias)
if (!host) {
  console.error(`no host "${alias}" in ${storePath}`)
  process.exit(1)
}

const pool = new SshPool({ connectTimeoutMs: 15000 })
pool.setHosts([host])

const started = Date.now()
const session = await pool.sftp(alias)
console.log(`connected to ${alias} in ${Date.now() - started} ms`)

const attrs = await sftp.stat(session, remoteDir)
console.log('stat:', remoteDir, '->', attrs ? { mode: attrs.mode?.toString(8), size: attrs.size, mtime: attrs.mtime } : null)

const entries = await sftp.readdir(session, remoteDir)
console.log(`readdir: ${entries.length} entries`)
for (const entry of entries.slice(0, 8)) {
  console.log(`  ${sftp.entryType(entry.attrs).padEnd(9)} ${String(entry.attrs.size).padStart(9)} ${entry.name}`)
}

const firstFile = entries.find((entry) => sftp.isFile(entry.attrs) && entry.attrs.size > 0 && entry.attrs.size < 64 * 1024)
if (firstFile) {
  const filePath = `${remoteDir.replace(/\/$/, '')}/${firstFile.name}`
  const raw = await sftp.readFile(session, filePath)
  console.log(`readFile: ${filePath} (${raw.length} bytes) head=${JSON.stringify(raw.subarray(0, 60).toString('utf8'))}`)

  const window = []
  const stream = sftp.createReadStream(session, filePath, { start: 0, end: 40 })
  for await (const chunk of stream) window.push(chunk)
  console.log(`readByteRange [0,40]: ${Buffer.concat(window).length} bytes`)
}

const missing = await sftp.stat(session, `${remoteDir}/definitely-not-here-${Date.now()}`)
console.log('missing stat ->', missing)

pool.close()
console.log('done')
