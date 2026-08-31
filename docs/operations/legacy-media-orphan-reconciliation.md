# Legacy 媒体孤儿记录受管对账

## 适用范围

`scripts/reconcile-legacy-media-orphan.mjs` 只用于首次蓝绿迁移前遗留的媒体子记录：父任务和对应 n8n execution 已终态，但 `prepare`、`audio` 或 `vision` 子记录仍错误停留在 `queued`、`accepted` 或 `running`。

该工具不处理 `finalize`，不取消、恢复或重提任务，不删除记录，不修改父任务，也不替代正常的 `/api/n8n/runs/reconcile`。

## 强制门禁

dry-run、prepare 和 apply 都会按各自阶段重新验证：

- 3017 与 5678 唯一监听进程的 PID、UID、启动时间、argv SHA-256、物理 cwd、Node executable、release ID；
- 3017 打开的 `mission-control.db` 以及 5678 打开的 `database.sqlite` 路径、device/inode，并在 SQLite 打开期间用验证器自身 FD 再次绑定；
- 5678 listener 与 n8n LaunchAgent 的直接父子关系；
- video-lane supervisor 已 disabled、unloaded，且无 worker、无全局锁；
- n8n 活跃 execution 为零，正式持久队列 `waiting/running` 均为零；
- 目标是唯一活跃媒体子记录，父任务已终态，子记录超过显式阈值且与父任务、binding、租户和 workspace 一致；
- 子阶段不是 `finalize`，没有 execution lease、媒体工作目录或关联进程；
- 操作者显式给出的 n8n execution 已终态，且严格 JSON 解析后的结构中至少一个字符串值精确等于目标父任务标识；子串不算绑定；
- Mission Control 与 n8n SQLite 的 `quick_check` 均为 `ok`。

JSON、manifest 和数据库成员均有尺寸上限；重复 JSON key、异常 `pgrep`、非 `ENOENT` 的路径检查失败、符号链接、路径双向重叠、身份漂移、附加活跃记录、备份变化或写前竞态都会失败关闭。工具不依赖尚未部署的签名冻结标记；`BEGIN IMMEDIATE` 是本次单行写入的线性化点。

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

apply 先取得两次一致的实时快照并与 prepare 逐字段比较，再取得 Mission Control `BEGIN IMMEDIATE` writer lock，在同一事务中重新读取全局活跃媒体、目标、父任务、lease、工作目录/进程、其他记录投影和 n8n execution。任何先到的新任务都会在锁内复核时使操作失败；后到写入必须等待本事务结束。工具只用完整旧值做 CAS，把该 child 改为 `failed` 并写入固定错误码。事务内确认父任务与其他记录未变、仅四个受控字段变化并再次执行 `quick_check`，提交后立即重新绑定两库、复核 n8n/正式队列/媒体节点归零并回读目标。

成功 apply 会输出 `handoffNonce`、`postApplyQueueDigestSha256`、`backupManifestSha256` 和 `othersDigest`，但固定返回 `handoffReady=false`、`releaseDecision=NO-GO`：对账成功只证明这一条生产数据修复完成，不能单独授权发布。后续必须由独立 freeze guard 对权威 Mission Control SQLite 取得 `BEGIN IMMEDIATE` writer reservation，并在锁建立后重新绑定仍在线的 legacy 3017 身份、重新取得两次完整零活动快照，再生成 bootstrap evidence。apply 与 guard 之间如果出现新任务，锁后的新快照会失败关闭；不会沿用 apply 的旧零状态。guard 不暂停 legacy 进程，3017 读探针保持在线，新写会被 writer reservation 阻塞或拒绝；guard 异常退出、TTL 到期或受管 revoke 时锁由 SQLite 释放，因此不需要 SIGSTOP/SIGCONT guardian。

若提交后发现异常，不得覆盖整库或继续重试。先冻结全部入口并停止写入者，再依据 prepare 目录中的 `backup-manifest.json` 和 `consistent-snapshot.db` 制定精确恢复步骤；三个 forensic 原始成员不能替代权威 snapshot。恢复生产仍属于独立生产数据操作，必须重新确认。

## 安全记录边界

Git 只保存本说明、工具和测试。实际 child/task/execution ID、PID、数据库路径、备份路径、冻结 nonce、确认 token、manifest 和数据库内容均不得提交或复制到飞书。
