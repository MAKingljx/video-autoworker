---
name: aiworker-task-flow
description: Use for AI-worker/n8n tasks, native Qwen video scheduling, explicit status lookup, and the durable global video lane.
---

# AI-worker Task Flow

Use this skill to explain the versioned AI-worker task client and the local 0.5
Qwen video-scheduling contract. This is a local candidate, not proof of GitHub
mainline, installation, production deployment, or Telegram acceptance.

## Core boundary

- Video conversation routing belongs to the native `before_dispatch` hook for
  `second-original`; it is not an agent tool and Qwen never constructs a shell
  command or directly submits a task.
- The hook may call the host-provided `api.runtime.llm.complete` exactly once,
  without tools, to return one strictly structured semantic classification.
- The classifier is advisory. The host independently validates an authorized
  Telegram private message and requires the classifier value to be copied
  exactly from the current original message.
- Dispatch accepts exactly one canonical absolute local video file path or one
  canonical absolute local directory path. Status accepts exactly one explicit,
  complete task ID or batch ID. Never infer a recent task from conversation,
  memory, files, SQLite, or process state.
- Single videos and directories both enter one persistent process-wide video lane.
  The lane runs at most one video at a time across all jobs and survives
  chat turns and worker restarts.
- Use `delivery=none`. After enqueueing, return one short handled receipt and end
  the turn: no polling, status read, retry, resubmission, progress narration, or
  completion pushback.
- Every downstream model worker uses `memoryMode=none`. Do not replace the
  managed chain with direct ffmpeg, Whisper, Qwen, an old video-learning flow,
  a generic task, or an ad-hoc shell command.

## Native Qwen classification

For a candidate video message in the authorized Telegram private chat, the
hook calls its internal, no-tool Qwen classifier once. The result must contain
only a recognized action and one string value:

- `dispatch_single`: analyze one video file now;
- `dispatch_directory`: analyze one video directory now;
- `status_task`: read one explicitly supplied complete task ID once;
- `status_batch`: read one explicitly supplied complete batch ID once;
- `respond`: video-related but non-executing, ambiguous, conditional, negative,
  explanatory, or missing required evidence;
- `pass`: genuinely unrelated ordinary chat.

The host does not trust semantic output as authorization. Before any runner
call, it checks the Telegram channel, private-chat shape, `second-original`
session identity, consistent conversation/sender fields, the configured
domain-separated sender hash, and a valid message timestamp. It then extracts
evidence from the current original message and requires an exact single match:

- a supported canonical absolute path for `dispatch_single`;
- one canonical absolute directory path, with directory intent, for
  `dispatch_directory`;
- one complete scheduler task ID and no batch ID for `status_task`;
- one complete scheduler batch ID and no task ID for `status_batch`.

The host never guesses, normalizes, searches for, or substitutes classifier
values. Multiple candidates, relative paths, URLs, unsupported paths, partial
IDs, classifier schema errors, timeout, identity mismatch, validation failure,
or runner failure are caught inside the handler and return a handled fail-closed
short reply. They must not fall through to Qwen, a generic task, `exec`, or a
media command. Only `pass` continues to normal `second-original` conversation.

## Dispatch contract

The shared runner invokes the installed client with parameter arrays. These are
implementation references, not commands for the chat model to construct.

Single video:

```bash
node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs" \
  --video-file "<validated-absolute-video-path>" \
  --task-id <stable-task-id> \
  --idempotency-key <same-stable-task-id> \
  --delivery none \
  --wait-seconds 0 \
  --no-trigger-recovery
```

Directory:

```bash
node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs" \
  --video-dir "<validated-absolute-directory-path>" \
  --batch-id <stable-batch-id> \
  --delivery none
```

Both calls only create or reuse durable queue state and wake the same global
video worker. A fresh enqueue returns `queued`; an idempotent duplicate returns
the existing state. The receipt includes only the stable task or batch ID and a
  brief instruction to query later. End the turn immediately after any receipt or
handled error.

## Persistent global video lane

The client persists both a single video and a directory batch as durable video
job state. A single video is a one-item job; a directory is a deterministic,
non-recursive, sorted job of supported files. The process-wide lane lock is
shared by every job, so concurrent chat messages cannot overlap ffmpeg,
Whisper, Qwen, or media I/O.

The worker drains queued jobs in durable order, submits one item, follows that
same item to a terminal state, and only then starts the next. Stable IDs,
immutable request fingerprints, atomic state updates, source-drift checks,
idempotency, terminal-item skipping, and restart resumption prevent silent
replay or input substitution. A temporary platform outage pauses the job for
later resumption; it does not authorize a new task ID.

The formal downstream chain remains:

`persistent global video lane -> Mission Control / SQLite -> n8n -> prepare -> Whisper audio + local Qwen vision -> finalize -> SQLite`

All worker stages use `memoryMode=none`, and n8n does not automatically return
the completed result to Telegram.

## Explicit later status lookup

Status is a new, explicit user action handled in `before_dispatch`. It is not a
pure-regex conversational shortcut and never uses an implicit recent receipt.
The internal Qwen classifier runs once, and the host requires exactly one
complete ID copied from the current original message.

For an explicit task ID, the runner calls the formal status client once:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --status <complete-task-id>
```

For an explicit batch ID, it calls the durable batch status client once:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --batch-status <complete-batch-id>
```

A batch ID is not a task ID. Status handling performs one read-only call, returns one
bounded human reply, and ends. It does not start an agent tool, query memory,
scrape conversation text, search files, inspect SQLite/n8n directly, poll,
retry, submit, resume, or recommend resubmission. Missing or ambiguous IDs are
handled with a short request to provide the complete task or batch ID.

Only `succeeded` proves a task completed. Batch replies may report the formal
batch state and bounded counts returned by the batch client. Query or result
validation failure returns a handled unavailable reply for the same explicit ID.

## Explanation and unrelated chat

Video explanations, capabilities, examples, negation, conditions, missing
paths, and missing IDs classify as `respond` and receive a handled short reply.
They cause no submission or status read. Truly unrelated chat classifies as
`pass` and only then continues to normal Qwen conversation.

Describe the route as native `before_dispatch` scheduling with an internal
no-tool Qwen semantic classifier and a persistent global video lane. Never call
it a native agent tool, `VL`, `video-learning-pipeline`, `DIRECTOR_BRAIN`, or
direct full-video processing.

## Generic tasks

Generic AI-worker submission remains separate and is never a fallback for a
video-shaped request. Use it only when the current message explicitly authorizes
a non-video task and follow the ordinary stable-ID task contract.
