import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MountTable } from '../lib/mounts.js'

/** Minimal pool stand-in: records the host list it was given. */
class FakePool {
  constructor() {
    this.hosts = []
  }

  setHosts(hosts) {
    this.hosts = hosts
  }
}

/**
 * @param {object} [options]
 * @returns {Promise<{ dir: string, storePath: string, hostsPath: string, sshHostsPath: string, table: MountTable, pool: FakePool }>}
 */
async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-mounts-'))
  const storePath = path.join(dir, 'store.json')
  const hostsPath = path.join(dir, 'hosts.json')
  const sshHostsPath = path.join(dir, 'ssh.json')
  await writeFile(sshHostsPath, JSON.stringify({
    version: 1,
    hosts: [
      { alias: 'box', host: '10.0.0.5', port: 22, user: 'root', auth: { kind: 'password', password: 'secret' } },
      { alias: 'other', host: '10.0.0.6', port: 2200, user: 'me', auth: { kind: 'key', keyPath: 'C:\\keys\\id' } },
    ],
  }), 'utf8')
  const pool = new FakePool()
  const table = new MountTable({
    storePath,
    hostsPath,
    sshHostsPath,
    anchorRoot: path.join(dir, 'anchors'),
    staticMounts: options.staticMounts ?? [],
    pool,
  })
  await table.ready()
  return { dir, storePath, hostsPath, sshHostsPath, table, pool }
}

test('first run seeds hosts from the dsh-ssh store and persists an empty store', async () => {
  const { dir, storePath, table, pool } = await fixture()
  try {
    const hosts = table.hosts()
    assert.deepEqual(hosts.map((host) => host.alias).sort(), ['box', 'other'])
    assert.equal(pool.hosts.length, 2)
    const persisted = JSON.parse(await readFile(storePath, 'utf8'))
    assert.equal(persisted.mounts.length, 0)
    assert.equal(persisted.hosts.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('addMount creates the anchor, persists, and maps both directions', async () => {
  const { dir, storePath, table } = await fixture()
  try {
    const mount = await table.addMount({ host: 'box', remote: '/srv/app' })
    assert.equal(mount.remote, '/srv/app')
    assert.ok(mount.anchor.startsWith(path.join(dir, 'anchors')))
    assert.deepEqual(table.mounts().map((entry) => entry.id), [mount.id])

    const persisted = JSON.parse(await readFile(storePath, 'utf8'))
    assert.equal(persisted.mounts.length, 1)

    const child = path.join(mount.anchor, 'src', 'a.ts')
    const remote = table.toRemote(child)
    assert.ok(remote)
    assert.equal(remote.remotePath, '/srv/app/src/a.ts')

    const back = table.toHost('box', '/srv/app/src/a.ts')
    assert.ok(back)
    assert.equal(path.resolve(back.hostPath), path.resolve(child))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the longest matching mount wins and non-anchor paths do not match', async () => {
  const { dir, table } = await fixture()
  try {
    const outer = await table.addMount({ host: 'box', remote: '/srv' })
    const inner = await table.addMount({ host: 'box', remote: '/srv/app' })
    const insideInner = path.join(inner.anchor, 'x.ts')
    assert.equal(table.matchLocal(insideInner)?.id, inner.id)
    assert.equal(table.matchLocal(path.join(outer.anchor, 'readme.md'))?.id, outer.id)
    assert.equal(table.matchLocal(path.join(dir, 'elsewhere')), undefined)
    assert.equal(table.matchRemote('/srv/app/x.ts')?.id, inner.id)
    assert.equal(table.matchRemote('/srv/other/x.ts')?.id, outer.id)
    assert.equal(table.matchRemote('/var/log'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('removeMount forgets the mount but keeps the store valid', async () => {
  const { dir, table, storePath } = await fixture()
  try {
    const mount = await table.addMount({ host: 'box', remote: '/srv/app' })
    assert.equal(await table.removeMount(mount.id), true)
    assert.equal(table.mounts().length, 0)
    assert.equal(await table.removeMount(mount.id), false)
    const persisted = JSON.parse(await readFile(storePath, 'utf8'))
    assert.equal(persisted.mounts.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('static mounts are merged without touching the store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-static-'))
  try {
    const { table } = await fixture({
      staticMounts: [{ host: 'box', remote: '/srv/static', anchor: path.join(dir, 'anchor') }],
    })
    const mounts = table.mounts()
    assert.equal(mounts.length, 1)
    assert.equal(mounts[0].remote, '/srv/static')
    assert.equal(table.matchLocal(path.join(dir, 'anchor', 'a.ts'))?.remote, '/srv/static')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('refresh picks up external store edits', async () => {
  const { dir, table, storePath } = await fixture()
  try {
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    store.mounts.push({ id: 'external', host: 'box', remote: '/external', anchor: path.join(dir, 'anchors', 'external'), createdAt: 1 })
    await writeFile(storePath, JSON.stringify(store), 'utf8')
    await table.refresh()
    assert.ok(table.mounts().some((mount) => mount.id === 'external'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('credentials are resolved live from the ssh host store', async () => {
  const { dir, table, sshHostsPath } = await fixture()
  try {
    // The persisted store keeps identities only; the password never lands there.
    const persisted = JSON.parse(await readFile(table.storePath, 'utf8'))
    assert.equal(persisted.hosts.find((host) => host.alias === 'box').auth, undefined)
    const live = await table.liveHost('box')
    assert.equal(live?.auth?.password, 'secret')
    assert.equal((await table.liveHost('missing')), undefined)
    assert.ok(sshHostsPath.endsWith('ssh.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('refresh reloads when the ssh host store changes', async () => {
  const { dir, table, pool, sshHostsPath } = await fixture()
  try {
    assert.equal(pool.hosts.find((host) => host.alias === 'box').auth.password, 'secret')
    await writeFile(sshHostsPath, JSON.stringify({
      version: 1,
      hosts: [{ alias: 'box', host: '10.0.0.5', port: 22, user: 'root', auth: { kind: 'password', password: 'rotated' } }],
    }), 'utf8')
    await table.refresh()
    assert.equal(pool.hosts.find((host) => host.alias === 'box').auth.password, 'rotated')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the plugin host store is self-sufficient: save, resolve live, remove', async () => {
  const { dir, hostsPath, table, pool } = await fixture()
  try {
    await table.saveHost({ alias: 'private', host: '192.0.2.10', port: 2222, user: 'dev', authKind: 'password', password: 'pw' })
    const own = JSON.parse(await readFile(hostsPath, 'utf8'))
    assert.equal(own.hosts.length, 1)
    assert.equal(own.hosts[0].auth.password, 'pw')
    // The mount store still keeps identities only.
    const persisted = JSON.parse(await readFile(table.storePath, 'utf8'))
    assert.equal(persisted.hosts.find((host) => host.alias === 'private').auth, undefined)
    // Live credentials and the pool view both see the new host.
    assert.equal((await table.liveHost('private'))?.auth?.password, 'pw')
    assert.equal(pool.hosts.find((host) => host.alias === 'private').auth.password, 'pw')
    assert.equal(table.hosts().find((host) => host.alias === 'private').source, 'plugin')
    assert.equal(table.hosts().find((host) => host.alias === 'box').source, 'dsh-ssh')
    // Remove works and reloads.
    assert.equal(await table.removeHost('private'), true)
    assert.equal(await table.removeHost('private'), false)
    assert.equal((await table.liveHost('private')), undefined)
    assert.equal(table.hosts().some((host) => host.alias === 'private'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the plugin host store wins over the dsh-ssh import for the same alias', async () => {
  const { dir, table, pool } = await fixture()
  try {
    await table.saveHost({ alias: 'box', host: '10.0.0.9', port: 22, user: 'root', authKind: 'password', password: 'own' })
    assert.equal((await table.liveHost('box'))?.auth?.password, 'own')
    assert.equal(table.hosts().find((host) => host.alias === 'box').host, '10.0.0.9')
    assert.equal(pool.hosts.find((host) => host.alias === 'box').auth.password, 'own')
    assert.equal(table.hosts().find((host) => host.alias === 'box').source, 'plugin')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveHost validates input and supports key authentication', async () => {
  const { dir, table } = await fixture()
  try {
    await assert.rejects(() => table.saveHost({ host: '192.0.2.1' }), /needs an alias/)
    await assert.rejects(() => table.saveHost({ alias: 'x' }), /needs an address/)
    await assert.rejects(() => table.saveHost({ alias: 'x', host: 'h', port: 70000 }), /port must be an integer/)
    await assert.rejects(() => table.saveHost({ alias: 'x', host: 'h', authKind: 'password' }), /needs a password/)
    await assert.rejects(() => table.saveHost({ alias: 'x', host: 'h', authKind: 'key' }), /needs a private key path/)
    const saved = await table.saveHost({ alias: 'keyed', host: '192.0.2.2', authKind: 'key', keyPath: '~/.ssh/id_ed25519', passphrase: 'pp' })
    assert.equal(saved.auth.kind, 'key')
    assert.ok(saved.auth.keyPath.includes('.ssh'))
    assert.equal((await table.liveHost('keyed'))?.auth?.passphrase, 'pp')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
