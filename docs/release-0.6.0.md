# dsh-remote-workstation 0.6.0 — remote shell routing

`0.6.0` adds an **opt-in remote shell**: with one extra patch, the agent's own `bash` / `pwsh`
commands run on the SSH host whenever their working directory is inside a mount anchor, so builds and
test suites execute next to the code instead of in the empty local anchor directory.

## Added

- `lib/shell-remote-core.js`, `lib/shell-remote.js`, `lib/pwsh-remote.js` — remote executors for the
  `shell` service. They subclass the stock sandboxed executors and only take over commands whose
  `workdir` is inside an anchor; every other command keeps the stock local behaviour and sandbox.
- `lib/ssh-exec-helper.mjs` — the helper the host spawns per remote command. It connects with the
  shared SSH pool, opens an exec channel, and pipes stdin/stdout/stderr so the host keeps its own
  timeout, output cap, spill file and background-job semantics.
- `examples/cordis.remote-shell.yml` — the two loader rows that enable routing (they rewrite
  `bash-sandbox` / `pwsh-sandbox` **in place**, so the `shell` service keeps a single provider).
- `test/shell-remote.test.mjs` — routing, the confined-session fence, and a real `ctx.shell`
  execution against an SSH host (skipped unless `DSH_RW_REMOTE_HOST` is set).

## Safety model

A process on another machine cannot be confined by the host sandbox, so a remote command only runs
when the call's sandbox mode is `danger-full-access`. In `workspace-write` / `read-only` the executor
refuses with an explanation, and the model can retry once with
`sandbox_permissions: "danger-full-access"` + a one-sentence justification — the standard approval
prompt. `remote_exec` / `remote_git` keep the same gate.

## Not covered

The interactive `terminal` (PTY), built-in `glob` / `grep` (host ripgrep), LSP, `@` mentions and turn
diffs stay host-local; use `remote_search` / `remote_exec` / `remote_git` for remote work.

## Upgrade notes

Nothing changes unless you add the rows from `examples/cordis.remote-shell.yml` to your profile's
`cordis.patch.yml`. In the Windows desktop app that patch replaces the launcher's ACL-confined pwsh
executor, which is why it stays opt-in.

## Verification

- `npm test` — 41 tests: 34 offline + 7 SSH-gated (`DSH_RW_REMOTE_HOST=<alias>`) all green.
- Real host: `ctx.shell.execute({ command: "uname -s && pwd", workdir: <anchor> })` returns
  `Linux\n/tmp/dsh-remote-workspace-fixture` through the SSH host (≈1 s including connect).
- Isolated profile boot with the shell rows enabled: no provider conflict, only the pre-existing
  plugin-import warnings.
