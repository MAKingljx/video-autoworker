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

默认运行数据位于 `~/ai-worker/state/n8n`，日志位于 `~/ai-worker/logs/n8n`，PID 位于 `~/ai-worker/run/n8n`，备份位于 `~/ai-worker/backups/n8n`。这些目录均在仓库外，可在外部环境文件中修改。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `scripts/n8n-install.sh` | 创建外部环境、生成 256 位加密密钥并用 `npm ci` 安装锁定依赖 |
| `scripts/n8n-start.sh` | 优先通过 LaunchAgent 启动，否则以受管后台进程启动；等待 `/healthz` |
| `scripts/n8n-stop.sh` | 优雅停止 LaunchAgent 或已核验的 n8n 进程，不自动发送 `SIGKILL` |
| `scripts/n8n-status.sh` | 显示版本、路径、LaunchAgent、PID 和健康状态 |
| `scripts/n8n-import-workflows.sh` | 在 n8n 停止时备份状态，以固定 ID 导入并默认发布工作流 |
| `scripts/n8n-install-launch-agent.sh` | 渲染、备份旧配置、安装并启动当前用户的 LaunchAgent |
| `ops/n8n/workflows/aiworker-task-intake.json` | `Webhook -> 字段整理 -> 202 JSON 响应` 的最小闭环 |

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

然后再次执行安装脚本。脚本始终使用 `package-lock.json` 和 `npm ci`，并在结束时断言实际安装版本等于 `2.31.6`。

## 导入样例工作流

n8n CLI 离线导入期间不能让服务同时写 SQLite。脚本会同时检查 LaunchAgent、受管 PID 和 `/healthz`，发现 n8n 仍在运行时会拒绝继续；已有状态及与之配套的外部加密环境文件会一起备份到仓库外并生成 SHA-256：

```bash
bash scripts/n8n-stop.sh
bash scripts/n8n-import-workflows.sh
bash scripts/n8n-start.sh
```

导入脚本默认执行无人值守的 `unpublish（仅已存在时） -> import:workflow -> publish:workflow`，并用活动工作流清单复核固定 ID 只存在一份。若仅需导入草稿，可显式执行：

```bash
bash scripts/n8n-import-workflows.sh --no-activate
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
  "source": "video-autoworker",
  "routing": {
    "taskType": "summarize",
    "agentRole": "editor",
    "model": "qwen-local"
  },
  "input": {
    "text": "测试任务"
  }
}
```

成功响应 HTTP `202`，包含 `accepted`、`taskId`、`idempotencyKey`、模型路由、原始 `input` 和 `receivedAt`，便于控制台和执行日志核对同一任务。

当前样例只使用 Webhook、Edit Fields 和 Respond to Webhook 三个内置 JavaScript 节点，不依赖 Python Task Runner。原生 macOS 启动时若提示缺少内部 Python runner，对这条工作流不构成阻塞；后续真正加入 Python Code 节点前，应按 n8n 官方要求单独部署 external task runner，不能把该提示当作已具备 Python 执行能力。

## 安装 macOS LaunchAgent

依赖和工作流验证后安装当前用户服务：

```bash
bash scripts/n8n-install-launch-agent.sh
bash scripts/n8n-status.sh
```

模板会渲染为 `~/Library/LaunchAgents/com.video-autoworker.n8n.plist`。若目标文件已存在且内容变化，旧文件先备份到仓库外的 `~/ai-worker/backups/n8n-launchagent-*`。LaunchAgent 使用外部环境文件，标准输出和错误日志也写到仓库外。

日常操作：

```bash
bash scripts/n8n-start.sh
bash scripts/n8n-status.sh
bash scripts/n8n-stop.sh
```

## Video AutoWorker 配置

以下变量属于 Video AutoWorker 服务环境，不写入代码仓库：

```bash
N8N_BASE_URL="http://127.0.0.1:5678"
N8N_DEFAULT_WEBHOOK_PATH="webhook/aiworker-task"
N8N_API_KEY="<在 n8n UI 中创建的 API key>"
N8N_WEBHOOK_SECRET="<可选的共享秘密>"
```

`N8N_API_KEY` 用于控制台读取 n8n 工作流与执行记录。样例工作流部署在仅回环监听的可信边界内，未绑定凭据；如果以后将 Webhook 暴露到其他主机，必须先给 Webhook 配置 Header Auth 或在入口反向代理验证 `X-AIWorker-Webhook-Secret`，不能原样公网开放。样例会携带并回显幂等键作为关联证据，但不会持久化去重；任何产生外部副作用的正式工作流都必须在执行副作用前增加持久化幂等检查。

在 Video AutoWorker 的任务链配置中创建绑定时，填写：

- 工作流 ID：从 n8n UI 或管理 API 读取。
- Webhook 路径：`webhook/aiworker-task`。
- 任务类型、Agent 角色和模型：按实际任务路由填写。
- 超时和重试：n8n 负责确定性流程重试；不要与后续 LangGraph 的节点级重试重复叠加。

## 验收

先检查 n8n 自身：

```bash
bash scripts/n8n-status.sh
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
4. `git status --short` 不出现数据库、日志、PID、环境文件或备份。

## 升级与回退

升级时不要直接执行 `npm update`。应在开发仓库中同时修改 `ops/n8n/package.json` 的精确版本、重新生成并审查 `package-lock.json`，完成离线导入与真实 Webhook 回归后再提交。生产部署前备份整个外部 n8n 状态和环境文件，随后只从 GitHub 拉取并重新执行 `scripts/n8n-install.sh`。

回退时恢复原 Git 提交、用该提交的 lockfile 重新 `npm ci`，并在 n8n 数据库发生迁移时同时恢复升级前的外部状态备份；不能只降级二进制而继续使用已迁移的新数据库。
