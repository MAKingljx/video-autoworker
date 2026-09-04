# Legacy 媒体孤儿记录受管对账

## 适用范围

`scripts/reconcile-legacy-media-orphan.mjs` 默认仍只用于首次蓝绿迁移前遗留的媒体子记录：父任务和对应 n8n execution 已终态，但 `prepare`、`audio` 或 `vision` 子记录仍错误停留在 `queued`、`accepted` 或 `running`。

显式 `--parent-pre-media` 是一个更窄的兼容扩展，只处理正式队列自动发现的唯一一条 stale `accepted` 顶层 `video-analysis` 父记录，且该记录从未创建四个确定性媒体子记录。它用于正常 reconciliation API 不具备受管备份、不可变 manifest、短时确认 token 和双样本门禁时的单次历史收敛；不是日常替代 API。

两种模式都不取消、恢复、删除或重提任务。默认子模式不处理 `finalize`、不修改父任务；父模式只允许把自动发现的父记录做固定四字段终态转换。

## 强制门禁

dry-run、prepare 和 apply 都会按各自阶段重新验证：

- 3017 与 5678 唯一监听进程的 PID、UID、启动时间、argv SHA-256、物理 cwd、Node executable、release ID；
- 3017 打开的 `mission-control.db` 以及 5678 打开的 `database.sqlite` 必须来自各自进程的数字 FD；guard 再用自身 verifier FD 和 Node `22.22.3` 内建 `node:sqlite` 新增的数字 FD 同时绑定预捕获 path/device/inode，并在查询结束及关闭前复核；
- 5678 listener 与 n8n LaunchAgent 的直接父子关系；
- video-lane supervisor 已 disabled、unloaded，且无 worker、无全局锁；
- n8n 活跃 execution 为零，正式持久队列 `waiting/running` 均为零；
- 目标是唯一活跃媒体子记录，父任务已终态，子记录超过显式阈值且与父任务、binding、租户和 workspace 一致；
- 子阶段不是 `finalize`，没有 execution lease、媒体工作目录或关联进程；
- 操作者显式给出的 n8n execution 已终态，且严格 JSON 解析后的结构中至少一个字符串值精确等于目标父任务标识；子串不算绑定；
- Mission Control 与 n8n SQLite 的 `quick_check` 均为 `ok`。

父模式另外要求先通过 OpenClaw 官方 LaunchAgent 流程停止唯一具备 `aiworker-video-command` 的 `qwen-current` Gateway。工具会连续两次证明 `ai.openclaw.qwen-current` job 不存在、`18889` 无 listener、无可识别的该 Gateway 进程，并且所有 `submit-task.mjs` / material-handoff 进程均已归零。legacy runtime 没有 `n8n_intake_controls` 表或暂停 API，缺表会被明确绑定为 `legacy-gateway-freeze`，不得临时创建或伪造该表；若后续 runtime 已真实具备此表，它只能作为额外门禁，且唯一控制行必须已暂停并绑定 revision/摘要。后续新 slot 的 bootstrap/migration 仍须按正式 schema 和 intake API 正常创建、暂停并验证该控制状态，不能复用本次 legacy 缺表证明。

正式队列必须恰好只有一条 `attention`：`accepted`、stale、`sourceAvailable=null`、`queueOrigin=n8n`，并由该队列项自动绑定数据库父记录；命令行不得携带 row、task、execution 等业务标识。父记录必须至少陈旧 24 小时，source 为受支持的顶层入口，routing 与 scope 内 binding 均严格为 `video-analysis`，idempotency key 等于 task ID，尚未 started/completed，attempt 为零且 delivery 为 `none`。全库只能有这一条 active 顶层记录，四个确定性媒体子记录必须在任意 scope 下全部不存在，并且全局 media/model active、同 task identity 的父 claim、dispatch lease、子 lease、cleanup debt、director outbox、媒体工作目录、关联进程和 n8n active execution 全部为零。

JSON、manifest 和数据库成员均有尺寸上限；重复 JSON key、异常 `pgrep`、非 `ENOENT` 的路径检查失败、符号链接、路径双向重叠、身份漂移、附加活跃记录、备份变化或写前竞态都会失败关闭。工具不依赖尚未部署的签名冻结标记，也不会为 legacy runtime 合成新版 intake 状态。父模式的线性化边界由生产提交路径共用的 `.duplicate-submission.lock` 与两库 `BEGIN IMMEDIATE` 共同建立。

## 受管暂停与工作目录隔离

`scripts/legacy-media-orphan-runtime-guard.mjs` 是 orphan 对账前的窄 preparatory guard。它不修改任务、execution 或数据库，不创建第二条队列，也不删除媒体。当前实现仍是本地候选；只有随完整提交通过发布门并在真实生产仓库纯快进后，才能从该生产 checkout 调用，不能把本地同名脚本复制到服务器执行。

guard 的 `prepare` 自动从 3017 打开的权威 Mission Control SQLite 识别唯一 orphan、终态父任务和严格绑定的终态 n8n execution，不从命令行接收业务 ID。调用方只提供两个已存在、当前用户所有、物理无符号链接且 mode `0700` 的根，以及显式陈旧阈值。生产 prepare 必须增加 `--hold-guardian yes`，使同一进程在输出 `prepared-held` 后继续刷新 guardian，直至后续 dry-run、备份 prepare 与人工决策完成：

```text
node scripts/legacy-media-orphan-runtime-guard.mjs prepare \
  --run-root /绝对路径/受控运行根 \
  --quarantine-root /绝对路径/同卷隔离根 \
  --minimum-age-seconds <900-2592000> \
  --hold-guardian yes
```

执行前它连续两次绑定 3017/5678 listener、进程 incarnation、open-FD 权威库、受保护 listener、现役 LaunchAgent plist、唯一 serve-root worker 和全局锁，并要求持久批次没有 runnable item、staging recovery 或 material-handoff journal，n8n active 与正式 waiting/running 均为零。工作目录必须是 mode `0700` 的物理目录，整棵树无 symlink、无关联 open FD 或进程命令引用，且两次树摘要一致。

历史隔离测试可能在 batch root 留下一层终态目录。guard 只接受 owner 当前用户、mode `0700`、物理无 symlink、非空且仅含严格成对的 `64hex.json/.bak` 普通文件的一层目录；主备两份都必须符合批次 schema，实际调度所读取的 primary batch/item 必须全部非 active、无 staging recovery。`.bak` 只作为上一个历史快照绑定身份和摘要，即使保留旧 active 字样也不等于当前可运行任务。目录、成员 dev/inode/mode/bytes/SHA、主备角色与状态进入 projection 摘要；未知成员、更深目录、软链、缺失主备或 primary 任一活跃状态仍失败关闭。guard 只读绑定这种终态目录，不移动或删除它。

guard 先以独占 `.worker-launch.lock` guardian 阻断绕过 LaunchAgent 的 detached worker，并持续刷新、复核该 guardian 的 inode 与 token；随后持久化不可变 intent，再精确 `disable` 和 `bootout` 现役 video-lane。它不发送 `SIGKILL`、不覆盖 installed skill，也不调用 supervisor installer。由于现役 worker 在默认 `SIGTERM` 下不会执行 JavaScript `finally`，guard 只在旧 PID 已消失且未复用、无任何进程打开全局锁、锁的 dev/inode/完整内容/token 均未漂移时，才把死亡 owner lock 同卷原子移动为 attempt 内的只读证据，绝不 `unlink` 该锁或删除证据。

锁静默门通过后，guard 只允许对遗留工作目录执行同一 device 上的一次 `rename(2)`，核对前后 dev/inode 与完整树摘要，并依次 fsync 隔离父目录和原工作目录父目录。最终 receipt 与独立 anchor 均为 mode `0400`、nlink `1`，绑定 intent、工具摘要、launch guardian、死亡锁证据、前后运行身份、源/目标 inode 和树摘要；anchor 的 durable publish 是唯一提交点，attempt 目录随后收紧到 mode `0500`。

只有在 rename 明确尚未发生、源目录仍与 intent 完全一致且目标不存在时，普通失败才允许安全释放 guardian 并按原 plist 恢复 lane。rename 一旦已经发生或可能发生，任何 receipt/anchor/chmod/fsync 后续失败都保留隔离目录、静默 lane 和 guardian，不做反向移动，也不把已提交状态回滚成冲突状态。此时只能使用同一不可变 intent 接管原 guardian：缺 receipt 时补 receipt，缺 anchor 时严格回读候选 receipt 后补 anchor，已提交时只完成 mode/fsync；源/目标双有、双无或 inode/内容/树漂移均拒绝续作。唯一允许的旧工具摘要只适用于本次已知的 rename 前中断 intent，receipt/status 仍必须匹配当前工具摘要。

`--hold-guardian yes` 的 holder 必须作为活进程保留。每 5 秒刷新同一 inode/token，使现役提交脚本看到小于 30 秒的 handoff lock 并拒绝启动 detached worker；不得用陈旧静态文件、`touch` 循环或“尽快执行”替代。`status` 对持锁 receipt 返回 `prepared-held`，同时核对 holder PID、token、inode 与刷新时间。holder 被 `SIGKILL` 后文件会保留，但不再构成持续门禁，必须先按 intent 接管或恢复，不能继续 dry-run/prepare。

```text
node scripts/legacy-media-orphan-runtime-guard.mjs recover --intent /受控运行目录/intent.json
node scripts/legacy-media-orphan-runtime-guard.mjs status --receipt /受控运行目录/receipt.json
node scripts/legacy-media-orphan-runtime-guard.mjs restore --receipt /受控运行目录/receipt.json
```

`status` 和 `restore` 只消费 receipt 并回读 anchor、intent、dev/inode、哈希和实时运行态。`restore` 先写不可变 `restore-intent.json`，再以单向追加方式原子移回同一棵工作目录、恢复原 lane并发布 restore receipt/anchor；任一 SIGKILL 后根据“仍隔离且 lane 静默”“已移回且 lane 静默”“已移回且 lane 精确 active”三种唯一现场续作，其他组合失败关闭。restore anchor 是恢复提交点；提交后只补目录 seal/fsync，绝不重新隔离。重复调用只验证并返回已恢复，不重复移动或启动。guard 永不删除隔离根、attempt、intent、receipt、anchor 或媒体数据。

guard `prepare` 成功只解除现有 orphan 工具的外部运行门，不产生数据库备份。随后仍须运行下文的 orphan dry-run 与 prepare；数据库四字段 apply 继续要求用户看过该次权威备份和 prepare manifest 后作出新的当次确认。

## 三阶段操作

### 1. dry-run

默认是纯只读 dry-run。操作者提供目标 child row、child task、parent task、阶段、当前状态、原 `updated_at`、对应 execution 和最小陈旧阈值；此阶段不接受备份根，不创建目录、manifest 或确认 token：

```text
node scripts/reconcile-legacy-media-orphan.mjs \
  --child-row-id <row> \
  --child-task-id <child-task> \
  --parent-task-id <parent-task> \
  --stage <prepare|audio|vision> \
  --expected-status <queued|accepted|running> \
  --expected-updated-at <unix-seconds> \
  --execution-id <n8n-execution> \
  --minimum-age-seconds <900-2592000>
```

父记录模式不接收或输出业务 ID。最小阈值下限固定为 86400 秒：

先在生产节点使用已安装 OpenClaw 的官方命令停止该 profile，并等待 job、listener、Gateway 和提交/交接子进程全部退出；不要直接删除 plist、修改插件或创建 intake 表：

```text
openclaw --profile qwen-current gateway stop
```

```text
node scripts/reconcile-legacy-media-orphan.mjs \
  --parent-pre-media \
  --minimum-age-seconds 86400
```

### 2. prepare

dry-run 通过后，使用完全相同的目标参数增加 `--prepare` 和权限为 `0700` 的独立备份根：

```text
--prepare --backup-root /受控备份根
```

父记录模式的完整 prepare 命令仍不携带业务 ID：

```text
node scripts/reconcile-legacy-media-orphan.mjs \
  --parent-pre-media \
  --minimum-age-seconds 86400 \
  --prepare \
  --backup-root /受控备份根
```

prepare 创建并验证备份，然后生成 mode `0400` 的 `backup-manifest.json` 与 `prepare-manifest.json`，最后把该次目录收紧为 `0500`。prepare manifest 与 confirmation token schema 均升级为 v3，旧 schema/token 明确不可复用。v3 绑定 10 分钟有效期、随机 nonce、handoff nonce、入口脚本及其可达本地静态 import/re-export 依赖闭包的确定性 SHA-256、备份 manifest SHA-256、父子及其他记录摘要、两库验证器 FD、完整进程身份、队列摘要、物理 batch root 身份和 supervisor 状态；因此 prepare 后只修改共享锁模块或其传递依赖也会使旧 token 失效。manifest 还独立绑定 TypeScript parser 的绝对路径、版本、字节数、SHA-256 与 device/inode/owner/mode/link-count 身份，以及实际数据库运行时的 Node 可执行文件同级绑定、Node 版本、内建 SQLite 版本和固定 `node:sqlite` 类型。这些字段都进入不可变 manifest 与 confirmation token。

工具闭包由绑定后的 TypeScript AST 从无跟随文件描述符读出的字节建立；只接受 `node:` 内建模块和闭包根内的相对 `.js` / `.mjs` 静态 import/re-export。动态 import、bare package、绝对路径、`file:` URL、query/hash、越界路径和其他文件类型全部失败关闭，不会被静默漏出摘要。对账工具本身不再加载外部 `better-sqlite3` JS 或 native addon，而使用 Node 内建 `node:sqlite`；首次访问业务库前会在纯内存库上探测 `DatabaseSync`、statement、`backup`、`BEGIN IMMEDIATE` 与查询能力，缺失即失败关闭。本次验证环境是 Node `22.22.3` / SQLite `3.51.3`，manifest 仍精确绑定实际 Node/SQLite 版本以及 Node 可执行文件身份和摘要；prepare 后任一项漂移都必须重新 prepare，但工具不以硬编码 minor 版本替代能力验证。适配层保持既有 `backup`、双库 reservation、`quick_check`、pragma、CAS 与 FD 身份合同。子模式还绑定终态 execution，父模式绑定 legacy Gateway 冻结证明、可选 intake 状态、n8n active 为零及自动发现的完整父行。只有 prepare 成功才输出短时 `confirmationToken`。manifest 是受控私有证据，可能包含精确数据库身份，不得复制到聊天、Git 或飞书。

### 3. apply

只有用户看过 prepare 结果并明确确认当次生产数据写入后，才能使用仅包含以下三个参数的 apply；不得混入或重新解释目标参数：

```text
node scripts/reconcile-legacy-media-orphan.mjs \
  --apply \
  --prepare-manifest /受控备份目录/prepare-manifest.json \
  --confirm-token confirm-<prepare 返回值>
```

apply 不创建第二份备份。它从不可变 prepare manifest 恢复目标和模式，逐一回读备份成员、权威快照和实时状态。父模式 apply 同样只接收 manifest 与 token，不追加 `--parent-pre-media` 或任何业务 ID。入口启动阶段只加载 Node 内建模块；apply 最早阶段只用 Node 内建文件与严格 JSON 逻辑读取 manifest、备份引用和独立 runtime bindings，先用完整 manifest SHA 校验 supplied token，再读取并比较 Node/SQLite runtime 与 parser 的绑定，任何外部 parser 代码都不得早于这个顺序执行。parser 从已验证的内存字节通过同步 loader hook 加载，hook 保持到 AST 闭包构建及加载后磁盘复核结束；因此 parser 在捕获后被替换成带顶层副作用的版本也不会执行替换版本。

每次 SQLite 打开都把规范化文件路径编码为 `file:` URL，并显式附加只读 `mode=ro` 或可写 `mode=rw`，等价于强制 `fileMustExist`：路径在 verifier 捕获后消失时，内建驱动只能失败，不能重建空主库、journal、WAL 或 SHM；路径被另一 inode 替换时，新增数字 FD 与预捕获身份不一致，必须在任何查询、事务或 CAS 前关闭并拒绝。测试同时约束缺失路径不留下数据库家族成员、替换库字节与 sidecar 集合不变。

tool token 与 parser/runtime 独立绑定通过后，父模式再用同步 loader hook 从同一私有内存闭包快照加载共享提交锁模块，加载前后复核磁盘成员。非入口闭包成员额外禁止 `require`、`createRequire` 和 `import.meta` 运行时加载；loader 只放行已验证闭包 URL 和 `node:` 内建模块，并一直保持到共享锁 acquisition 返回，随后立即注销，绝不跨越 Mission Control / n8n writer transaction。即使磁盘成员在验证后发生竞态替换，也不会执行替换后的顶层代码；闭包外的延迟本地加载同样会在取得共享锁前失败关闭。manifest 到期、工具、parser、Node/SQLite runtime、文件或任一实时证据变化后，必须重新 dry-run、prepare 并取得新的用户确认；不得自动提取、缓存或回填 token。

## 备份、写入与回滚

prepare 创建独占备份目录。Mission Control SQLite、WAL、SHM 的逐字节副本仅标记为 `forensic`，用于调查，不能直接宣称为可恢复数据库；哈希使用固定小块流式读取，并在同一 FD 上比较读前、读后身份和尺寸。工具另用 SQLite backup API 生成 `authoritative` 一致性快照，执行 `quick_check` 并回读目标、父任务和其他记录摘要。该 snapshot 才是唯一权威回滚数据库。

同一 orphan 修复备份家族最多保留最近两份经 manifest、成员 SHA-256、权限与 `consistent-snapshot.db` `quick_check` 全部验证通过的恢复点。生成新恢复点后，先验证新旧两份均有效，再对更早成员执行可恢复归档或受控清理；不得在新备份尚未完整验证时删除旧恢复点，也不得把 forensic 三件套误当权威恢复库。

apply 先取得两次一致的实时快照并与 prepare 逐字段比较。默认子模式依次取得 Mission Control 与 n8n 的 `BEGIN IMMEDIATE` writer reservation，并把 n8n reservation 持有到 Mission Control CAS/COMMIT 完成，关闭只读校验到 CAS 之间的新 execution 竞态；父模式先按 prepare 绑定的物理 batch root 取得与 `createBatchState` / `createSingleVideoState` 共用的 `.duplicate-submission.lock`，再取得相同的两库 reservation。全局顺序固定为“可选提交锁 → Mission Control → n8n”，避免锁序反转。

持有三层 reservation 期间，工具连续两次回读正式队列并严格比较 `queueOrigin/sourceAvailable` 等完整投影，在第二次样本后紧邻 CAS；首次 n8n 读取后新起的 execution 会在取得 n8n reservation 后、Mission Control 写入前被发现，reservation 建立后 n8n 无法提交新 execution。若真实 intake 表存在，其暂停行在同一 Mission Control writer transaction 内不能恢复；legacy 缺表时则依靠已绑定的 Gateway/process 冻结证明和共享提交锁，而不是虚构 intake 行。事务同时重新读取全局活跃媒体/模型、目标、父任务、claims/leases、工作目录/进程、outbox/debt 和其他完整记录；children、claims 与 leases 按全局 task identity 查询，不因异常 scope 值漏检。

任何先到的新任务都会在锁内复核时使操作失败；已经通过入口预检但尚未持久化的提交会阻塞在共享锁，只有 CAS 完成后才能成为线性化点之后的新提交，不能追溯性推翻已提交判断。工具只用完整旧值做 CAS，把目标改为 `failed`，并以同一个秒值写入 `completed_at` 与 `updated_at`。子模式写入 `LEGACY_MEDIA_ORPHAN_RECONCILED`；父模式写入固定 `VIDEO_CALLBACK_LEASE_EXPIRED` 语义，CAS 同时绑定 id、task、source、status、updated_at、routing、binding、scope 和 idempotency。父模式先提交 Mission Control，提交前始终持有 n8n writer reservation，随后释放 n8n reservation、关闭两库连接，最后释放共享提交锁。事务内以完整旧行摘要确认仅 `status/error/completed_at/updated_at` 四字段变化、其他记录及旁路状态未变并再次执行 `quick_check`；提交后立即重新绑定两库、复核 runtime 未漂移。父模式还强制正式队列 attention/waiting/running/total 全部归零；若提交后此门失败，工具报告失败但绝不重试已经提交的 CAS。

成功 apply 会输出 `handoffNonce`、`postApplyQueueDigestSha256`、`backupManifestSha256` 和 `othersDigest`，但固定返回 `handoffReady=false`、`releaseDecision=NO-GO`：对账成功只证明这一条生产数据修复完成，不能单独授权发布。后续必须由独立 freeze guard 对权威 Mission Control SQLite 取得 `BEGIN IMMEDIATE` writer reservation，并在锁建立后重新绑定仍在线的 legacy 3017 身份、重新取得两次完整零活动快照，再生成 bootstrap evidence。apply 与 guard 之间如果出现新任务，锁后的新快照会失败关闭；不会沿用 apply 的旧零状态。guard 不暂停 legacy 进程，3017 读探针保持在线，新写会被 writer reservation 阻塞或拒绝；guard 异常退出、TTL 到期或受管 revoke 时锁由 SQLite 释放，因此不需要 SIGSTOP/SIGCONT guardian。

若提交后发现异常，不得覆盖整库或继续重试。先冻结全部入口并停止写入者，再依据 prepare 目录中的 `backup-manifest.json` 和 `consistent-snapshot.db` 制定精确恢复步骤；三个 forensic 原始成员不能替代权威 snapshot。父模式恢复只能从 authoritative snapshot 提取该行原 `status/error/completed_at/updated_at`，在重新确认现行完整行、scope、错误码和其他字段均符合预期后执行精确反向 CAS，并在同一事务内复核完整行摘要与 `quick_check`。本工具不提供自动 restore 命令，也禁止用 snapshot 或 forensic 文件整库覆盖生产库。恢复生产仍属于独立生产数据操作，必须重新取得对应阶段规则与用户确认。

## 安全记录边界

Git 只保存本说明、工具和测试。实际 parent/child/task/execution ID、PID、数据库路径、备份路径、冻结 nonce、确认 token、manifest 和数据库内容均不得提交或复制到飞书。
