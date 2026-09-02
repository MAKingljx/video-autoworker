# n8n 新任务暂停与 3017 蓝绿热切换

## 目标与非目标

本方案解决“发布 3017 新功能时必须等待所有 n8n execution 和长视频节点结束”的问题。
这里的“热更新”是不可变 release 加蓝绿路由切换，不是在运行进程内覆盖代码。

发布窗口只暂停新的顶层任务准入。已经受理的任务、n8n execution、模型节点和媒体节点
不被取消或强停，继续回调创建该任务的旧 release。新 release 验收并切换后即可恢复新任务
准入；旧 release 在后台排空后再退役。

完成首次协议迁移后的常规 3017 发布不会重启或修改 n8n、Gateway、模型服务、video worker、
正式任务和业务数据，也不会自动重提失败任务。当前旧 n8n 工作流尚未携带完整的 slot-v1
execution owner，因此首次迁移是一次明确的例外维护窗：必须先停 n8n，离线导入并发布兼容
工作流，再恢复 n8n；这一步不属于日常蓝绿切换，也不能由 3017 部署脚本隐式执行。

## 稳定入口与运行槽

- 稳定入口：`127.0.0.1:3017`
- blue：`127.0.0.1:3317`
- green：`127.0.0.1:3417`
- `probe`：只连接一致性 SQLite 快照，用于隔离验收，永远不能切入 3017。
- `active`：连接显式声明的生产 SQLite，可以成为路由目标。
- `drain`：保留旧任务回调能力，但关闭内置 scheduler，不能成为路由目标。

3017 只运行最小 loopback router。router 的状态文件通过原子替换更新，包含当前槽、上一槽、
generation 和两个槽的 release 绑定。HTTP keep-alive、SSE 和 WebSocket 按连接转发；新请求
在切换后进入新槽，旧槽不会因为 router 切换被立即停止。

## 单一鉴权边界

外部用户身份与访问授权统一由 OpenClaw 完成。3017、n8n 与导演脑只通过本机
`127.0.0.1` HTTP 通道互调，不再生成或转发 Webhook 共享密钥，也不在每个内部接口重复实现
登录和角色判断。3017 的 `MC_AUTH_MODE=openclaw-loopback` 分支拒绝非 HTTP loopback、外部
Host 和外部 forwarded 链；普通本地请求只得到固定 viewer，只有精确的 task ingress、callback
和发布控制路径获得内部权限。该分支不会回退到密码、Cookie session、全局/Agent API key、
proxy header、desktop mode 或默认租户推断。

OpenClaw Gateway token 由唯一 Gateway 适配器从 SecretRef 解析，只在真实 Gateway HTTP/CLI
调用时短暂注入 Authorization 或子进程环境；列表和连接 API 只返回凭据来源/配置状态，不解析
SecretRef、不向浏览器返回 token，也不把探测值写入 SQLite。旧版数据库中若已有 Gateway token，
读接口只脱敏、不隐式修改生产库；发布前必须在已备份、显式批准的维护步骤中清除。

任务 ID、execution owner、release affinity、lease、fencing、幂等键、revision/CAS 与发布锁
继续保留；这些字段用于绑定任务和控制并发，不是第二套用户鉴权。若服务未来离开受控 loopback、
通过不可信跨主机网络直连或进入多租户模式，必须先建立新的鉴权决策，不能静默放宽当前边界。

## 全局新任务闸门

迁移 `052_n8n_intake_controls` 增加单例闸门、审计事件和单调 revision。
`POST /api/n8n/trigger` 在 SQLite `IMMEDIATE` 事务中完成以下二选一：

1. 读取并返回已存在的同幂等任务；
2. 确认全局闸门仍为 accepting 后创建新任务。

因此“暂停”和“创建新任务”在线性化点上不会穿透。暂停后新任务返回脱敏的 HTTP `423`
和 `N8N_INTAKE_DRAINING`；已有任务查询、幂等续派和 callback 不受影响。

`GET/POST /api/n8n/intake-control` 使用 CAS revision，避免两个管理员覆盖彼此操作。
OpenClaw-only 模式下，精确 loopback 发布控制路径可读取并操作全局闸门；普通 loopback viewer
不能获得全局管理权。旧鉴权模式仍保留原 owner workspace 范围，避免兼容运行时扩大租户管理员
权限。`drain-status` 和
`release-readiness` 使用同一角色判断。`/tasks` 的按钮以后端返回的 `canManage` 为准。

## Webhook 幂等与响应不确定性

迁移 `054_n8n_task_dispatch_leases` 为顶层 webhook 派发增加带 fencing token 的短租约。
只有租约 owner 能提交派发结果，过期 owner 不能覆盖后来者。

- 明确、非重试型 HTTP 4xx 表示 n8n 已拒绝，可把尚未 claim 的父任务置为失败。
- 网络断开、超时、响应体丢失、HTTP 5xx、408、425 和 429 都是
  `outcome_unknown`，不能证明 n8n 未接收。
- `outcome_unknown` 返回 HTTP `202`，父任务保持 queued，派发租约保持不变；租约到期后
  只能携带同一任务 ID、幂等键和原始持久载荷续派。
- 本地 base URL 和 webhook path 在创建父任务前验证，本地配置错误返回 503，
  不伪装成远端响应不确定。

通用模型链和视频链都必须在第一个业务节点前调用父任务 claim。首次 claim 原子推进父任务并
清理派发租约；重复 claim 只返回 duplicate 分支并立即结束该次 n8n execution，绝不能继续
planner、executor 或媒体节点。

## Callback release affinity

新任务 routing 固定写入：

- `callbackProtocol=slot-v1`
- `runtimeSlot`
- `runtimeReleaseId`
- 该槽的 claim、node、media loopback callback URL

`claim`、`node-execute` 和 `media-execute` 都核对父任务记录与当前进程的 slot/release。向错误
槽或后来复用同一槽位的其他 release 直连 callback 会返回 409，不能执行模型或创建子任务。
缺少 affinity 不会默认当作 legacy；只有显式 `legacy-v1` 或受控迁移兼容开关可以放行。
父任务处于 failed 或 cancelled 时，所有迟到 callback 均被拒绝。父任务已 succeeded 时，仅同一
n8n execution 对确定性 `reviewer` / `finalize` 成功子任务的响应丢失重试可以读取 cached 结果；
非最终节点、错误 owner 或身份不匹配的子任务仍返回 409。

历史 `/api/n8n/execute` 只允许显式 `callbackProtocol=legacy-v1`，并且当前进程必须是非 slot 的
legacy runtime。它不能处理 `slot-v1` 任务，也不能作为蓝绿发布期间绕过 execution owner、
child lease、fencing token 或 callback freeze 的回退路径。

迁移 `055_n8n_child_execution_leases` 为模型和媒体子任务增加 process-instance owner、心跳、
租约 revision 和 fencing token。创建子任务与 claim 在同一事务中完成；同一实例的并发重复
不能双跑，进程重启后的新实例可 CAS 接管，同一旧 token 不能再 complete/fail。长媒体任务
持续心跳，不能仅靠一个短固定超时判断死亡。

迁移 `056_n8n_parent_execution_claims` 把顶层任务绑定到格式受控的
`n8n-execution:<workflow-id>:<execution-id>`。首次认领、父任务进入 `running` 与 dispatch lease 清理在同一
事务完成；同一 n8n execution 在认领响应丢失后可以继续，其他 execution 只能走 duplicate
终止分支。模型或媒体子任务仍在运行时 callback 返回非 2xx 与 `Retry-After`，工作流持续
轮询，只有读取到已持久化的 cached success 才进入下游。跨实例接管仍要求原租约已过期。

## Scheduler 单主

迁移 `053_scheduler_leader_lease` 为内置 scheduler 增加共享 SQLite leader lease。
blue/green 进程只有在受限 router state 中同时满足“当前 active slot”和“精确 release 匹配”时
才有资格竞选。

切换时，旧 leader 如果已有本地 job，会续租直到该 job 收尾，但不会启动新 job；之后主动
释放。新 active slot 有界等待并成为合法 leader。`unknown`、`unavailable`、过期 leader lease
或 router generation 不一致都会使发布失败关闭。

`release-readiness` 还返回当前 release 编译时的导演证据投影契约摘要。摘要一致时，已有任务
可按原 slot 回调并由新 leader 使用同一契约继续投影；摘要不一致时，普通 switch/rollback
无条件拒绝，不能把“页面热更新无需等待”误扩展成投影契约迁移。forward switch 还会把
HEAD 绑定的静态 verifier 摘要与 target runtime 摘要直接对账。路由切换后按预提交时封存的
release/readiness/router 证据复验；自动回滚历史 source 不再调用只接受当前 HEAD 的 target
verifier。旧槽 callback 冻结静默后仍复查不兼容 pending，失败时拒绝退役。
延迟退役使用受限 ancestor 模式：active release 必须仍是干净 `main` HEAD 的祖先，才能避免
docs-only 审计提交把已验证 release 永久挡在退役门外；该模式不接受分叉 release，也不放宽
payload、投影闭包、standalone bundle 或 outbox 校验。

## 数据库滚动兼容门

`release-readiness` 不相信代码里的迁移常量，而是回读当前进程实际打开的 SQLite：

- `schema_migrations` 中必须存在 052 至 057；
- 七张新增表的关键列、类型、主键、非空约束和默认值必须匹配；导演证据 outbox
  还必须精确保留幂等键唯一性、父任务级联外键，以及作品查询、结果和投影契约摘要的
  字段 CHECK 约束；
- 必需索引的列顺序和升降序必须匹配；
- source/target 的 schema epoch、闸门 revision 和 router generation 必须一致。

所有迁移均为 additive side table，旧 release 在排空期间仍可读取原任务表。生产数据库路径
必须从运行进程的真实 open-file 和 runtime attestation 绑定，不能从 checkout 的默认 `.data`
路径推断。

## Runtime attestation

slot 启动器以 `umask 077` 运行，并拒绝符号链接、非当前用户所有或组/其他用户可写的环境文件。
每次启动以 `0600`、fsync 和 rename 原子写入 runtime attestation，只包含：

- schema、PID、slot、role；
- release ID 与 manifest SHA-256；
- loopback host/port；
- canonical SQLite 与 router state 路径；
- 启动时间和非敏感运行身份。

attestation 不保存 Token、密码、Webhook Secret、App Secret、环境变量内容或用户会话。
switch/rollback 同时核对 binding、attestation、PID、监听进程 cwd、release manifest 和显式
`AIWORKER_BG_LIVE_DB_PATH`。probe、drain、错误数据库或漂移证明不能进入 3017。

## 首次引导与后续发布

既有单进程 `542eebd-runtime` 没有 callback affinity，所以首次迁入蓝绿结构仍需一次完整归零。
仓库合同对比也已证明旧通用工作流缺少 claim，旧视频工作流的 claim/media 回调缺少
`executionOwner`；如果直接切换，新 API 会按严格 schema 拒绝这些回调。因此首次迁移顺序固定为：

1. 在外部冻结所有顶层入口，并证明活跃媒体节点、n8n 活跃 execution、正式队列
   waiting/running 全部为零；
2. 备份当前 3017、n8n 状态、配套环境和工作流回滚点；
3. 优雅停止 n8n，使用受管离线导入器按固定 ID 导入并发布当前 Git HEAD 的两条工作流；
4. 恢复 n8n，验证健康、真实 PID/SQLite 绑定、固定工作流唯一且 active/published，并核对
   imported current/active/published version 一致、published nodes/connections/settings/nodeGroups
   摘要与 slot-v1 execution-owner 协议；n8n 2.31.6 导入时会生成新的 versionId，不能错误要求
   数据库 versionId 等于仓库 JSON 中的 source versionId；
5. 使用新的 n8n PID 重新签发新鲜的零活动证据；旧 PID 的证据不得沿用；
6. 执行 legacy bootstrap。部署器在停止 legacy 3017 前后再次只读核对两个权威 SQLite、
   n8n 完整运行身份和已发布工作流摘要，完全一致后才建立蓝绿基线。完整身份同时绑定
   `com.video-autoworker.n8n` LaunchAgent job、5678 唯一 listener、精确 Node + release 内 n8n CLI
   `start` argv、父子 PID、物理 cwd、数据库 open FD 的 device/inode、40 位 commit release 根、
   `SOURCE_COMMIT`、`SOURCE_MANIFEST`、`RUNTIME_SOURCE_SHA256SUMS` 和 n8n `2.31.6` 包版本。

首次引导证据固定使用 `video-autoworker-legacy-freeze-evidence/v3`，不能再手填 v2 JSON。
`generate-legacy-freeze-evidence.mjs` 从 3017/5678 唯一 listener 派生 PID，以 macOS `lsof` 中唯一
物理 `/bin/node` txt 映射、进程启动时间、argv 摘要、物理 cwd 和数据库 FD 的 device/inode 建立身份；两库
必须无符号链接、归当前用户所有、组/其他用户不可写且 `quick_check=ok`。正式队列通过 3017
只读队列接口合并持久批次和平台任务，证据同时绑定队列投影摘要。生成前还要求 video-lane
supervisor 已 disabled + unloaded、没有 worker、没有全局锁，并连续取得两次完全相同的零活动
快照。

legacy 停止判断绑定的是进程 incarnation，而不是单独一个 PID：PID、PPID、UID、启动时间和 argv
任一变化且 3017 已无 listener 时，可判定旧 incarnation 已结束；如果复用该 PID 的新进程正在监听
3017，或 3017 被其他 PID 占用，则必须失败关闭。同一 incarnation 下 executable、cwd 或数据库 FD
身份漂移同样不是“已停止”，不得回收 guard、继续 bootstrap 或把新进程误认成原 legacy。

数据库归零本身不能证明入口持续冻结，因此生成器要求 `legacy-freeze-guard.mjs` 按固定顺序对
3017 实际打开的 Mission Control SQLite 和 n8n SQLite 同时持有 `BEGIN IMMEDIATE` writer reservation。
guard 等待锁前既有 writer 完成，取得双锁后再次复核精确 legacy PID 的 3017 listener/启动时间/
argv/Node txt/双数据库 FD 身份；锁后两库新写都无法提交，而旧 3017 与 n8n 仍可提供只读探针。
guard 用随机 challenge、私有 token、PID/open-FD/socket 身份和 TTL 证明持续持锁，
TTL 到期或受管 revoke 会自动 rollback 并清理 socket/token，崩溃残留只允许在证明旧 PID 已消失后
精确回收。证据还绑定两份 `quick_check=ok`、摘要匹配的 Mission/n8n SQLite 回滚备份证明。
回滚证明只能由 `generate-legacy-bootstrap-rollback-proof.mjs` 在同一 guard 持锁、四项活动归零时生成；
它从 3017/5678 open FD 派生权威源库，以 SQLite online backup 建立快照，并绑定 guard、完整运行身份、
队列摘要和目标 slot/release/manifest。大库摘要使用同一 FD 分块读取并复核前后 dev/inode/size，避免
整库读入内存及路径替换。
证据只写入 mode `0700` 安全目录，以独占 hard-link publish 原子创建 mode `0600` 文件。bootstrap
使用 Bash 3.2 兼容的固定 FD 9，并在 SIGTERM 紧前再次做完整双快照。

停止 legacy 前还必须由 `legacy-bootstrap-controller.mjs` 完成 prepare → 当前状态复核 → apply；部署器
只消费同一次 `SHUTDOWN_REQUESTED` 收据，并逐项绑定提交、release、manifest、evidence、proof、
双库和 router 路径。legacy 停止后 guard 进入 `recovery-hold`：只释放 Mission Control 写锁供新槽
迁移和启动，继续持有 n8n 写锁；新槽、暂停闸门、router 和最终工作流复核全部成功后才释放。
`bootstrap.pending` 存在期间，init/stage/bind/retire/switch/rollback 全部失败关闭，只有只读 status
和完整绑定的 bootstrap 恢复可进入。

工作流离线迁移另有独立的人类授权门。transition anchor 先把权威 n8n SQLite、回滚包、目标完整
提交、受管 n8n runtime 和 application release 固定到 upgrade intent；用户审阅本次意图、备份和
目标后，由外部受控步骤提供一次性 64-hex token，才能生成短时 current confirmation/capability 并
调用强制发布两条固定工作流的 importer。`legacy-bootstrap-controller.mjs current-confirm --prepare`
只做系统实时状态复核，不是用户授权，也不得代替、复制或伪造该 token。import、restore、install 与
n8n start 还共享物理 maintenance lock，确保停机检查到 journal 提交的维护窗口互斥。

`bootstrap.pending` 已升级为不可变 v4：以 `O_EXCL|O_NOFOLLOW` 独占创建、文件与父目录 fsync，
最终必须为 `0400`、`nlink=1`。它固定三段授权收据、evidence/proof、目标 release、双库物理身份、
router 和原始 n8n/workflow 身份；恢复时不刷新、不覆盖，也不把已过期的历史证据冒充当前安全。
若 guard 因 TTL、SIGKILL 或主机重启消失，部署器为本次恢复创建独立 UUID 目录，重新证明 legacy PID
与 3017 listener 均不存在、当前 n8n 来自精确受管 release、工作流未漂移、两库 `quick_check=ok`，
并离线复核媒体节点、n8n active execution、正式 waiting/running 都为零。历史非 durable accepted/running
超过 24 小时只进入 attention，不永久阻断；durable 队列无论年龄仍阻断。离线 projection 摘要和原始
queue digest 同时绑定到 120 秒一次性 resume capability。

fresh capability 先在锁外验证，再由 `serve-recovery` 按 Mission → n8n 固定顺序取得双库
`BEGIN IMMEDIATE`，锁内再次复核相同 runtime/projection。只有私有 socket/token 已原子就绪后才写入
不可变 consumed 收据并删除 capability；重放、错库、活跃任务、工作流漂移和部分 stale guard 状态
全部失败关闭。新 guard 以 `dual-recovery` 出现，随后按既有 handoff 只释放 Mission 锁并进入
`recovery-hold`。工作流确实损坏时必须先在 n8n 完全停止后走独立 restore-only journal，不能借 resume
路径放宽证据。

restore-only 分为两种收据。normal restore 只适用于 `bootstrap.pending` 尚未写入、legacy 尚未停止，
且原 guard 与 prepare/confirm/shutdown 链仍新鲜的首次迁移失败；由 controller 的
`derive-n8n-restore-confirmation` 派生。disaster restore 只适用于 pending v4 已写、legacy 已停止、
原确认或 guard 已失效的崩溃/重启现场；由 `derive-n8n-disaster-recovery-confirmation` 在 n8n、
LaunchAgent、3017/5678 listener 和目标数据库 open FD 全部满足停机证明后派生。同一 bootstrap
attempt 的 restore 与 resume 以不可变 branch claim 互斥。统一恢复脚本按 receipt schema 选择
normal/disaster journal；未提交阶段可在身份不变时续跑，`COMMITTED` 不可重放。恢复后必须先启动
精确受管 n8n release，复验 5678、真实数据库 FD、两条唯一 active/published 工作流及内容摘要，
再重新取得零活动证明并派生 fresh resume，绝不能从 restore 直接开放入口。

`bootstrap.pending`、evidence/proof 和备份已有明确的文件与父目录 fsync 边界。workflow transition、
normal/disaster restore 和 maintenance lock 的完整 durability 必须继续以候选实现的 file → directory
fsync 顺序、崩溃注入、重启恢复和 journal 续跑测试为发布门；在这些测试通过并形成证据前，文档不把
所有中间状态统称为已持久化保证。

生产 argv 允许使用受控的 n8n 与 Node `current` 软链接；验证器逐组件绑定其 owner、mode、
device/inode、链接目标与最终物理文件，n8n CLI 最终必须落到本次 40 位 commit release，Node
最终文件必须与 n8n 进程的 executable FD 一致。数据库、cwd 和物理 release 自身仍禁止软链接。
验证器在查询 SQLite 前后各捕获一次上述身份，并在 SQLite handle 保持打开期间用自身数字 FD
再次绑定数据库 device/inode，阻断路径换 inode 后再恢复的 ABA 窗口。任一原子替换、越界链接、
运行身份或工作流摘要漂移都会失败关闭；启动基线并通过 manager 检查后、写 baseline 前还会做
第三次紧邻复核。测试专用命令替身只有显式 test 环境才可用，部署器调用前会清除全部测试覆盖
变量，生产验证固定调用系统 `launchctl`、`lsof` 和 `ps`。

首次迁移中，n8n 工作流升级发生在 bootstrap 之前的独立维护步骤；`deploy-blue-green.sh`
本身只读验证，不导入工作流、不停止或启动 n8n。任一检查失败都保持外部冻结维护态，不能
启动新基线或开放入口。基线 application release ID 必须由当前 Git HEAD 的 7 至 40 位提交前缀
加可选 `-runtime` 组成；部署器把它解析为精确 40 位提交，并要求受管 n8n release 的
`SOURCE_COMMIT`、两条 release 内工作流和数据库已发布内容全部绑定同一提交，不能仅依赖后来
可能前移的 checkout 工作树。

首次引导完成后，常规发布顺序为：

1. 通过 `/tasks` 或 API 暂停新任务准入，记录 revision 与原因；
2. 构建不可变 release，并在 probe + SQLite 一致性快照上验收页面、CSS、只读 API、manifest
   和 `quick_check`；
3. 用真实数据库把同一候选启动为 inactive active-role slot；
4. 对 source/target 执行权限、schema、scheduler、runtime 和回滚点门禁；
5. 原子切换 3017，复验页面、API、数据库、manifest、runtime 身份和 scheduler leader；
6. 仅在全部成功后恢复新任务准入；
7. 旧 release 继续处理自己的 callback，新任务立即进入新 release；
8. 旧 release 排空并满足静默窗后再退役。

候选命令示例仅描述协议，不代表授权执行生产发布：

```bash
bash scripts/deploy-blue-green.sh stage <release-id> <absolute-standalone-root>
bash scripts/deploy-blue-green.sh bind <inactive-slot> <release-id> <absolute-release-root>

AIWORKER_BG_PROBE_DATA_DIR=<absolute-snapshot-dir> \
  bash scripts/start-standalone-slot.sh <inactive-slot> probe
bash scripts/deploy-blue-green.sh probe <inactive-slot>

bash scripts/start-standalone-slot.sh <inactive-slot> active
AIWORKER_BG_LIVE_DB_PATH=<absolute-live-db> \
  bash scripts/deploy-blue-green.sh switch <inactive-slot>
```

router/blue/green 使用独立、无密钥 LaunchAgent。安装清单同时固定 plist、router 脚本和 slot
启动脚本的 SHA-256；脚本漂移会让 preflight/start/status 失败关闭，必须重新执行受控安装事务。
安装默认不启动；service manager 提供 preflight/start/stop/status，退役槽被停止后不能被
KeepAlive 自动拉起。`status` 仅在健康时返回 0，未托管返回 1，已托管但异常返回 2。

## 退役与回滚

旧槽退役采用“在线初检 → 原子冻结该 release callback → listener 保持在线并有界二次排空
→ 停止 listener → 共享 SQLite 最终复核 → 签发一次性 proof v2”。冻结后会重新等待
release-owned / untracked callback、child lease、旧槽直连 TCP、router HTTP/SSE/WebSocket 和静默窗
全部归零，避免初检后刚进入的 callback 被直接终止。若有界等待失败，脚本会在停止进程前撤销
冻结并保持旧槽运行，让 n8n 重试继续完成，而不是先杀进程再发现任务尚未排空。最终复核要求：

- release-owned active callback 为零；
- 没有 untracked callback 或同槽其他 release 活跃记录；
- scheduler 已 inactive；
- router HTTP/SSE/WebSocket 连接归零；
- 满足 120 秒静默窗；
- PID、manifest、数据库、router generation 和 runtime identity 未漂移。

停止 listener 前若发现迟到 callback 或二次排空超时，旧槽恢复 callback 并保持运行；只有二次排空
成功后才停止 listener。停止后的最终 SQLite 复核若失败，旧槽才保持“冻结且停止”，不会在运行
身份已不确定时冒险重新开放。
rebind 只有在一次性消费有效 proof 后才清理旧 binding、freeze marker 和 proof。

切换后任一页面、API、数据库、manifest、runtime 或 scheduler 验收失败，脚本只把 router 原子
回到上一槽；不回滚共享任务数据库，不重启其他服务。首次 legacy bootstrap 在停止旧进程前会
直接复核两个 SQLite；停止后再次复核，随后启动新基线。任何后置失败都保持明确的冻结维护态，
不能猜测恢复未知旧环境。

如果首次工作流升级在 legacy bootstrap 开始前失败，必须保持入口冻结，并从已验证备份恢复
上一版 n8n 工作流/运行态，确认旧 3017 与旧工作流重新兼容后才允许开放。bootstrap 已停止
legacy 3017 后则不得自动把共享数据库或 n8n 工作流猜测性回滚；只按维护手册恢复明确的完整
回滚点，或保留冻结态处理。

## OpenClaw 兼容组

入口暂停协议要求 3017、`aiworker-task-flow` 和 `aiworker-video-command` 同时理解 423、稳定任务
身份和恢复语义。当前兼容候选插件版本为 `0.5.14`；task-flow 没有独立版本号，以唯一安装入口和目标
Git 提交校验实际文件。

蓝绿脚本不自动安装或重启 OpenClaw。生产变更单必须显式列出 plugin、Skill、3017 的兼容矩阵
与分项回滚顺序，不能把 release 内附带源码误当作 Gateway 已加载的新载荷。

video-command、task-flow 与 director-brain 三个共享安装器统一占用 blue/green 的
`.deployment.lock`；入口 `drain`、`resume` 以及新 `directorWork` 从作品解析到任务准入也必须先以
同一原子 `mkdir` 协议有限尝试取得该锁。已有幂等任务直接复用持久绑定，不再次查询飞书。安装器从
gate 验证开始，经实际替换、验收和失败补偿结束前始终持锁，因此不能在一次 `exists` 检查后绕过
锁变更入口或在作品解析与任务持久化之间切换共享树。常规路径必须显式传入物理规范的
`AIWORKER_BG_LIVE_DB_PATH`、
`AIWORKER_BG_N8N_DB_PATH` 和现存、物理、owner-private 的 `AIWORKER_VIDEO_BATCH_DIR`，并在实际替换前
验证入口暂停、n8n active execution 为零、活跃媒体节点为零、正式 waiting/running 为零和导演
outbox pending 为零；durable 根目录缺失不能按空队列处理。无 durable 归属且超过 24 小时的普通
历史任务只计 attention，有 durable 状态仍阻断；旧媒体节点即使超龄也单独阻断。

首次主库尚无 052/057 表时，只有同一未过期 bootstrap attempt 的 guard、evidence、proof、两库
身份和目标提交实时复核全部通过才可进入 legacy 安装路径。fresh `PREPARED` 可用于先安装三项共享
组件，避免把安装与 Gateway restart 挤进 `CURRENT_CONFIRMED` 的 120 秒窗口；最终 confirm/apply
仍在安装结束后执行。`CURRENT_CONFIRMED`、`SHUTDOWN_REQUESTED` 只用于同一 attempt 的幂等恢复。
三个安装器都会把当前源码提交和 `<commit>-runtime` 传给 gate，A attempt 不能安装 B release；缺表
本身不能作为放行条件。

## 当前状态

遗留媒体记录已按授权完成四字段 CAS，当前活跃媒体节点、n8n active execution 和正式队列
waiting/running 均为零；video lane 仍保持 disabled、unloaded、worker-free。远端 OpenClaw 已可使用
导演脑 `0.3.0` 的只读与候选入口，但生产 3017 仍运行 `542eebd-runtime`。当前 `0.5.14`、迁移
`057`、导演脑 `0.3.1` 和自动投影链仍是待切换候选；首次 n8n 离线迁移、blue/green bootstrap、
真实视频投影和恢复 lane 均须以当次运行核验为准。bootstrap 硬门会拒绝旧生产工作流、未发布
工作流、内容漂移以及 n8n PID/SQLite 错绑，防止在协议迁移不完整时切走 legacy 3017。
