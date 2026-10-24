/**
 * Model-facing tools owned by this plugin.
 *
 * The stock `glob`/`grep`/`bash` tools run on the DSH host, so a remote
 * workspace cannot use them to search or build on the SSH machine. These two
 * tools close that gap without requiring another SSH plugin:
 *
 *   remote_exec   - run a shell command on the host (builds, tests, git, ...)
 *   remote_search - grep text files under a remote directory
 *
 * They are registered only when the host composes a `tools` service, and they
 * honour the same host aliases as the filesystem provider (this plugin's own
 * host store first, then the imported `dsh-ssh` list).
 *
 * @module dsh-remote-workstation/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** One text content block (the only render shape these tools emit). */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** @param {number} ms */
function formatDuration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

/**
 * @param {{ exec: (host: string, command: string, options?: any) => Promise<any> }} engine
 */
function remoteExecTool(engine) {
  return defineTool({
    name: 'remote_exec',
    description:
      'Execute a shell command on a REMOTE host that is visible to this plugin\'s Remote panel (builds, tests, git, package installs). The command runs on the remote machine, never locally. Prefer combining independent read-only queries into one command.',
    parameters: {
      host: {
        type: 'string',
        required: true,
        description: 'Host alias from the Remote panel (or ~/.dsh/dsh-ssh.json).',
      },
      command: {
        type: 'string',
        required: true,
        description: 'Shell command to run on the remote host.',
      },
      cwd: {
        type: 'string',
        description: 'Remote working directory; defaults to the login directory.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Timeout in milliseconds (default 60000).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(
        `exit ${value.exitCode ?? 'signal'} in ${formatDuration(value.durationMs)}`
        + (value.stdout ? `\n${value.stdout}` : '')
        + (value.stderr ? `\n--- stderr ---\n${value.stderr}` : ''),
      ),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return engine.exec(args.host, args.command, {
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        signal: exec.signal,
      })
    },
  })
}

/**
 * @param {{ search: (request: any) => Promise<any> }} engine
 */
function remoteSearchTool(engine) {
  return defineTool({
    name: 'remote_search',
    description:
      'Search text files under a remote directory with grep on the SSH host. Returns matching lines as "path:line: text". Use it instead of grep/glob when the workspace lives on a remote host.',
    parameters: {
      host: {
        type: 'string',
        required: true,
        description: 'Host alias from the Remote panel (or ~/.dsh/dsh-ssh.json).',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Remote directory to search (absolute path).',
      },
      pattern: {
        type: 'string',
        required: true,
        description: 'Extended regular expression (grep -E).',
      },
      glob: {
        type: 'string',
        description: 'Only search files whose name matches this shell glob, e.g. "*.ts".',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum matching lines to return (default 200).',
      },
      ignoreCase: {
        type: 'boolean',
        description: 'Case-insensitive match.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          matches: { type: 'array', required: true, items: { type: 'string' } },
          stderr: { type: 'string' },
        },
      },
      render: (_args, value) => text(
        value.count === 0
          ? `no matches${value.stderr ? `\n${value.stderr}` : ''}`
          : `${value.count} match${value.count === 1 ? '' : 'es'}${value.truncated ? ' (truncated)' : ''}\n${value.matches.join('\n')}`,
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return engine.search({
        host: args.host,
        path: args.path,
        pattern: args.pattern,
        glob: args.glob,
        maxResults: args.maxResults,
        ignoreCase: args.ignoreCase,
        signal: exec.signal,
      })
    },
  })
}

/**
 * @param {{ git: (request: any) => Promise<any> }} engine
 */
function remoteGitTool(engine) {
  return defineTool({
    name: 'remote_git',
    description:
      'Run one read-only git query inside a repository on a REMOTE host (status, diff, log, show, branch, rev-parse, ls-files, blame, stash). Use it to inspect a remote workspace: the built-in diff/status views only look at the local anchor directory.',
    parameters: {
      host: {
        type: 'string',
        required: true,
        description: 'Host alias from the Remote panel (or ~/.dsh/dsh-ssh.json).',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Remote directory inside the repository, e.g. /srv/app.',
      },
      command: {
        type: 'string',
        required: true,
        description: 'One of: status, diff, log, show, branch, rev-parse, ls-files, blame, stash.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra arguments appended after the subcommand, e.g. ["--stat", "-n", "5"].',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', required: true },
          path: { type: 'string', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(
        `${value.command} in ${value.path}: exit ${value.exitCode ?? 'signal'} in ${formatDuration(value.durationMs)}`
        + (value.stdout ? `\n${value.stdout}` : '')
        + (value.stderr ? `\n--- stderr ---\n${value.stderr}` : ''),
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return engine.git({
        host: args.host,
        path: args.path,
        command: args.command,
        args: args.args,
        signal: exec.signal,
      })
    },
  })
}

/**
 * Build the plugin's tool set for one engine.
 * @param {any} engine
 */
export function createRemoteTools(engine) {
  return [remoteExecTool(engine), remoteSearchTool(engine), remoteGitTool(engine)]
}
