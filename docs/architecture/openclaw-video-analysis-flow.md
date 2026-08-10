# OpenClaw 视频分析主流程

## 目标与边界

视频分析只有一条正式下游生产路径，但提供两种受控入口。精确单行命令由 Git 管理的 OpenClaw 原生插件在模型运行前通过 `before_dispatch` 接管；普通自然语言由 `second-original` 选择同一插件注册的可选工具 `aiworker_analyze_video`，插件再以可信运行上下文校验当前消息、锁定唯一绝对路径并保证同一轮最多提交一次。两种入口最终都调用已安装的 `aiworker-task-flow` 客户端，把任务交给 Mission Control 和 n8n。模型工作节点完成无状态分析，最终结果写回任务数据库并由后续状态查询读取。OpenClaw 不在同一轮会话中等待长任务，也不以临时 shell、旧视频学习脚本或直接媒体命令替代正式工作流。

## 核心流程

`精确命令 -> before_dispatch` 或 `普通自然语言 -> second-original -> aiworker_analyze_video`，随后统一进入：

`native plugin runner -> installed submit-task -> Mission Control / SQLite -> n8n -> prepare -> Whisper audio + local Qwen vision -> finalize -> SQLite -> status query`

各环节职责如下：

1. 用户在 `qwen-current` 的 `second-original` 会话中，在当前消息明确要求执行，并给出一个生产 Mac 上的绝对视频路径。
2. 若消息精确为 `分析视频 <绝对路径>`，`before_dispatch` 在模型前校验私聊和命令语法，直接调用插件 runner；若消息是 `帮我分析一下这个视频 <绝对路径>` 等普通肯定表达，则模型只能选择可选工具 `aiworker_analyze_video`。
3. 自然语言分支的 `before_prompt_build` 先做三态判断；无路径、多路径、否定、条件、方法或示例请求都不准入。`before_tool_call` 再核对可信 `runId`、`sessionKey`、agent、工具调用 ID 和路径，阻止 `memory_search`、`exec` 及任何其他工具，并从可信上下文派生隐藏的稳定任务 ID。模型不能填写任务 ID，也不能直接调用提交脚本。
4. 两种分支共用 runner。runner 以参数数组调用已安装的 `submit-task`，固定传入 `--video-file`、相同任务/幂等 ID、`delivery=none` 和 `wait-seconds=0`；同一自然语言 run 只共享一次提交 Promise。
5. `submit-task` 通过回环接口向 Mission Control 提交任务。Mission Control 先在 SQLite 中持久化任务身份、状态和路由信息，再触发固定 n8n 工作流。
6. n8n 执行 `prepare`，完成受控收件、输入校验、分段和阶段元数据准备。
7. `audio` 使用 Whisper 处理语音，`vision` 使用本地 Qwen 处理画面。两类模型节点均固定为 `memoryMode=none`，不接收 OpenClaw profile、会话键或长期记忆目录。
8. `finalize` 合并音频、画面和时间线证据，生成结构化结果并更新父任务终态。Mission Control / SQLite 保存结果；OpenClaw 只在后续显式状态查询中读取同一任务，不重新提交。

## 模型前入口与后备层

- `before_dispatch` 只在 `qwen-current` 的 Telegram 私聊上识别精确单行入口；群聊或缺少明确私聊分类的命令会短路拒绝。
- 自然语言分支不是通用 prompt fallback。插件工具必须同时满足：只安装在 `qwen-current`、factory 只允许 `second-original` 的 Telegram 私聊或受控单次 CLI 验收执行、manifest 将工具声明为 optional，并把该 agent 设为 `profile=full` 后用限制性 `tools.allow` 锁定为升级前真实有效工具集合加 `aiworker_analyze_video`。不得设置同层 `alsoAllow`，也不得放行插件组或全局工具组。`tools.effective` 的只读投影不携带 owner 位，因此 owner 未知时工具可以被列出但执行必定拒绝；生产 owner 授权由唯一真实自然语言验收继续证明。
- 模型只负责在已准入的自然语言消息中选择专用工具；解析、可信身份、唯一提交、参数固定和幂等由插件运行时负责。skill、workspace 规则和 MEMORY 只指导模型，不构成执行安全边界。
- 插件是 OpenClaw 原生加载对象，必须由上游插件 allowlist 明确允许；未进入 allowlist 时不得假定插件已经生效。
- 实际 `2026.7.1-2` dispatch 代码确认：普通消息会全局调用 `before_dispatch`，不要求额外 binding；hook 返回 `handled` 后，OpenClaw 直接执行 `sendFinalPayload`，不再进入模型生成。
- `aiworker-task-flow` skill 和 exact-command parser 继续保留，分别作为模型可见说明层和显式 CLI / 运维入口；普通自然语言不得原样落入 generic prompt binding，也不得由模型直接拼接 shell 调用。
- 插件只负责解析、单次提交和短回执，不直接处理媒体，不读取模型结果，也不改变 n8n 工作节点的 `memoryMode=none` 边界。

## 说明型问答边界

用户询问“使用什么技能”“链路怎么走”或明确要求只说明、不执行时，`second-original` 不调用工具、不查询历史记忆，也不提交任务；它直接依据当前 workspace 规则说明正式链路。当前固定口径为：精确命令由插件直接接管，普通肯定表达由千问选择 `aiworker_analyze_video`，两者都通过 `aiworker-task-flow` 将任务交给 Video AutoWorker / Mission Control 和 n8n，随后执行 `prepare -> Whisper audio + local Qwen vision -> finalize`。全部模型工作节点使用 `memoryMode=none`，视频提交使用 `delivery=none`；入口只返回受理信息，完成结果由后续状态查询读取，不由 n8n 自动回投 Telegram。

旧 `VL`、导演脑、`video-learning-pipeline` 或直接全视频处理属于历史学习流程，不得用于描述当前生产视频分析链。说明型问答的业务任务数、n8n execution、媒体 inbox 和工作目录必须保持零增量。

## 单次提交与异步回执

- 一条执行消息最多触发一次正式提交；消息键、任务 ID 与幂等键必须稳定且一致。自然语言分支的任务身份只能由插件从可信 Telegram 入站内容、会话身份和时间派生，再绑定到 host runContext；不能由模型生成。host 状态缺失、清除、未绑定或发生偏差时必须拒绝执行。
- 提交成功后立即返回包含任务身份和排队状态的简短回执，长时处理转入后台。
- 同一轮 OpenClaw 不轮询任务状态，不等待模型完成，也不反复播报阶段进度。
- 用户后续询问进度或结果时，才使用原任务 ID 或批次 ID 查询；查询失败不得自动创建新任务。
- 视频任务的工作节点不承担聊天投递。是否向用户通道回复由 OpenClaw 会话层决定，不能由直连模型或 n8n 节点绕过。

## 禁止的旁路

以下行为不属于正式视频分析链：

- 直接在 OpenClaw 会话中反复运行 ffmpeg、抽帧、场景分析或临时轮询命令；
- 把旧 `video-learning-pipeline`、`DIRECTOR_BRAIN` 等学习流程当作当前生产任务入口；
- 让模型自行处理精确 Telegram 单行命令，或让普通自然语言绕过专用工具进入 generic task；
- 在压缩、超时或状态不明后重新提交同一视频；
- 把模型输出、原始日志、文件路径清单或会话正文写入长期记忆或 Git。

若正式提交不可用，OpenClaw 应返回可核验的失败或暂停状态，保留稳定任务身份，不得静默退化到上述旁路。

## 状态与验收口径

生产验收必须分别覆盖两个入口，同时证明它们汇入同一条下游链。精确入口需验证真实或明确标注 synthetic 的 `before_dispatch`；自然语言入口需由 `second-original` 在唯一新 run 中只调用一次 `aiworker_analyze_video`，零 `memory_search`、零 `exec`、零 generic workflow。Mission Control 中只能新增一条对应父任务和四个确定性阶段子任务，n8n 只能新增一次 video-analysis execution，`prepare/audio/vision/finalize` 全部可追踪且 `memoryMode=none`。后续状态查询读取原任务且不得再次提交。端口在线、工具出现在列表或 OpenClaw 能对话都不能代替完整链路证据。
