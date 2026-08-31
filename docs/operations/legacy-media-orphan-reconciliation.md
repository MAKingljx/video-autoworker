# Legacy 媒体孤儿记录受管对账

## 适用范围

`scripts/reconcile-legacy-media-orphan.mjs` 只用于首次蓝绿迁移前遗留的媒体子记录：父任务和对应 n8n execution 已终态，但 `prepare`、`audio` 或 `vision` 子记录仍错误停留在 `queued`、`accepted` 或 `running`。

该工具不处理 `finalize`，不取消、恢复或重提任务，不删除记录，不修改父任务，也不替代正常的 `/api/n8n/runs/reconcile`。

## 强制门禁

dry-run、prepare 和 apply 都会按各自阶段重新验证：

- 3017 与 5678 唯一监听进程的 PID、UID、启动时间、argv SHA-256、物理 cwd、Node executable、release ID；
- 3017 打开的 `mission-control.db` 以及 5678 打开的 `database.sqlite` 必须来自各自进程的数字 FD；guard 再用自身 verifier FD 和 better-sqlite3 新增的数字 FD 同时绑定预捕获 path/device/inode，并在查询结束及关闭前复核；
- 5678 listener 与 n8n LaunchAgent 的直接父子关系；
- video-lane supervisor 已 disabled、unloaded，且无 worker、无全局锁；
- n8n 活跃 execution 为零，正式持久队列 `waiting/running` 均为零；
- 目标是唯一活跃媒体子记录，父任务已终态，子记录超过显式阈值且与父任务、binding、租户和 workspace 一致；
- 子阶段不是 `finalize`，没有 execution lease、媒体工作目录或关联进程；
- 操作者显式给出的 n8n execution 已终态，且严格 JSON 解析后的结构中至少一个字符串值精确等于目标父任务标识；子串不算绑定；
- Mission Control 与 n8n SQLite 的 `quick_check` 均为 `ok`。

JSON、manifest 和数据库成员均有尺寸上限；重复 JSON key、异常 `pgrep`、非 `ENOENT` 的路径检查失败、符号链接、路径双向重叠、身份漂移、附加活跃记录、备份变化或写前竞态都会失败关闭。工具不依赖尚未部署的签名冻结标记；`BEGIN IMMEDIATE` 是本次单行写入的线性化点。

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

### 2. prepare

dry-run 通过后，使用完全相同的目标参数增加 `--prepare` 和权限为 `0700` 的独立备份根：

```text
--prepare --backup-root /受控备份根
```

prepare 创建并验证备份，然后生成 mode `0400` 的 `backup-manifest.json` 与 `prepare-manifest.json`，最后把该次目录收紧为 `0500`。prepare manifest 绑定 10 分钟有效期、随机 nonce、handoff nonce、工具 SHA-256、备份 manifest SHA-256、父子及其他记录摘要、execution、两库验证器 FD、完整进程身份、队列摘要和 supervisor 状态。只有 prepare 成功才输出短时 `confirmationToken`。

### 3. apply

只有用户看过 prepare 结果并明确确认当次生产数据写入后，才能使用仅包含以下三个参数的 apply；不得混入或重新解释目标参数：

```text
node scripts/reconcile-legacy-media-orphan.mjs \
  --apply \
  --prepare-manifest /受控备份目录/prepare-manifest.json \
  --confirm-token confirm-<prepare 返回值>
```

apply 不创建第二份备份。它从不可变 prepare manifest 恢复目标输入，逐一回读备份成员、权威快照和实时状态。manifest 到期、工具变化、文件篡改或任一实时证据漂移后，必须重新 dry-run、prepare 并取得新的用户确认；不得自动提取、缓存或回填 token。

## 备份、写入与回滚

prepare 创建独占备份目录。Mission Control SQLite、WAL、SHM 的逐字节副本仅标记为 `forensic`，用于调查，不能直接宣称为可恢复数据库；哈希使用固定小块流式读取，并在同一 FD 上比较读前、读后身份和尺寸。工具另用 SQLite backup API 生成 `authoritative` 一致性快照，执行 `quick_check` 并回读目标、父任务和其他记录摘要。该 snapshot 才是唯一权威回滚数据库。

同一 orphan 修复备份家族最多保留最近两份经 manifest、成员 SHA-256、权限与 `consistent-snapshot.db` `quick_check` 全部验证通过的恢复点。生成新恢复点后，先验证新旧两份均有效，再对更早成员执行可恢复归档或受控清理；不得在新备份尚未完整验证时删除旧恢复点，也不得把 forensic 三件套误当权威恢复库。

apply 先取得两次一致的实时快照并与 prepare 逐字段比较，再取得 Mission Control `BEGIN IMMEDIATE` writer lock，在同一事务中重新读取全局活跃媒体、目标、父任务、lease、工作目录/进程、其他记录投影和 n8n execution。任何先到的新任务都会在锁内复核时使操作失败；后到写入必须等待本事务结束。工具只用完整旧值做 CAS，把该 child 改为 `failed` 并写入固定错误码。事务内确认父任务与其他记录未变、仅四个受控字段变化并再次执行 `quick_check`，提交后立即重新绑定两库、复核 n8n/正式队列/媒体节点归零并回读目标。

成功 apply 会输出 `handoffNonce`、`postApplyQueueDigestSha256`、`backupManifestSha256` 和 `othersDigest`，但固定返回 `handoffReady=false`、`releaseDecision=NO-GO`：对账成功只证明这一条生产数据修复完成，不能单独授权发布。后续必须由独立 freeze guard 对权威 Mission Control SQLite 取得 `BEGIN IMMEDIATE` writer reservation，并在锁建立后重新绑定仍在线的 legacy 3017 身份、重新取得两次完整零活动快照，再生成 bootstrap evidence。apply 与 guard 之间如果出现新任务，锁后的新快照会失败关闭；不会沿用 apply 的旧零状态。guard 不暂停 legacy 进程，3017 读探针保持在线，新写会被 writer reservation 阻塞或拒绝；guard 异常退出、TTL 到期或受管 revoke 时锁由 SQLite 释放，因此不需要 SIGSTOP/SIGCONT guardian。

若提交后发现异常，不得覆盖整库或继续重试。先冻结全部入口并停止写入者，再依据 prepare 目录中的 `backup-manifest.json` 和 `consistent-snapshot.db` 制定精确恢复步骤；三个 forensic 原始成员不能替代权威 snapshot。恢复生产仍属于独立生产数据操作，必须重新确认。

## 安全记录边界

Git 只保存本说明、工具和测试。实际 child/task/execution ID、PID、数据库路径、备份路径、冻结 nonce、确认 token、manifest 和数据库内容均不得提交或复制到飞书。
