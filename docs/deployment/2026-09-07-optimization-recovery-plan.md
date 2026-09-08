# 2026-09-07 优化与同次部署恢复计划

目标为在第二台 heisenbergs-1 恢复 Video AutoWorker 控制台与正常任务准入。应用来源固定为 d96cad249b56ed8506f30e4d8b76148f5f8ac13e，部署控制固定为 cbcbd258e30a94821df8225c0204b4148199baa6（完整 Quality Gate 已通过）。独立 QA 脚本来源在其输入与验收结果中另行绑定，不改变应用与恢复控制；历史 pending/controller/n8n 来源固定为 3db98c30f70126b78a0575b6e69023d70407c490。此前交付的 3332b067 制品未激活，因缺少 keyed agent 修复不再作为最终目标。

## 已具备证据

应用在 Node 22.22.3 构建，ABI 127 原生 SQLite 验证通过；本地与远端制品内容摘要一致，普通文件无共享 inode。实际接口、素材边界和主题切换通过。生产一致性备份副本的 051–059 迁移通过，原 53 张业务表内容保持一致，519 条视频任务未变。两库备份经 SHA 和 SQLite 完整性验证。

只读现场 dry-run 发现 9.2 已把 agent 身份迁移为 `agents.entries` 的键；旧 convergence 与应用同步只读 `agents.list`。共享配置合同现同时读取两种布局，拒绝混合、畸形与重复身份，写回保留原布局及未修改字段。最终 d96cad2 制品已重建并通过 keyed agent 读取与同步验证；数据库迁移实现未变，复用上述迁移证据。

## 执行顺序

1. 完成 canonical Git 提交/推送及 Quality Gate，交付同一来源的 clean 控制仓库和完整应用制品。历史 canonical 目录保持原 HEAD 与文件身份。
2. 读取安装 manifest、三套 plist 的当前摘要，先 dry-run execve adapter；复用已验证的 9.2 SDK 合同。历史升级前工具基线保持原样，先记录与现有 9.2 工具面的差异，再通过官方只读采集命令为已运行的 9.2 建立单独基线，验证本次 fresh convergence 不改变配置与当前能力。计划引用唯一历史 session 的摘要，实际 session key 只在受控进程内解析。新基线只能证明当前恢复前后的一致性，不能反向证明升级前后的能力语义完全相同。
3. 在当前用户确认具体生产数据动作后，以四项旧摘要 CAS 应用 execve adapter，保留安装器事务备份；现场验证安装、来源与三套 plist。通过官方收敛命令生成当前运行证明，若发现超出已分析范围的配置差异则保持暂停。
4. 从私有计划启动 Git 绑定 successor runner。再次检查旧 pending/resume、保护进程、两库、空队列、端口、兼容性与 readiness，随后消费新的一次性 successor 能力。历史 f78 resume 只做 alreadyConsumed 回验，不重新消费；不导入 n8n 工作流。
5. 精确映射 blue/router 到新应用，受管启动 blue，在首次数据库使用时执行迁移 051–059；创建 baseline 前保持全局 intake 暂停。完成页面、路由、版本、数据库与 readiness 验证后，由官方流程解除原 guard、完成 pending。
6. deploy 释放共享锁后，runner 使用 paused revision 恢复 intake；前后核对同一 release/generation，记录不可变 resumed 证明并发布最终 recovered result。复核 3017/3317、三套 Gateway、n8n、数据库身份与任务计数，视频 lane 保持 disabled/unloaded。
7. 使用绑定独立 QA 来源的 9.2 对话/压缩验收包：会话经官方 session-store-runtime 读取；隔离压缩的历史只用官方 chat.send/chat.inject 构造，不直接改 SQLite/JSONL。对话验收创建一个预先证明不存在的随机合成 session，五轮完成后按确切 sessionId/updatedAt CAS 调用官方 sessions.delete，关闭 lifecycle hooks，再回读活动会话不存在；如平台保留归档则如实记录。只输出计数、摘要和校验结果，不向用户通道发送消息，不启用剪辑、渲染、导出或视频 lane。

## 生产数据对象和影响

Mission Control 数据库为 `~/.mission-control-openclaw-profiles/mission-control.db`。051–059 新增清理债务、全局准入与审计、调度/派发/子执行租约、父任务 claim、导演证据 outbox 与 checkpoint/projection/review receipt 共 12 张表及索引，并追加 schema_migrations。准入控制先 paused 后按 revision 恢复，正常 scheduler 后续按现有设置写入自身运行状态与同步元数据。当前普通 tasks 表为空，视频队列无活动任务；此次不重试历史失败任务。

n8n 数据库 `~/ai-worker/state/n8n/.n8n/database.sqlite` 保持既有工作流与任务记录，不重复 schema/工作流导入。原一致性备份位于 `~/ai-worker/state/video-autoworker/maint/auto-3db98c3-0ada7686/postinstall-inputs/mission-control.db` 和同目录 `database.sqlite`，摘要绑定在原 rollback-proof.json；执行前再次核对来源与是否出现新增业务数据。

OpenClaw 验收另涉及 qwen-current / second-original 下一个新建的随机合成会话。既有会话不作为写入或清理对象；测试所有权在首次调用前单独落受控记录，失败时也只按该记录清理同一会话。若官方接口报告身份变化、忙碌或清理失败，保留失败证据和该会话的受控定位信息，不扩大删除范围。平台内部可能按自己的策略保留归档，不把活动会话删除表述为从未持久化或物理擦除。

## 失败与回退

successor 能力消费前失败只停止准备，不改变应用映射或数据库。能力在 bootstrap-successor 内于应用映射和首次数据库迁移前消费；消费后即使尚未开始迁移，失败也保留原 pending、guard、收据及数据库，不盲重签或删除，并在同一来源与目标下按官方 successor 幂等续接。未形成可用 baseline 时不存在可声称已验的旧在线应用回滚点：回退目标为当前受保护的停机状态，同时保持 n8n 与三套 Gateway。新槽位由受管 manager 精确停止，安装器失败按其事务备份恢复自身配置。

新增表迁移本身经实证不修改原业务内容，优先保留数据并修复前向恢复。若确需恢复数据库，先停止有关写入者并保护迁移后新增数据，核对原备份及两库一致性后采用已审恢复流程；不得在仍有新任务时直接覆盖备份。不得降级 OpenClaw 9.2、改回不安全 SecretRef、重放 n8n、启用视频 lane 或手工抹掉 pending 来绕过阻断。

## 当前状态

用户已在收到本计划的数据影响、备份和回退说明后明确确认部署，满足 RULE-PROD-DATA-CONFIRM-001 的本次具体确认要求。9 月 8 日新入口已通过原主机密钥校验，执行前现场核查通过。CBC adapter 已安装并验证，官方 fresh convergence apply 成功且配置未变；首次 successor 在权限检查处停止，尚未产生授权或数据库迁移。

控制程序需修复 Node 显式执行的兼容性 CLI 权限合同后，以新的 clean 控制提交交付独立 recovery-20260908 目录，并重绑 adapter 与当前运行证明再继续。旧 CBC 目录与历史 3db 保留。应用 d96 制品不变，独立 QA 固定为 f6ded076dc71bf799ec93016e9bd0f1d9e6a53b7，其完整 Quality Gate 34116762086 已通过。具体执行与本次缺陷见 2026-09-08 运维记录；应用仍未恢复上线。
