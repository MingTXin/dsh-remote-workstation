# 发布与分享

这个仓库可以按三种方式给别人的 DeepSeek Harness 使用。发布前请先把下面「隐私检查」走一遍。

## 0. 包名现状（已核对）

- `dsh-remote-workstation`：**npm 上仍可用**（`npm view dsh-remote-workstation version` → 404），可以直接发布；若要发 scoped 包则首次用 `npm publish --access public`。
- `dsh-remote-workspace`：已被别人占用（`0.1.0-alpha.2`），本项目早期用的就是这个名字，现已改名，别再改回去。

包名若再改，必须**同时**改两处，否则 patch 行找不到包：

| 位置 | 字段 |
| --- | --- |
| `package.json` | `name` |
| `cordis.patch.yml` | `insert[0].name`（必须与 `package.json.name` 完全一致） |
| `lib/client.js` | `window.__ModuleLoader__.load({ id: '<包名>' })` 的 `id`（必须与包名一致，否则浏览器侧模块不挂载） |

版本号在 `package.json.version`；每次发 npm 前记得递增。

## 1. GitHub 安装（最省事，不发 npm）

```powershell
cd <本仓库>
git init
git add .
git commit -m "dsh-remote-workstation 0.2.0"
gh repo create dsh-remote-workstation --public --source=. --push
```

别人这样装：

```powershell
dsh plugin --profile web add github:<你的GitHub账号>/dsh-remote-workstation
```

`dsh plugin add` 会跑 pnpm 安装，并把本包追加进该 profile 的 `dsh.profile.bundles`；装完重启 DSH 宿主即可。

## 2. npm 发布

```powershell
npm login
npm pack --dry-run          # 先看打包清单（应当只有 lib/、cordis.patch.yml、README、LICENSE）
npm publish                 # scoped 包首次发布用 npm publish --access public
```

别人这样装：

```powershell
dsh plugin --profile web add <包名>      # 例如 @your-name/dsh-remote-workstation
```

## 3. 离线分发（tarball）

```powershell
npm pack                    # 生成 dsh-remote-workstation-0.2.0.tgz
```

把 tgz 发给对方，对方：

```powershell
dsh plugin --profile web add file:<路径>\dsh-remote-workstation-0.2.0.tgz
```

## 隐私检查（发布前必做）

本插件在运行时会读写下面这些**只应存在于你自己机器上**的文件，绝对不能进仓库：

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/remote-workspaces-hosts.json` | 面板里添加的主机，**含明文密码/私钥口令** |
| `~/.dsh/remote-workspaces.json` | 锚点映射表（含主机名与远端路径） |
| `~/.dsh/dsh-ssh.json` | dsh-ssh 的主机表，**含明文密码/私钥路径** |
| 任何 `*.pem` / `*.key` / `id_*` | 私钥 |
| `*.log`、`.rwtest*`、`test-out.txt` | 运行日志，可能带主机名/路径 |

`.gitignore` 已经覆盖上述模式；另外建议发布前跑一遍扫描，确认仓库里没有残留的 IP、内网地址、家目录和口令：

```powershell
cd <本仓库>
git ls-files | Where-Object { $_ -notmatch '^node_modules/' } | ForEach-Object {
  Select-String -Path $_ -Pattern '(\d{1,3}\.){3}\d{1,3}|password"\s*:\s*"[^"]+"|BEGIN [A-Z ]*PRIVATE KEY|C:\\Users\\|/home/[a-z]' -AllMatches
}
```

命中项只有两类是正常的：占位示例（`192.0.2.x`、`my-server`）与代码里的字段名/正则。真实主机、真实口令、真实家目录一律删掉。

同时确认：

- `git status` 里没有 `node_modules/`（Windows 上它是 junction，提交上去是坏链接）。
- 测试默认**离线**：`npm test` 在未设置 `DSH_RW_REMOTE_HOST` 时应通过（SSH 相关用例自动 skip）。
- 改过主机/IP 的示例，README 里一律用 `my-server`、`192.0.2.x` 这类占位值。

## 使用方需要知道的三件事（建议写进 README/Release Notes）

1. **凭据是明文**：面板添加的主机存在 `~/.dsh/remote-workspaces-hosts.json`，仅按 0600 写盘（Windows 取决于 NTFS ACL）。不想落盘就用私钥 + 系统 agent，或复用 dsh-ssh 的配置。
2. **会接管 `ctx.fs`**：bundle patch 禁用了 `fs-sandbox` 行并在同一服务名上挂联合文件系统（继承沙箱围栏）。装进哪个 profile，哪个 profile 的会话就走这套 fs；不装的 profile 不受影响。
3. **阶段 1 只读**：远端写入会报 `remote workspaces are read-only in this build`；远端目录也没有 `watch`（Files 标签不会自动刷新）。
