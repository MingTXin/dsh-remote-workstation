## Crash fix

A handshake timeout is reported by ssh2 as an `error` event on the connection object. The pool listened for it only while waiting for `ready` and detached the listener on its own timeout, so ssh2's timer then emitted into an emitter with no `error` listener — an uncaught exception that killed the DSH host (`fatal uncaught exception: Error: Timed out while waiting for handshake`, `DSH Host exited (1)`).

Fixed by owning the guard for the whole connection lifetime, disabling ssh2's handshake timer, guarding the SFTP session and read streams, and rejecting the caller with a normal `cannot connect to "<alias>" (...): connection timed out after <n> ms` error. `test/pool-errors.test.mjs` reproduces the old crash and now passes.

Also in this release: `resolveRemote(host, path)` so the panel previews an explicitly named host instead of the first configured one.
