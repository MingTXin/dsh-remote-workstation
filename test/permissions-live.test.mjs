/**
 * Live test of the permission gate on the real remote tools (SSH required).
 *
 * Verifies the contract the plugin promises for DSH permission presets:
 *   - danger-full-access      → remote commands run without asking
 *   - workspace-write         → remote commands are refused until the model
 *                               escalates, and the escalation goes through
 *                               ctx.approval (allow-once / reject / unavailable)
 *   - read-only               → read-only work (search, git status) still runs
 *
 * Set DSH_RW_REMOTE_HOST to an alias from `~/.dsh/dsh-ssh.json` to enable the
 * suite; otherwise it is skipped and `npm test` stays offline.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'

const HOST = process.env.DSH_RW_REMOTE_HOST
const REMOTE = process.env.DSH_RW_REMOTE_DIR ?? '/tmp/dsh-remote-workspace-fixture'
const skip = HOST ? false : 'set DSH_RW_REMOTE_HOST to run the SSH-backed tests'

/**
 * Boot the plugin in a real Cordis context with stub policy/approval/tools
 * services, and return the model-facing tools it registered.
 */
async function boot(dir, { mode, outcome }) {
  const ctx = new Context()
  let currentMode = mode
  const asked = []
  ctx.reflect.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: currentMode, writableRoots: [dir] }),
  })
  ctx.reflect.provide('approval', {
    request: async (request) => {
      asked.push(request)
      return outcome
    },
  })
  const tools = new Map()
  ctx.reflect.provide('tools', {
    register: (tool) => {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  })
  ctx.reflect.provide('webServer', { register: () => () => {} })
  await ctx.plugin(apply, {
    storePath: path.join(dir, 'store.json'),
    hostsPath: path.join(dir, 'hosts.json'),
    sshHostsPath: path.join(os.homedir(), '.dsh', 'dsh-ssh.json'),
    anchorRoot: path.join(dir, 'anchors'),
    connectTimeoutMs: 20000,
    watchIntervalMs: 500,
    remoteReadOnly: false,
  })
  await ctx.ready?.()
  return {
    ctx,
    tools,
    asked,
    setMode: (next) => {
      currentMode = next
    },
  }
}

/** The tool-execution shape the gate reads. */
function exec(callId) {
  return { callId, signal: new AbortController().signal, agent: { session: { id: 'session-test' } } }
}

test('permission presets gate the remote tools', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-perms-'))
  const session = await boot(dir, { mode: 'danger-full-access', outcome: 'allowed-once' })
  try {
    const execTool = session.tools.get('remote_exec')
    const searchTool = session.tools.get('remote_search')
    const gitTool = session.tools.get('remote_git')
    assert.ok(execTool && searchTool && gitTool, 'the plugin registered its three tools')

    // 1. danger-full-access: real command, no approval prompt.
    const direct = await execTool.execute({ host: HOST, command: 'echo danger-ok' }, exec('c1'))
    assert.equal(direct.exitCode, 0)
    assert.match(direct.stdout, /danger-ok/)
    assert.equal(session.asked.length, 0)

    // 2. workspace-write without escalation: refused with actionable wording.
    session.setMode('workspace-write')
    await assert.rejects(
      execTool.execute({ host: HOST, command: 'echo should-not-run' }, exec('c2')),
      /is blocked: this session runs in "workspace-write" mode/,
    )

    // 3. workspace-write + escalation allowed once: the command really runs.
    const escalated = await execTool.execute({
      host: HOST,
      command: 'echo escalated-ok',
      sandbox_permissions: 'danger-full-access',
      justification: 'verify the escalation path',
    }, exec('c3'))
    assert.equal(escalated.exitCode, 0)
    assert.match(escalated.stdout, /escalated-ok/)
    assert.equal(session.asked.length, 1)
    assert.match(session.asked[0].reason, /escalate sandbox to danger-full-access: verify the escalation path/)

    // 4. read-only git and search still work in workspace-write.
    const status = await gitTool.execute({ host: HOST, path: REMOTE, command: 'status' }, exec('c4'))
    assert.equal(status.command, 'git status')
    assert.ok(Number.isInteger(status.exitCode), 'git status ran on the remote host')
    const found = await searchTool.execute({ host: HOST, path: REMOTE, pattern: 'second line' }, exec('c5'))
    assert.ok(found.count >= 1)

    // 5. a mutating git command is gated the same way as remote_exec.
    await assert.rejects(
      gitTool.execute({ host: HOST, path: REMOTE, command: 'stash' }, exec('c6')),
      /remote_git on .*is blocked/,
    )

    // 6. read-only mode refuses everything mutating, even a search-free command.
    session.setMode('read-only')
    await assert.rejects(
      execTool.execute({ host: HOST, command: 'echo read-only' }, exec('c7')),
      /"read-only" mode/,
    )
  } finally {
    await session.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rejecting approval user keeps the gate closed', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-perms-deny-'))
  const session = await boot(dir, { mode: 'workspace-write', outcome: 'rejected' })
  try {
    const execTool = session.tools.get('remote_exec')
    await assert.rejects(
      execTool.execute({
        host: HOST,
        command: 'echo should-not-run',
        sandbox_permissions: 'danger-full-access',
        justification: 'the user said no',
      }, exec('d1')),
      /the user rejected escalating this command to "danger-full-access"/,
    )
    assert.equal(session.asked.length, 1)
  } finally {
    await session.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
