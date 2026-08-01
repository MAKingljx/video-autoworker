# n8n 单机生产部署与 Git 管理

## 目标与边界

本方案在同一台 Mac Studio 上把 n8n 作为 Video AutoWorker 的确定性工作流调度层，固定使用 `n8n 2.31.6` 和 `Node.js >= 22.22`。n8n 仅监听 `127.0.0.1:5678`，Video AutoWorker 通过本机回环地址调用，默认不把编辑器或 Webhook 暴露到公网。

进入 GitHub 的内容：

- `ops/n8n/package.json` 与 `package-lock.json`：固定 n8n 及完整依赖树。
- `ops/n8n/workflows/*.json`：脱敏的工作流定义。
- `ops/n8n/launchd/*.template`：不含用户名、路径和密钥的 LaunchAgent 模板。
- `ops/n8n/.env.example`：无密钥配置模板。
- `scripts/n8n-*.sh`：安装、启停、状态、导入和 LaunchAgent 安装脚本。

不得进入 GitHub 的内容：

- SQLite 数据库、用户账户、凭据和加密密钥。
- 运行日志、PID、缓存、导入前备份和临时文件。
- 实际生产环境文件及其中的 `N8N_API_KEY`、Webhook 密钥等秘密。

GitHub 仓库是唯一源码；安装脚本会在 `~/ai-worker/services/video-autoworker-n8n/releases/<git-commit>/` 中按锁文件构建不可变运行版本，再将 `current` 软链接原子切到通过校验的新版本。控制脚本、工作流、依赖和清单都复制自同一个 Git 提交，不链接回仓库。这样 macOS LaunchAgent 不需要访问受隐私保护的 `Documents` 目录。默认运行数据位于 `~/ai-worker/state/n8n`，日志位于 `~/ai-worker/logs/n8n`，PID 位于 `~/ai-worker/run/n8n`，备份位于 `~/ai-worker/backups/n8n`。这些目录均在仓库外，可在外部环境文件中修改。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `scripts/n8n-install.sh` | 创建外部环境、生成 256 位加密密钥，并在仓库外生成可追溯到 Git commit 的运行副本 |
| `scripts/n8n-start.sh` | 优先通过 LaunchAgent 启动，否则以受管后台进程启动；等待 `/healthz` |
| `scripts/n8n-stop.sh` | 优雅停止 LaunchAgent 或已核验的 n8n 进程，不自动发送 `SIGKILL` |
| `scripts/n8n-status.sh` | 显示版本、路径、LaunchAgent、PID 和健康状态 |
| `scripts/n8n-import-workflows.sh` | 在 n8n 停止时备份状态，以固定 ID 导入并默认发布工作流 |
| `scripts/n8n-install-launch-agent.sh` | 渲染、备份旧配置、安装并启动当前用户的 LaunchAgent |
| `ops/n8n/workflows/aiworker-task-intake.json` | `Webhook -> 字段整理 -> 202 响应 -> 本地 OpenClaw 执行` 的任务闭环 |
| `scripts/install-platform-env.sh` | 在仓库外初始化并保留 Video AutoWorker 与 n8n 共享密钥 |
| `scripts/install-aiworker-task-flow-skill.sh` | 备份后安装 OpenClaw 任务提交技能 |

## 首次安装

以下命令必须在远端真实生产仓库的根目录执行。部署前先确认仓库 remote、当前分支和提交，再从 GitHub 快进拉取：

```bash
git remote -v
git status --short
git pull --ff-only
```

Node 默认路径为 `~/ai-worker/node/current/bin/node`，可在安装前或安装后通过外部环境文件修改。首次安装：

```bash
export AIWORKER_N8N_ENV_FILE="$HOME/.config/video-autoworker/n8n.env"
bash scripts/n8n-install.sh
```

安装器只在外部环境文件不存在时创建文件，并在其中生成随机 `N8N_ENCRYPTION_KEY`。已有文件会保留，不会重置密钥。这个密钥一旦用于加密凭据就不能随意更改，必须与数据库一起备份。

如 Node 22 位于其他位置，编辑外部环境文件中的两行：

```bash
N8N_NODE_BIN="/absolute/path/to/node"
N8N_NPM_BIN="/absolute/path/to/npm"
```

然后再次执行安装脚本。脚本要求 Git 工作树干净，把当前提交中的控制脚本、公共库、工作流、`package.json` 和 `package-lock.json` 复制到临时 release，再执行 `npm ci`、版本断言和逐文件 SHA-256 校验；运行清单本身还会与干净 Git 源码重新计算出的清单哈希交叉核对，不能由 release 自证完整性。全部成功后才用同目录临时链接和原子 rename 切换 `current`。`SOURCE_COMMIT` 与 `SOURCE_MANIFEST` 会记录来源提交、脱敏 remote、lock/workflow SHA-256 和 n8n 版本。切换前若已有状态，脚本会把数据库状态、对应加密环境、切换前/目标 release 清单和 `RELEASE_TRANSITION` 一起备份。不要直接编辑生成的运行副本，任何变更都应先进入 GitHub 再重装。

## 导入样例工作流

n8n CLI 离线导入期间不能让服务同时写 SQLite。脚本会同时检查 LaunchAgent、受管 PID 和 `/healthz`，发现 n8n 仍在运行时会拒绝继续；已有状态及与之配套的外部加密环境文件会一起备份到仓库外并生成 SHA-256：

```bash
runtime="$HOME/ai-worker/services/video-autoworker-n8n/current"
bash "$runtime/scripts/n8n-stop.sh"
bash "$runtime/scripts/n8n-import-workflows.sh"
```

首次部署在导入后直接继续安装下文的 LaunchAgent，由 LaunchAgent 完成首次启动。已有 LaunchAgent 的升级导入则在上述命令后执行 `bash "$runtime/scripts/n8n-start.sh"` 恢复服务。

导入脚本默认执行无人值守的 `unpublish（仅已存在时） -> import:workflow -> publish:workflow`，并用活动工作流清单复核固定 ID 只存在一份。若仅需导入草稿，可显式执行：

```bash
runtime="$HOME/ai-worker/services/video-autoworker-n8n/current"
bash "$runtime/scripts/n8n-import-workflows.sh" --no-activate
```

首次打开 `http://127.0.0.1:5678` 仍需完成 n8n 所有者账号初始化，以便创建供 Video AutoWorker 使用的管理 API Key；工作流的导入和发布本身不依赖 UI 操作。若人在另一台电脑上操作远端 Mac，可使用经过身份校验的 SSH 本地端口转发访问，仍不要直接暴露 5678：

```bash
ssh -L 5678:127.0.0.1:5678 heisenbergs-1
```

样例工作流固定 ID 为 `aiworker-task-intake-v1`。重复部署时先取消旧发布状态，再按相同 ID 更新，不产生第二份工作流。n8n 2.31.6 实际导入、二次导入、发布和导出验证后的 Webhook 生产路径为：

```text
/webhook/aiworker-task
```

它接收 Video AutoWorker `/api/n8n/trigger` 生成的结构：

```json
{
  "taskId": "task-001",
  "idempotencyKey": "task-001",
  "source": "openclaw",
  "requestedBy": "local-desktop",
  "routing": {
    "taskType": "summarize",
    "agentRole": "editor",
    "model": "qwen-local"
  },
  "input": {
    "text": "测试任务"
  },
  "delivery": {
    "mode": "none"
  }
}
```

工作流先响应 HTTP `202`，再把同一 `taskId` 和幂等键回调到回环地址 `/api/n8n/execute`。该接口从 SQLite 读取已持久化的路由、输入和回投目标，调用指定 OpenClaw profile/agent/model，并把成功输出或失败原因写回 `n8n_task_runs`。相同幂等键不会重复创建任务；已经成功的任务直接返回缓存结果，失败任务只会在绑定配置的最大尝试次数内重试。

当前样例只使用 Webhook、Edit Fields、Respond to Webhook 和 HTTP Request 四个内置节点，不依赖 Python Task Runner。共享密钥只存在仓库外的 Video AutoWorker 环境文件中：控制台发给 n8n，n8n 从入站 Header 原样转给回环执行接口，工作流 JSON 本身不保存密钥。原生 macOS 启动时若提示缺少内部 Python runner，对这条工作流不构成阻塞；后续真正加入 Python Code 节点前，应按 n8n 官方要求单独部署 external task runner。

## 安装 macOS LaunchAgent

依赖和工作流验证后安装当前用户服务：

```bash
bash scripts/n8n-install-launch-agent.sh
runtime="$HOME/ai-worker/services/video-autoworker-n8n/current"
bash "$runtime/scripts/n8n-status.sh"
```

模板会渲染为 `~/Library/LaunchAgents/com.video-autoworker.n8n.plist`。若目标文件已存在且内容变化，旧文件先备份到仓库外的 `~/ai-worker/backups/n8n-launchagent-*`。LaunchAgent 使用外部环境文件，执行路径和工作目录指向 `~/ai-worker/services/video-autoworker-n8n/current`，标准输出和错误日志也写到仓库外；它不会直接从 `Documents` 下的 Git 工作树启动。安装 LaunchAgent 前还会确认 `current/SOURCE_COMMIT` 与仓库 HEAD 完全一致。

日常操作：

```bash
runtime="$HOME/ai-worker/services/video-autoworker-n8n/current"
bash "$runtime/scripts/n8n-start.sh"
bash "$runtime/scripts/n8n-status.sh"
bash "$runtime/scripts/n8n-stop.sh"
```

## Video AutoWorker 配置

先在真实生产仓库根目录初始化外部平台环境，再重启 3017 服务。脚本为现有文件补齐空的共享密钥，但保留已有非空值；密钥不会打印到终端：

```bash
bash scripts/install-platform-env.sh
chmod 600 "$HOME/.config/video-autoworker/platform.env"
```

以下变量属于 Video AutoWorker 服务环境，不写入代码仓库：

```bash
N8N_BASE_URL="http://127.0.0.1:5678"
N8N_DEFAULT_WEBHOOK_PATH="webhook/aiworker-task"
N8N_API_KEY="<完成所有者初始化后在 n8n UI 创建的 API key>"
N8N_WEBHOOK_SECRET="<安装脚本生成的随机共享密钥>"
```

`N8N_API_KEY` 只用于控制台读取 n8n 管理 API，未配置时不阻塞 Webhook 执行闭环。`N8N_WEBHOOK_SECRET` 是 n8n 回调 `/api/n8n/execute` 的必需认证信息，不能留空。任务及幂等状态由 Video AutoWorker 的 SQLite 持久化；数据库、外部环境文件和 n8n 状态必须作为同一生产备份链管理。如果以后将 Webhook 暴露到其他主机，还必须在入口反向代理或 n8n Webhook 层增加独立认证，不能仅依赖回环部署假设。

## OpenClaw 任务入口

把版本化技能安装到 `qwen-current` 的第二原始 Agent 工作区：

```bash
bash scripts/install-aiworker-task-flow-skill.sh
openclaw --profile qwen-current skills info aiworker-task-flow --agent second-original
```

技能脚本只允许访问本机回环地址。OpenClaw 可以提交任务并查询持久化状态：

```bash
node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs" \
  --prompt '只输出：闭环成功'

node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs" \
  --status '<上一步返回的 taskId>'
```

默认 `delivery.mode=none`，结果仅保存在任务运行记录中。要把结果回投到已有手机会话，必须显式传入 `--delivery reply --session-key '<已验证会话键>'`，或同时给出 `--channel` 与 `--target`；不得把测试消息投递到未经确认的会话。

`/automation` 页面提供“打开 n8n 编辑器”和按需“嵌入 n8n 编辑器”两个入口。n8n 继续只监听回环地址，不直接暴露公网；从远端电脑访问时，应在同一条 SSH 连接中同时转发控制台和 n8n 端口：

```bash
ssh -N \
  -L 3017:127.0.0.1:3017 \
  -L 5678:127.0.0.1:5678 \
  heisenbergs-1
```

然后访问 `http://127.0.0.1:3017/automation`。内嵌时控制台和 n8n 必须使用相同的回环主机名；当前默认统一使用 `127.0.0.1`，不要混用 `localhost` 或 `::1`。如果页面并非通过本机回环地址打开，而配置的 n8n 仍是回环地址，页面会停用编辑器入口，避免把手机或另一台客户端自己的 `127.0.0.1` 误当作 Mac Studio。HTTPS 控制台也不会内嵌 HTTP 编辑器；这种情况应使用新窗口或部署经过验证的 HTTPS 私网入口。

在 Video AutoWorker 的任务链配置中创建绑定时，填写：

- 工作流 ID：从 n8n UI 或管理 API 读取。
- Webhook 路径：`webhook/aiworker-task`。
- 任务类型、Agent 角色和模型：按实际任务路由填写。
- 超时和重试：n8n 负责确定性流程重试；不要与后续 LangGraph 的节点级重试重复叠加。

## 验收

先检查 n8n 自身：

```bash
runtime="$HOME/ai-worker/services/video-autoworker-n8n/current"
bash "$runtime/scripts/n8n-status.sh"
curl --fail --silent http://127.0.0.1:5678/healthz
```

工作流激活后直接验证 Webhook：

```bash
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  -H 'X-AIWorker-Idempotency-Key: smoke-001' \
  --data '{"taskId":"smoke-001","idempotencyKey":"smoke-001","source":"video-autoworker","routing":{"taskType":"smoke","agentRole":"orchestrator","model":"none"},"input":{"message":"hello"}}' \
  http://127.0.0.1:5678/webhook/aiworker-task
```

最终还应从 Video AutoWorker 页面或 API 发起一次真实绑定触发，确认：

1. `/api/n8n/status` 显示健康且可读取工作流。
2. `/api/n8n/trigger` 返回同一个 `taskId` 和 n8n 的 `202` 响应。
3. n8n 执行记录中存在对应执行且没有凭据或输入敏感信息泄漏。
4. `/api/n8n/runs` 中同一任务依次进入 `accepted/running/succeeded`，输出包含实际 provider/model 证据。
5. 使用同一幂等键再次提交时不产生第二次模型调用，并返回已有任务或缓存结果。
6. 经确认的手机会话收到一次真实回投，且输出与任务运行记录一致。
7. `git status --short` 不出现数据库、日志、PID、环境文件或备份。

## 升级与回退

升级时不要直接执行 `npm update`。应在开发仓库中同时修改 `ops/n8n/package.json` 的精确版本、重新生成并审查 `package-lock.json`，完成离线导入与真实 Webhook 回归后再提交。生产部署前备份整个外部 n8n 状态和环境文件，随后只从 GitHub 拉取并重新执行 `scripts/n8n-install.sh`，由脚本刷新仓库外运行副本。

回退时先停止 n8n，按备份目录的 `RELEASE_TRANSITION` 把 `current` 切回 `previous_release`，并恢复同目录成套保存的数据库状态和加密环境，再启动并复验健康检查与 Webhook。不能只切旧 `node_modules` 而继续使用可能已经迁移的新数据库；`previous-release-manifest`、`target-release-manifest`、GitHub 提交和 SHA-256 清单必须能够相互核对。
