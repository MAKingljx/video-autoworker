# 导演脑视频链发布兼容门

## 目的

`scripts/verify-director-video-release-readiness.mjs` 是 3017 视频分析到飞书导演脑单向投影链的
唯一跨组件发布检查。它只读、失败关闭，不安装组件、不重启服务、不修改任务、数据库或飞书。

当前兼容发布集固定为：

| 组件 | 发布身份 |
| --- | --- |
| Video AutoWorker standalone | Git release ID + `2.0.1` + `release-manifest.json` |
| `aiworker-video-command` | `0.5.15` |
| `aiworker-task-flow` | 与同一 Git 提交生成的精确安装清单 |
| `aiworker-director-brain` | 已验证接口兼容的 `0.4.1`、`0.4.2` 或薄客户端 `0.4.3`；安装树由独立 runtime proof 绑定 |

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

Video command 与 Skill 继续按安装器 payload 精确比较。director-brain 在 app 发布门只核对已知版本、
工具/钩子接口、manifest/package 版本一致性和安全文件类型；插件树字节身份由同一会话的 runtime proof
绑定。`0.4.1`/`0.4.2` 的历史厚插件可先服务新 app，`0.4.3` 薄客户端再独立安装和重启 Gateway，
避免 app 与插件互相要求对方先上线。

集成契约另行确认：

- 已安装 `submit-task.mjs` 仍接受并传递 `--director-work`；
- 导演 CLI wrapper、Feishu service、service 直接依赖的共享敏感值扫描器、schema、证据
  transformer wrapper、inner library、应用侧封套/分批/回执语义模块，以及
  `director-evidence-delivery-core.ts` 的 SHA-256 与 `director-evidence-outbox.ts` 固定闭包一致；
  delivery core 自身不保存自己的摘要，避免自引用；
- 八项实现闭包继续逐文件校验并写入 provenance 的 implementation 指纹，但不再决定互通协议。
  `projection_contract_digest` 对新任务使用稳定 protocol 摘要；历史 `e4bc…`、`1b23…`、`eec8…`
  仅凭 v2 声明中的完整旧闭包精确映射，未知摘要仍失败关闭；
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
`propose_batch` 的子进程超时只按其有界条数从 30 秒受控增加。批量 `get_many` 保留并发上限，
不设置整个批次的固定 wall timer；其他普通命令仍使用各自有界超时。

同一 release gate 还只读核对 extraction root/phase 的作用域绑定、成功 phase 的 checkpoint 与
projection receipt 摘要、review receipt 摘要、后继 phase 的前置审核和 checkpoint 的投影版本。
等待人工审核和合法但尚未发起提炼的成功来源都不是活跃执行。已识别的 pending、有效 delivered
回执或 `receipt_invalid` 历史冲突可在新 app 上线后由独立幂等入口处理；未知协议、身份损坏、
queued/running phase、断链、缺失回执或旧投影边界仍阻断切换。

工具基线采用v4，同时固定catalog/effective可见工具描述面和策略提示。唯一已验证可接受的提示是
effective中的 `browser-filtered-by-profile / info`，它表示现有profile有意过滤browser；必须保留其
原始message/profile哈希，并要求browser确实不在有效工具集合。catalog非空提示、MCP目录未就绪、
警告、重复和未知提示仍拒绝。安装前后先比策略数组，再比工具集合与描述面，不能删除提示或改变
profile来使门禁通过；复用近期收敛proof时也必须具备完整v4策略内证。

runtime proof 还必须具备插件收集锚点：快照在本轮首次 RPC 前取得，证据处理前后都验证同一组
插件树；生成和复用均验证 `pluginCollectionAnchor`，缺少该内证的旧 proof 拒绝复用。
controller 必须把 readiness 返回的 proof SHA 与实际使用的文件引用绑定，不能在通过校验后
接纳另一个未经该次校验的文件。该要求不改变外层 proof/v1 或合法 fresh proof 的重验流程。

共享组件的 rolling 安装门按成对布局验证运行状态根和不可变 release 根。生产使用同一受管用户
home 下的 `ai-worker/state/video-autoworker/blue-green` 与
`ai-worker/services/video-autoworker-app/releases`，避免运行资产落入 CloudDocs/FileProvider
管理的 Documents。既有仓库内布局仍限定为同一 repository root 下的 `.run/blue-green` 与
`.runtime/releases`。两种布局不能交叉配对，也不接受任意环境变量指定的其他目录；选定布局后仍逐项
核对目录 owner、运行状态根的 0700 权限、realpath、router/slot 的状态路径、真实 PID/cwd 和数据库打开文件身份。

实际部署从 canonical repository 的物理脚本路径执行。统一 preinstall 显式传入 `--releases-root`
和 `--deployment-run-dir`；bootstrap controller 显式绑定 `--router-run-dir` 与 `--router-state`。
部署及 LaunchAgent 安装同时设置 `AIWORKER_BG_RUN_DIR`、`AIWORKER_BG_RELEASES_DIR` 和绝对 Node 路径，
并在 bootstrap 前完成受管 LaunchAgent 的安装，使运行目录与启动参数持久化。生产槽每次启动依次
读取 canonical repository 的 `.env`、`.env.local` 和默认
`~/.config/video-autoworker/platform.env`，必须核对这些持久文件合并后的数据库与运行配置；不能把
仅在当前 shell 中设置的路径当作重启后的配置证据。

readiness 只给统一 preinstall orchestrator 提供不可变只读判据。orchestrator 对每个组件维护
append-only journal，以固定 component identity、备份、安装结果和补偿结果追加事件，不覆盖历史；
terminal 状态只能由单次 finalize CAS 从未决状态推进。成功必须产出绑定同一 attempt、source commit、
transition claim、runtime convergence proof 和 readiness 摘要的 handoff，bootstrap controller 只接受这
个 handoff。失败或进程恢复只能续作同一 journal 分支，不得手填 success、复用其他 attempt 的证明或
跳过逆序补偿。

## 发布顺序

常规发布从最终干净提交构建并审计 immutable standalone，复用未变化组件的有效安装证明，只对影响面
执行 focused 隔离验收；随后 stage inactive slot、核对数据库 `quick_check` 与回滚点、绑定并探测候选，
在同一 intake revision 下原子切换 3017。插件、控制层或飞书 schema 未变化时，不重复安装、Gateway
重启、全页面/CSS 验收或历史数据修复。首次 bootstrap、飞书迁移和旧 38 条恢复继续使用各自专用流程。

进入生产数据阶段前，还须在真实 canonical checkout 核对统一 orchestrator 直接调用的四个 shell
入口均具备 Git 跟踪的可执行位，并以正式入口验证解释器和参数可用。模拟 fixture 的权限不能作为
真实文件权限证据；缺少执行权限必须先通过源码提交和最终制品验证修复，不得等数据迁移后才发现。

### 插件安装与数据库迁移边界

`aiworker-director-brain 0.4.3` 安装器只替换目标 OpenClaw profile 下的薄插件和该 Agent 的窄授权；
Feishu CLI、service、scanner 与 schema 随 app release 交付。安装器不打开 Mission Control SQLite、
不调用 `runMigrations`，也不创建、
更新或回填导演提炼记录，也不会迁移飞书导演脑 catalog。当前真实测试 catalog 是 v2，随安装包
携带的 schema v3 只是待迁移候选；在另行完成 v3 迁移和真实 API 回读前，加载 0.4.1 的运行时会
对版本不匹配失败关闭。发布顺序应先用 `migrate --dry-run` 固定无破坏性计划，再由显式外部写入任务
生成权限受控的全表备份、执行 v2 → v3 追加迁移并真实回读，最后才由统一 preinstall orchestrator
安装 0.4.1 并 fresh restart 目标 Gateway 一次；不能把插件安装当成飞书迁移器。安装本身不要求生产数据库先出现 058/059，也不能作为飞书
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
必需迁移，不能把“0.4.1 插件已安装”误报成“数据库提炼链已上线”。

首次 blue/green bootstrap 会在提交 baseline、释放维护保护之前自动执行该检查。常规 forward
`switch` 会在 router 原子切换前执行，并把 HEAD 绑定的静态 verifier 摘要与 target runtime
readiness 摘要直接对账；失败时 intake 继续暂停，router 不切换。显式 `rollback` 只允许同一投影
契约。普通 `switch` 默认同样如此；同一 schema 的缺陷修复只有在目标 release 带有精确前向兼容
声明时才可跨摘要。声明固定旧契约完整闭包、旧摘要、新摘要、允许变化的闭包成员、same-wire、
稳定 ID、source/outbox/receipt 身份不变保证及回归文件 SHA。clean commit 构建时声明同时写入
`release-provenance.json` 和 `release-manifest.json`；发布门从同一 Git commit 重读并重算，再与
source/target runtime readiness 的实时摘要对账。缺失、漂移、额外闭包变化或反向使用均失败关闭。
legacy 首迁仍只能走带冻结证据和回滚证明的专用 bootstrap。

首次 bootstrap 前的回滚证明必须同时包含 `quick_check=ok` 的 Mission Control 与 n8n SQLite online
backup，并绑定源库 device/inode、队列摘要、freeze guard 和目标 release。新 release 启动后 058/059
只执行 `CREATE ... IF NOT EXISTS`，不改写既有业务行。bootstrap 成功提交 baseline 后，旧
`57f6e6c-runtime` 被永久 fence，不再允许作为普通 blue/green slot 或普通 rollback 目标；后续常规
回滚只能在相同稳定 projection protocol 的新架构 release 之间进行。历史 implementation 摘要映射只允许原
`switch` 在本次调用内使用；路由提交后的既有复验失败可按已捕获 source 证据自动补偿，成功返回后
不授权显式反向切换。除此之外的跨契约或需恢复旧 legacy
数据库时必须保持入口冻结，走显式 restore/disaster-recovery 手册和完整双库回滚点，不能让部署器
猜测性降级。

每个 slot 的 `release-readiness` 同时公开稳定投影 protocol、实现指纹和权威 outbox 计数。
source/target protocol 相同即可按 release affinity 排空并热切换；仅历史 implementation 摘要需要通过
目标 release 的精确映射，否则转换失败关闭。转换提交前同时捕获 source/target 的 release manifest、slot/runtime/router
attestation 哈希、readiness revision/schema epoch/契约摘要与原路由元组，并以进程内只读、带
SHA-256 封套的证据复验。这样 source=A、仓库 HEAD=B 时，自动回滚不会拿只接受 HEAD 的 target
verifier 错验历史 source；显式 rollback 也使用同一证据路径。目标验证失败仍返回非零，任一
source 回滚证据失败则保持 intake 暂停。旧槽 callback 冻结并达到静默后、停止旧槽前还会再查
未知协议 pending；普通 app 实现变化不再因文件 SHA 改变而失去热切换能力。

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

## 制品来源格式兼容

新增协议字段使用 `video-autoworker-standalone-provenance/v3`。验证器从目标release对应Git提交中的writer声明读取格式，制品审核器也绑定制品内writer声明；不拿当前源码的格式要求直接覆盖历史格式。已部署v2继续校验原clean提交、源码闭包、构建锚点、清单和完整内容摘要，同时要求新增协议字段不存在。v3必须同时具有完整protocol与implementation绑定；冒充旧格式、未知声明或缺字段均拒绝。
