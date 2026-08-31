# n8n 新任务暂停与 3017 蓝绿热切换

## 目标与非目标

本方案解决“发布 3017 新功能时必须等待所有 n8n execution 和长视频节点结束”的问题。
这里的“热更新”是不可变 release 加蓝绿路由切换，不是在运行进程内覆盖代码。

发布窗口只暂停新的顶层任务准入。已经受理的任务、n8n execution、模型节点和媒体节点
不被取消或强停，继续回调创建该任务的旧 release。新 release 验收并切换后即可恢复新任务
准入；旧 release 在后台排空后再退役。

本方案不会重启或修改 n8n、Gateway、模型服务、video worker、正式任务和业务数据，也不会
自动重提失败任务。

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

## 全局新任务闸门

迁移 `052_n8n_intake_controls` 增加单例闸门、审计事件和单调 revision。
`POST /api/n8n/trigger` 在 SQLite `IMMEDIATE` 事务中完成以下二选一：

1. 读取并返回已存在的同幂等任务；
2. 确认全局闸门仍为 accepting 后创建新任务。

因此“暂停”和“创建新任务”在线性化点上不会穿透。暂停后新任务返回脱敏的 HTTP `423`
和 `N8N_INTAKE_DRAINING`；已有任务查询、幂等续派和 callback 不受影响。

`GET/POST /api/n8n/intake-control` 使用 CAS revision，避免两个管理员覆盖彼此操作。
完整全局计数、原因和操作者只对以下发布管理员可见：

- 受信 loopback desktop；
- 全局 API key 身份；
- 默认 owner tenant/workspace 的正常管理员。

其他租户管理员和 agent-scoped 管理身份不能写闸门，只能读到
`{ accepting, canManage: false }`，不会获得跨租户计数或操作者信息。`drain-status` 和
`release-readiness` 使用同一发布权限边界。`/tasks` 的按钮以后端返回的 `canManage` 为准，
不能只凭租户角色显示。

## Webhook 幂等与响应不确定性

迁移 `054_n8n_task_dispatch_leases` 为顶层 webhook 派发增加带 fencing token 的短租约。
只有租约 owner 能提交派发结果，过期 owner 不能覆盖后来者。

- 明确、非重试型 HTTP 4xx 表示 n8n 已拒绝，可把尚未 claim 的父任务置为失败。
- 网络断开、超时、响应体丢失、HTTP 5xx、408、425 和 429 都是
  `outcome_unknown`，不能证明 n8n 未接收。
- `outcome_unknown` 返回 HTTP `202`，父任务保持 queued，派发租约保持不变；租约到期后
  只能携带同一任务 ID、幂等键和原始持久载荷续派。
- 本地 base URL、webhook path 和共享 secret 在创建父任务前验证，本地配置错误返回 503，
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

## 数据库滚动兼容门

`release-readiness` 不相信代码里的迁移常量，而是回读当前进程实际打开的 SQLite：

- `schema_migrations` 中必须存在 052 至 056；
- 四组新增表、关键列、类型、主键和非空约束必须匹配；
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
引导证据必须同时证明：入口外部冻结、活跃媒体节点为零、n8n 活跃 execution 为零、正式队列
waiting/running 为零，并且证据新鲜、Mission Control/n8n 数据库与两个真实 PID 绑定正确。
部署器在停止 legacy 3017 前后分别以只读方式对两个权威 SQLite 执行 `quick_check` 和零活动
复核，并验证 n8n PID 始终打开同一个数据库；证据中的 legacy release ID 还必须与进程物理 cwd
一致。任一检查失败都保持冻结维护态，不启动新基线。

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

## OpenClaw 兼容组

入口暂停协议要求 3017、`aiworker-task-flow` 和 `aiworker-video-command` 同时理解 423、稳定任务
身份和恢复语义。插件候选版本为 `0.5.13`；task-flow 没有独立版本号，以唯一安装入口和目标
Git 提交校验实际文件。

蓝绿脚本不自动安装或重启 OpenClaw。生产变更单必须显式列出 plugin、Skill、3017 的兼容矩阵
与分项回滚顺序，不能把 release 内附带源码误当作 Gateway 已加载的新载荷。

## 当前状态

以上均为本地候选，尚未部署生产。首次迁移硬门仍有一个活跃媒体节点，因此生产 3017 继续运行
旧 release；当前只允许测试、Git 交付和只读复核。
