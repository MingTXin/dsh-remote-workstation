/**
 * Tests for the remote shell executors: routing, the escalation fence, and (when
 * an SSH host is available) a real command executed through `ctx.shell`.
 *
 * `DSH_RW_REMOTE_HOST=<alias>` enables the integration part; without it the
 * suite still covers routing and the sandbox fence with a fake base class.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

import { createRemoteShellExecutor } from '../lib/shell-remote-core.js'
import { RemotePwshExecutor } from '../lib/pwsh-remote.js'

const HOST = process.env.DSH_RW_REMOTE_HOST ?? ''
const skip = HOST ? false : 'set DSH_RW_REMOTE_HOST to an alias from ~/.dsh/dsh-ssh.json to run this test'

/**
 * Fake stock executor that records what the remote subclass decided.
 */
class FakeLocalExecutor {
  static decorateResult(execution, map) {
    return map(execution)
  }

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  get sandboxMode() {
    return 'danger-full-access'
  }

  async execute(spec) {
    return { where: 'local', command: spec.command, sandbox: { mode: this.sandboxMode, denied: false } }
  }

  async executeArgv(spec, argv) {
    return { where: 'remote', command: spec.command, argv }
  }
}

/**
 * Build a store file with one mount and return the paths the executor needs.
 * @returns {Promise<{ dir: string, storePath: string, anchorRoot: string, anchor: string, cleanup: () => Promise<void> }>}
 */
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-shell-'))
  const anchorRoot = path.join(dir, 'anchors')
  const anchor = path.join(anchorRoot, 'box', 'srv', 'app')
  await mkdir(anchor, { recursive: true })
  const storePath = path.join(dir, 'store.json')
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      hosts: [],
      mounts: [{ id: 'mount:box:/srv/app:1', host: 'box', remote: '/srv/app', anchor, createdAt: 1 }],
    }),
  )
  return {
    dir,
    storePath,
    anchorRoot,
    anchor,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test('a workdir inside a mount anchor is routed to the helper', async () => {
  const box = await fixture()
  try {
    const RemoteExecutor = createRemoteShellExecutor(FakeLocalExecutor)
    const ctx = { on() {} }
    const executor = new RemoteExecutor(ctx, {
      cwd: box.anchor,
      storePath: box.storePath,
      hostsPath: path.join(box.dir, 'hosts.json'),
      sshHostsPath: '',
      anchorRoot: box.anchorRoot,
    })
    const result = await executor.execute({
      command: 'uname -a',
      workdir: box.anchor,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: box.anchor },
    })
    assert.equal(result.where, 'remote')
    assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
    const argv = result.argv
    assert.equal(argv[0], process.execPath)
    assert.match(argv[1], /ssh-exec-helper\.mjs$/)
    assert.equal(argv[argv.indexOf('--host') + 1], 'box')
    assert.equal(argv[argv.indexOf('--workdir') + 1], '/srv/app')
    assert.equal(argv[argv.indexOf('--command') + 1], 'uname -a')
    assert.equal(argv[argv.indexOf('--store') + 1], box.storePath)
  } finally {
    await box.cleanup()
  }
})

test('a workdir outside every anchor keeps the local executor', async () => {
  const box = await fixture()
  try {
    const RemoteExecutor = createRemoteShellExecutor(FakeLocalExecutor)
    const executor = new RemoteExecutor({ on() {} }, {
      cwd: os.tmpdir(),
      storePath: box.storePath,
      hostsPath: path.join(box.dir, 'hosts.json'),
      sshHostsPath: '',
      anchorRoot: box.anchorRoot,
    })
    const result = await executor.execute({
      command: 'echo hi',
      workdir: os.tmpdir(),
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: os.tmpdir() },
    })
    assert.equal(result.where, 'local')
  } finally {
    await box.cleanup()
  }
})

test('a confined session cannot route a command to the remote host', async () => {
  const box = await fixture()
  try {
    const RemoteExecutor = createRemoteShellExecutor(FakeLocalExecutor)
    const executor = new RemoteExecutor({ on() {} }, {
      cwd: box.anchor,
      storePath: box.storePath,
      hostsPath: path.join(box.dir, 'hosts.json'),
      sshHostsPath: '',
      anchorRoot: box.anchorRoot,
    })
    await assert.rejects(
      () =>
        executor.execute({
          command: 'rm -rf /',
          workdir: box.anchor,
          sandboxPolicy: { mode: 'workspace-write', workspaceRoot: box.anchor },
        }),
      /cannot run "rm -rf \/" in .*cannot be confined by the host sandbox/,
    )
  } finally {
    await box.cleanup()
  }
})

test('ctx.shell runs an anchor command on the remote host', { skip }, async () => {
  const box = await fixture()
  const table = await import('../lib/mounts.js').then((module) => module.MountTable)
  const poolModule = await import('../lib/ssh/pool.js')
  const pool = new poolModule.SshPool()
  const mounts = new table({
    storePath: box.storePath,
    hostsPath: path.join(box.dir, 'hosts.json'),
    sshHostsPath: path.join(os.homedir(), '.dsh', 'dsh-ssh.json'),
    anchorRoot: box.anchorRoot,
    pool,
  })
  await mounts.ready()
  await mounts.addMount({ host: HOST, remote: '/tmp/dsh-remote-workspace-fixture' })
  const mounted = mounts.mounts().at(-1)
  const anchor = mounted.anchor
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalSandboxProvider)
    ctx.reflect.provide('sandboxPolicy', {
      defaultMode: 'danger-full-access',
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: anchor, writableRoots: [] }),
    })
    await ctx.plugin(RemotePwshExecutor, {
      storePath: box.storePath,
      hostsPath: path.join(box.dir, 'hosts.json'),
      sshHostsPath: path.join(os.homedir(), '.dsh', 'dsh-ssh.json'),
      anchorRoot: box.anchorRoot,
      cwd: anchor,
    })
    const shell = ctx.get('shell')
    assert.ok(shell, 'the remote executor provides the shell service')
    const spec = shell.resolve({
      command: 'uname -s && pwd',
      workdir: anchor,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: anchor },
    })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /^Linux\n\/tmp\/dsh-remote-workspace-fixture/m)
  } finally {
    await mounts.removeMount(HOST, '/tmp/dsh-remote-workspace-fixture')
    pool.close()
    ctx.fiber.dispose()
    await box.cleanup()
  }
})

