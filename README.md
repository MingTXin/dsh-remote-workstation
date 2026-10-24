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

## Requirements

- DeepSeek Harness (`dsh`) **>= 0.2.1-rc.2** with a `web` profile (the plugin ships a browser half).
- A reachable SSH server with SFTP enabled, plus one of: password, private key, or a running SSH agent.
- Node.js `^22.19.0 || >=24`.

## Install

```bash
# straight from GitHub
dsh plugin --profile web add github:<you>/dsh-remote-workstation

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
        remoteReadOnly: true                              # stage 1: read-only
        connectTimeoutMs: 15000
        maxReadTextBytes: 33554432
```

| Option | Default | Meaning |
| --- | --- | --- |
| `storePath` | `~/.dsh/remote-workspaces.json` | mount table (no credentials) |
| `hostsPath` | `~/.dsh/remote-workspaces-hosts.json` | plugin-owned hosts (credentials, `0600`) |
| `sshHostsPath` | `~/.dsh/dsh-ssh.json` | fallback host source |
| `anchorRoot` | `~/.dsh/remote-workspaces` | anchor directory root |
| `remoteReadOnly` | `true` | reject remote writes |
| `connectTimeoutMs` | `15000` | SSH connect timeout |
| `maxReadTextBytes` | 32 MiB | single `readText` ceiling |
| `mounts` | `[]` | static mounts (`{host, remote, anchor?}`), not persisted |

`fs-sandbox` has to be disabled: a composition may mount only one `ctx.fs` provider, and this
plugin's provider already inherits the sandboxed implementation.

## Security notes

- **Plaintext credentials** live in `~/.dsh/remote-workspaces-hosts.json` (mode `0600`; on Windows the
  effective protection is the NTFS ACL of your user profile). Prefer keys or an SSH agent if that
  matters, or keep using `dsh-ssh.json`.
- **The plugin takes over `ctx.fs` for the whole profile** it is installed into. Sessions that never
  touch anchors behave exactly as before (local backend), but the swap is profile-wide.
- **Read-only by default** (`remoteReadOnly: true`): remote writes fail with
  `remote workspaces are read-only in this build` until stage 2 lands.
- Credentials never cross the HTTP API: the panel only receives `alias/host/port/user/source`.

## Known limitations

- **No remote `watch`** — the Files tab does not auto-refresh for anchor workspaces
  (`workspace-file/watch-unsupported`); collapse/expand the folder or reopen the file.
- `@`-file mentions and turn diffs still use host-local paths (upstream boundary: DSH's
  `docs/subsystems/ssh.md` notes that web workspace views which assume host filesystem access need
  separate integration).
- Built-in `glob` / `grep` run the host ripgrep binary, so they see the empty anchor directory rather
  than remote files. Use SSH-exec style tools for remote searching until `remote_search` lands.
- SFTP `mtime` has one-second resolution; the version token combines device, inode, size and mtime.

## Roadmap

- **Stage 2** — remote `writeText` / `editText` with version checks (atomic SFTP writes),
  `remote_search` tool, reuse of remote shells for builds.
- **Stage 3** — polling-based remote `watch`, git integration, image/binary previews.
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
