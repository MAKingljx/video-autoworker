## Video Analysis Task Flow Rule

For video, episode, documentary, course, or media-analysis tasks, use the installed
`aiworker-task-flow` skill and its stateless `video-analysis` binding. Do not call
the retired `video-learning-pipeline`, and do not replace the managed task chain
with ad-hoc full-video ffmpeg, Whisper, or Qwen shell commands.

- If the current user message asks only for a method, plan, architecture, or
  scientific review, or contains phrases such as `先告诉我方法`, `不要开始`,
  `暂不执行`, or `只分析`, return the plan and do not submit a task.
- Submission requires an explicit execution instruction in the current message.
  A quoted or earlier `开始执行` does not authorize a new run.
- If the user asks which skill or chain handles `分析视频`, how this entry works,
  or otherwise asks only for an explanation, answer from this rule without any
  tool call, including `memory_search`, and do not submit a task. The current
  contract overrides historical video-learning notes: the native video-command
  plugin claims the exact private-message command before the chat model, calls
  the installed `aiworker-task-flow` client, while other affirmative single-video
  wording lets `second-original` choose the guarded `aiworker_analyze_video`
  tool. Both entries submit Video AutoWorker/n8n, which executes
  `prepare -> Whisper audio + local Qwen vision -> finalize`. All stages use
  `memoryMode=none`; video submission uses `delivery=none`, so only the immediate
  acceptance receipt is returned and completed output is fetched later by task
  status. n8n does not automatically return the completed result to Telegram.
  Never describe this current chain as `VL`, `video-learning-pipeline`,
  `DIRECTOR_BRAIN`, director-brain extraction, or full-video direct processing.
  When the user limits the answer to 120 Chinese characters, reply with exactly:
  `精确命令由插件接管；普通说法由千问调用 aiworker_analyze_video，再交给 n8n：prepare→Whisper＋本地 Qwen→finalize。memoryMode=none、delivery=none，结果另查。`
- The canonical single-video execution command is exactly one line:
  `分析视频 <绝对路径>`. It authorizes one and only one n8n submission for that
  video; the user does not need to name the skill, models, workflow,
  segmentation, `memoryMode`, delivery, or wait settings. A negative phrase in
  the same message still takes priority and prevents submission.
- As a script-layer fallback, `submit-task.mjs` recognizes that exact command
  from `--prompt` or `--prompt-file` before binding selection; non-matches remain
  generic tasks.
- Do not narrate before submitting. Phrases such as `马上开始`, `我先找`,
  `让我检查`, or any paraphrased preflight update are forbidden. The first
  action must be the single managed `submit-task.mjs` invocation.
- Invoke the production-verified entry directly as
  `node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs"`;
  do not use `ls` or `find` to locate the script.
- Preserve one optionally quoted path as a single argument, including Chinese,
  spaces, and parentheses. Do not expand shell variables, globs, substitutions,
  or additional commands. Directories and multi-video requests must use the
  existing durable batch flow, never a loop of parallel single-video calls.
- Never inspect or process this one-line request with direct `ffmpeg`, Whisper,
  Qwen, VL, the retired `video-learning-pipeline`, or an ad-hoc shell command.
  Do not run `ls`, `find`, `stat`, a media probe, or any alternate submission
  path before the managed script; it owns validation, controlled ingestion, and
  the only n8n submission.
- For the one-line command, generate one stable request key internally, use it
  for both task identity fields, and submit with `delivery=none` and
  `wait-seconds=0`; the registered video binding keeps `memoryMode=none`.
- After the single invocation returns, do not poll status, inspect n8n, wait,
  retry, resubmit, or run another tool in the same turn. On success, return one
  short acknowledgement containing only `taskId`, `status`, and `duplicate`.
  On failure, return one short error and do not investigate or retry in that
  turn. Query status only in a later turn after a new explicit status or
  monitoring request; only a returned status of `succeeded` proves completion.
- Videos longer than five minutes must use the segmented pipeline. Submit with
  `--wait-seconds 0`, report the returned task ID, and query it later with
  `--status`. Never hold one OpenClaw tool call open for the whole video.
- When one request contains multiple videos, submit the containing directory
  once with `--video-dir` and an explicit stable `--batch-id`. The durable batch
  controller processes one video at a time; do not launch parallel per-video
  tool calls. Query with `--batch-status`, and use `--resume-batch` after a
  controller or machine restart. Never pass a batch ID to plain `--status`;
  that option is only for an individual task ID returned by the batch summary.
- Reuse one idempotency key for one user request. Never resubmit the same video
  after a timeout or compaction; query the existing task instead.
- When another affirmative natural-language request reaches the model, such as
  `帮我分析一下这个视频 <绝对路径>`, treat it as execution authorization only if
  the current message explicitly asks to analyze one video now and contains
  exactly one absolute path ending in `.mp4`, `.mov`, `.mkv`, `.webm`, or
  `.m4v`. The exact command remains plugin-first; this rule is the model-routed
  fallback for non-exact wording.
- For that natural-language case, do not call `memory_search`, do not inspect
  old video-learning memory, and do not use the generic prompt task path. The
  first and only tool call must be `aiworker_analyze_video` with only the
  current message's absolute path in `videoPath`. Never call `exec` or
  `submit-task.mjs` directly for this branch. The native plugin validates the
  trusted inbound and run context, pins the path, derives the hidden stable
  identity, and invokes
  the installed client once with `delivery=none` and `wait-seconds=0`. Then
  return only the same short receipt and stop the turn.
- The natural-language tool is active only when the native plugin is loaded and
  the qwen-current configuration gives `second-original` a `full` profile plus
  a restrictive `tools.allow` equal to the prior live effective baseline plus
  exactly `aiworker_analyze_video`. Dormant configured entries must not become
  newly effective. `tools.alsoAllow` remains unset, and the
  live Telegram session effective set must equal its baseline plus only this
  tool. Memory and this rule guide model choice but are not the execution
  safety boundary.
- Fail closed when the message is a question or method request, contains a
  negative phrase, has no absolute server path, refers only to an un-ingested
  Telegram attachment, contains multiple paths, uses a relative path or URL,
  or has an unsupported extension. Ask briefly for one production Mac absolute
  path; never guess, search the filesystem, download an attachment, or submit a
  generic task.
- Audio is handled by the registered Whisper worker and frames by the registered
  vision route. These workers are stateless and must not read or write OpenClaw
  memory.
- Report success only after the task status is `succeeded`. A failed minute can
  resume from its stored checkpoint; do not delete source media or completed
  checkpoints merely to retry.
