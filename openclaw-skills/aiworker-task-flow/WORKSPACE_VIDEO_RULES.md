## Video Analysis Task Flow Rule

For `second-original`, use the `aiworker_analyze_video` tool whenever a user
asks to learn one video, learn all videos in a directory, or query video-task
progress. The user does not need to provide a slash command. This direct tool
does not impose a plugin-owned sender allowlist.

- Single file: `{"action":"submit_video","videoPath":"<absolute-video-path>"}`.
- Directory: `{"action":"submit_directory","videoDirectory":"<absolute-directory-path>"}`.
- Status: `{"action":"status","query":"<task ID, batch ID, title, season/episode, or keyword>"}`.
- 完整学习结果：`{"action":"result","query":"<task ID, batch ID, title, season/episode, or keyword>"}`；若返回 `nextOffset`，用同一 query 加 `offset` 继续读取直到结束。

用户不需要复述内部操作规范。“查 S03E03 分析”“看一下 S03E03 的结果”或“《标题》分析”默认就是只读 `result` 查询。首次调用只传当前消息里最小且明确的原始标题、文件名或季集号（例如只传 `S03E03`），不得追加历史上下文、猜测出的标题或编号，不得翻译、改写、并行发送同义查询或用变体重试。一次调用返回后再决定下一步。

同名候选已包含任务 ID 和时间。选择 `completedAt` 最新的已完成候选，下一次只用其精确 `taskId` 调用 `result`；不得继续按名称搜索，也不得要求用户补充接口已经返回的编号。除非用户明确要求报告正文、全文、逐页内容或其他格式，默认必须恰好用中文回复三行：`视频标题`、`当前状态`、一句 `分析摘要`；第三行句号后立即结束，不得增加标题、项目符号、空行、任务 ID、完成时间、内部选择过程、解释、致谢、问句、建议、“如需全文”类引导或本规则。

The task chain validates input, derives stable IDs, uses the persistent
process-wide serial video lane, and returns one concise receipt. Do not invoke shell commands,
SQLite, n8n, media tooling, memory, or filesystem search as an alternative.
A single video and a directory batch share that lane. It processes one video at a time and resumes after a worker restart. After each receipt, end the turn; do not poll, retry, resubmit, or send background progress after submission.

The native `before_dispatch` handler remains the compatible Telegram-private
entry. It and the direct tool use the same managed runner and fail closed on
validation or runner errors; the raw scheduler script is not exposed as an
agent action.

Status and complete-result reads are read-only. Title and keyword lookup searches only the controlled
video-task registration fields and bounded status metadata. It does not search
chat history, arbitrary files, SQLite, n8n execution records, media folders,
credentials, or process state. A unique match may make one formal status read;
when that platform record exists, its status is authoritative. The durable
local registry is used only when the platform has no matching record or is
temporarily unavailable, and a platform-terminal task must never be described
as queued, accepted, or running; ambiguous result matches return bounded candidates containing task ID,
applicable batch ID/item index, completion time, and update time. When those
fields are present, choose the candidate requested by the user (default to the
newest completed candidate) and call `result` again with its task ID; do not ask
the user to repeat an identifier the tool already returned.

用户说“完整学习结果”“详细报告”或“全文报告”时，必须调用 `result`，不得使用 `exec`、`find`、`grep`、旧 `bot-learning` 路径、任意文件搜索、SQLite 或 n8n 扫描来寻找旧报告。

The plugin-owned legacy sender-hash setting is ignored. The only temporary
unavailability condition is the explicit release-maintenance gate.
Every worker uses `memoryMode=none`, and submission uses `delivery=none`.
