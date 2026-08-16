## Current AI-worker Video Analysis Memory

- `second-original` has the direct `aiworker_analyze_video` task-chain tool.
  It accepts one structured action for video submission, directory intake, or
  status lookup; users are not required to use slash commands.
- The tool does not impose a plugin-owned sender allowlist. The legacy sender
  hash configuration remains only for compatibility and has no runtime effect.
- single videos and directories share one durable persistent process-wide serial video lane. Stable IDs,
  idempotency, source-drift checks, and restart resumption are managed by the
  task chain, not by the model. It processes one video at a time after a restart.
- Status is a read-only bounded read over controlled task registration records.
  It may use a task ID or batch ID directly, or a title/keyword search, but never scans
  conversation history, media, SQLite, n8n executions, credentials, or process
  state.
- Submission returns one receipt and ends. Do not poll, retry, resubmit, or
  push completion messages. The release gate is maintenance-only.
- The compatible native `before_dispatch` Telegram-private entry and the direct
  tool use the same managed runner. Both fail closed on validation or runner errors;
  the raw scheduler script is not exposed as a model action.
- The downstream chain is `Mission Control / SQLite -> n8n -> prepare ->
  Whisper audio + local Qwen vision -> finalize -> SQLite`; workers use
  `memoryMode=none` and submissions use `delivery=none`.
