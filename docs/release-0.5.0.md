## Remote operations now obey the session's sandbox mode and approval policy

Until 0.4.x the three remote tools bypassed DSH's permission model: in a `workspace-write` session with
`ask` approvals, `remote_exec` would run any command on the server without a prompt — the filesystem
provider was fenced, the shell was not.

0.5.0 closes that hole and makes a remote workspace behave like a local one:

- **`remote_exec` and mutating `remote_git` calls** (`stash`, `--output`) are refused when the session
  runs in `workspace-write` or `read-only`. The error tells the model how to retry, and the retry —
  `sandbox_permissions: "danger-full-access"` plus a one-sentence `justification` — goes through
  `ctx.approval` exactly like a `bash` escalation: `ask` shows the standard prompt, `never` fails closed.
- **`danger-full-access` sessions** (完全权限) run remote commands directly, as before.
- **`workspace-write` is rejected as an escalation target**: no host-side sandbox can confine a process
  on another machine, so the only meaningful target is `danger-full-access`.
- **Reads never prompt** — `remote_search`, read-only git queries and the Files tab stay available in
  every mode, mirroring "reads are allowed in every mode" for local files.
- **Auto review** (自动审查, preset `auto`) needs no plugin support: it hooks `tools/pre-execute` for
  every tool, so the remote tools are judged by the same reviewer as `bash`.

Tests: 41 (34 offline + 7 SSH-gated), including an end-to-end gate test that runs `echo` on a real
host, refuses an un-escalated call, runs it again after `allowed-once`, and keeps a `rejected` call
closed.
