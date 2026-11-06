# OpenClaw 可插拔图片能力

图片生成只保留一套 H1 图片应用、任务队列和模型服务。OpenClaw profile 只作为薄入口：验证用户身份、接收图片请求并调用动作明确的图片工具。它们不拥有单独的图片队列、模型进程、视频任务、剪辑权限或系统管理权限。

模型侧不再使用把提交、查询、读取和取消混在一起的旧工具。当前接口按职责拆分：

- `aiworker_submit_creative_image`：明确授权的整图创作，严格要求 `prompt` 与 `images`；
- `aiworker_submit_designed_cover`：已部署设计方案，严格要求 `design` 与 `images`；
- `aiworker_submit_protected_cover`：真实原片保护封面，严格要求一张原图与 `protected` 计划；
- `aiworker_image_task`：仅以已返回的任务编号执行 `status`、`result`、`inspect` 或用户明确要求的 `cancel`；
- `aiworker_image_help`：可被通用工具检索的只读说明，不创建任务。

`qwen-current / second-original` 的已学习视频封面保持一条 direct-only 业务工作流，但模型可见层使用四个严格动作：`aiworker_video_cover_read_directory`、`aiworker_video_cover_get_candidates`、`aiworker_video_cover_submit_protected` 与 `aiworker_video_cover_task`。每个动作的实际字段均为 Schema 必填，避免模型仅发送 `action` 后落入无效提交；它们仍复用同一个后台状态机、会话绑定、图片队列和结果权威。

工作流从应用权威的已学习摘要目录读取可用片段，返回当前会话绑定的 `operationId`；候选帧步骤只接受该编号和目录中真实存在的片段，返回三张原生图片块及短期 `frameRef`；提交步骤同时核验工作流、会话、图片 scope 和帧引用后复用既有原片保护图片队列。候选帧不是学习任务的长期产物，工作流和帧引用均在 60 分钟后过期。原片不可用、学习结果不唯一、片段失败、阶段跳过或跨会话引用都会被拒绝。

图片任务编号不是自由输入参数。应用服务返回经校验的受理收据后，插件会在独立、私有且有界的会话级任务凭证库中写入该编号；`status`、`result`、`inspect` 和 `cancel` 均须先通过这项凭证校验。未知或跨会话的合法格式编号会在插件内被拒绝，不会向图片服务发起读取、取消或其他请求。完成提醒的订阅记录只负责投递，不承担任务授权。

同一 `operationId + frameRef` 另有独立的提交尝试账本。网络或提供方未确认受理时，只能用首次受控计划和相同幂等键恢复确认，模型不能改写布局后再入队；服务明确拒绝且没有任务的标题框过小，最多允许一次受控布局修订。已确认受理的帧只返回原任务状态，绝不创建第二条图片任务。

原片保护文字仍完全由 H1 本地模型生成并由 OCR 精确验收。长中文单行文字发生识别不一致时，系统最多尝试四个确定性本地模型候选：首个沿用任务种子，后续候选使用可审计的派生种子和逐字校对提示；每个候选的实际种子写入素材收据。没有一条通过精确文字校验时任务明确失败，不用系统字体、人工修字或错误文字替代。

旧的 `aiworker_video_cover_workflow`、`aiworker_video_cover_frames` 与 `aiworker_submit_protected_cover_from_frame` 已从 qwen-current 工具面退役；历史记录保留，但新请求不得走旧的分段桥接链。

为保证组件发布失败时能够恢复已验证的旧图片插件，应用暂时保留同名的 loopback-only HTTP 兼容适配器；它没有 OpenClaw 工具注册、不会进入 Tool Search，也不会形成第二条业务状态机。新应用切换、图片插件升级和真实对话验收完成后，适配器将在后续单独版本按保留期退役。

提交未返回任务编号时，调用方必须停止重试并报告安全错误码与下一步；不能把“工具调用完成”误认为图片已受理。

## 能力清单

`ops/openclaw/image-capability-attachments.json` 是唯一的图片入口声明。它固定声明图片插件版本、当前工具集合与退役工具，以及每个 profile 的绑定关系。每一项固定声明：

- `profile`：允许接入的 OpenClaw 配置档；
- `agentId`：唯一允许获得工具的代理；
- `stateRoot` 与 `gatewayPort`：该入口的受控运行身份；
- `mediaRoot`：图片应用可以读取的唯一该入口媒体目录；
- `legacyScope`：仅历史 `image-studio` 使用，确保已受理图片任务仍能被原会话查询。
- `toolIds`：每个 profile 的最小可见工具集合，避免 qwen 专用视频帧能力泄漏到 image-studio。

当前清单保留既有 `image-studio`，并声明首个复用入口 `qwen-current / second-original`。新增入口必须先经用户授权，新增一条完整声明并验证该入口的媒体目录；不能复制插件、工作区或图片服务。

## 安装与恢复

`scripts/install-openclaw-image-capability.mjs` 只接受清单内 profile。它会：

1. 核对 Git 提交、插件版本、profile、代理、配置与受控目录；
2. 先作只读干运行，再备份该 profile 的配置与旧插件树；
3. 使用 OpenClaw 官方插件安装，基于 Gateway 配置修订进行 CAS 更新；
4. 只加入图片插件的当前工具集合并移除已退役工具，重启该 profile；
5. 核对其它有效工具未变化、图片工具已由正确插件提供，并保留两份可恢复备份。

失败时只有在当前配置仍能证明仅发生了本组件变更时才恢复；否则保留 `RECONCILE_REQUIRED` 收据，不覆盖未知配置。

图片服务的 `reference_roots` 由同一清单派生。接入新入口而需要接收用户图片时，应在图片队列为空时定向更新图片服务；不得放开任意本机路径。

## 验收边界

每个新入口至少验证：插件已加载、有效工具中只有当前声明的图片工具、退役工具不可再调用、提交 Schema 不能接受缺少图片或生成要求的请求、无效提交不会进入图片服务、图片任务按该入口独立会话范围受理与回读、完成提醒回到同一会话。长期会话只保留安全的任务编号、状态、错误码与下一步，不保留提示词、路径或图片字节。生成成功、OCR 或保护像素校验不等同于封面最终采用；封面仍按保真和人工视觉审核规范处理。
