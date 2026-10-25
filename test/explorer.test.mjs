import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { API_PREFIX } from '../lib/explorer.js'

const HOST = process.env.DSH_RW_REMOTE_HOST ?? ''
const FIXTURE = process.env.DSH_RW_REMOTE_FIXTURE ?? '/tmp/dsh-remote-workspace-fixture'
const skip = HOST ? false : 'set DSH_RW_REMOTE_HOST to an alias from ~/.dsh/dsh-ssh.json to run this test'
const storeDir = path.join(os.tmpdir(), 'dsh-rw-explorer-test')
const storePath = path.join(storeDir, 'mounts.json')

/** @returns {{ status: number, body: any }} */
async function request(routes, action, body = {}) {
  const route = routes.find((entry) => entry.path === API_PREFIX)
  assert.ok(route, 'the explorer registered its prefix route')
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = `${API_PREFIX}/${action}`
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
  await route.handler(req, res)
  return { status: res.status, body: JSON.parse(res.body) }
}

test('the explorer API browses and mounts a remote directory', { skip }, async () => {
  rmSync(storeDir, { recursive: true, force: true })
  const routes = []
  const ctx = new Context()
  ctx.reflect.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  })
  ctx.reflect.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access', writableRoots: [] }),
  })
  await ctx.plugin(plugin, {
    storePath,
    hostsPath: path.join(storeDir, 'hosts.json'),
    sshHostsPath: path.join(os.homedir(), '.dsh', 'dsh-ssh.json'),
    remoteReadOnly: true,
    connectTimeoutMs: 15000,
  })

  try {
    const ping = await request(routes, 'ping')
    assert.equal(ping.body.ok, true)
    assert.equal(ping.body.value.service, 'remote-workspace')

    const hosts = await request(routes, 'hosts')
    assert.equal(hosts.body.ok, true, hosts.body.error?.message)
    const alias = hosts.body.value.find((entry) => entry.alias === HOST)
    assert.ok(alias, `host ${HOST} is configured`)
    assert.equal(alias.host, HOST)
    assert.equal(alias.password, undefined, 'credentials never leave the host')

    const saved = await request(routes, 'hostSave', {
      alias: 'localbox',
      host: '192.0.2.55',
      port: 2222,
      user: 'dev',
      authKind: 'password',
      password: 'pw',
    })
    assert.equal(saved.body.ok, true, saved.body.error?.message)
    assert.equal(saved.body.value.host.source, 'plugin')
    const afterSave = await request(routes, 'hosts')
    assert.ok(afterSave.body.value.some((entry) => entry.alias === 'localbox' && entry.source === 'plugin'))
    assert.equal(afterSave.body.value.find((entry) => entry.alias === HOST).source, 'dsh-ssh')
    assert.equal(afterSave.body.value.find((entry) => entry.alias === 'localbox').password, undefined)

    const badSave = await request(routes, 'hostSave', { alias: 'x', host: 'h', authKind: 'password' })
    assert.equal(badSave.body.ok, false)
    assert.match(badSave.body.error.message, /needs a password/)

    const removedHost = await request(routes, 'hostRemove', { alias: 'localbox' })
    assert.equal(removedHost.body.ok, true, removedHost.body.error?.message)
    assert.equal(removedHost.body.value.removed, true)
    assert.equal(removedHost.body.value.hosts.some((entry) => entry.alias === 'localbox'), false)
    const removeMissing = await request(routes, 'hostRemove', { alias: 'localbox' })
    assert.equal(removeMissing.body.ok, false)

    const home = await request(routes, 'home', { host: HOST })
    assert.equal(home.body.ok, true, home.body.error?.message)
    assert.match(home.body.value.path, /^\//)

    const listed = await request(routes, 'list', { host: HOST, path: FIXTURE })
    assert.equal(listed.body.ok, true, listed.body.error?.message)
    assert.equal(listed.body.value.path, FIXTURE)
    assert.equal(listed.body.value.parent, '/tmp')
    const names = listed.body.value.entries.map((entry) => entry.name)
    assert.ok(names.includes('hello.txt'), `fixture listing contains hello.txt: ${names.join(',')}`)
    assert.equal(listed.body.value.entries[0].type, 'directory', 'directories sort first')

    const read = await request(routes, 'read', { host: HOST, path: `${FIXTURE}/hello.txt` })
    assert.equal(read.body.ok, true, read.body.error?.message)
    assert.equal(read.body.value.bytes, 39)
    assert.match(read.body.value.head, /^hello from the remote host/)
    assert.match(read.body.value.targetKey, /^rw:\/\//, 'content came from the remote namespace')

    const missing = await request(routes, 'list', { host: HOST, path: `${FIXTURE}/nope` })
    assert.equal(missing.body.ok, false)
    assert.match(missing.body.error.message, /no such directory/)

    const mounted = await request(routes, 'mount', { host: HOST, path: FIXTURE })
    assert.equal(mounted.body.ok, true, mounted.body.error?.message)
    const mount = mounted.body.value.mount
    assert.equal(mount.remote, FIXTURE)
    assert.ok(existsSync(mount.anchor), 'the anchor directory exists on the host')
    assert.ok(existsSync(storePath), 'the mount store was written')

    const mounts = await request(routes, 'mounts')
    assert.equal(mounts.body.value.length, 1)

    const removed = await request(routes, 'unmount', { id: mount.id })
    assert.deepEqual(removed.body.value, { removed: true })
    assert.equal((await request(routes, 'mounts')).body.value.length, 0)

    const unknown = await request(routes, 'list', { host: 'no-such-host', path: '/' })
    assert.equal(unknown.body.ok, false)
    assert.match(unknown.body.error.message, /unknown host/)
  } finally {
    await ctx.fiber.dispose()
    rmSync(storeDir, { recursive: true, force: true })
  }
})

