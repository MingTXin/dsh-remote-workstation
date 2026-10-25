/**
 * Unit tests for the sandbox/approval gate that mutating remote tools pass
 * through (no SSH, no host: the policy and the approval service are stubs).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeRemoteOperation, isMutatingGitRequest } from '../lib/permissions.js'

const CALL = {
  toolName: 'remote_exec',
  subject: 'command',
  host: 'build-box',
  kind: 'mutate',
  callId: 'call-1',
}

/** @param {string} outcome */
function approver(outcome) {
  const asked = []
  return {
    asked,
    request: async (request) => {
      asked.push(request)
      return outcome
    },
  }
}

test('danger-full-access runs a remote command without asking', async () => {
  const approval = approver('rejected')
  const result = await authorizeRemoteOperation({
    ...CALL,
    policy: { mode: 'danger-full-access' },
    approval,
    agent: { id: 'agent' },
  })
  assert.equal(result.mode, 'danger-full-access')
  assert.equal(approval.asked.length, 0)
})

test('a narrower session must escalate instead of silently running', async () => {
  await assert.rejects(
    authorizeRemoteOperation({
      ...CALL,
      policy: { mode: 'workspace-write' },
      approval: approver('allowed-once'),
      agent: { id: 'agent' },
    }),
    /remote_exec on "build-box" is blocked: this session runs in "workspace-write" mode/,
  )
})

test('workspace-write is refused as an escalation target for remote commands', async () => {
  const approval = approver('allowed-once')
  await assert.rejects(
    authorizeRemoteOperation({
      ...CALL,
      policy: { mode: 'workspace-write' },
      sandboxPermissions: 'workspace-write',
      justification: 'write into the remote checkout',
      approval,
      agent: { id: 'agent' },
    }),
    /cannot run under "workspace-write": nothing on this host can confine a remote command/,
  )
  assert.equal(approval.asked.length, 0)
})

test('an allowed escalation runs once and the prompt carries the reason', async () => {  const approval = approver('allowed-once')
  const result = await authorizeRemoteOperation({
    ...CALL,
    policy: { mode: 'workspace-write' },
    sandboxPermissions: 'danger-full-access',
    justification: 'the build needs to write to /srv/app',
    approval,
    agent: { id: 'agent' },
  })
  assert.equal(result.mode, 'danger-full-access')
  assert.equal(approval.asked.length, 1)
  assert.equal(approval.asked[0].toolName, 'remote_exec')
  assert.equal(approval.asked[0].callId, 'call-1')
  assert.match(approval.asked[0].reason, /^escalate sandbox to danger-full-access: the build needs/)
  assert.equal(approval.asked[0].displayReason.zh, '允许本次操作使用 danger-full-access 权限：the build needs to write to /srv/app')
})

test('a rejected escalation fails closed with the shared wording', async () => {
  await assert.rejects(
    authorizeRemoteOperation({
      ...CALL,
      policy: { mode: 'read-only' },
      sandboxPermissions: 'danger-full-access',
      justification: 'install dependencies',
      approval: approver('rejected'),
      agent: { id: 'agent' },
    }),
    /the user rejected escalating this command to "danger-full-access"; it stays denied/,
  )
})

test('an unavailable approval channel fails closed', async () => {
  await assert.rejects(
    authorizeRemoteOperation({
      ...CALL,
      policy: { mode: 'workspace-write' },
      sandboxPermissions: 'danger-full-access',
      justification: 'run the test suite',
      approval: approver('unavailable'),
      agent: { id: 'agent' },
    }),
    /no approval channel is available/,
  )
})

test('read-only operations never ask', async () => {
  const approval = approver('rejected')
  for (const mode of ['read-only', 'workspace-write']) {
    const result = await authorizeRemoteOperation({
      ...CALL,
      kind: 'read',
      policy: { mode },
      approval,
      agent: { id: 'agent' },
    })
    assert.equal(result.mode, mode)
  }
  assert.equal(approval.asked.length, 0)
})

test('an escalation needs both halves', async () => {
  await assert.rejects(
    authorizeRemoteOperation({
      ...CALL,
      policy: { mode: 'workspace-write' },
      sandboxPermissions: 'danger-full-access',
      approval: approver('allowed-once'),
      agent: { id: 'agent' },
    }),
    /sandbox_permissions requires a justification/,
  )
})

test('git requests are classified as read or mutate', () => {
  assert.equal(isMutatingGitRequest('status'), false)
  assert.equal(isMutatingGitRequest('diff', ['--stat']), false)
  assert.equal(isMutatingGitRequest('stash'), true)
  assert.equal(isMutatingGitRequest('diff', ['--output=patch.diff']), true)
  assert.equal(isMutatingGitRequest('log', ['--output', 'log.txt']), true)
})
