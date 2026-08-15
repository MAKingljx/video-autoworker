## Current AI-worker Video Analysis Memory

- The local 0.5 target is a native `before_dispatch` scheduler for
  `second-original`, not an agent tool.
- A candidate message receives exactly once per request a no-tool structured semantic classification
  through the host-provided `api.runtime.llm.complete`. The host, not the model,
  owns authorization, evidence validation, stable IDs, runner calls, and replies.
- Dispatch requires an authorized Telegram private message and exactly one
  canonical absolute video-file or directory path present in the current
  original message. Status requires exactly one explicit complete task ID or
  complete batch ID in the current original message.
- There is no implicit recent-task binding. Conversation history, model memory,
  filesystem state, SQLite/n8n scans, and process state never supply a missing
  task or batch ID.
- Single videos and directory batches share one persistent process-wide serial
  video lane. A single video is a one-item durable job; the lane runs one video at a time
  across all jobs, with stable identity, atomic state, idempotency, source
  drift protection, and restart resumption.
- Dispatch returns one handled short receipt and ends. It never polls, retries,
  resubmits, monitors, or pushes the completed analysis into Telegram.
- Explicit task or batch status makes one read-only formal client call and returns one
  handled bounded reply. It never submits or resumes work.
- Classifier, identity, evidence, validation, and runner failures are caught by
  the handler and fail closed. Only a truly unrelated `pass` message continues
  to normal Qwen conversation.
- The downstream chain remains `Mission Control / SQLite -> n8n -> prepare ->
  Whisper audio + local Qwen vision -> finalize -> SQLite`; all model workers
  use `memoryMode=none`, and video submission uses `delivery=none`.
- Older pure-regex status routing, implicit recent receipts, model-selected
  video tools, `VL`, `video-learning-pipeline`, and `DIRECTOR_BRAIN` are retired
  designs and must not guide this candidate.
- This file records a local target contract only. It is not evidence of GitHub
  mainline, installation, production deployment, or real Telegram acceptance.
