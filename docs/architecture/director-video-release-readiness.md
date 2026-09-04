# 导演脑视频链发布兼容门

## 目的

`scripts/verify-director-video-release-readiness.mjs` 是 3017 视频分析到飞书导演脑单向投影链的
唯一跨组件发布检查。它只读、失败关闭，不安装组件、不重启服务、不修改任务、数据库或飞书。

当前兼容发布集固定为：

| 组件 | 发布身份 |
| --- | --- |
| Video AutoWorker standalone | Git release ID + `2.0.1` + `release-manifest.json` |
| `aiworker-video-command` | `0.5.14` |
| `aiworker-task-flow` | 与同一 Git 提交生成的精确安装清单 |
| `aiworker-director-brain` | `0.4.0`，包含插件和 Skill |

## 验证范围

检查要求 canonical 仓库位于 `main`、工作树干净、remote 正确，release ID 精确解析到当前
Git HEAD。standalone 必须位于声明的不可变 releases 根下，并通过已有 standalone 完整性审计。
审计同时覆盖 Next standalone 的静态 import 闭包和 shell 运行时显式动态依赖闭包；被 shell helper
按路径调用、但不可能被打包器静态追踪的脚本也必须进入 manifest、制品和来源证明。release 只能由
最终干净提交构建，dirty 源树、缺失动态 helper 或仅在源码仓库中存在的依赖都不得进入发布门。
最终制品采用无自引用的三方绑定：`release-provenance.json` 保存排除自身与
`release-manifest.json` 后的完整 artifact content digest；manifest 保存同一 digest，并包含 provenance
文件摘要。content digest 覆盖目录、全部服务端/可执行/静态普通文件的字节数与 SHA-256，以及符号
链接路径和目标；运行数据库、token、PID 等外部数据不属于 release。修改任一 artifact 成员后只重生
普通 manifest 会因 provenance 中的旧 content digest 失败，单独重生 provenance 也会因 manifest
中的 provenance 文件摘要失败。发布门还把 provenance 绑定到干净 Git commit 与抽取源码闭包。
本机制用于发现发布后的漂移，不宣称在没有独立签名基础设施时可以抵抗同时重建两份证明的发布者。

三份 OpenClaw 安装载荷按现有安装器的真实 payload 边界重建期望清单，再与安装目录的目录集合、
文件集合和每个文件 SHA-256 精确比较。任何软链接、额外文件、文件缺失、set-id 文件或组/其他用户
可写对象都会失败。插件的 `package.json` 与 `openclaw.plugin.json` 版本必须同时匹配。

集成契约另行确认：

- 已安装 `submit-task.mjs` 仍接受并传递 `--director-work`；
- 导演 CLI wrapper、Feishu service、service 直接依赖的共享敏感值扫描器、schema、证据
  transformer wrapper、inner library、应用侧封套/分批/回执语义模块，以及
  `director-evidence-delivery-core.ts` 的 SHA-256 与 `director-evidence-outbox.ts` 固定闭包一致；
  delivery core 自身不保存自己的摘要，避免自引用；
- 上述八项闭包与投影 schema 版本共同计算
  `projection_contract_digest`；当前 SQLite 中所有
  `pending` outbox 必须使用同一摘要，存在旧摘要 pending 时 forward switch 失败关闭；
- standalone 的服务端 bundle 实际包含同一组固定闭包摘要，而不是只检查源码副本。

outbox 在创建时把投影契约摘要纳入幂等身份。部分批次已经写入后如果转换器或飞书写入契约
升级，新版本不会继续投影或把该行错误标记为 delivered；旧契约恢复后仍可依靠稳定证据 ID
完成幂等重放。该门只阻断投影契约不兼容的发布，不会让普通页面功能更新等待已 delivered、
conflict 或同摘要 pending 记录。

binding 严格解析、query digest、outbox 不可变身份、权威任务回读、transform、分批写入、回执、
重试分类和全部状态 CAS 都位于 hashed delivery core；外层 outbox 只保留受管命令身份、子进程
runner、投影契约构建与薄入口。transform 的 JSON 合同仍为 2 MiB，wire 只额外允许一个换行；
其 stdout/stderr 总上限为 8 MiB，以容纳最多 240 段中文画面字段经受控复制后的合法投影。
`operate`、`project-evidence` 继续使用较窄上限。只有 delivery core 已验证本次命令输入合同后，
`director_command_output_too_large` 才是不可重试冲突；否则按可恢复错误退避。

五阶段候选写入使用 `feishu-candidate-projection-v2`。它不再按固定 20 条切批，而是对最终
`propose_batch` JSON 加换行后的真实 UTF-8 字节数计量：常规批次最多 8 条并以 24 KiB 为软目标，
32 KiB 是不可越过的 CLI 线协议上限。单条合法候选超过边界时，只缩写允许承载长叙事的字段，保留
头尾并写入完整 checkpoint 的摘要指纹；完整模型候选仍留在不可变 checkpoint，飞书仅保存供人工
复核的有界投影。即使缩写后仍不能投影，也以
`director_extraction_projection_input_too_large` 确定性终止，不能按网络故障无限重试。
`propose_batch` 的子进程超时只按其有界条数从 30 秒受控增加，普通查询仍保持 30 秒。

同一 release gate 还只读核对 extraction root/phase 的作用域绑定、成功 phase 的 checkpoint 与
projection receipt 摘要、review receipt 摘要、后继 phase 的前置审核和 checkpoint 的投影版本。
等待人工审核本身不是活跃执行；queued/running phase、断链、缺失回执或旧投影边界均阻断切换。

readiness 只给统一 preinstall orchestrator 提供不可变只读判据。orchestrator 对每个组件维护
append-only journal，以固定 component identity、备份、安装结果和补偿结果追加事件，不覆盖历史；
terminal 状态只能由单次 finalize CAS 从未决状态推进。成功必须产出绑定同一 attempt、source commit、
transition claim、runtime convergence proof 和 readiness 摘要的 handoff，bootstrap controller 只接受这
个 handoff。失败或进程恢复只能续作同一 journal 分支，不得手填 success、复用其他 attempt 的证明或
跳过逆序补偿。

## 发布顺序

完整发布顺序为：从最终干净提交构建并审计 immutable standalone；在隔离端口验收页面、CSS、只读 API、
两库 `quick_check` 与回滚点；执行飞书 v2 -> v3 的 dry-run、私有全表快照、独立 verify、仅新增 14 字段的
apply、真实 API 回读和 rollback-dry-run；完成 n8n transition/attestation；捕获真实
`second-original` 会话工具基线；运行统一 preinstall orchestrator；收到 terminal handoff 后再执行
legacy controller 的 `prepare -> current-confirm -> apply`；最后才 bootstrap 并精确切换 3017。该检查
不能代替隔离启动、飞书迁移、OpenClaw 自然对话、跨压缩恢复或真实视频闭环验收。

### 插件安装与数据库迁移边界

`aiworker-director-brain 0.4.0` 的安装器只替换目标 OpenClaw profile 下的插件、Skill、私有无密钥
运行载荷和该 Agent 的窄授权；它不打开 Mission Control SQLite、不调用 `runMigrations`，也不创建、
更新或回填导演提炼记录，也不会迁移飞书导演脑 catalog。当前真实测试 catalog 是 v2，随安装包
携带的 schema v3 只是待迁移候选；在另行完成 v3 迁移和真实 API 回读前，加载 0.4.0 的运行时会
对版本不匹配失败关闭。发布顺序应先用 `migrate --dry-run` 固定无破坏性计划，再由显式外部写入任务
生成权限受控的全表备份、执行 v2 → v3 追加迁移并真实回读，最后才由统一 preinstall orchestrator
安装 0.4.0 并 fresh restart 目标 Gateway 一次；不能把插件安装当成飞书迁移器。安装本身不要求生产数据库先出现 058/059，也不能作为飞书
v3 已就绪的证据。

生产数据库对象只由新的 3017 application release 首次打开权威 Mission Control SQLite 时按既有
迁移器创建。`057_n8n_director_evidence_outbox` 已进入 canonical `main`，其迁移块 SHA-256 固定为
`bf78ce0a0784e823261bc0e55e0e4ea23ec226013a70702faa3200e285d6d048`，后续不得改写。新增对象严格
追加为：

- `058_director_extraction_task_runs`：三张 phase 级表
  `director_extraction_checkpoints`、`director_extraction_projection_receipts`、
  `director_extraction_review_receipts`；生命周期继续以既有 `n8n_task_runs` root/phase 为权威；
- `059_director_evidence_projection_receipts`：一张
  `n8n_director_evidence_projection_receipts`，只保存飞书证据投影的紧凑可验证回执，避免把远端
  回执塞进已发布且含可变重试状态的 057 outbox。

058 只有在启用自动五阶段提炼时才是功能必需；只读问答、作品解析、检索和候选提交并不依赖它。
059 对“远端写入成功后可证明、可恢复而不盲目重写”是必需的；因为 057 已冻结，不能通过回改 057
增加回执列。当前完整非剪辑导演脑发布同时包含自动提炼和可验证投影，因此 readiness 将两项都列为
必需迁移，不能把“0.4.0 插件已安装”误报成“数据库提炼链已上线”。

首次 blue/green bootstrap 会在提交 baseline、释放维护保护之前自动执行该检查。常规 forward
`switch` 会在 router 原子切换前执行，并把 HEAD 绑定的静态 verifier 摘要与 target runtime
readiness 摘要直接对账；失败时 intake 继续暂停，router 不切换。普通 `switch` 和显式
`rollback` 都只允许同一投影契约，任务归零也不能跨契约。legacy 首迁仍只能走带冻结证据和
回滚证明的专用 bootstrap，不能把普通切换当作契约迁移通道。

首次 bootstrap 前的回滚证明必须同时包含 `quick_check=ok` 的 Mission Control 与 n8n SQLite online
backup，并绑定源库 device/inode、队列摘要、freeze guard 和目标 release。新 release 启动后 058/059
只执行 `CREATE ... IF NOT EXISTS`，不改写既有业务行。bootstrap 成功提交 baseline 后，旧
`57f6e6c-runtime` 被永久 fence，不再允许作为普通 blue/green slot 或普通 rollback 目标；后续常规
回滚只能在相同 `projection_contract_digest` 的新架构 release 之间进行。跨契约或需恢复旧 legacy
数据库时必须保持入口冻结，走显式 restore/disaster-recovery 手册和完整双库回滚点，不能让部署器
猜测性降级。

每个 slot 的 `release-readiness` 同时公开该 release 编译时的投影契约摘要和权威 outbox 计数。
source/target 摘要相同，已有任务可继续按 release affinity 排空并热切换；摘要不同则普通转换
直接失败关闭。转换提交前同时捕获 source/target 的 release manifest、slot/runtime/router
attestation 哈希、readiness revision/schema epoch/契约摘要与原路由元组，并以进程内只读、带
SHA-256 封套的证据复验。这样 source=A、仓库 HEAD=B 时，自动回滚不会拿只接受 HEAD 的 target
verifier 错验历史 source；显式 rollback 也使用同一证据路径。目标验证失败仍返回非零，任一
source 回滚证据失败则保持 intake 暂停。旧槽 callback 冻结并达到静默后、停止旧槽前还会再查
不兼容 pending；普通页面和不改变投影闭包的功能发布仍保留热切换能力。

延迟退役可能发生在发布后的 docs-only 审计提交之后。退役门允许 active release 是当前干净
`main` HEAD 的 Git 祖先，但仍执行完整 payload、闭包、bundle 与 outbox 校验；非祖先 release、
脏工作树或 projection 源码/安装树漂移继续失败关闭。router runtime attestation 只绑定启动 PID、
监听地址和 router state 路径，不包含 generation；正常原子更新 router state 不会改写该文件，
因此转换证据保存的 attestation SHA-256 不会因 generation 增长而自然失效。

切换完成后，在显式启用 video lane 或把 intake 改回 active 前，应紧邻操作再执行一次只读检查：

```bash
node scripts/verify-director-video-release-readiness.mjs \
  --repository-root /absolute/path/to/video-autoworker \
  --releases-root /absolute/path/to/video-autoworker/.runtime/releases \
  --release-id <git-commit-runtime> \
  --release-root /absolute/path/to/video-autoworker/.runtime/releases/<git-commit-runtime>/standalone \
  --live-db-path /absolute/path/to/authoritative-mission-control.sqlite
```

默认安装身份是 `~/.openclaw-qwen-current` 与
`~/AI-worker-second-original-workspace`。非默认受管安装必须显式增加
`--profile-state-root` 和 `--workspace-root`，不能通过指向源码目录来替代已安装载荷验收。

成功只输出一行 JSON，包含 app manifest SHA、四个安装树 manifest SHA、插件版本、八项投影闭包
摘要、当前投影契约摘要、pending 数和不兼容 pending 数。任一错误返回非零；不得忽略退出码
继续开放 intake 或恢复 video lane。安装共享投影组件前仍应先让当前契约的 pending 归零，避免
旧进程在共享安装树已经更新后失去完成重放的能力。

三份共享安装器与 blue/green 发布器使用同一个 `.deployment.lock`。常规安装要求入口已暂停、
权威 Mission Control/n8n SQLite 均为显式物理文件、durable batch 根目录现存且 owner-private，
n8n active execution、媒体节点、正式队列 waiting/running 与 outbox pending 全部为零。入口
`drain`、`resume` 和新 `directorWork` 的作品解析到任务准入均通过相同原子锁串行；安装或失败补偿
持锁期间返回 locked，不会变更入口，也不会让新任务在两套导演组件之间解析和持久化。已有幂等任务
继续读取原持久绑定，不依赖飞书在线。首次
legacy 主库尚无 052/059 表时，不接受环境变量布尔绕过；只能使用未过期、绑定同一双数据库、
源码提交和 `<commit>-runtime` 的 bootstrap attempt，实时复核 freeze guard、evidence、rollback
proof 和双采样归零证据后安装。fresh `PREPARED` 可承载三项安装，120 秒的 current-confirm 留给
最终 transition；confirmed/shutdown 阶段只接受同一 attempt 的恢复。

durable batch 根允许保留 runtime guard 自身的 `.worker-launch.lock` 与
`.worker-launch.lock.owner`，但两者必须完整成对、权限与 schema 正确、marker 的 inode/摘要/token
和 owner 绑定一致、owner PID 仍存活且 marker 在 15 秒刷新窗内；它们只代表发布期间阻断新 worker
的 guardian，不计为 durable work。根下也可保留 runtime guard 已接受的一层终态历史目录：目录必须
为物理 `0700`，且只包含成对的 `<64hex>.json` 与 `.json.bak` 普通文件，主状态及其 item 全部终态。
缺任一 guardian 成员、绑定漂移、陈旧 guardian、活跃主状态、孤立备份、未知成员、软链接或更深目录
都会让共享安装门失败关闭。
