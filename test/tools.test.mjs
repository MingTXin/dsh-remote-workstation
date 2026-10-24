/**
 * Unit tests for the plugin's model-facing tools (no SSH required: the engine
 * is a stub).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteTools } from '../lib/tools.js'

test('remote tools forward to the engine', async () => {
  const calls = []
  const tools = createRemoteTools({
    exec: async (host, command, options) => {
      calls.push({ kind: 'exec', host, command, options })
      return { exitCode: 0, stdout: 'built ok\n', stderr: '', durationMs: 12 }
    },
    search: async (request) => {
      calls.push({ kind: 'search', request })
      return { count: 1, truncated: false, exitCode: 0, matches: ['a.ts:2: hit'] }
    },
  })
  assert.deepEqual(tools.map((tool) => tool.name), ['remote_exec', 'remote_search'])

  const [execTool, searchTool] = tools
  const signal = new AbortController().signal
  const execResult = await execTool.execute({ host: 'box', command: 'make', cwd: '/srv/app', timeoutMs: 5000 }, { signal })
  assert.equal(execResult.stdout, 'built ok\n')
  assert.equal(calls[0].kind, 'exec')
  assert.equal(calls[0].host, 'box')
  assert.equal(calls[0].options.cwd, '/srv/app')
  assert.equal(calls[0].options.timeoutMs, 5000)
  assert.equal(calls[0].options.signal, signal)

  const searchResult = await searchTool.execute({ host: 'box', path: '/srv/app', pattern: 'hit', glob: '*.ts' }, { signal })
  assert.equal(searchResult.count, 1)
  assert.deepEqual(searchResult.matches, ['a.ts:2: hit'])
  assert.equal(calls[1].request.pattern, 'hit')
  assert.equal(calls[1].request.glob, '*.ts')

  const rendered = execTool.output.render({}, execResult)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /exit 0/)
})
