## Video Analysis Task Flow Rule

For `second-original`, use the `aiworker_analyze_video` tool whenever a user
asks to learn one video, learn all videos in a directory, or query video-task
progress. The user does not need to provide a slash command. This direct tool
does not impose a plugin-owned sender allowlist.

- Single file: `{"action":"submit_video","videoPath":"<absolute-video-path>"}`.
- Directory: `{"action":"submit_directory","videoDirectory":"<absolute-directory-path>"}`.
- Status: `{"action":"status","query":"<task ID, batch ID, title, season/episode, or keyword>"}`.
- 完整学习结果：`{"action":"result","query":"<task ID, batch ID, title, season/episode, or keyword>"}`；若返回 `nextOffset`，用同一 query 加 `offset` 继续读取直到结束。

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
ambiguous matches only return bounded candidates.

用户说“完整学习结果”“详细报告”或“全文报告”时，必须调用 `result`，不得使用 `exec`、`find`、`grep`、旧 `bot-learning` 路径、任意文件搜索、SQLite 或 n8n 扫描来寻找旧报告。

The plugin-owned legacy sender-hash setting is ignored. The only temporary
unavailability condition is the explicit release-maintenance gate.
Every worker uses `memoryMode=none`, and submission uses `delivery=none`.
