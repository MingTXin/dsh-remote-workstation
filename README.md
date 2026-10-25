# dsh-remote-workstation

**Remote SSH workspaces for DeepSeek Harness — mount a server directory into the DSH sidebar and work on it like a local workspace.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.1--rc.2-4B6BFB)]()
[![Transport](https://img.shields.io/badge/transport-SSH%2FSFTP-2ea44f)]()

DeepSeek Harness (DSH) workspaces must be directories on the machine that runs DSH. This plugin
removes that restriction: it adds a **Remote** panel where you browse any SSH host over SFTP, pick a
directory, and register it as a workspace. The Files tab, file previews, and the agent's
`read` / `write` / `edit` tools then work on the remote files, while every other path in the profile
keeps using local disk.

If you know **VS Code Remote-SSH**, this is the same idea for DSH: browse the server in the sidebar,
select a folder, and let the agent work there.

```
┌─────────────────────────── DSH host (your machine) ──────────────────────────┐
│  sidebar:  Remote  ▸ host ▸ /srv/app          workspace: app@build-box       │
│                                                    │                          │
│  ctx.fs  ── resolve/listDir/readText/writeText ──► RemoteWorkspaceFileSystem │
│                                                    │  anchor prefix           │
│  ~/.dsh/remote-workspaces/build-box/srv/app  ◄─────┘  (local, empty)         │
└────────────────────────────────────────────────────┼──────────────────────────┘
                                                     │ SSH/SFTP (ssh2)
                                                     ▼
                                         build-box:/srv/app  (real files)
```

## Features

- **Remote Explorer panel** — host picker, directory browser, "mount as workspace" in one click.
- **Workspace anchoring** — DSH requires a real host directory, so the plugin creates an empty
  *anchor* under `~/.dsh/remote-workspaces/<host>/<path>` and maps it to the remote directory.
  The Files tab, previews and `read`/`write`/`edit` tools then operate on the remote files.
- **Pluggable filesystem provider** — replaces `ctx.fs` with a union filesystem: anchor paths go to
  SFTP, everything else stays local. It extends `SandboxedFileSystem`, so the read-only /
  workspace-write / full-access sandbox fences still apply.
- **Self-contained host management** — add, edit, test and remove SSH hosts inside the panel
  (password, private key, or `SSH_AUTH_SOCK` agent). No other plugin required; hosts from an existing
  `~/.dsh/dsh-ssh.json` are picked up as a secondary source.
- **Careful credential handling** — the mount table never stores secrets; credentials are read from
  the plugin host store (`0600`) or the DSH SSH store on every connection and never leave the host
  process.
- **Nothing to install on the server** — plain SFTP, no agent or helper binary.
- **Remote writes and edits** — `write` and `edit` tools work on remote files through the same
  `ctx.fs` contract as local ones: create-if-absent, version-checked replace (stale writes are
  rejected), literal `editText` with ambiguity detection, and the sandbox fence still applies.
- **Remote shell and search tools** — `remote_exec` runs a command on the mounted server (builds,
  tests, `git`, anything), `remote_search` greps a remote directory and returns `path:line` hits,
  so agents do not have to fall back to host-local `glob`/`grep`.
- **Live refresh over SFTP** — remote `watch` is implemented by polling file attributes (2 s
  default), so the Files tab and open previews pick up external changes without a server agent.
- **Git over SSH** — `remote_git` runs a read-only git query (`status`, `diff`, `log`, `show`,
  `branch`, `rev-parse`, `ls-files`, `blame`, `stash`) inside a remote repository.
- **Binary and image previews** — `readByteRange`/`readBytes` are real SFTP reads, so the built-in
  image/PDF/Excel/Office previews render remote files without downloading them first.
- **Honours your permission preset** — the sandbox mode and approval policy of the calling session
  gate remote writes and remote commands; auto review judges them like any other tool.

## Requirements

- DeepSeek Harness (`dsh`) **>= 0.2.1-rc.2** with a `web` profile (the plugin ships a browser half).
- A reachable SSH server with SFTP enabled, plus one of: password, private key, or a running SSH agent.
- Node.js `^22.19.0 || >=24`.

## Install

```bash
# straight from GitHub
dsh plugin --profile web add github:MingTXin/dsh-remote-workstation

# from npm (once published)
dsh plugin --profile web add dsh-remote-workstation

# local development checkout
dsh plugin --profile web add link:/absolute/path/to/dsh-remote-workstation
```

The plugin declares `dsh.bundle`, so `dsh plugin add` appends it to the profile's
`dsh.profile.bundles`. **Restart DSH Desktop / `dsh web`** afterwards — a plugin's host half is only
mounted at process start (client bundles hot-reload on page refresh, host code does not).

Want to try it without touching your main GUI? Copy the profile, point its `node_modules` at the
original (junction / symlink), and boot a second host:

```bash
dsh --profile rwtest --port 43199 --no-open
```

## Quick start

1. Sidebar → **Remote**.
2. Pick a host, or click **＋ Add host** and fill in alias / host / port / user / auth.
3. Browse to the directory you want (click folders, or type a path and press Enter).
4. Click **Mount as workspace** — the plugin creates the anchor, records the mapping and registers
   the workspace (idempotent: mounting twice is a no-op).
5. Open the workspace from the sidebar and switch to the **Files** tab: that is the remote
   directory. Sessions started there give the agent remote file access.

**中文速览**：侧栏「远程」→ 选主机（或「＋ 添加主机」）→ 浏览到目标目录 →「挂载为工作区」→
从侧栏打开该工作区，右侧 Files 标签即远端内容，会话里的读写工具也走远端。
更详细的中文说明（主机管理、验收记录、排错）见 [`docs/README.zh.md`](docs/README.zh.md)。

## Host management

The panel keeps its own host list in `~/.dsh/remote-workspaces-hosts.json`
(written with mode `0600`, **credentials in plaintext** — the same trade-off as
`~/.dsh/dsh-ssh.json`):

```json
{
  "version": 1,
  "hosts": [
    {
      "alias": "build-box",
      "host": "10.0.0.5",
      "port": 22,
      "user": "dev",
      "auth": { "kind": "password", "password": "..." }
    }
  ]
}
```

- Sources are merged: **plugin store first, then `~/.dsh/dsh-ssh.json`**. A host defined in both
  places uses the plugin definition, so ports, users and keys can be overridden per host.
- Keys use `{ "kind": "key", "keyPath": "~/.ssh/id_ed25519", "passphrase": "..." }`;
  `{ "kind": "none" }` falls back to `SSH_AUTH_SOCK`.
- **Test** connects once and reports the remote home directory plus latency; on failure it shows the
  raw error (timeout, auth, DNS).

## Configuration

The plugin is mounted through a bundle patch (`cordis.patch.yml`), so options live on the loader row:

```yaml
- id: fs-sandbox          # replaced by the plugin's union filesystem
  disabled: true
- insert:
    - id: remote-workspace
      name: dsh-remote-workstation
      config:
        storePath: ~/.dsh/remote-workspaces.json          # anchor <-> remote mapping
        sshHostsPath: ~/.dsh/dsh-ssh.json                 # secondary host source
        hostsPath: ~/.dsh/remote-workspaces-hosts.json    # plugin-owned host store
        anchorRoot: ~/.dsh/remote-workspaces              # where anchors are created
        remoteReadOnly: false                             # true = reject every remote mutation
        watchIntervalMs: 2000                             # remote watch() polling interval
        connectTimeoutMs: 15000
        maxReadTextBytes: 33554432
```

| Option | Default | Meaning |
| --- | --- | --- |
| `storePath` | `~/.dsh/remote-workspaces.json` | mount table (no credentials) |
| `hostsPath` | `~/.dsh/remote-workspaces-hosts.json` | plugin-owned hosts (credentials, `0600`) |
| `sshHostsPath` | `~/.dsh/dsh-ssh.json` | fallback host source |
| `anchorRoot` | `~/.dsh/remote-workspaces` | anchor directory root |
| `remoteReadOnly` | `false` | set to `true` to reject every remote mutation |
| `enableTools` | `true` | register the `remote_exec` / `remote_search` / `remote_git` tools |
| `watchIntervalMs` | `2000` | remote `watch()` polling interval (minimum 250) |
| `connectTimeoutMs` | `15000` | SSH connect timeout |
| `maxReadTextBytes` | 32 MiB | single `readText` ceiling |
| `mounts` | `[]` | static mounts (`{host, remote, anchor?}`), not persisted |

`fs-sandbox` has to be disabled: a composition may mount only one `ctx.fs` provider, and this
plugin's provider already inherits the sandboxed implementation.

## Remote tools

With `enableTools: true` (the default) the plugin registers three tools next to the filesystem:

| Tool | Arguments | What it does |
| --- | --- | --- |
| `remote_exec` | `host`, `command`, `cwd?`, `timeoutMs?` | Runs a shell command on the server through an SSH exec channel and returns `{ exitCode, stdout, stderr, durationMs }`. Use it for builds, tests, `git`, `ls`, anything the anchor session cannot run locally. |
| `remote_search` | `host`, `path`, `pattern`, `glob?`, `ignoreCase?`, `maxResults?` | Recursive `grep -rInE` on the server (`.git` excluded), returning `path:line: text` hits plus a `truncated` flag. |
| `remote_git` | `host`, `path`, `command`, `args?` | One read-only git query (`status`, `diff`, `log`, `show`, `branch`, `rev-parse`, `ls-files`, `blame`, `stash`) inside a remote repository. Other subcommands are rejected. |

```text
remote_exec(host="my-server", command="npm test", cwd="/srv/app")
remote_search(host="my-server", path="/srv/app/src", pattern="TODO", glob="*.ts")
remote_git(host="my-server", path="/srv/app", command="diff", args=["--stat"])
```

Both tools take the same host alias the panel uses, so a mounted workspace and a remote shell share
one host store and one connection pool.

## Permissions and approvals

A remote workspace follows the same permission model as a local one: the session's preset decides the
sandbox mode and the approval policy, and every path below reads the *live* policy of the calling
session — switching the preset mid-session changes the behaviour immediately.

| Session mode | Remote reads (`read`, `Files` tab, `remote_search`, read-only git) | Remote writes (`write` / `edit` tools) | Remote commands (`remote_exec`, `git stash`) |
| --- | --- | --- | --- |
| `danger-full-access` (完全权限 / 自动审查 runs on top of it) | allowed | allowed | allowed, no prompt |
| `workspace-write` (default) | allowed | only inside the anchor subtree (plus `/tmp` and the host temp directory) | refused, unless the call escalates to `danger-full-access` with a justification |
| `read-only` | allowed | refused (`FS_SANDBOX_DENIED`) | refused, same escalation path |

How a refusal behaves depends on the approval policy the preset bundles: `ask` shows the standard DSH
approval prompt with the justification (`允许本次操作使用 danger-full-access 权限：…`), while `never`
fails closed with `the user rejected escalating this command to "danger-full-access"; it stays denied`.

`workspace-write` is not an escalation target for remote commands: no host-side sandbox can confine a
process that runs on another machine, so the only meaningful escalation is `danger-full-access` — which
is exactly the prompt DSH shows before running anything wider than the session's standing mode.

**Auto review** (自动审查, preset `auto`) needs no special support: it hooks `tools/pre-execute` for
whatever tools the session has, so `remote_exec` / `remote_git` are classified by the same reviewer that
judges `bash` — a low-risk read is allowed, an unknown or broad write is denied or escalated to you.

```python
# workspace-write session, first attempt (refused):
remote_exec(host="my-server", command="npm test")            # -> "blocked: … cannot be confined"

# the model retries once, with a reason (prompts you):
remote_exec(host="my-server", command="npm test",
            sandbox_permissions="danger-full-access",
            justification="run the project's test suite on the server")
```

## Security notes

- **Plaintext credentials** live in `~/.dsh/remote-workspaces-hosts.json` (mode `0600`; on Windows the
  effective protection is the NTFS ACL of your user profile). Prefer keys or an SSH agent if that
  matters, or keep using `dsh-ssh.json`.
- **The plugin takes over `ctx.fs` for the whole profile** it is installed into. Sessions that never
  touch anchors behave exactly as before (local backend), but the swap is profile-wide.
- **Writes stay fenced.** Remote `writeText`/`editText` run through the same sandbox check as local
  writes: `read-only` denies, `workspace-write` allows only the anchor subtree (plus `/tmp` and the
  host temp directory), `danger-full-access` allows everything. Set `remoteReadOnly: true` to refuse
  every remote mutation regardless of the session mode.
- Credentials never cross the HTTP API: the panel only receives `alias/host/port/user/source`.

## Known limitations

- **Refresh is polled, not pushed** — SFTP has no change feed, so remote `watch` re-reads file
  attributes every `watchIntervalMs` (2 s default). A change shows up one interval later; the cost is
  one `stat` per watched path per interval, not a full directory walk. A file's own edits (from any
  client) are detected by size/mtime; a directory watch notices entries added or removed, while
  in-place content edits of a file you never opened are only noticed once it is opened or written
  through DSH.
- `@`-file mentions and turn diffs still use host-local paths (upstream boundary: DSH's
  `docs/subsystems/ssh.md` notes that web workspace views which assume host filesystem access need
  separate integration). Use `remote_git` / `remote_exec` to inspect the real repository.
- Built-in `glob` / `grep` run the host ripgrep binary, so they see the empty anchor directory rather
  than remote files. Use `remote_search` (or `remote_exec` with `rg`/`find`) instead.
- SFTP `mtime` has one-second resolution; the version token combines device, inode, size and mtime,
  so a rewrite that keeps size and mtime within the same second is not distinguishable.

## Troubleshooting

- **The desktop app exits while adding a remote directory (fixed in 0.4.1)** — ssh2 reports a
  handshake timeout as an `error` event on the connection, and an EventEmitter without an `error`
  listener throws. Inside the DSH host process that surfaced as
  `fatal uncaught exception: Error: Timed out while waiting for handshake` followed by
  `DSH Host exited (1)`. The pool now keeps a permanent `error` guard on every connection, disables
  ssh2's own handshake timer, and rejects the caller with
  `cannot connect to "<alias>" (<user>@<host>:<port>): connection timed out after <n> ms` instead.
  `npm test` covers it in `test/pool-errors.test.mjs`.
- **"All configured authentication methods failed"** — the host entry has no usable credential.
  Open the 远程 panel → 主机 → 编辑 and set a password or a private key (or rely on ssh-agent).

## Roadmap

- ~~**Stage 2** — remote `writeText` / `editText` with version checks, `remote_search`, remote shells
  for builds.~~ Shipped in 0.3.0 (`remote_exec`, `remote_search`, version-guarded writes).
- ~~**Stage 3** — polling-based remote `watch`, git integration, image/binary previews.~~ Shipped in
  0.4.0 (`watchIntervalMs`, `remote_git`, byte-range previews).
- Optional: consume the upstream `packages/ssh` family (`@deepseek-ai/dsh-fs-ssh`) instead of the
  custom union provider, once web workspace views become provider-driven.

## Development

```bash
npm test                          # offline: unit tests; SSH integration tests auto-skip
npm run probe -- <alias> /path    # manual SFTP transport probe against ~/.dsh/dsh-ssh.json
```

SSH-backed tests opt in through environment variables:

```bash
DSH_RW_REMOTE_HOST=<alias from ~/.dsh/dsh-ssh.json> \
DSH_RW_REMOTE_DIR=/tmp/dsh-remote-workstation-fixture \
npm test
```

Layout: `lib/index.js` (provider + plugin entry), `lib/mounts.js` (anchor table, host store),
`lib/ssh/{pool,sftp}.js` (ssh2 transport and SFTP primitives), `lib/explorer.js` (JSON API),
`lib/client.js` (browser panel: `sidebar.panellist` + `main` slot).

## License

[MIT](LICENSE) © dsh-remote-workstation contributors

> Not affiliated with DeepSeek. "DeepSeek Harness" and "DSH" refer to the harness this plugin extends.
