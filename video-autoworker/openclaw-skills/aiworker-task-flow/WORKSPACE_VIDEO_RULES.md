## Video Analysis Task Flow Rule

`second-original` 使用 `aiworker_analyze_video`。用户无需 slash 命令。
“查 S03E03 分析”默认 `segments`，首次只传当前消息中最小且明确的原始标题、
文件名或季集号。不得追加旧上下文、改写名称、并行同义查询或用变体重试。
多候选先满足用户指定对象，默认选 `completedAt` 最新的已完成记录，必要时
比较 `updatedAt`；下一次仅传精确 `taskId`，不问用户要已经返回的任务 ID。

- `segments`：按原始文件名/片段编号/时间码读取目录；`offset` 是片段偏移，
  `limit` 默认 10，范围 1..20。目录预览不等于全视频总结。
- `segment`：用 `segmentIndex`（从 1 开始）只读所需单段，单次最多 12 KiB。
  只有已读片段可以作为回答依据；截断、缺失或旧章摘要必须说明。
- `export`：仅用户明确要求文件时调用，`format` 为 `docx` 或 `markdown`。
  程序按序组装已保存摘要；只返回已校验固定根下的文件元信息。
  禁止循环读取 100/200 个片段、禁止拼接 `result` 全文再让模型重写文件。
  不把导出全文送入模型上下文。用户明确要求发送时使用 OpenClaw 现有附件
  通道；不能伪造路径、另建发送链或把“已生成”说成“已发送”。
- `result`：仅兼容用户明确要历史报告正文/全文，字节 `offset` 分页；
  不作为默认摘要查询或导出办法。没有片段摘要时不重跑任务。

默认中文三行：视频标题、当前状态、一句分析摘要（限定已读范围）。用户明确
要目录、片段正文或文件时遵循其格式。第三行后不加解释、问句、建议或“如需全文”。
提交/目录入队后只回一次收据，不轮询、不重试、不重复提交。重复确认必须来自
用户后续新消息，不能由模型自行确认。统一持久化串行 lane 和稳定 ID 由系统管理。

`status`、`segments`、`segment`、`result` 只读受控登记和正式结果；`export`
仅写受控文件，不改变学习状态。正式平台状态优先于本地登记；只有缺记录或
暂时不可用才回退。`not_registered` / `unavailable` 不触发恢复或推测进度。
禁止 `exec`、`find`、`grep`、旧 `bot-learning`、任意文件、聊天历史、SQLite、
n8n执行、媒体目录、凭据或进程状态搜索。入口无插件 sender allowlist，
release gate 只表示维护。worker `memoryMode=none`，提交 `delivery=none`。
原生 before_dispatch 与工具共用受控 runner；文件/指定片段交给结构化工具。
