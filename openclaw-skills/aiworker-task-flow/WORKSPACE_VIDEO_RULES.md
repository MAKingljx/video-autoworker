## Video Analysis Task Flow Rule

The local 0.5 candidate uses one native `before_dispatch` handler for
`second-original` video scheduling. It is not an agent tool.

- For a candidate message, call the host-provided `api.runtime.llm.complete`
  exactly once with no tools and accept only the strict structured actions
  `dispatch_single`, `dispatch_directory`, `status_task`, `status_batch`,
  `respond`, or `pass`.
- Treat classification as semantic advice, never authorization. The host must
  independently validate the authorized Telegram private chat, consistent
  `second-original` session/conversation/sender identity, configured sender
  hash, and valid message timestamp.
- Before dispatch, require exactly one canonical absolute video-file path or
  exactly one canonical absolute directory path copied byte-for-byte from the
  current original message. Do not guess, normalize, search, download, expand,
  or reuse a quoted or earlier path.
- Before status, require exactly one explicit complete task ID or complete batch ID from
  the current original message. Never infer a recent task or batch from a
  receipt, conversation history, model memory, files, SQLite, n8n, or processes.
- Send both single videos and directories to the same persistent process-wide
  video lane. A single video is a one-item durable job. Across every job, run at
  most one video at a time and resume durable state without replaying terminal
  items after a worker restart.
- The shared runner calls the installed client exactly once with parameter
  arrays. Single video uses one `--video-file`, identical task/idempotency IDs,
  `--delivery none`, `--wait-seconds 0`, and `--no-trigger-recovery`;
  directories use `--video-dir`, a stable `--batch-id`, and `--delivery none`.
- After enqueueing, return one handled short receipt with the stable task or
  batch ID and end the turn. Do not read status, inspect Mission Control/n8n,
  wait, poll, retry, resubmit, narrate progress, or push completed output back.
- An explicit task or batch status request calls the corresponding formal
  read-only client exactly once, returns one bounded handled reply, and ends.
  Status never submits or resumes work.
- Catch classifier schema/timeout errors, identity or evidence mismatches,
  invalid input, and runner errors inside the handler. Return a handled
  fail-closed short reply; never fall through to normal Qwen, generic tasks,
  `exec`, file search, or direct media processing.
- `respond` is handled with no side effect. Only genuinely unrelated `pass`
  messages continue to normal `second-original` conversation.

The only formal downstream chain is:

`before_dispatch -> internal no-tool Qwen classification -> host validation -> persistent global video lane -> Mission Control / SQLite -> n8n -> prepare -> Whisper audio + local Qwen vision -> finalize -> SQLite`

Every worker uses `memoryMode=none`, and video submission uses `delivery=none`.
Do not describe this as a native agent tool, `VL`, `video-learning-pipeline`,
`DIRECTOR_BRAIN`, or direct full-video processing.

This rule describes a local candidate. It does not claim installation, GitHub
publication, production deployment, or Telegram acceptance.
