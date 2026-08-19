## Current AI-worker Video Analysis Memory

- `second-original` has the direct `aiworker_analyze_video` task-chain tool.
  It accepts one structured action for video submission, directory intake,
  status lookup, or paged final-report reading; users are not required to use
  slash commands.
- The tool does not impose a plugin-owned sender allowlist. The legacy sender
  hash configuration remains only for compatibility and has no runtime effect.
- single videos and directories share one durable persistent process-wide serial video lane. Stable IDs,
  idempotency, source-drift checks, and restart resumption are managed by the
  task chain, not by the model. It processes one video at a time after a restart.
- Status is a read-only bounded read over controlled task registration records.
  It may use a task ID or batch ID directly, or a title/keyword search, but never scans
  conversation history, media, SQLite, n8n executions, credentials, or process
  state.
- Full learning results use `result`, which reads only final `output.summary`
  and falls back to `combinedText` when needed. Continue with the returned
  offset for later pages. Ambiguous name matches include task/batch identifiers
  and completion/update times, so the agent can select the newest completed
  candidate and continue without asking the user for an ID. Never search old
  `bot-learning` material or invoke `exec`, `find`, or `grep` as a substitute.
- Short requests such as “查 S03E03 分析” are sufficient. The first `result`
  query must be the smallest explicit title or season/episode token copied from
  the current message. Make one call at a time, never add prior-context words
  or parallel synonym queries, and after ambiguity use the newest completed
  candidate's exact task ID instead of searching by name again. Unless report
  正文 or another format is explicitly requested, reply in Chinese with exactly
  three lines: title, status, and one-sentence analysis summary. End after the
  third line; add no heading, bullets, blank lines, explanation, question,
  suggestion, or follow-up offer such as “如需全文”.
- Submission returns one receipt and ends. Do not poll, retry, resubmit, or
  push completion messages. The release gate is maintenance-only.
- The compatible native `before_dispatch` Telegram-private entry and the direct
  tool use the same managed runner. Both fail closed on validation or runner errors;
  the raw scheduler script is not exposed as a model action.
- The downstream chain is `Mission Control / SQLite -> n8n -> prepare ->
  Whisper audio + local Qwen vision -> finalize -> SQLite`; workers use
  `memoryMode=none` and submissions use `delivery=none`.
