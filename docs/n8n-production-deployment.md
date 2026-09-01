# n8n 单机生产部署与 Git 管理

## 目标与边界

本方案在同一台 Mac Studio 上把 n8n 作为 Video AutoWorker 的确定性工作流调度层，固定使用 `n8n 2.31.6` 和 `Node.js >= 22.22`。OpenClaw 负责提交任务；通用链依次编排 `planner`、`executor`、`reviewer`，视频链则执行“受控收件箱 → ffmpeg 预处理 → 音频/画面无状态分支执行 → 确定性合并”。每个生成模型节点都从外部注册表选择本地模型或云端模型 API，不在工作流 JSON 中固定供应商或密钥。n8n 仅监听 `127.0.0.1:5678`，Video AutoWorker 通过本机回环地址调用，默认不把编辑器或 Webhook 暴露到公网。

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
| `ops/n8n/workflows/aiworker-task-intake.json` | `Webhook -> 202 响应 -> 规划 -> 执行 -> 审核/回投` 的三模型节点闭环 |
| `ops/n8n/workflows/aiworker-video-analysis.json` | `Webhook -> 视频预处理 -> 音频/画面独立无状态分支 -> 合并` 的视频分析闭环 |
| `ops/model-routing/model-routes.example.json` | 无密钥的本地/云端模型注册表示例 |
| `scripts/install-model-routes.sh` | 在仓库外初始化并保留模型注册表 |
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

## 离线导入并发布受管工作流

n8n CLI 离线导入期间不能让服务同时写 SQLite。导入器会同时检查 LaunchAgent、受管 PID 和
`/healthz`，发现 n8n 仍在运行时拒绝继续；它只接受 release 内按固定顺序提供的两条受管工作流，
并强制执行 `unpublish（仅已存在时） -> import:workflow -> publish:workflow`。无参数调用和
`--no-activate` 都会失败关闭，不能把未发布草稿留作首次蓝绿迁移的目标状态。

每次导入都必须先建立独立的 mode `0700` transition 目录和受管回滚包，再生成绑定权威 n8n
SQLite、目标完整提交、受管 n8n runtime 与 application release 的不可变意图。以下命令只展示
参数合同；路径、UUID、提交、槽位与 release 必须来自本次已复核维护计划：

```bash
runtime_release=/absolute/path/releases/<40-character-commit>
application_release=/absolute/path/application-releases/<release-id>/standalone
transition_dir=/absolute/private-state/workflow-transition

node "$runtime_release/scripts/n8n-workflow-transition-anchor.mjs" prepare-intent \
  --upgrade-id <one-current-uuid> \
  --database /absolute/path/database.sqlite \
  --rollback-package /absolute/path/recovery-package \
  --runtime-root "$runtime_release" \
  --target-commit <40-character-commit> \
  --slot <blue-or-green> \
  --release-id <application-release-id> \
  --application-release-root "$application_release" \
  --output "$transition_dir/upgrade-intent.json"
```

运维人员必须先审阅意图、实际备份、权威数据库与目标 release，再对“本次生产工作流写入”作出
明确确认。`operator-token` 必须由外部受控确认步骤当次提供为 mode `0400` 的单个 64 位十六进制
token；导入脚本、transition anchor 和 legacy bootstrap controller 都不得自行复制、生成或伪造
该授权。确认收据和短时 capability 使用固定文件名：

```bash
node "$runtime_release/scripts/n8n-workflow-transition-anchor.mjs" current-confirm \
  --intent "$transition_dir/upgrade-intent.json" \
  --confirmation-token-file "$transition_dir/operator-token" \
  --confirmation-receipt-id <one-current-uuid> \
  --confirmation-output "$transition_dir/current-confirmation.json" \
  --capability-output "$transition_dir/import-capability.json"

bash "$runtime_release/scripts/n8n-stop.sh"
bash "$runtime_release/scripts/n8n-import-workflows.sh" \
  --transition-intent "$transition_dir/upgrade-intent.json" \
  --transition-confirmation "$transition_dir/current-confirmation.json" \
  --transition-token-file "$transition_dir/operator-token" \
  --transition-capability "$transition_dir/import-capability.json" \
  --transition-journal "$transition_dir/journal"
```

短时 confirmation 只约束 capability 的首次原子领取：仅创建空的 `journal/` 不算领取，超过 120 秒后
仍必须失败关闭；`import-capability.json` 已在同一文件系统原子移动为
`journal/capability.consumed.json` 后，确认只作为不可变历史见证。即使进程在 rename 后、写入
`CLAIMED` 或进入 `MUTATING` 前崩溃，也必须用同一参数幂等补齐 journal 并继续，不能因为确认到期
把已经获得写权限且可能开始改库的迁移永久卡死。

如果 journal 已进入 `MUTATING`，但目标工作流因确定性错误无法完成，而且尚未生成
`transition-attestation.json` 的 `COMMITTED` 事件或 `bootstrap-claim.json`，不能只反复尝试前进，
也不能为了取得恢复权先伪造一个 bootstrap attempt。必须在 n8n、LaunchAgent、5678 listener 和
数据库 open FD 全部停止后，从原 transition 目录派生单向 rollback 授权：

```bash
node "$runtime_release/scripts/n8n-workflow-transition-anchor.mjs" \
  authorize-transition-rollback \
  --intent "$transition_dir/upgrade-intent.json" \
  --confirmation "$transition_dir/current-confirmation.json" \
  --journal-dir "$transition_dir/journal" \
  --output "$transition_dir/transition-rollback-authorization.receipt.json"

bash "$runtime_release/scripts/n8n-restore-managed-workflows.sh" \
  --database /absolute/path/database.sqlite \
  --package /absolute/path/recovery-package \
  --confirmation-receipt \
    "$transition_dir/transition-rollback-authorization.receipt.json" \
  --runtime-release "$runtime_release"
```

授权命令与 importer、restore、install、start 共用权威数据库目录下同一把物理 maintenance lock；
如果前向导入仍持锁，授权必须失败且不能产生 receipt。取得锁后才重新校验 transition journal 并原子
选择分支，任何校验失败都先释放锁。该固定 0400 receipt 同时绑定原 intent、已消费 capability、
CLAIMED/MUTATING journal 头、权威 SQLite inode、原 rollback package、目标 runtime 及
importer/maintenance-lock/anchor/validator/restore 五项工具。
创建后 transition 永久选择 rollback 分支，前向导入、attest 和 bootstrap claim 全部失败关闭；恢复
使用独立 `transition-rollback-journal/` 和固定 claim，崩溃后只能续作同一恢复，`COMMITTED` 后不得
重放。它不依赖尚不存在的 controller prepare/current-confirm/apply，且不得在空 bootstrap attempt
中预置任何成员；controller 的 `prepare` 仍只接受完全空的 attempt 目录。

首次部署在导入后继续安装下文的 LaunchAgent，由 LaunchAgent 完成首次启动；已有 LaunchAgent 的
升级导入则执行 `bash "$runtime_release/scripts/n8n-start.sh"` 恢复服务。安装、导入、恢复和启动
共用同一物理 maintenance lock，互斥覆盖整个离线变更窗口，不能并发跨过停机检查。导入成功后
仍须启动精确受管 release 并完成下述 PID、数据库 FD、版本和工作流内容复验，不能仅凭 CLI 退出码
恢复入口。

### 首次迁入 3017 蓝绿协议

从旧单进程 3017 首次迁入 slot-v1 时，两条工作流也必须完成一次协议升级。该窗口必须先在
外部停止新任务准入，并确认媒体节点、n8n 活跃 execution 和正式队列 waiting/running 全部
归零；随后备份 n8n 状态，停止 n8n，使用上述离线导入器发布当前 Git HEAD 的固定 ID 工作流，
再启动 n8n。启动后必须用 `scripts/verify-n8n-blue-green-workflows.mjs` 核对真实 n8n PID 打开的
SQLite 中 current/active/published version 的一致性和内容摘要，并用新 PID 重新生成引导证据，
最后才可执行 `deploy-blue-green.sh bootstrap`。n8n 2.31.6 在 `import:workflow` 时会生成新的
versionId，因此验证器不把数据库 versionId 与 JSON 中的 source versionId 强行相等；它要求
数据库三个版本引用同一已发布 history，并比较规范化后的 nodes、connections、settings 和
nodeGroups。应用基线 release、受管 n8n release 的 `SOURCE_COMMIT` 和工作流内容还必须来自
同一个精确 Git 提交。

bootstrap 的固定顺序是 **serve guard → rollback proof → evidence**。生成器不会用布尔字段
自行宣称入口冻结；必须先启动 `legacy-freeze-guard.mjs serve`，由它按
Mission Control → n8n 的固定顺序对两份权威 SQLite 取得 `BEGIN IMMEDIATE` writer reservation；
锁建立后 guard 再次复核精确 legacy PID 的进程/监听/双库 FD 身份。legacy 3017 与 n8n 保持在线，
读探针继续工作，但两库新写会被阻塞或拒绝。guard 状态目录、proof/备份目录和 evidence 目录须
预先由运维方建立为当前用户所有的 mode `0700` 独立物理目录，目标文件必须不存在。以下三个步骤
必须保持同一个 guard 进程，并由 proof 固定绑定同一个 `guard_socket`：

```bash
guard_socket=/absolute/private-state/legacy-freeze/guard.sock
guard_token=/absolute/private-state/legacy-freeze/guard.token

node scripts/legacy-freeze-guard.mjs serve \
  --database /absolute/path/mission-control.db \
  --n8n-database /absolute/path/database.sqlite \
  --socket "$guard_socket" \
  --token-file "$guard_token" \
  --ttl-seconds 1800 \
  --legacy-pid <verified-3017-pid> &
```

等待 guard 报告 active 后，从另一个受控会话用相同数据库和 socket 执行 `status`；status 未成功
时不得生成 proof：

```bash
guard_socket=/absolute/private-state/legacy-freeze/guard.sock

node scripts/legacy-freeze-guard.mjs status \
  --database /absolute/path/mission-control.db \
  --n8n-database /absolute/path/database.sqlite \
  --socket "$guard_socket"

node scripts/generate-legacy-bootstrap-rollback-proof.mjs \
  --output /absolute/managed-backup/rollback-proof.json \
  --slot blue \
  --release-id <target-release-id> \
  --standalone-root /absolute/repository/.runtime/releases/<target-release-id>/standalone \
  --guard-socket "$guard_socket"

node scripts/generate-legacy-freeze-evidence.mjs \
  --output /absolute/managed-evidence/freeze.json \
  --slot blue \
  --release-id <target-release-id> \
  --standalone-root /absolute/repository/.runtime/releases/<target-release-id>/standalone \
  --rollback-proof /absolute/managed-backup/rollback-proof.json
```

guard 默认最长只允许 1800 秒，
TTL 到期或 `revoke` 都自动 rollback 并删除 socket/token；
SIGKILL 遗留只能用 `recover-stale` 在证明旧 guard PID 不存在且 state/数据库身份完全匹配后清理。
回滚生成器只在同一 guard 已验真且四项活动归零时工作；它从 3017/5678 唯一 listener 的 open FD
绑定两库，使用 SQLite online backup 生成一致性快照，以单 FD 分块摘要、前后身份、`quick_check`、
`0600`、`nlink=1` 和目录 fsync 验证，再独占发布 v2 proof。proof 绑定目标、guard、运行身份和队列摘要。
冻结证据生成器随后要求 supervisor disabled/unloaded、worker 与全局锁均不存在，并回读该 proof；
两个生成器都必须是当前 Git HEAD 中受管文件，普通手填 JSON 不能替代。

停止状态不能只比较 PID 数字。冻结证据把 legacy incarnation 固定为 PID、PPID、UID、启动时间和
argv：若该 PID 已被新 incarnation 复用且 3017 无 listener，才可认定旧 legacy 已停；若复用 PID
正在监听 3017，或 3017 被其他 PID 占用，则失败关闭。同一 incarnation 的 executable、cwd 或
数据库 FD 身份发生漂移也必须阻断，不得回收 guard 或继续 bootstrap。

停止旧 3017 前还必须使用 `legacy-bootstrap-controller.mjs` 生成同一私有 attempt 目录中的
prepare、当前状态复核和 `SHUTDOWN_REQUESTED` 收据，并把 attempt 目录作为 bootstrap 的最后一个参数。
其中 `legacy-bootstrap-controller.mjs current-confirm --prepare ...` 只证明运行身份、活动量和绑定在
该时刻仍然新鲜，不代表用户批准生产写入，也不能替代上文外部提供的 workflow transition token。
部署器在写入或刷新 pending 前精确核对收据与提交、目标 release、证据、证明、双库和 router；
停止后 guard 只释放 Mission、继续以 n8n 写锁保持 `recovery-hold`，直到新槽、全局暂停闸门、
3017 router 与最终工作流复核全部成功。pending 期间其他变更命令失败关闭，`status` 保持可读。

orphan 对账固定为 dry-run → prepare/实际备份 → 用户查看本次差异与备份并明确确认生产数据写入
→ apply。apply 只接受该次 prepare manifest 与对应 confirm token；权威数据、manifest 或确认过期/
漂移后必须重新 prepare 并重新取得用户确认，不能复用旧授权。apply 失败按备份和 journal 保留现场，
不得猜测删除或覆盖；成功也固定输出 `handoffReady=false / NO-GO`，不能直接授权 bootstrap。只有随后
在 freeze guard 锁内重新证明四项活动归零、复核回滚包和隔离 release，才可进入下一门。完整操作与
回滚检查见 `docs/operations/legacy-media-orphan-reconciliation.md`。生产首次 bootstrap 仍默认
`BLOCKED / NO-GO`。

验证器还要求 `com.video-autoworker.n8n` LaunchAgent job PID 是 n8n Node PID 的直接父进程，
5678 只有该 Node PID 监听，argv 精确为 Node、当前 40 位 commit release 内的 n8n CLI 和
`start`。argv 可经过受控的 Node/n8n `current` 软链接，但会逐组件绑定权限与身份；CLI 最终目标
必须是当前物理 release，Node 最终目标必须匹配进程 executable FD。数据库、cwd、release 根及
其他受管运行文件不得经过符号链接；数据库和 cwd 的路径 device/inode 必须与 n8n 实际打开的
FD 一致，验证器自己的 SQLite 数字 FD 也会在查询期间与同一 inode 绑定。`SOURCE_COMMIT`、`SOURCE_MANIFEST`、
`RUNTIME_SOURCE_SHA256SUMS`、受管源码文件、n8n `2.31.6` 包版本和两条工作流摘要会在查询前后
重新捕获并比较，防止检查期间发生原子替换、ABA 恢复或运行身份漂移；baseline 原子写入前还会
在服务管理器验收之后执行一次紧邻复核并使用该最终摘要。

蓝绿部署器不会代替这一维护步骤操作 n8n，只会在停止旧 3017 前后只读复核工作流契约没有
漂移。首次迁移完成后，普通 3017 发版不再导入工作流或重启 n8n；只暂停新的顶层任务，旧
execution 按持久化 release affinity 继续回调原槽。

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
    "model": "qwen-local",
    "taskRouting": {
      "nodes": {
        "planner": { "routeId": "cloud-gpt-main", "fallbackRouteIds": ["local-qwen36-direct"] },
        "executor": { "routeId": "local-qwen36-direct", "fallbackRouteIds": [] },
        "reviewer": { "routeId": "cloud-gpt-main", "fallbackRouteIds": ["local-qwen36-direct"] }
      }
    }
  },
  "input": {
    "text": "测试任务"
  },
  "delivery": {
    "mode": "none"
  }
}
```

工作流先响应 HTTP `202`，再让三个 HTTP Request 节点依次回调回环地址 `/api/n8n/node-execute`。回调 URL 由 Video AutoWorker 服务端按自身 `PORT` 生成并强制校验为回环 HTTP；工作流不写死 3017，因此隔离环境不会误调生产控制台。需要显式覆盖时只能在外部环境设置完整的 `AIWORKER_N8N_NODE_CALLBACK_URL`，路径仍必须是 `/api/n8n/node-execute`。接口从 SQLite 读取父任务、节点配置和回投目标，按“本次任务覆盖 → 任务链节点配置 → 旧版兼容模型”的顺序解析路由。规划结果传给执行节点，规划和执行结果再交给审核节点；仅最终审核节点完成父任务并按需回投手机会话。

每个节点会建立独立、可幂等查询的子任务记录，记录实际 `routeId`、本地/云端位置、传输方式和模型名。模型执行一旦产生错误不会自动重放，以免工具或外部 API 产生重复副作用；n8n 重复同一个节点 HTTP 请求只会读取已经持久化的结果。旧版 `/api/n8n/execute` 仅供显式 `legacy-v1` 任务在非 slot 旧运行时兼容使用；它拒绝 `slot-v1` 任务，不能作为蓝绿发布期间的回退入口。

两条样例只使用 Webhook、Edit Fields、Respond to Webhook、HTTP Request 和 Merge 内置节点，不依赖 Python Task Runner。共享密钥只存在仓库外的 Video AutoWorker 环境文件中：控制台发给 n8n，n8n 从入站 Header 原样转给回环执行接口，工作流 JSON 本身不保存密钥。原生 macOS 启动时若提示缺少内部 Python runner，对这两条工作流不构成阻塞；后续真正加入 Python Code 节点前，应按 n8n 官方要求单独部署 external task runner。

### 视频分析任务链

第二个固定工作流 ID 为 `aiworker-video-analysis-v1`，生产 Webhook 路径为 `/webhook/aiworker-video-analysis`。OpenClaw 技能收到 `--video-file` 后不会把任意本机路径写进任务，而是以 0600 权限复制到 0700 的受控收件箱，只把随机 `videoKey` 交给平台。`prepare` 阶段验证容器、大小、时长和视频流，使用参数数组调用 ffmpeg，提取 16 kHz 单声道音轨和有限数量的 JPEG 抽帧；不拼接 shell 命令，也不接受远程 URL。

准备完成后，n8n 分出两个独立分支：音频分支从模型注册表解析 `Whisper large-v3-turbo` CLI 资源，画面分支从任务链 `vision` 节点解析具备 `vision` 能力的 `openai-compatible` 直连路由。两个分支都固定 `memoryMode=none`，不接收 OpenClaw profile、agent、session key 或记忆目录。n8n v1 在同一次执行中按节点顺序调度分支，Merge 节点等待两侧都完成；这里保证的是模型职责隔离，不把顺序分支误报为计算并发。最终接口从 SQLite 中读取两个已成功的子任务结果并做确定性合并，不再调用第三个带会话模型。SQLite 只保存任务状态和本次输出，属于运维审计记录，不属于智能体长期记忆；抽帧、音轨和当前任务工作目录在成功合并后按当前任务范围删除。正常 `prepare` 不再执行跨任务 TTL 扫描；异常残留与未消费收件箱文件只能通过下文的独立只读审计入口盘点，任何恢复、隔离或删除都需要另立任务并取得明确授权。

建议绑定配置如下；路由 ID 仍可替换成其他本地或云端直连视觉模型，不能换成 OpenClaw Agent 路由：

```json
{
  "media": {
    "audioResourceId": "whisper-large-v3-turbo",
    "language": "zh",
    "maxDurationSeconds": 1800,
    "maxFrames": 4,
    "frameWidth": 960
  },
  "modelRouting": {
    "allowTaskOverride": true,
    "nodes": {
      "vision": {
        "routeId": "local-qwen36-direct",
        "fallbackRouteIds": [],
        "instruction": "按时间顺序分析人物、场景、动作、文字和事件。"
      }
    }
  }
}
```

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
bash scripts/install-model-routes.sh --sync-resources --enable-video-analysis
chmod 600 "$HOME/.config/video-autoworker/platform.env"
chmod 600 "$HOME/.config/video-autoworker/model-routes.json"
```

已有注册表需要合并仓库模板中的辅助模型资源时，使用 `bash scripts/install-model-routes.sh --sync-resources`。部署视频链时再加 `--enable-video-analysis`：脚本仍保留现有路由地址、模型名和其他自定义字段，只为 `local-qwen36-direct` 合并 `vision` 能力，并同步 Whisper 的视频音频节点用途。任何实际写入前都会在目标旁生成 0600 权限的时间戳备份。资源的 `production` 字段用于区分“生产已用”和“已安装待分配”；同步未分配资源只登记可核验的本机模型文件，不会启动模型服务或把它接入生产任务。

以下变量属于 Video AutoWorker 服务环境，不写入代码仓库：

```bash
N8N_BASE_URL="http://127.0.0.1:5678"
N8N_DEFAULT_WEBHOOK_PATH="webhook/aiworker-task"
N8N_API_KEY="<完成所有者初始化后在 n8n UI 创建的 API key>"
N8N_WEBHOOK_SECRET="<安装脚本生成的随机共享密钥>"
AIWORKER_MODEL_ROUTES_FILE="$HOME/.config/video-autoworker/model-routes.json"
AIWORKER_FFMPEG_BIN="$HOME/ai-worker/bin/ffmpeg"
AIWORKER_MEDIA_INGEST_DIR="$HOME/ai-worker/state/video-autoworker/media-inbox"
AIWORKER_MEDIA_WORK_DIR="$HOME/ai-worker/state/video-autoworker/media-tasks"
```

`N8N_API_KEY` 只用于控制台读取 n8n 管理 API，未配置时不阻塞 Webhook 执行闭环。`N8N_WEBHOOK_SECRET` 是 n8n 回调模型执行接口的必需认证信息，不能留空。模型注册表可以同时登记 `openclaw` 与 `openai-compatible` 路由；前者引用外部 OpenClaw profile，后者只保存本地回环地址或云端 `apiKeyEnv` 变量名。默认优先让无需工具的规划、执行和审核节点使用 `local-qwen36-direct`，避免每个节点重复加载完整 OpenClaw Agent、工具和会话上下文；只有确实需要 OpenClaw 工具或最终会话回投时才选 `local-qwen36`。云端 API Key 本身必须放在 `platform.env` 或其他受管外部环境中，不能写入注册表、SQLite、n8n 工作流或 Git。直接 API 路由不负责手机回投，因此带回投的最终审核节点必须选择 OpenClaw 路由。

模型注册表中的 `resourceId` 与 `resourceLabel` 描述物理生成模型资源，`id` 仍表示任务链实际调用的访问路由。同一台本地 Qwen 可以把直连路由和 OpenClaw Agent 路由登记到同一个 `resourceId`；模型集群页面会聚合显示为一个模型，并展开各条路由。顶层 `resources` 登记 Whisper、embedding、reranker 等辅助模型：`production=true` 表示已有专用生产链路调用，`production=false` 只表示本机安装文件经过检测、尚未分配生产任务。两类辅助资源都不会被误列成通用文本节点。n8n 任务链只保存路由 `id`，不会保存物理地址之外的凭据，也不会把供应商实现写死在流程节点中。

修改注册表后重启 Video AutoWorker 即可刷新可选模型，不需要重新导入 n8n 工作流。`/api/n8n/models` 只向已登录用户返回脱敏路由、可用状态和缺失的凭据引用，不返回任何凭据值。任务及幂等状态由 Video AutoWorker 的 SQLite 持久化；数据库、外部环境文件、模型注册表和 n8n 状态必须作为同一生产备份链管理。

## OpenClaw 任务入口

把版本化技能安装到 `qwen-current` 的第二原始 Agent 工作区：

```bash
bash scripts/install-aiworker-task-flow-skill.sh
openclaw --profile qwen-current skills info aiworker-task-flow --agent second-original
```

`aiworker-task-flow` 是唯一受控任务链。插件只提供两个薄适配器：
`second-original` 的 `before_dispatch` 负责 Telegram 私聊入口，
`aiworker_analyze_video` 负责普通 Agent 会话的结构化调用。两者都调用同一个
`scheduler-runner` 和已安装的 `aiworker-task-flow/scripts/submit-task.mjs`，不得各自
实现任务创建、排队、状态仲裁、结果检索或重试恢复。

```text
分析视频 /完整路径/video.mp4
帮我分析一下这个视频 /完整路径/video.mp4
```

分类器只输出受限结构化意图，模型输出本身不构成授权；宿主仍独立校验 Telegram
私聊身份、当前原消息中的唯一规范路径、完整任务或批次编号，以及逐字复制的最小标题
或关键词。状态和结果查询只搜索受控登记字段并调用正式平台接口，不读取聊天、任意
文件、n8n execution、媒体或凭据。平台存在记录时其状态覆盖本地耐久登记；平台无记录
或暂时不可用时才允许本地降级。

单视频与目录都先写入持久任务状态并进入同一个进程级全局串行 video lane；单视频是
一个 item 的任务，目录是确定性排序的多 item 任务。所有 job 共用全局锁，任一时刻最多
处理一个视频，并能在 worker 重启后续跑且跳过终态 item。正常新任务和幂等任务只返回
含稳定 taskId 或 batchId 的 handled 短回执。同一轮不得查询状态、监控、等待、重试、
再次提交或完成回投。以后查询可在当前新消息中显式提供完整 taskId/batchId，或提供
标题/关键词；完整 ID 直接调用对应正式状态客户端一次，标题搜索唯一命中后以有界摘要
状态客户端再调用一次，多命中只返回候选。`delivery=none` 表示结果保存在任务运行记录中，
不自动回投 Telegram。

### 当前插件发布与媒体审计边界

插件源码只保留从 `index.js` 可达的当前模块。生产发布统一使用
`scripts/install-aiworker-video-command-plugin.sh`；脚本验证 canonical Git 提交，
创建清单化回滚点，使用 OpenClaw 官方安装命令并只刷新 `qwen-current` Gateway。
它不得启动视频 worker、修改队列、n8n、媒体或数据库。版本化升级脚本与旧处理器不再
作为活动源码保留，历史过程只存在于 Git 和日期化运维记录。

生产验收必须证明：插件运行时只有一个 `before_dispatch` 和一个
`aiworker_analyze_video`；二者都进入同一个持久化全局 video lane；派发后的当前轮
状态读取、轮询、重试、重提与完成回投均为零；classifier、鉴权、证据与 runner 失败
都 handled fail-closed。插件、任务流 Skill 和控制台投影分别验证，但不得形成第二条
派发链。

同一次验收暴露了既有媒体清理边界：执行前受控 inbox 记录了一个普通文件的数量
基线，同时存在一条更早的 `accepted / attempt=0` 记录；执行后文件数量变为零。本轮
QA 与历史记录使用不同的视频键，且当时 `prepare` 热路径会先扫描并删除超过 24 小时的全部
受控 inbox 文件；目录时间也与本轮 prepare 时段吻合。因此现有证据高度怀疑历史
文件被旧的全局 TTL 扫描删除，但部署前只保存了数量基线，没有保存该文件的路径、
大小和哈希，运行时也没有逐文件删除审计，不能把该判断表述为完整法证结论，更不能
据此推测或执行恢复。

当前实现从 `prepare` 热路径移除全局过期清理，并要求 prepare 请求的视频键与父任务
持久化的视频键完全一致；不匹配的请求在创建子任务或读取文件前拒绝。受控媒体检查改为独立审计入口
`scripts/aiworker-media-retention.mjs`，核心逻辑位于
`scripts/lib/aiworker-media-retention.mjs`。当前版本只提供审计模式，调用时必须显式
使用 `--dry-run`；它不会通过 SQLite 打开生产数据库，而是先把文件状态稳定的主库和
WAL 复制到权限受控的临时快照，在快照上执行 `query_only` 与完整性检查，结束后只清理
该精确临时目录。生产数据库及其 sidecar 在前后必须保持不变，唯一保留的写入是调用者
指定、位于源码仓库和媒体根之外的 0700 目录中的 0600 审计计划文件。`--apply` 与
`--delete` 会被拒绝，没有媒体恢复或删除能力，也不把审计动作
挂回任务执行路径。该审计能力只修改 Video AutoWorker 应用代码和测试，不涉及 n8n
release、工作流、OpenClaw 插件、模型路由或数据库 schema；生产部署只允许重新构建
并刷新 `3017` 应用，n8n 与 OpenClaw Gateway 不应随之重启。任何后续保留、恢复或
删除动作都必须作为独立任务重新取证并获得明确授权，不能由审计 CLI 自动完成。

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
- 规划、执行、审核模型：分别从注册表选择本地或云端路由；页面保存的是路由 ID，不保存凭据。
- 兼容默认模型：仅在某个节点尚未选择注册路由时使用。
- 允许 OpenClaw 单次改选：开启后，技能脚本可以只覆盖本次任务的节点模型，不改保存的工作流。
- 纯本地三节点：规划、执行和审核都选择 `local-qwen36-direct`；只有需要工具或手机回投时再把对应节点切到 `local-qwen36` Agent 路由。
- 视频分析链：Webhook 使用 `webhook/aiworker-video-analysis`，任务类型使用 `video-analysis`；`vision` 选择具备 `vision` 能力的直连路由，音频资源在高级配置的 `media.audioResourceId` 中选择。
- 超时和重试：n8n 负责确定性流程重试；不要与后续 LangGraph 的节点级重试重复叠加。

`/agents` 页的“模型集群”标签读取 `/api/n8n/models` 与 `/api/n8n/workflows`，按物理模型聚合路由，并把“生产已用”和“已安装待分配”分组展示，反向列出每个模型负责的任务链节点、主路由、备用路由和专用生产用途。生成模型的“可调度”代表配置与外部凭据引用完整；CLI 辅助模型会检查命令和权重权限，Ollama 辅助模型会实时检查本机模型清单，`local-files` 资源只检查已登记的模型目录和关键文件。真实推理结果仍以生产验收和任务链执行记录为准，文件检测通过不等于模型正在运行。智能体卡片属于 OpenClaw 管理能力，只显示在“命令”标签中，不再作为模型集群内容。

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
4. `/api/n8n/runs` 中父任务最终进入 `succeeded`，并存在 `planner`、`executor`、`reviewer` 三个子任务；各自输出包含实际 route/provider/model 证据。
5. 本地与云端路由至少各做一次不回投验证；不可用路由会使用配置的后备路由或明确失败，不会静默改用未知模型。
6. 使用同一幂等键再次提交时不产生第二次模型调用，并返回已有任务或缓存结果。
7. 经确认的手机会话只收到最终审核节点的一次真实回投，且输出与父任务运行记录一致。
8. `git status --short` 不出现数据库、日志、PID、环境文件、模型注册表或备份。
9. 视频链存在 `prepare`、`audio`、`vision`、`finalize` 四个子任务；音频与画面输出均显示 `memoryMode=none`，父任务合并结果一致，媒体临时目录已经清理。
10. 从 OpenClaw 当前会话执行技能的 `--video-file ... --wait-seconds ...`，确认是 OpenClaw 发起、n8n 编排、本地模型实际完成，而不是直接调用测试接口冒充完整链路。

## 升级与回退

### 首次蓝绿引导的恢复与灾后继续

首次工作流迁移失败时先判断不可混用的三类恢复路径：

- **transition rollback**：工作流导入已进入 `MUTATING`、尚未完成 transition commit，也尚未 claim
  bootstrap 时，使用上文固定的 `authorize-transition-rollback`。这是 bootstrap 之前唯一的恢复
  授权，不创建也不借用 controller attempt；一旦生成就不能再回到前向导入。

- **normal restore**：尚未写入 `bootstrap.pending`、legacy 3017 尚未停止，而且原 freeze guard、
  prepare/当前确认/`SHUTDOWN_REQUESTED` 链仍新鲜时，使用
  `legacy-bootstrap-controller.mjs derive-n8n-restore-confirmation` 派生 normal restore receipt；收据
  必须由 controller 独占写入同一 bootstrap attempt 根目录，固定 basename 为
  `n8n-restore-confirmation.receipt.json`。
- **disaster restore**：`bootstrap.pending` v4 已写且 legacy 3017 已停止，原 guard 或确认已因崩溃、
  超时或重启失效时，使用 `derive-n8n-disaster-recovery-confirmation`。该路径还必须证明 n8n 与其
  LaunchAgent 完全停止、3017/5678 无监听、目标 SQLite 没有任何 open FD，并绑定 pending、proof、
  recovery attempt、回滚包与精确 runtime release；收据固定 basename 为
  `n8n-disaster-recovery-confirmation.receipt.json`，且只能位于该 bootstrap attempt 下预先建立的
  mode `0700` disaster recovery UUID 目录。

disaster receipt 中的 workflow report 不要求位于 bootstrap attempt 根。实际 transition 本来就是
独立 0700 目录；report 可以保留在该 transition 目录。验证器必须同时核对 receipt、pending、
transition attestation 三方携带的同一完整 path/dev/ino/size/SHA-256 引用，并重算 report 内容与
combined digest，任何一方漂移都失败关闭。

同一个 bootstrap attempt 的 restore 与 resume 分支通过不可变 branch claim 互斥；选择一支后不得
切换到另一支。normal 路径必须按以下完整参数派生固定收据，再把该精确路径交给统一恢复入口：

```bash
attempt_dir=/absolute/private-state/bootstrap-attempt
runtime_release=/absolute/path/releases/<40-character-commit>

node scripts/legacy-bootstrap-controller.mjs derive-n8n-restore-confirmation \
  --prepare "$attempt_dir/prepare.receipt.json" \
  --confirm "$attempt_dir/current-confirm.receipt.json" \
  --shutdown "$attempt_dir/shutdown-requested.receipt.json" \
  --package /absolute/path/recovery-package \
  --runtime-release "$runtime_release" \
  --database /absolute/path/database.sqlite

bash "$runtime_release/scripts/n8n-restore-managed-workflows.sh" \
  --database /absolute/path/database.sqlite \
  --package /absolute/path/recovery-package \
  --confirmation-receipt "$attempt_dir/n8n-restore-confirmation.receipt.json" \
  --runtime-release "$runtime_release"
```

disaster 路径的 recovery UUID 目录必须位于固定的 `disaster-recovery-attempts/` 父目录；其派生参数
额外绑定 pending、proof 和本次 recovery attempt：

```bash
attempt_dir=/absolute/private-state/bootstrap-attempt
recovery_dir="$attempt_dir/disaster-recovery-attempts/<one-current-uuid>"
runtime_release=/absolute/path/releases/<40-character-commit>
run_dir=/absolute/private-state/blue-green-run

node scripts/legacy-bootstrap-controller.mjs \
  derive-n8n-disaster-recovery-confirmation \
  --prepare "$attempt_dir/prepare.receipt.json" \
  --confirm "$attempt_dir/current-confirm.receipt.json" \
  --shutdown "$attempt_dir/shutdown-requested.receipt.json" \
  --pending "$run_dir/bootstrap.pending.json" \
  --proof /absolute/managed-backup/rollback-proof.json \
  --package /absolute/path/recovery-package \
  --runtime-release "$runtime_release" \
  --database /absolute/path/database.sqlite \
  --recovery-attempt-dir "$recovery_dir"

bash "$runtime_release/scripts/n8n-restore-managed-workflows.sh" \
  --database /absolute/path/database.sqlite \
  --package /absolute/path/recovery-package \
  --confirmation-receipt \
    "$recovery_dir/n8n-disaster-recovery-confirmation.receipt.json" \
  --runtime-release "$runtime_release"
```

统一恢复脚本按 receipt schema 选择 normal/disaster/transition-rollback journal。未完成 journal
可以在所有身份仍精确匹配时重跑剩余阶段；已写 `COMMITTED` 的恢复不得重放。
恢复完成后必须先启动 receipt 绑定的精确受管 n8n release，再验证 5678 唯一 listener、真实数据库
open FD、`quick_check=ok`、两条固定 ID 工作流唯一且 active/published，以及 current/active/published
version 与规范化摘要一致。只有这些检查和零活动证明重新通过后才可派生 fresh resume；恢复完成
本身不能直接开放 3017 或新任务入口。

首次引导已经写入 `bootstrap.pending` 且 legacy 3017 已停止后，如果 freeze guard 因超时、被杀或
主机重启消失，不要手工改 pending、伪造收据或直接开放入口。再次执行原参数完全一致的 bootstrap
时，部署器只会在 pending v4、prepare/confirm/shutdown、evidence/proof、双库、目标 release 与
router 全部精确匹配后创建 fresh resume attempt。当前 n8n 必须是同一提交的受管 release，5678
listener、数据库 FD 和两条 published workflow 必须一致；媒体、n8n active execution 和正式队列
waiting/running 必须为零。旧 stale attention 可以保留，但任何 durable 或新鲜 waiting/running 都会
阻断。恢复 guard 成功后继续既有 baseline 流程；resume token 只能消费一次。

如果 n8n 工作流或数据库确实需要恢复，必须使用上述独立 restore-only journal；不得借 resume
路径放宽停机证明或授权。任一步失败都继续保持维护冻结态。

持久化边界必须按故障点验证：`bootstrap.pending`、evidence/proof、SQLite 备份和已经实现的收据
创建都要求文件内容落盘并同步父目录；normal/disaster/transition-rollback receipt、restore journal
与 maintenance lock 的完整 file → directory fsync 顺序仍以当前候选代码和测试结果为准。提交或生产发布前必须
通过对应 fsync 顺序、进程崩溃、主机重启与 journal 续跑测试，不能把“写入成功”或内存中的状态
当成 durable 完成。

升级时不要直接执行 `npm update`。应在开发仓库中同时修改 `ops/n8n/package.json` 的精确版本、重新生成并审查 `package-lock.json`，完成离线导入与真实 Webhook 回归后再提交。生产部署前备份整个外部 n8n 状态和环境文件，随后只从 GitHub 拉取并重新执行 `scripts/n8n-install.sh`，由脚本刷新仓库外运行副本。

回退时先停止 n8n，按备份目录的 `RELEASE_TRANSITION` 把 `current` 切回 `previous_release`，并恢复同目录成套保存的数据库状态和加密环境，再启动并复验健康检查与 Webhook。不能只切旧 `node_modules` 而继续使用可能已经迁移的新数据库；`previous-release-manifest`、`target-release-manifest`、GitHub 提交和 SHA-256 清单必须能够相互核对。
