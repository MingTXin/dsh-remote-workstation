/**
 * End-to-end test of the provider through a real Cordis context.
 *
 * Requires a reachable SSH host: set DSH_RW_REMOTE_HOST to a host alias from
 * `~/.dsh/dsh-ssh.json` and (optionally) DSH_RW_REMOTE_DIR to a directory that
 * contains these fixture files, created with:
 *
 *   mkdir -p $DIR/sub
 *   printf 'hello from the remote host\nsecond line\n' > $DIR/hello.txt
 *   printf '# notes\n\n- item one\n- item two\n' > $DIR/sub/notes.md
 *   head -c 64 /dev/urandom > $DIR/binary.bin
 *
 * Without the environment variable the suite is skipped, so `npm test` stays
 * offline.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { RemoteWorkspaceFileSystem } from '../lib/index.js'

const HOST = process.env.DSH_RW_REMOTE_HOST
const REMOTE = process.env.DSH_RW_REMOTE_DIR ?? '/tmp/dsh-remote-workspace-fixture'
const SSH_STORE = path.join(os.homedir(), '.dsh', 'dsh-ssh.json')
const skip = HOST ? false : 'set DSH_RW_REMOTE_HOST to run the SSH-backed tests'

test('ctx.fs serves a mounted remote directory read-only', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-remote-'))
  const ctx = new Context()
  ctx.reflect.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access', writableRoots: [dir] }),
  })
  try {
    await ctx.plugin(RemoteWorkspaceFileSystem, {
      storePath: path.join(dir, 'store.json'),
      sshHostsPath: SSH_STORE,
      anchorRoot: path.join(dir, 'anchors'),
      connectTimeoutMs: 20000,
    })
    const fs = ctx.fs
    assert.ok(fs, 'the provider registers ctx.fs')

    // --- anchor set-up -----------------------------------------------------
    const mount = await fs.addMount(HOST, REMOTE)
    assert.equal(mount.remote, REMOTE)
    assert.ok(mount.anchor.startsWith(path.join(dir, 'anchors')), mount.anchor)
    assert.equal((await fs.listMounts()).length, 1)

    // --- resolve: anchor path -> remote coordinates ------------------------
    const anchorTarget = await fs.resolve(mount.anchor)
    assert.equal(anchorTarget.displayPath, REMOTE)
    assert.ok(anchorTarget.targetKey.startsWith(`rw://${HOST}/`))

    // --- listDir -----------------------------------------------------------
    const entries = await fs.listDir(anchorTarget)
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    for (const name of ['hello.txt', 'sub', 'binary.bin', 'big.txt']) {
      assert.ok(byName.has(name), `listDir exposes ${name}: ${entries.map((e) => e.name).join(', ')}`)
    }
    assert.equal(byName.get('sub').type, 'directory')
    assert.equal(byName.get('hello.txt').type, 'file')
    assert.equal(byName.get('hello.txt').size, 39)
    assert.ok(byName.get('hello.txt').target.targetKey.startsWith(`rw://${HOST}/`))

    // --- readText through the anchor path ---------------------------------
    const helloPath = path.join(mount.anchor, 'hello.txt')
    const hello = await fs.resolve(helloPath)
    assert.equal(await fs.readText(hello), 'hello from the remote host\nsecond line\n')

    // relative resolve against a cwd works too
    const relative = await fs.resolve('hello.txt', { cwd: mount.anchor })
    assert.equal(relative.targetKey, hello.targetKey)

    // stat
    const info = await fs.stat(hello)
    assert.equal(info.type, 'file')
    assert.equal(info.size, 39)
    assert.ok(info.version)

    // --- byte access -------------------------------------------------------
    assert.equal(Buffer.from(await fs.readByteRange(hello, { offset: 0, length: 5 })).toString('utf8'), 'hello')
    const bytes = await fs.readBytes(hello, undefined, 4096)
    assert.equal(bytes.length, 39)
    await assert.rejects(fs.readBytes(hello, undefined, 10), /exceeds the 10-byte limit/)

    // --- streaming ---------------------------------------------------------
    const chunks = []
    for await (const chunk of fs.streamText(hello)) chunks.push(chunk)
    assert.equal(chunks.join(''), 'hello from the remote host\nsecond line\n')

    // --- error mapping -----------------------------------------------------
    const binary = await fs.resolve(path.join(mount.anchor, 'binary.bin'))
    await assert.rejects(fs.readText(binary), (error) => error.code === 'FS_NOT_TEXT' && /binary file|not valid UTF-8/.test(error.message))

    const missing = await fs.resolve(path.join(mount.anchor, 'definitely-missing.txt'))
    await assert.rejects(fs.readText(missing), (error) => error.code === 'FS_NOT_FOUND' && /no such file or directory/.test(error.message))
    assert.equal(await fs.stat(missing), undefined)

    await assert.rejects(fs.listDir(hello), (error) => error.code === 'FS_NOT_DIRECTORY' && /not a directory/.test(error.message))

    // --- read-only gate ----------------------------------------------------
    await assert.rejects(
      fs.writeText(hello, 'nope'),
      (error) => error.code === 'FS_SANDBOX_DENIED' && /read-only in this build/.test(error.message),
    )
    await assert.rejects(
      fs.editText(hello, { oldString: 'hello', newString: 'bye' }),
      (error) => error.code === 'FS_SANDBOX_DENIED' && /read-only in this build/.test(error.message),
    )

    // --- namespace helpers -------------------------------------------------
    const processed = fs.processPath(hello)
    assert.equal(path.resolve(processed), path.resolve(helloPath))
    assert.equal(fs.processPathFromHostPath(helloPath), `${REMOTE}/hello.txt`)
    assert.equal(fs.fileUrl(hello), `file://${HOST}${REMOTE}/hello.txt`)
    assert.equal(fs.contains(anchorTarget, hello), true)
    assert.equal(fs.contains(hello, anchorTarget), false)

    // remote-namespace resolve works without an anchor
    const remoteTarget = await fs.resolve(`${REMOTE}/sub/notes.md`)
    assert.equal(remoteTarget.displayPath, `${REMOTE}/sub/notes.md`)
    assert.match(await fs.readText(remoteTarget), /# notes/)

    // --- unmounted local paths keep the local backend ----------------------
    const localFile = path.join(dir, 'local.txt')
    await writeFile(localFile, 'still local\n', 'utf8')
    const localTarget = await fs.resolve(localFile)
    assert.equal(localTarget.displayPath, localFile)
    assert.equal(await fs.readText(localTarget), 'still local\n')

    // --- unmounts ----------------------------------------------------------
    assert.equal(await fs.removeMount(mount.id), true)
    assert.equal((await fs.listMounts()).length, 0)
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the remote fixture is intact', { skip }, async () => {
  assert.ok(SSH_STORE, 'dsh-ssh store')
  const raw = await readFile(SSH_STORE, 'utf8')
  assert.match(raw, /"hosts"/)
})
