# dsh-remote-workstation

把远程服务器目录挂进 DeepSeek Harness 侧栏工作区（阶段 3：可读写 + 自动刷新 + 远端 git + 二进制预览）。

插件做三件事：

1. **替换文件系统提供方**：`ctx.fs` 由本插件提供，落在「锚点目录」下的路径全部转成 SFTP 访问远端；其余路径仍走本地磁盘（继承 `SandboxedFileSystem`，沙箱围栏不变）。
2. **提供 Remote Explorer 侧栏面板**：浏览器侧注册 `sidebar.panellist` 图标 + `main` 页面，用 JSON API（`/api/remote-workspace/*`）浏览远端目录。
3. **锚点工作区**：DSH 的工作区必须是宿主真实目录，插件在 `~/.dsh/remote-workspaces/<host>/<远端路径>` 建本地空锚点目录，并把「锚点 → 远端」的映射写进 `~/.dsh/remote-workspaces.json`。把锚点加为工作区后，右侧 **Files** 标签与文件预览就会显示远端内容。

## 安装

装进 DSH 的某个 profile（通常 `web`）：

```powershell
# 1) 从 npm（需要先发布，见 PUBLISHING.md）
dsh plugin --profile web add @<你的npm账号>/dsh-remote-workstation

# 2) 直接从 GitHub 装（不用发 npm）
dsh plugin --profile web add github:<你的GitHub账号>/dsh-remote-workstation

# 3) 本地开发：link 掉本仓库
dsh plugin --profile web add link:<本仓库的绝对路径>
```

`github:` 与 npm 方式都会跑一次 pnpm 安装并把本包追加到该 profile 的 `dsh.profile.bundles`；`link:` 只建符号链接，改代码后重启宿主即生效。

**⚠️ 影响范围**：本插件的 bundle patch 会**禁用 `fs-sandbox` 行**，并在同一服务名上挂自己的 `ctx.fs`（继承 `SandboxedFileSystem`，沙箱围栏不变）。因此装进哪个 profile，哪个 profile 的所有会话都变成「本地 + 锚点」联合文件系统；不装的 profile 不受影响。

重启 DSH Desktop（或 `dsh web`）后，左侧栏出现「远程」按钮。

想先在不影响主 GUI 的情况下试：复制一个 profile，指向同一份 `node_modules`，单独起一个宿主：

```powershell
Copy-Item ~\.dsh\profiles\web\package.json,~\.dsh\profiles\web\cordis.patch.yml,~\.dsh\profiles\web\pnpm-workspace.yaml ~\.dsh\profiles\rwtest\
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\rwtest\node_modules" "$env:USERPROFILE\.dsh\profiles\web\node_modules"
dsh --profile rwtest --port 43199 --no-open   # 打开它打印的 http://127.0.0.1:43199/?token=...
```


## 使用

### 从「远程」面板挂载

1. 左侧栏点「远程」。
2. 顶部下拉选主机（主机来自两处：本插件自己的 `~/.dsh/remote-workspaces-hosts.json` 优先，其次 `@linxin666/dsh-ssh` 的 `~/.dsh/dsh-ssh.json`；带 jump host 的配置不参与本插件的直连）。
3. 浏览目录：单击文件夹进入，「上一级」返回，路径框可直接输入后回车。
4. 目标目录上点 **挂载为工作区**：插件在 `~/.dsh/remote-workspaces/<host>/<远端路径>` 创建锚点、写入映射，并调用 `workspaces.create` 注册成工作区（已存在则提示）。
5. 在左侧工作区列表里打开这个工作区（标题形如 `my-server:/srv/project`），右侧 **Files** 标签即可看到远端文件、点开预览。

### 主机管理（插件自带，不需要 dsh-ssh）

「远程」面板底部有 **主机（N）** 区：

- 每行显示 `别名`、`host:port`、`用户`，以及来源徽章：**插件**（本插件自己的存储）/ **dsh-ssh**（从 `~/.dsh/dsh-ssh.json` 现读）。
- **测试** 连一次远端并 `realpath('.')`，返回 home 目录与耗时；失败会显示原始错误（超时/鉴权/主机名）。
- **添加主机**：别名、主机、端口、用户、认证方式（密码 / 私钥 / 无凭据走 `SSH_AUTH_SOCK` agent）、密码或私钥路径（+ 可选 passphrase）。保存后无需重启，下一次浏览/挂载即用新主机。
- **编辑 / 删除** 只对来源为 **插件** 的主机开放；`dsh-ssh` 的主机请去那边的配置改（本插件不越权写别人的文件）。
- 别名同时存在于两处时，**插件里的定义胜出**（可用来给同一台机器换端口/换账号/换私钥）。

凭据存在 `~/.dsh/remote-workspaces-hosts.json`，**明文**，写盘时按 0600 处理（Windows 上 NTFS ACL 不受 mode 影响，请自行保证用户目录权限）：

```json
{
  "version": 1,
  "hosts": [
    {
      "alias": "build-box",
      "host": "10.20.0.5",
      "port": 22,
      "user": "dev",
      "auth": { "kind": "password", "password": "..." }
    }
  ]
}
```

想把主机写进 profile 的 patch 行也可以，但密码会进 `cordis.patch.yml`，不推荐；`sshHostsPath` 可指向任意 ssh 主机文件（同 `dsh-ssh.json` 格式），因此插件既能自给自足，也能复用 dsh-ssh 的主机表。

### 为什么「工作区」标题行的 ＋ 里没有「远程」这一项

＋ 走的是上游 `single` 槽 `sidebar.workspaces.directoryFlow`，**只有一个占位者**。
本插件最初接管过它（＋ 卡片里多出「🖥 远程服务器目录…」），但 Windows 桌面的启动层
（`C:\Program Files\DSH Desktop\resources\app\lib\profile-*.js` 的 launcher 层，
在插件 patch **之后**才执行）会固定插入
`@deepseek-ai/dsh-client-ui-directory-picker-browse` 作为该槽的占位者：

- 插件抢到槽 ⇒ 内置目录选择器注册时抛 `single slot "..." already has a registration`
  ⇒ 整个客户端 boot 失败（界面报 `Renderer boot failed for 1 plugin(s)`，日志点名 browse 选择器）
- 插件让出槽 ⇒ ＋ 只能浏览本机目录

所以 v0.1 **不接管**该槽，只提供「远程」面板。真要把远端目录塞进 ＋ 卡片，可行但侵入性更大：
在 `~/.dsh/profiles/web/node_modules/@deepseek-ai/` 下放一个同名的
`dsh-client-ui-directory-picker-browse`（影子包），替换它的 UI 并加上「远程」标签页；
代价是每次升级 DSH 都要重新对齐上游实现。

注意：

- **远端可写**（0.3.0 起，`remoteReadOnly` 默认 `false`）：`write`/`edit` 工具经同一个 `ctx.fs` 契约落到远端——`createIfAbsent`、按版本令牌的 `replaceIfVersion`（版本过期报 `FS_STALE_VERSION`）、字面量 `editText`（多处命中未 `replaceAll` 报 `FS_AMBIGUOUS_EDIT`）；沙箱围栏照旧（`read-only` 拒、`workspace-write` 限锚点子树 + `/tmp`、`danger-full-access` 放行）。想维持只读就把 `remoteReadOnly` 设回 `true`。
- Files 标签的**自动刷新**（0.4.0 起）：远端 `watch` 用「轮询文件属性」实现——每 `watchIntervalMs`（默认 2000ms，最小 250）对被监视路径做一次 `stat`，版本令牌（dev/ino/size/mtime/ctime）变化就通知上层，`workspace-file/watch-unsupported` 不再出现；代价是变化最多延迟一个轮询周期，且每个被监视路径每周期一次 `stat`（不是整目录遍历）。不想要轮询可把 `watchIntervalMs` 调大。
- `@` 文件提及、回合 diff（git）仍走宿主本地路径，不会看到远端内容；这是上游按设计保留的边界（`docs/subsystems/ssh.md`："Web workspace views that assume host filesystem access need separate integration"）。
- 远端连接超时默认 15s，可在 loader 行 config 里调 `connectTimeoutMs`。
- **锚点工作区里的会话，cwd 是本地空锚点目录**：读文件/读写/列目录/Files 标签走 `ctx.fs`（到远端），但 `bash`/`terminal` 工具与内置 `glob`/`grep` 仍在本地执行（ripgrep 跑在宿主、锚点目录是空的）。0.4.0 起插件自带三个工具：`remote_exec`（在远端跑命令，返回 exitCode/stdout/stderr/durationMs，可带 `cwd`）、`remote_search`（远端递归 `grep -rInE`，返回 `path:line: text`）与 `remote_git`（在远端仓库里跑只读 git 查询：status/diff/log/show/branch/rev-parse/ls-files/blame/stash），无需再依赖 dsh-ssh。
- **凭据存储**：`~/.dsh/remote-workspaces.json`（挂载表）只存 `alias/host/port/user`；凭据来源有两处——本插件自己的 `~/.dsh/remote-workspaces-hosts.json`（面板里添加的主机，明文、0600），以及 `~/.dsh/dsh-ssh.json`（dsh-ssh 的主机表，现读）。两者都没有该主机时不会静默退化成 agent 鉴权，而是直接报
  `remote workspace: no credentials for host "<alias>" — add a password or a private key for it in the DSH SSH host store (~/.dsh/dsh-ssh.json, 侧栏「远程」→ 主机列表来自该文件)`
  （旧版会报 `All configured authentication methods failed`）。
- **改了插件代码之后**：客户端 bundle 变化 → **刷新页面**（Ctrl+R）即可；宿主侧（`ctx.fs` 提供方）变化 → 必须**重启 DSH Desktop / `dsh web` 宿主进程**。桌面版有 `patchReload: live`，但只对配置行生效，不会因插件源码变化重载宿主侧。
- **v0.1.1 已知回归修复**：0.1.0 曾接管 `sidebar.workspaces.directoryFlow`，在 Windows 桌面会导致内置 browse 目录选择器注册失败、整页 `Renderer boot failed for 1 plugin(s)`。0.1.1 移除了该注册，仅保留「远程」面板；如仍看到该报错，请确认 `lib/client.js` 里不再含 `directoryFlow`，并彻底退出重开 DSH Desktop。
- **主机凭据改动后**：不用重启，插件在下一次连接时现读 `~/.dsh/dsh-ssh.json`；挂载表文件被外部改动也会自动重载。

## 权限与审批（0.5.0）

远程工作区沿用 DSH 自己的权限模型：会话的**预设**（完全权限 / workspace-write / 只读 / 自动审查）决定 sandbox 模式与 approval 策略，插件在每次调用时读取**当前**策略——会话中途切换预设立即生效。

| 会话模式 | 远端读（`read`、Files 标签、`remote_search`、只读 git） | 远端写（`write`/`edit`） | 远端命令（`remote_exec`、`git stash`） |
| --- | --- | --- | --- |
| `danger-full-access`（完全权限；自动审查跑在它之上） | 允许 | 允许 | 允许，无提示 |
| `workspace-write`（默认） | 允许 | 仅锚点子树内（外加 `/tmp` 与宿主临时目录） | 拒绝；需带 `sandbox_permissions: "danger-full-access"` + 一句 `justification` 升级 |
| `read-only` | 允许 | 拒绝（`FS_SANDBOX_DENIED`） | 同上，走升级审批 |

拒绝的表现取决于预设自带的 approval 策略：`ask` 会弹出 DSH 标准审批框（`允许本次操作使用 danger-full-access 权限：…`），`never` 直接失败关闭（`the user rejected escalating this command to "danger-full-access"; it stays denied`）。

`workspace-write` 不作为远端命令的升级目标——宿主侧没有任何沙箱能约束跑在另一台机器上的进程，唯一有意义的目标是 `danger-full-access`，也正是 DSH 会向你确认的那一步。

**自动审查**（预设 `auto`，= `danger-full-access` + `ask`）无需插件适配：它挂在 `tools/pre-execute` 上，对会话里所有工具一视同仁，`remote_exec` / `remote_git` 与 `bash` 由同一个 reviewer 判风险——低风险放行、未知或大范围改动拒绝或升级给你。

## 远端 shell（0.6.0，可选）

上面所有能力都是"把文件操作送到服务器"。agent 用的 shell（POSIX 上是 `bash`、Windows 上是 `pwsh`）仍在宿主跑，所以在锚点会话里执行 `npm test` 只会在本地空锚点目录里跑。**远端 shell 路由**把这类命令也搬到服务器：同一个会话、同一个工作区、同一套审批，只要命令的 `cwd` 在锚点内，就发到 SSH 主机上执行。

启用方式：把 [`examples/cordis.remote-shell.yml`](../examples/cordis.remote-shell.yml) 里的两行粘到 profile 的 `cordis.patch.yml`（桌面版：`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`）。这两行**原地改写**已有的 `bash-sandbox` / `pwsh-sandbox` 加载行：

| 方面 | 启用后的行为 |
| --- | --- |
| `cwd` 在锚点内的命令 | 经 SSH exec 通道流式执行；stdout/stderr、退出码、超时、后台任务与本地一致（宿主启动一个小 helper 进程把通道接到自己的管道上） |
| `cwd` 在锚点外的命令 | 完全保持本地行为，包括原有沙箱 |
| shell 方言 | 命令串由**远端** POSIX shell 解释（宿主是 Windows 也一样） |
| 约束 | 跑在另一台机器上的进程无法被宿主沙箱约束 ⇒ 只有调用本身的 sandbox 模式是 `danger-full-access` 时才执行；否则报错并提示模型申请升级（走正常审批弹窗） |
| `terminal`（交互 PTY）、内置 `glob`/`grep`、LSP、`@` 提及、回合 diff | 仍然在宿主本地（远端请用 `remote_search` / `remote_exec`） |

为什么不默认开启：Windows 桌面版的 launcher 会把 `pwsh-sandbox` 行替换成它自己的 ACL 沙箱执行器，原地改写会绕过那层 ACL 约束。所以这是显式取舍：agent 获得真正的远端 shell，远端命令改用审批模型把关，而不是宿主沙箱。


## 验收记录（2026-10-24，真实 DSH 宿主）

隔离宿主：复制 web profile 到 `~/.dsh/profiles/rwtest`（`node_modules` 用 junction 指向 web），`dsh --profile rwtest --port 43199 --no-open` 启动。

| 检查 | 结果 |
| --- | --- |
| 插件 host 半边加载 | 无报错（`/api/remote-workspace/ping` 返回 `{service:'remote-workspace'}`） |
| 客户端半边进 boot roster | 首页 preload 清单里含 `dsh-remote-workstation/client.js` |
| 经 `ctx.fs` 读远端（`read` 动作） | `targetKey = rw://my-server/tmp/dsh-remote-workspace-fixture/hello.txt`，39 字节 |
| typert `workspace/create` 用锚点建工作区 | 成功，`workspaceId=f10562b9-…`，`path` = 锚点目录 |
| `session/create`（cwd=锚点）→ `workspaceFiles/list` | 返回**远端**条目：`big.txt` 200000、`binary.bin` 64、`hello.txt` 39、`sub/` |
| `workspaceFiles/read`（Files 标签预览） | 返回远端文本，version 令牌 `0:0:39:1792810431000:1792810431000`（远端派生，本地文件不会有这种形状） |
| 子目录 `sub` 列表 | `notes.md` 31 字节（锚点子路径映射正确） |
| 同宿主 cwd=`D:\WorkStation` 的会话 | 仍正常列出本地目录（无回归） |
| 凭据 | 存储文件无 password/passphrase/keyPath |
| 凭据现读（把 pool 内存记录故意剥掉 auth 后再连） | 连接成功，`entries: big.txt,binary.bin,hello.txt,sub`；未知主机报 `no credentials for host ...` |
| 主机凭据改动后自动重载 | 改 `dsh-ssh.json` 密码 → `refresh()` 后池内记录变为新密码 |
| 自有主机存储（0.2.0） | `hostSave` → `{alias:'verify-box',host:'192.0.2.9',port:2200,user:'dev',source:'plugin'}`；`hosts` 同时列出插件主机与 dsh-ssh 主机（带 `source` 字段），`hostRemove` 删除插件主机 |
| 自有主机优先 | 同名 alias 在插件存储里覆盖 `dsh-ssh.json` 的连接参数与凭据 |
| `hostTest` 错误面 | 不可达主机 → 400 `cannot connect to "verify-box" (dev@192.0.2.9:2200): connection timed out after 15000 ms` |
| 远端写入（0.3.0） | `createIfAbsent` 新建 / 再次 `createIfAbsent` → `FS_NOT_OBSERVED`；`replaceIfVersion` 成功、旧版本 → `FS_STALE_VERSION`；`editText` 成功、缺失 → `FS_EDIT_NOT_FOUND`、多处命中未 `replaceAll` → `FS_AMBIGUOUS_EDIT` |
| `remote_exec`（0.3.0） | `uname -srm && cat hello.txt` → `exitCode 0`、`Linux 5.10.0-… aarch64`、290ms |
| `remote_search`（0.3.0） | `pattern:"second line"` → `./hello.txt:2:second line`；`glob:"*.md"` → `./sub/notes.md:1:# notes` |
| 远端 `watch`（0.4.0） | 真实 SSH：改文件内容后 5s 内收到回调；`close()` 幂等、close 后 700ms 内无回调 |
| `remote_git`（0.4.0） | `status --short` → `exitCode 0`、` M app.txt`、288ms；`diff --stat` → ` app.txt \| 1 +`；`push` → 400 白名单拒绝 |
| 二进制/图片预览（0.4.0） | `workspaceFiles/readBytes`（multipart）返回远端 70 字节 PNG（magic `89504e47`），metadata `version:"0:0:70:…"`、`eof:true` |
| 单元测试 | `node --test` 41 例（离线默认 34 通过 + 7 例 SSH 集成用例自动跳过；设 `DSH_RW_REMOTE_HOST` 可全跑） |
| 客户端 bundle 服务端可解析 | `plugins/??dsh-remote-workstation/client.js&rev=…` → 200、20 KB、`new vm.Script()` 通过 |


## 配置（`cordis.patch.yml` 的 loader 行）

```yaml
- id: fs-sandbox
  disabled: true
- insert:
    - id: remote-workspace
      name: dsh-remote-workstation
      config:
        storePath: ~/.dsh/remote-workspaces.json   # 挂载表
        sshHostsPath: ~/.dsh/dsh-ssh.json          # 主机来源之一（dsh-ssh 的配置）
        hostsPath: ~/.dsh/remote-workspaces-hosts.json  # 插件自有主机表（面板「主机」区维护，含明文凭据、0600）
        anchorRoot: ~/.dsh/remote-workspaces       # 锚点目录根
        remoteReadOnly: false                      # true = 拒绝一切远端写入
        enableTools: true                          # 注册 remote_exec / remote_search / remote_git
        watchIntervalMs: 2000                      # 远端 watch 轮询间隔（最小 250）
        connectTimeoutMs: 15000
        maxReadTextBytes: 33554432                 # 单次 readText 上限 32 MiB
        # 也可以静态声明挂载（不落盘）：
        # mounts:
        #   - host: my-server
        #     remote: /srv/project
```

必须把 `fs-sandbox` 这一行禁用：`ctx.fs` 服务一个组合只能有一个提供方（`dsh-base/README.zh.md`），本插件的提供方已经继承了它的沙箱围栏。

## 故障排查

- **桌面端添加远程目录时闪退（0.4.1 已修复）**：ssh2 把握手超时报成连接对象上的 `error` 事件，而没有任何 `error` 监听者的 EventEmitter 会直接抛出。在 DSH 宿主进程里表现为
  `fatal uncaught exception: Error: Timed out while waiting for handshake` + `DSH Host exited (1)`（2026-10-25 日志里两次崩溃都是这一条）。
  现在连接池在 `connect()` 之前就永久挂上 `error`/`close` 监听、关掉 ssh2 自带的握手定时器（`readyTimeout: 0`）、SFTP 会话也加了 `error` 监听，超时只让调用方收到
  `cannot connect to "<alias>" (<user>@<host>:<port>): connection timed out after <n> ms`。回归用例见 `test/pool-errors.test.mjs`。
  用旧代码复现的原始输出：`Unhandled 'error' event: Error: Timed out while waiting for handshake { level: 'client-timeout' }` → 进程直接退出。
- **"All configured authentication methods failed"**：该主机没有可用的凭据。打开「远程」面板 → 主机 → 编辑，填密码或私钥路径（也可以用 ssh-agent）。

## 限制与后续阶段

- 阶段 2（0.3.0 已实现）：`writeText` / `editText`（SFTP 写入 + mtime/size 版本令牌 + 原子替换语义）、`remote_exec` 与 `remote_search` 工具（内置 `glob`/`grep` 走宿主 ripgrep 二进制，不经过 `ctx.fs`，因此远端目录要用插件工具）。
- 阶段 3（0.4.0 已实现）：远端 `watch` 轮询（`watchIntervalMs`，默认 2000ms，最小 250）、`remote_git` 工具与 `/api/remote-workspace/git` 动作（只读子命令白名单）、图片/二进制预览（`readBytes`/`readByteRange` 走真实 SFTP，PNG 字节端到端验证通过）。
- 远端 shell 路由（0.6.0，可选）：`examples/cordis.remote-shell.yml` 原地改写 `bash-sandbox` / `pwsh-sandbox` 行，锚点内的 `bash`/`pwsh` 命令改在服务器执行；仅 `danger-full-access` 放行远端命令。`test/shell-remote.test.mjs` 覆盖路由、围栏与真实 `ctx.shell` 执行（4 例）。
- 已知边界：远端刷新是轮询不是推送；SFTP 的 mtime 精度为秒（同秒内等长等 mtime 的重写无法区分）；`@` 提及与回合 diff 仍走宿主路径（上游边界），要看远端仓库请用 `remote_git`；`processPath()` 返回锚点宿主路径（因此「在文件管理器中打开」可用）；远端 shell 只覆盖 `bash`/`pwsh`，交互式 `terminal`、内置 `glob`/`grep`、LSP 仍在宿主本地，且远端命令绕过了宿主沙箱（因此要求 `danger-full-access`）。
