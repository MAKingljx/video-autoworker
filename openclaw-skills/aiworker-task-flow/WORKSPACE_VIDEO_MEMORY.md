## Current AI-worker Video Analysis Memory

- The canonical video-analysis design has two controlled entries. The exact
  Telegram private-message command `分析视频 <绝对路径>` is claimed by the native
  plugin before the model. Other affirmative natural-language wording may be
  handled by `second-original` only when the current message explicitly asks to
  analyze one video now and contains exactly one absolute supported video path.
- For the model-routed natural-language entry, the first and only tool call is
  `aiworker_analyze_video` with only `videoPath`. The native plugin validates the
  trusted inbound and run context, derives identical hidden task/idempotency
  keys, and invokes the
  installed `aiworker-task-flow` client once with `delivery=none` and
  `wait-seconds=0`. Never use `memory_search`, `exec`, a generic prompt task,
  filesystem discovery, direct ffmpeg/Whisper/Qwen, same-turn status polling,
  retry, or resubmission.
- This memory describes the current canonical route; it is not an authorization
  or safety boundary. The natural-language entry is operational only after the
  plugin is loaded and qwen-current explicitly grants only
  `aiworker_analyze_video` through `second-original.tools.alsoAllow`.
- Method/questions, negative wording, missing or multiple paths, relative paths,
  URLs, unsupported extensions, and Telegram attachments without a managed
  server path do not authorize execution. Ask briefly for one production Mac
  absolute path instead of guessing.
- The formal downstream chain is Video AutoWorker / Mission Control -> n8n ->
  prepare -> Whisper audio + local Qwen vision -> finalize. All workers use
  `memoryMode=none`; `delivery=none` returns only the immediate acceptance
  receipt and never auto-returns completed output to Telegram. Results are read
  later by task status.
- Any older `VL`, `video-learning-pipeline`, `DIRECTOR_BRAIN`, director-brain
  extraction, 1-fps direct processing, or automatic Telegram return note is
  historical and must not guide the current `分析视频` execution path.
