## Video Analysis Task Flow Rule

Use one business path for video analysis. The native
`aiworker-video-command` plugin must classify both exact commands and affirmative
natural-language single-video requests in `before_dispatch`, before
`second-original` runs.

- Submit either `分析视频 <绝对路径>` or an affirmative request such as
  `帮我分析一下这个视频 <绝对路径>` only when the current message contains
  exactly one supported absolute local path. Support `.mp4`, `.mov`, `.mkv`,
  `.webm`, and `.m4v`. `只分析这个视频` and `仅分析这个视频` are affirmative
  full-chain requests, not negation.
- In the authorized Telegram private chat, let unrelated messages continue to
  `second-original`. For a video-shaped method, architecture, capability,
  example, conditional, or negative private message, the loaded native hook
  returns the managed short response without starting the model. These private
  messages use zero tools: no `memory_search`, `memory_get`,
  `exec`, generic task, filesystem search, or media command. A quoted or earlier
  execution instruction does not authorize the current message. Only a later explicit
  status request is the video-related exception.
- Briefly reject a clearly affirmative execution request whose path is missing,
  multiple, relative, a URL, malformed, non-canonical, or unsupported. Do not
  guess, search the filesystem, download an attachment, or select another file.
  Also reject a request limited to only picture, audio, subtitles, or another
  partial modality because this entry supports the complete audio-visual chain.
- Reuse OpenClaw's completed Telegram DM allowlist/pairing admission, then require
  the consistent inbound sender to match the plugin's domain-separated SHA-256
  for the unique Telegram command owner. The raw sender ID is not stored in the
  plugin config. Reject an applicable Telegram group request and leave other
  channels outside this plugin's scope. Pairing another user never grants video
  dispatch; multi-user dispatch needs an explicit sender-policy change and review.
- Do not ask Qwen to choose a video tool or construct a command. The plugin must
  derive the stable task/idempotency key and call its shared runner exactly
  once. The runner calls the installed `aiworker-task-flow` client with one
  `--video-file`, identical task/idempotency keys, `--delivery none`, and
  `--wait-seconds 0`, with `--no-trigger-recovery` so a trigger error never
  performs a hidden same-turn status read.
- If the plugin is missing, unloaded, or fails to claim an affirmative
  single-video request, fail closed with `未提交：视频入口当前不可用。` Never
  degrade to a generic prompt, `exec`, direct `submit-task.mjs`, filesystem
  discovery, ffmpeg, Whisper, Qwen, or another workflow.
- Do not narrate before submission. For a new task return only
  `已提交，任务编号：<taskId>。结果请稍后查询。`; for an idempotent duplicate
  return only `任务已存在，任务编号：<taskId>。结果请稍后查询。`. Keep status
  and duplicate values internal. On an invalid input or failure, return one
  short rejection or error without the path, child output, or credentials.
- End the conversation turn after the receipt, rejection, or failure. Do not
  query status, inspect Mission Control or n8n, wait, retry, resubmit, or report
  background progress in the same turn.
- A later explicit user request for progress/result is also handled by the same
  native plugin in `before_dispatch`, before Qwen runs. This route calls the
  read-only status client exactly once and then returns one human short reply;
  it never starts Qwen or lets the model select a tool.
- Resolve the task ID only from a complete task ID in the current message or the
  plugin's trusted, unique most-recent receipt binding for that private
  conversation. Do not scrape conversation prose. If neither source yields one
  unambiguous complete ID, return `请提供完整任务编号。` and stop.
- The status route must not call `memory_search`, `memory_get`, `exec`, process
  supervision, filesystem search, direct Mission Control/SQLite access, n8n
  inspection, polling, retry, resubmission, or a generic task. Query failure
  produces one short status-unavailable reply for the same ID and stops.
- Only a single formal status result of `succeeded` proves completion. Map
  pending, success, failure, and unavailable states to concise human language;
  never narrate lookup steps, expose internal reasoning, or recommend a new
  submission. Use `任务已受理，正在等待处理。`, `任务正在处理中。`,
  `任务已完成。`, `任务处理失败。`, or `暂时无法查询任务状态。`; a safe
  bounded result/reason may follow completion/failure. Do not repeat a long
  task ID in ordinary status replies.

The only formal downstream chain is:

`before_dispatch -> shared runner -> aiworker-task-flow -> Mission Control / SQLite -> n8n -> prepare -> Whisper audio + local Qwen vision -> finalize -> SQLite`

All worker stages use `memoryMode=none`. Video submission uses `delivery=none`,
so n8n never automatically returns the completed analysis to Telegram.
OpenClaw submits, returns the short receipt, and leaves the background task
alone until the user asks later.

When the authorized Telegram private user asks which skill or chain is used,
the loaded hook answers without starting the model or submitting. Its managed
reply is exactly:

`视频会由原生插件一次派发到 AI-worker，后台依次执行 prepare、Whisper 音频、本地 Qwen 画面和 finalize；当前轮不等待，结果按任务编号另查。`

Do not describe the current chain as `VL`, `video-learning-pipeline`,
`DIRECTOR_BRAIN`, director-brain extraction, or direct full-video processing.

For multiple videos, use one durable directory batch with a stable
`--batch-id`; process one video at a time, query later with `--batch-status`, and
resume with `--resume-batch`. Never loop over parallel single-video calls or
pass a batch ID to plain `--status`.
