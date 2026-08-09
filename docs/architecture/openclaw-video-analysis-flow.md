# OpenClaw 视频分析主流程

## 目标与边界

视频分析只有一条正式生产路径：用户从 OpenClaw 发起请求，`aiworker-task-flow` 将任务交给 Mission Control 和 n8n，模型工作节点完成无状态分析，最终结果写回任务数据库并由后续状态查询读取。OpenClaw 负责理解当前消息、提交一次任务和返回异步回执，不在同一轮会话中等待长任务，也不以临时 shell、旧视频学习脚本或直接媒体命令替代正式工作流。

## 核心流程

`User -> OpenClaw -> aiworker-task-flow -> Mission Control / SQLite -> n8n -> prepare -> Whisper audio + local Qwen vision -> finalize -> SQLite -> status query`

各环节职责如下：

1. 用户通过受支持的 OpenClaw 入口发起单视频或批次分析，并在当前消息中明确执行意图。
2. OpenClaw 选择版本化的 `aiworker-task-flow`，只生成一次稳定的任务 ID 与幂等键。
3. 技能通过回环接口向 Mission Control 提交任务。Mission Control 先在 SQLite 中持久化任务身份、状态和路由信息，再触发固定 n8n 工作流。
4. n8n 执行 `prepare`，完成受控收件、输入校验、分段和阶段元数据准备。
5. `audio` 使用 Whisper 处理语音，`vision` 使用本地 Qwen 处理画面。两类模型节点均固定为 `memoryMode=none`，不接收 OpenClaw profile、会话键或长期记忆目录。
6. `finalize` 合并音频、画面和时间线证据，生成结构化结果并更新父任务终态。
7. Mission Control / SQLite 保存运维状态与最终结果。OpenClaw 只在后续显式状态查询中读取同一任务，不重新提交，不把整段工作结果持续堆入原会话。

## 单次提交与异步回执

- 一条执行消息最多触发一次正式提交；任务 ID 与幂等键必须稳定且一致。
- 提交成功后立即返回包含任务身份和排队状态的简短回执，长时处理转入后台。
- 同一轮 OpenClaw 不轮询任务状态，不等待模型完成，也不反复播报阶段进度。
- 用户后续询问进度或结果时，才使用原任务 ID 或批次 ID 查询；查询失败不得自动创建新任务。
- 视频任务的工作节点不承担聊天投递。是否向用户通道回复由 OpenClaw 会话层决定，不能由直连模型或 n8n 节点绕过。

## 禁止的旁路

以下行为不属于正式视频分析链：

- 直接在 OpenClaw 会话中反复运行 ffmpeg、抽帧、场景分析或临时轮询命令；
- 把旧 `video-learning-pipeline`、`DIRECTOR_BRAIN` 等学习流程当作当前生产任务入口；
- 在压缩、超时或状态不明后重新提交同一视频；
- 把模型输出、原始日志、文件路径清单或会话正文写入长期记忆或 Git。

若正式提交不可用，OpenClaw 应返回可核验的失败或暂停状态，保留稳定任务身份，不得静默退化到上述旁路。

## 状态与验收口径

生产验收必须同时证明：Mission Control 中只有一条对应任务记录，n8n 只有一次对应执行，`prepare/audio/vision/finalize` 状态可追踪，模型节点为 `memoryMode=none`，同键复投命中幂等结果，后续状态查询读取原任务且没有再次提交。端口在线或 OpenClaw 能对话只能证明组件可达，不能代替这条完整链路证据。
