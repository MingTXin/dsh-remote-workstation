/**
 * Sandbox and approval gating for the plugin's remote tools.
 *
 * Reading remote files needs no confinement, but a remote shell cannot be
 * confined by any host sandbox: once `remote_exec` runs, the command may write
 * anywhere on that machine. So the mutating remote tools follow the same
 * contract as the stock `bash` tool:
 *
 *   - `danger-full-access` sessions run them directly;
 *   - narrower sessions (`read-only`, `workspace-write`) must escalate once
 *     with `sandbox_permissions: "danger-full-access"` + `justification`, which
 *     goes through `ctx.approval` exactly like a bash escalation (an `ask`
 *     policy prompts the user, a `never` policy refuses); `workspace-write` is
 *     rejected as a target because no host-side sandbox can confine a command
 *     that runs on another machine;
 *   - read-only tools (`remote_search`, read-only git queries) always run,
 *     mirroring "reads are allowed in every mode".
 *
 * @module dsh-remote-workstation/permissions
 */

import {
  approveEscalation,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'

/** Git subcommands that change the remote working tree. */
export const MUTATING_GIT_COMMANDS = ['stash']

/** Git flags that turn a read-only subcommand into a writer (`git diff --output=…`). */
const MUTATING_GIT_FLAGS = ['--output']

/**
 * True when this git request can write to the remote checkout.
 * @param {string} command - the whitelisted subcommand.
 * @param {readonly string[]} [args] - the extra arguments.
 * @returns {boolean}
 */
export function isMutatingGitRequest(command, args = []) {
  if (MUTATING_GIT_COMMANDS.includes(command)) return true
  return args.some((arg) => MUTATING_GIT_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
}

/**
 * The escalation parameter descriptions every mutating remote tool advertises.
 * @param {string} subject - the tool family's noun (`command`).
 * @returns {Record<string, unknown>} schema properties to spread into `parameters`.
 */
export function escalationParameters(subject) {
  return {
    sandbox_permissions: {
      type: 'string',
      enum: ['workspace-write', 'danger-full-access'],
      description: sandboxPermissionsDescription(subject),
    },
    justification: {
      type: 'string',
      description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact '
        + `${subject} needs the wider access. Use the language of the user’s current request.`,
    },
  }
}

/**
 * Judge one remote mutation before it runs.
 *
 * @param {object} options
 * @param {string} options.toolName - the tool asking (`remote_exec`, `remote_git`).
 * @param {string} options.subject - the noun used in user-facing texts (`command`).
 * @param {string} options.host - host alias, for the error message.
 * @param {'read' | 'mutate'} options.kind - read-only requests skip the gate.
 * @param {string} [options.sandboxPermissions] - the model's escalation target.
 * @param {string} [options.justification] - the model's one-sentence reason.
 * @param {{ mode: string } | undefined} options.policy - the call's standing sandbox policy.
 * @param {any} options.approval - `ctx.approval`, or undefined when not composed.
 * @param {any} options.agent - the calling agent (undefined for agent-less calls).
 * @param {string} options.callId - the tool-call id the approval prompt attaches to.
 * @param {AbortSignal} [options.signal] - the tool-execution signal.
 * @returns {Promise<{ mode: string }>} the mode the operation runs under.
 */
export async function authorizeRemoteOperation(options) {
  const {
    toolName,
    subject,
    host,
    kind,
    sandboxPermissions,
    justification,
    policy,
    approval,
    agent,
    callId,
    signal,
  } = options
  const mode = policy?.mode ?? 'danger-full-access'
  if (kind === 'read' || mode === 'danger-full-access') return { mode }
  if (sandboxPermissions === 'workspace-write') {
    throw new Error(
      `${toolName} on "${host}" cannot run under "workspace-write": nothing on this host can confine a `
      + `remote ${subject}, so the only meaningful target is "danger-full-access". Retry once with `
      + 'sandbox_permissions: "danger-full-access" and a one-sentence justification.',
    )
  }
  if (sandboxPermissions !== undefined || justification !== undefined) {
    validateEscalationArgs(sandboxPermissions, justification)
    const granted = await approveEscalation(
      { requestedMode: sandboxPermissions, justification, effectiveMode: mode, subject },
      { approver: approval, agent, callId, toolName, signal },
    )
    return { mode: granted }
  }
  throw new Error(
    `${toolName} on "${host}" is blocked: this session runs in "${mode}" mode and a remote ${subject} `
    + `cannot be confined by it. Retry once with sandbox_permissions: "danger-full-access" and a `
    + 'one-sentence justification so the user can approve this single call.',
  )
}
