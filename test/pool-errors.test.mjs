/**
 * Regression tests for transport failures.
 *
 * DSH runs inside the desktop host process, where an `error` event with no
 * listener is a fatal uncaught exception that restarts the app. ssh2 emits such
 * events for handshake timeouts and socket failures, so the pool has to own
 * them permanently; these tests fail (the runner dies) if that guarantee is
 * ever dropped.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { SshPool } from '../lib/ssh/pool.js'
import { createReadStream } from '../lib/ssh/sftp.js'

/** A TCP server that accepts connections and never speaks SSH. */
async function silentServer() {
  const sockets = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A TCP server that drops every connection as soon as it is opened. */
async function dropServer() {
  const server = net.createServer((socket) => {
    socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

function poolFor(port, connectTimeoutMs) {
  const pool = new SshPool({ connectTimeoutMs })
  pool.setHosts([{ alias: 'slow-box', host: '127.0.0.1', port, user: 'tester', auth: { kind: 'password', password: 'secret' } }])
  return pool
}

test('a handshake timeout rejects without an unlistened ssh2 error event', async () => {
  const server = await silentServer()
  const pool = poolFor(server.port, 500)
  try {
    await assert.rejects(
      () => pool.sftp('slow-box'),
      (error) => {
        assert.match(String(error.message), /connection timed out after 500 ms/u)
        return true
      },
    )
    // Give ssh2's own timers (realpath/keepalive/handshake) a chance to fire: an
    // unhandled `error` here would abort this test process.
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.ok(pool.lastError('slow-box') === undefined || pool.lastError('slow-box') instanceof Error)
  } finally {
    pool.close()
    await server.close()
  }
})

test('a dropped socket rejects without an unlistened ssh2 error event', async () => {
  const server = await dropServer()
  const pool = poolFor(server.port, 1500)
  try {
    await assert.rejects(() => pool.sftp('slow-box'), (error) => {
      assert.equal(error.code, 'FS_IO_ERROR')
      return true
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
  } finally {
    pool.close()
    await server.close()
  }
})

test('a timed-out host can be retried and still fails cleanly', async () => {
  const server = await silentServer()
  const pool = poolFor(server.port, 400)
  try {
    await assert.rejects(() => pool.sftp('slow-box'))
    await assert.rejects(() => pool.sftp('slow-box'))
  } finally {
    pool.close()
    await server.close()
  }
})

test('remote read streams never expose an unlistened error event', () => {
  const fakeSftp = { createReadStream: () => new EventEmitter() }
  const stream = createReadStream(fakeSftp, '/srv/app/file.txt', { start: 0, end: 9 })
  assert.equal(stream.listenerCount('error'), 1)
  // Emitting a failure is swallowed by the sink instead of throwing.
  stream.emit('error', new Error('connection closed'))
})
