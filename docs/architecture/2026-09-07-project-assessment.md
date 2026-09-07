# AI-worker 项目分析与优化顺序

分析基于本轮 canonical 源码、隔离验证和第二台运行环境只读证据。应用候选为 d96cad2，恢复控制为同一 Git lineage 的后续提交；这些候选尚未激活。平台通用性边界与验收见同目录 `2026-09-07-platform-independent-core.md`，具体部署对象和回退见 `../deployment/2026-09-07-optimization-recovery-plan.md`。

## 项目定位与边界

Video AutoWorker 是面向视频和通用 AI 任务的控制中心。Next.js 提供页面与 API，SQLite 保存任务、运行租约、素材索引和审计状态，n8n 编排持久化执行链，OpenClaw 当前承担会话运行时及唯一外部身份入口。飞书导演脑保存具有素材证据、候选审批与版本语义的知识。

AI-worker 根目录承担规划和运维记录，产品源码及可复现交付资产归 canonical 仓库 `MAKingljx/video-autoworker`。应用源码、控制程序、n8n 工作流、已安装平台运行时和业务数据库具有不同生命周期，不能用本地同名目录或某个 Git HEAD 推断当前生产版本。

## 当前真实调用链

普通页面/API 经过 `src/proxy.ts` 和 `src/lib/auth.ts` 的身份与权限检查；n8n 机器回调另经 callback admission 校验运行归属，不能作为第二个人员登录入口。应用会话服务通过 `src/lib/runtime-provider.ts` 选择当前 OpenClaw provider，调用平台 CLI 或公开 Gateway 接口。

n8n 任务由 `src/app/api/n8n/trigger/route.ts` 接收 task ID 与幂等键，通过准入、workspace/tenant 和 runtime affinity 建立持久化派发及租约。`src/lib/n8n-task-runs.ts`、`n8n-task-dispatch.ts`、`n8n-intake-control.ts` 与 `n8n-runtime-affinity.ts` 共同维护状态和归属。工作流中的 claim、node-execute、media execute 和 reconcile API 必须在核验所有权后结算步骤与父任务；两份 workflow JSON 承担编排，不能各自另建任务权威。

素材路由 `src/app/api/materials/asset/route.ts` 通过 `src/lib/safe-rooted-file.ts` 执行根目录检查、拒绝符号链接并打开文件句柄，响应从已打开的文件读取。当前加固减少路径检查与实际读取脱节的风险，未宣称消除所有并发文件系统攻击。导演知识提取经专用 outbox 与飞书协议实现持久化。

普通任务仍由 scheduler 调用 `src/lib/task-dispatch.ts`，直接处理 OpenClaw/Claude 选择、执行、重试与任务结算。这条旧实现尚未迁入新的会话注册表；现有适配器目录和模型名称也不能作为已完整支持其他平台的证据。

## 本轮修复和已验证范围

本轮修复素材边界与句柄读取、CSP 主题初始化 nonce、Node 主版本及 SQLite 原生 ABI 构建前验证、OpenClaw 9.2 keyed agent 配置读写和 Gateway 状态 DTO 兼容。恢复控制补齐受管 execve 启动合同、不可变历史凭据回验、应用映射、准入恢复和崩溃后的幂等接续。会话合同、注册表和 OpenClaw 实现已分离，替代 provider 的隔离测试验证了消息提交与等待过程中可以完全不创建 OpenClaw 实例。

最终应用经 Node 22/ABI 127 实际构建、远端内容审计和内存 SQLite 查询，独立 HOME/数据库下完成 12 项 HTTP 断言；主题行为另有真实浏览器证据。最终同一制品另完成官方 515 项完整端到端测试，全部通过，测试后的不可变制品复核通过，测试服务已停止。生产备份副本完成 051–059 迁移后，原 53 张业务表内容摘要不变，519 条视频任务保留。以上是隔离证据，不能替代正式激活后的接口、进程、数据和准入验收。完整 CI 的常规分组 183 文件、2218 测试已通过，后续重型安装器分组的测试副本依赖缺失仍在修正，尚不能称为 Quality Gate 全绿。

生产只读证据显示历史应用线停留在 3db，控制台及蓝绿应用槽位未监听，n8n 和三套 OpenClaw 9.2 Gateway 继续运行。普通任务为空，视频队列无活动任务，视频 lane 停用。两库一致性备份的摘要与完整性已复核；恢复 pending、保护 guard 和已消费凭据保留。制品已交付但未激活，生产迁移及准入恢复仍须按具体对象确认。

## 后续优化优先级

第一优先级是完成当前恢复事务与真实验收。发布控制自身的来源、能力消费、数据库迁移和准入顺序不能因上游升级或目录整理而绕开。工具目录的跨版本变化应保留历史指纹、记录差异，并为当前已运行版本建立独立恢复前基线；新基线仅证明本次恢复前后一致，不能追认历史升级的语义等价。

恢复后优先处理普通任务派发的持久化 attempt 和幂等性。`task-dispatch.ts` 的两处 Gateway 请求键含当前时间，异常重试会产生新键；状态提前写入可以减少重复派发，但无法证明请求已接收而响应丢失时不会再次执行。应先持久化稳定 attempt 身份、复用同一请求键、保存平台执行引用，并区分接受、运行和完成，再把该实现迁入 TaskExecutionPort。不要承诺跨数据库和外部平台天然具有 exactly-once 语义。该问题是既有普通任务路径的可靠性风险，本轮没有用生产任务触发或重试它。

下一步依次迁移 TaskExecution、AgentDirectory、Identity 和 KnowledgeRepository。每次迁移共用既有业务服务、任务标识、持久队列和权限语义；平台协议、配置、凭据与外部 ID 留在适配器。当前会话合同仍保留 `sessionKey`、`raw: any` 等兼容字段，需要逐步规范化响应、错误与能力声明，避免业务层继续解析平台 DTO。

最后选择一个真实第二平台进行端到端验收，覆盖幂等重试、乱序回调、取消、超时、附件、权限拒绝与平台不可用。在没有 OpenClaw 二进制、配置、Gateway 和凭据的环境中完成同一业务任务、读回结果并验证恢复后，才可声明对应业务已脱离 OpenClaw。生产切换时暂停新准入，保留进行中任务原有执行归属，排空后退役旧适配器。
