# 独立后台调度进程

Next.js 页面与 API 默认不启动后台调度器。独立 Node 进程复用原有 scheduler、导演证据及提炼服务、任务模块和 Mission Control SQLite；不新增数据库、队列、任务状态机或用户鉴权。UI 变更只影响 Web 制品，后台源码或其依赖内容变化时才更新 worker。

## 构建和运行接口

`scripts/build-scheduler-worker.mjs` 使用项目固定 Node、现有 TypeScript 和 Next 提供的编译工具离线生成独立制品，`--output` 参数必须指向尚不存在的输出目录。源码依赖由编译图与 Node 文件跟踪共同确定，运行时不编译 TypeScript。产物清单包括实际源码摘要、全部文件或符号链接、权限、内容摘要、Node ABI、操作系统和架构。成员必须完整回读；符号链接只能指向制品内部，私有标记、配置、数据库及运行数据不得混入。

`scripts/start-scheduler-worker.mjs` 接收 `--artifact`、`--state-dir` 和 `--env-file` 三个绝对路径参数，在启动前审计清单、文件、权限、平台与 SQLite 原生加载。状态目录必须为当前用户所有的 0700 目录，平台环境文件必须为 0600 普通文件，按 literal dotenv 解析，不执行 shell。安装控制器负责使用准确路径和固定 Node 渲染 `ops/scheduler-worker/launch-agent.plist.template`；该模板不是已安装服务的记录。

启动器剔除 Web 的 slot、release、router 和调度禁用标记，显式设置 `AIWORKER_SCHEDULER_MODE=worker`、`AIWORKER_WORKER_CONTENT_SHA256` 和 `AIWORKER_SCHEDULER_STATE_DIR`。后台身份独立于页面蓝绿槽位。Web 使用相同状态目录定位进程，但不因此获得调度资格。旧版 Web 的禁用开关仍是 `AIWORKER_DISABLE_SCHEDULER=1`，迁移和回滚必须明确处理它。

## 数据库准备

生产 Web 与 worker 只打开已经存在的数据库，检查已应用迁移和导演维护扩展；启动不创建管理员凭据、不生成替代数据库、不隐式执行 schema 变更。开发、构建和隔离测试保留原来的自动准备方式。

数据库维护入口为制品中的 `prepare-database.cjs --prepare-existing`，目标从 `MISSION_CONTROL_DB_PATH` 读取。它要求已有 0600 数据库并先检查完整性。该命令不代替发布锁、维护窗口、备份、业务状态检查或数据写入授权；安装控制器在明确的维护阶段调用。

## 首次交接与后续更新

后台沿用 `builtin_scheduler` 租约表及 holder/revision/expiry CAS，不建立第二把任务调度锁。首次迁移的 `handoff.json` 保持 0600，绑定操作、权威数据库 dev/ino/pathSha256 和已经验证的旧执行环境。

允许先启动 follower 消除发布依赖循环。此时收据使用 `migrationPending=true`，私有 `previous` 包含旧 PID、slot、release、router generation、lease holder 和 revision。安装控制器先核对实际旧 Web/数据库/租约身份及调度无活动作业；worker 启动再次确认旧 PID 存活、原租约 holder 相同、revision 未回退且租约有效。原有效租约存在时不会抢占，新 Web 切流后等待旧 scheduler 释放，后台才获得唯一领导权。

最终验收必须证明 worker 已持有有效租约、数据库身份一致、旧 scheduler 已停止或释放领导权，才能形成已完成交接收据并恢复准入。完成后的收据不再依赖旧 PID 存活。后续重启继续使用同一数据库租约；更新 worker 时通过 `POST /drain` 或 SIGTERM 停止新调度，保持租约心跳直到当前作业结束，再退出旧进程。不得用进程超时直接杀死长时间业务任务。

## 健康和页面通知

状态目录中的 `worker.sock` 是权限为 0600 的同用户 Unix socket，不监听网络端口。`GET /status` 返回实时 worker 身份、数据库身份、领导状态、活动作业数和 `leaseVerified`；只有实际数据库租约与本进程 holder/revision 一致且未过期才返回健康。`worker-status.json` 是每 5 秒更新的诊断投影，不能代替实时 socket 验收或成为业务权威。

应用通过共享 `getExternalSchedulerStatus()` 读取 socket，并再次核对数据库身份与状态新鲜度。`/api/scheduler` 保留现有权限入口，返回 worker 状态及本 Web 的 `webLeadership`；手动操作经 `/trigger` 转交同一后台。worker 不可用时明确返回 503，不在 Web 临时启动第二个 scheduler。

`/events` 和 `/event` 只传递瞬态状态通知。Web 和 worker 产生的数据库变更仍由原进程负责原有 webhook 投递；中继事件带 `relayed` 标记，其他进程仅用于 SSE，不重复创建 webhook 投递。缓慢订阅者断开后通过既有 API 回读权威状态，通知流不保存第二份业务数据。

顶层视频仍由 3017 当前应用服务受理并固定回调归属。后台创建的导演阶段继续绑定原 sourceTaskId、bindingId 和内部子任务身份，不根据 worker 启动时的 Web 槽位改写父任务 routing。已持久的 n8n 回调归属不变，不能因为调度独立就跳过旧回调排空检查。

数据库定时备份独立于 scheduler；`auto_backup` 只保留手动薄入口，调用受管 `database-backup.py`。缺少 `AIWORKER_DATABASE_BACKUP_CONFIG` 时明确报告未配置，不回退到旧裸复制或十份历史清理逻辑。

## 验证边界

定向验证覆盖生产 schema 只读检查、worker 资格与租约、Web 禁止调度、API 转发、通知投递去重及父任务绑定。`scripts/test-scheduler-worker-runtime.mjs` 的 `--artifact` 参数指定已有制品，测试使用独立临时数据库，验证真实进程启动、相同租约下拒绝重复 worker、socket 通知、优雅排空和 follower 交接，结束后清理本测试的进程与目录。源码与隔离通过不等于生产部署；正式制品必须来自固定且已审查的源码，生产事实另记对应运维记录。
