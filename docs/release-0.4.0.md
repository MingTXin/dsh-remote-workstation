## 新增 / New

- **远端 watch（轮询）**：`watchIntervalMs`（默认 2000ms，最小 250）。Files 标签不再报 `workspace-file/watch-unsupported`，外部改动最多延迟一个轮询周期出现。
  *Polling remote `watch`: the Files tab no longer fails with `workspace-file/watch-unsupported`.*
- **`remote_git` 工具 / `/api/remote-workspace/git`**：在远端仓库执行只读 git 查询（status/diff/log/show/branch/rev-parse/ls-files/blame/stash），其它子命令直接拒绝；面板新增「Git 状态」按钮。
  *`remote_git` tool plus a Git status button in the panel; only read-only subcommands are allowed.*
- **图片/二进制预览**：`readBytes`/`readByteRange` 走真实 SFTP 字节窗口，图片、PDF、Excel、Office 预览对远端文件可用。
  *Binary and image previews work through real SFTP byte windows.*

## 验证 / Verification

- 23 个测试：离线 19 通过 + 4 个 SSH 门控用例（本地真实主机 23/23，22.1s）
- 真实宿主：`readBytes` multipart 返回远端 70 字节 PNG（version `0:0:70:…`、`eof:true`）；`git status --short --branch` → `## master` + ` M app.txt`（309ms）；`git diff --stat` 正常；`push` 被白名单拒绝
- 客户端 bundle 已确认包含「Git 状态」按钮与主机管理区
- CI：syntax-check + `npm pack --dry-run`

## 升级 / Upgrade

```bash
dsh plugin --profile web add github:MingTXin/dsh-remote-workstation
```

宿主侧代码有变化，升级后需重启 DSH Desktop；客户端 bundle 只需刷新页面。
*Host-side code changed: restart DSH Desktop after upgrading (a page refresh is enough for the client bundle).*
