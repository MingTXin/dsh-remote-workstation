import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeTargetKey,
  encodeTargetKey,
  hostContains,
  hostRelative,
  isRemoteAbsolute,
  joinRemote,
  normalizeRemote,
  remoteContains,
  remoteRelative,
} from '../lib/paths.js'

test('encode/decode target keys', () => {
  const key = encodeTargetKey('box', '/srv/app/main.ts')
  assert.equal(key, 'rw://box/srv/app/main.ts')
  assert.deepEqual(decodeTargetKey(key), { hostRef: 'box', remotePath: '/srv/app/main.ts' })
  assert.equal(decodeTargetKey('C:\\local\\file.ts'), null)
  assert.equal(decodeTargetKey('rw://box'), null)
})

test('normalizeRemote collapses and anchors paths', () => {
  assert.equal(normalizeRemote('/srv/app/../app/./x/'), '/srv/app/x')
  assert.equal(normalizeRemote('srv//app'), '/srv/app')
  assert.equal(normalizeRemote('..'), '/')
  assert.equal(normalizeRemote('/'), '/')
  assert.equal(normalizeRemote('/a/../../etc'), '/etc')
})

test('joinRemote keeps root semantics', () => {
  assert.equal(joinRemote('/srv/app', 'src/a.ts'), '/srv/app/src/a.ts')
  assert.equal(joinRemote('/', 'etc'), '/etc')
  assert.equal(joinRemote('/srv/app', ''), '/srv/app')
  assert.equal(joinRemote('/srv/app', '.'), '/srv/app')
})

test('remoteContains is segment-aware', () => {
  assert.equal(remoteContains('/srv/app', '/srv/app'), true)
  assert.equal(remoteContains('/srv/app', '/srv/app/src/a.ts'), true)
  assert.equal(remoteContains('/srv/app', '/srv/application'), false)
  assert.equal(remoteContains('/', '/etc'), true)
})

test('remoteRelative', () => {
  assert.equal(remoteRelative('/srv/app', '/srv/app/src/a.ts'), 'src/a.ts')
  assert.equal(remoteRelative('/srv/app', '/srv/app'), '')
})

test('isRemoteAbsolute distinguishes namespaces', () => {
  assert.equal(isRemoteAbsolute('/root/x'), true)
  assert.equal(isRemoteAbsolute('C:\\root\\x'), false)
  assert.equal(isRemoteAbsolute('\\\\server\\share'), false)
  assert.equal(isRemoteAbsolute('relative/path'), false)
})

test('hostContains/hostRelative use host semantics', () => {
  const root = process.platform === 'win32' ? 'C:\\ws\\anchor' : '/ws/anchor'
  const child = process.platform === 'win32' ? 'C:\\ws\\anchor\\src\\a.ts' : '/ws/anchor/src/a.ts'
  const outside = process.platform === 'win32' ? 'C:\\ws\\anchor2\\a.ts' : '/ws/anchor2/a.ts'
  assert.equal(hostContains(root, root), true)
  assert.equal(hostContains(root, child), true)
  assert.equal(hostContains(root, outside), false)
  assert.equal(hostRelative(root, child), 'src/a.ts')
})
