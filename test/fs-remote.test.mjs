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
import * as sftpOps from '../lib/ssh/sftp.js'

const HOST = process.env.DSH_RW_REMOTE_HOST
const REMOTE = process.env.DSH_RW_REMOTE_DIR ?? '/tmp/dsh-remote-workspace-fixture'
const SSH_STORE = path.join(os.homedir(), '.dsh', 'dsh-ssh.json')
const skip = HOST ? false : 'set DSH_RW_REMOTE_HOST to run the SSH-backed tests'

/** Delete the scratch files through the provider's pooled connection. */
async function removeScratch(fs, ...names) {
  try {
    await fs.remoteState.pool.withSftp(HOST, async (session) => {
      for (const name of names) {
        try {
          await sftpOps.unlink(session, `${REMOTE}/${name}`)
        } catch {
          /* already gone */
        }
      }
    })
  } catch {
    /* the remote is unreachable: leave the scratch files for the next run */
  }
}

test('ctx.fs serves a mounted remote directory the way the local backend does', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-remote-'))
  const suffix = `${process.pid}-${Date.now()}`
  const scratchCreated = `scratch-created-${suffix}.txt`
  const scratchMulti = `scratch-multi-${suffix}.txt`
  const scratchWatch = `scratch-watch-${suffix}.txt`
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
      watchIntervalMs: 300,
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

    // --- watch: polling replaces the SFTP change feed ----------------------
    const watchPath = path.join(mount.anchor, scratchWatch)
    const watchTarget = await fs.resolve(watchPath)
    await fs.writeText(watchTarget, 'watching\n')
    let fired = 0
    const abort = new AbortController()
    const close = await fs.watch(watchTarget, () => {
      fired += 1
    }, abort.signal)
    try {
      const base = await fs.stat(watchTarget)
      await fs.writeText(watchTarget, 'watching changes\n', { kind: 'replaceIfVersion', version: base.version })
      const deadline = Date.now() + 5000
      while (fired === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(fired > 0, 'watch() reports the remote change')
      // closing is asynchronous and idempotent
      await close()
      await close()
      const settled = fired
      await fs.writeText(watchTarget, 'after close\n')
      await new Promise((resolve) => setTimeout(resolve, 700))
      assert.equal(fired, settled, 'no callbacks after close()')
    } finally {
      abort.abort()
      await close()
    }

    // --- writes: create / update / intent guards ---------------------------
    const createdTarget = await fs.resolve(path.join(mount.anchor, scratchCreated))
    const createOne = await fs.writeText(createdTarget, 'first line\n', { kind: 'createIfAbsent' })
    assert.equal(createOne.operation, 'create')
    assert.equal(await fs.readText(createdTarget), 'first line\n')
    await assert.rejects(
      fs.writeText(createdTarget, 'nope\n', { kind: 'createIfAbsent' }),
      (error) => error.code === 'FS_NOT_OBSERVED' && /without reading it first/.test(error.message),
    )

    const replaced = await fs.writeText(hello, 'hello from the remote host\nsecond line\n', { kind: 'replaceIfVersion', version: info.version })
    assert.equal(replaced.operation, 'update')
    await assert.rejects(
      fs.writeText(hello, 'stale\n', { kind: 'replaceIfVersion', version: info.version }),
      (error) => error.code === 'FS_STALE_VERSION' && /changed since it was read/.test(error.message),
    )

    // --- edits: literal, ambiguous, all, not-found -------------------------
    const editBase = await fs.stat(hello)
    const edited = await fs.editText(hello, { oldString: 'second line', newString: 'second line, edited' }, { version: editBase.version })
    assert.equal(edited.after, 'hello from the remote host\nsecond line, edited\n')
    assert.equal(await fs.readText(hello), 'hello from the remote host\nsecond line, edited\n')
    await assert.rejects(
      fs.editText(hello, { oldString: 'not there', newString: 'x' }, { version: edited.version }),
      (error) => error.code === 'FS_EDIT_NOT_FOUND',
    )

    const multiTarget = await fs.resolve(path.join(mount.anchor, scratchMulti))
    await fs.writeText(multiTarget, 'a\na\na\n')
    const multiInfo = await fs.stat(multiTarget)
    await assert.rejects(
      fs.editText(multiTarget, { oldString: 'a', newString: 'b' }, { version: multiInfo.version }),
      (error) => error.code === 'FS_AMBIGUOUS_EDIT',
    )
    const allEdited = await fs.editText(multiTarget, { oldString: 'a', newString: 'b', replaceAll: true }, { version: multiInfo.version })
    assert.equal(allEdited.after, 'b\nb\nb\n')

    // put the fixture back the way it was
    const restoreBase = await fs.stat(hello)
    await fs.editText(hello, { oldString: 'second line, edited', newString: 'second line' }, { version: restoreBase.version })
    assert.equal(await fs.readText(hello), 'hello from the remote host\nsecond line\n')

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

    // --- remote scratch files back out ------------------------------------
    await removeScratch(fs, scratchCreated, scratchMulti, scratchWatch)
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remoteReadOnly: true still fences every remote mutation', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-remote-ro-'))
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
      remoteReadOnly: true,
    })
    const fs = ctx.fs
    const mount = await fs.addMount(HOST, REMOTE)
    const hello = await fs.resolve(path.join(mount.anchor, 'hello.txt'))
    await assert.rejects(
      fs.writeText(hello, 'nope'),
      (error) => error.code === 'FS_SANDBOX_DENIED' && /read-only in this build/.test(error.message),
    )
    await assert.rejects(
      fs.editText(hello, { oldString: 'hello', newString: 'bye' }),
      (error) => error.code === 'FS_SANDBOX_DENIED' && /read-only in this build/.test(error.message),
    )
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
