---
name: aiworker-task-flow
description: Use for AI-worker/n8n tasks, native single-video dispatch, durable video batches, and later task-status queries.
---

# AI-worker Task Flow

Use this skill to explain or operate the versioned AI-worker task client. Keep
single-video conversation handling separate from generic tasks and durable
batches.

## Core boundary

- Submit only to the loopback Video AutoWorker endpoint at `127.0.0.1:3017`.
- Never put credentials in task input, logs, receipts, or memory.
- Reuse one stable task/idempotency key for one user request. A duplicate must
  return the existing task instead of creating another side effect.
- Use `delivery=none` for video analysis. The conversation receives only an
  immediate acceptance receipt; n8n does not return the completed result to the
  chat automatically.
- Treat a task as complete only after a later status query returns `succeeded`.
- Keep every video worker stateless with `memoryMode=none`. Do not pass an
  OpenClaw session key or memory directory to Whisper or local Qwen.
- Never replace the managed chain with direct ffmpeg, Whisper, Qwen, an old
  video-learning flow, a generic task, or an ad-hoc shell command.

## Single-video conversation entry

The native `aiworker-video-command` plugin owns both supported forms before the
chat model runs:

```text
分析视频 /完整路径/video.mp4
帮我分析一下这个视频 /完整路径/video.mp4
```

Keep the exact command path-only. If the user adds interaction preferences such
as `不要等待` or `不要回投`, use the natural-language form; prose appended to
the exact form is invalid and must not be guessed.

For an affirmative request containing exactly one supported absolute local
video path, the plugin's `before_dispatch` hook must:

1. classify the current message;
2. validate the trusted Telegram private-message identity;
3. derive one stable internal task/idempotency key;
4. call the shared runner exactly once; and
5. return one human-readable short receipt and end the turn.

The shared runner calls the installed `aiworker-task-flow` client with the
equivalent fixed contract below. This is an implementation reference, not an
instruction for the chat model to execute:

```bash
node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs" \
  --video-file "<absolute-video-path>" \
  --task-id <stable-request-key> \
  --idempotency-key <stable-request-key> \
  --delivery none \
  --wait-seconds 0 \
  --no-trigger-recovery
```

Do not make Qwen choose a video tool, construct this command, inspect the file,
or select a workflow. The plugin and runner own parsing, identity, ingestion,
idempotency, and submission.

### Classification

- **Submit:** an exact `分析视频 <绝对路径>` command or an affirmative
  natural-language request to analyze one video now, with exactly one absolute
  path ending in `.mp4`, `.mov`, `.mkv`, `.webm`, or `.m4v`. `只分析这个视频`
  and `仅分析这个视频` remain affirmative full-chain requests; `只` or `仅`
  alone is not execution negation.
- **Respond in the hook:** in the authorized Telegram private chat, a method,
  architecture, capability, example, conditional, or negative request. Return
  the managed short response without starting `second-original`, using tools,
  or submitting. Telegram groups and other channels are outside this response
  guarantee and cannot submit video through the plugin.
- **Reject briefly:** a clearly affirmative execution request with a missing,
  relative, URL, malformed, unsupported, non-canonical, or multiple video
  path, or one restricted to only picture, audio, subtitles, or another partial
  modality that the complete audio-visual entry does not support. Do not let
  the model guess or search for a replacement path.
- **Ignore as unrelated:** a message that is not a video-analysis request.

A quoted or earlier execution instruction never authorizes a new run. A current
negative phrase such as `不要开始`, `不要执行`, `不要提交`, `先别执行`,
`暂不执行`, `只给方案`, or `先告诉我方法` prevents submission and receives
the native short response without model execution.

For paths containing spaces, use one matching pair of quotes. Preserve Chinese
characters and parentheses. Do not expand shell variables, globs,
substitutions, URLs, or additional commands.

OpenClaw completes Telegram DM allowlist/pairing admission before this hook. The
plugin also compares the consistent inbound sender against the domain-separated
SHA-256 configured from the unique Telegram command owner; the raw sender ID is
not stored in the plugin config. A newly paired sender therefore receives no
video-dispatch authority. Multi-user dispatch requires an explicit sender-policy
change and a new review; pairing alone is insufficient.

If the native plugin is missing, unloaded, or does not claim an affirmative
single-video request, fail closed. Do not fall back to a generic prompt,
`exec`, `submit-task.mjs`, filesystem discovery, or direct media processing.
Return only:

```text
未提交：视频入口当前不可用。
```

### Conversation response

Do not narrate a preflight such as `马上开始`, `我先找`, or `让我检查`. A valid
request's first observable response is the plugin's final short receipt. For a
new task, return:

```text
已提交，任务编号：<taskId>。结果请稍后查询。
```

When idempotency returns the existing task, return:

```text
任务已存在，任务编号：<taskId>。结果请稍后查询。
```

Keep `status` and `duplicate` in the internal validation/audit result; do not
show those fields to an ordinary user.

An invalid execution input receives one short rejection, for example:

```text
未提交：请提供一个绝对视频路径。
未提交：一次只能分析一个视频。
未提交：只支持本机绝对视频路径。
未提交：视频路径或格式无效。
```

If the one submission call times out, do not query status in the same turn.
Return the stable task number so a later turn can query it, without the video
path, child output, or credentials:

```text
提交状态暂未确认，任务编号：<taskId>。请稍后查询。
```

After any receipt, rejection, or failure, stop the turn. Do not query status,
inspect Mission Control or n8n, wait, retry, resubmit, or send progress updates
in the same turn.

## Explanation-only questions

When the user asks which skill or chain handles video analysis, how it works, or
requests a plan without authorizing execution, the loaded `before_dispatch`
hook returns the managed reply before `second-original` starts. This uses zero
tools: do not call `memory_search`, `memory_get`, `exec`, a generic task,
filesystem search, or any media command. Do not submit a task. A later explicit
status request is the only video-related case that may call the bounded status
client described below.

The concise architecture is:

- the native plugin handles both exact and affirmative natural-language
  single-video messages in `before_dispatch`;
- its shared runner submits once through the installed `aiworker-task-flow`
  client;
- Video AutoWorker persists the task in Mission Control / SQLite and n8n runs
  `prepare -> Whisper audio + local Qwen vision -> finalize`;
- all worker stages use `memoryMode=none`, and video submission uses
  `delivery=none`;
- OpenClaw returns the receipt and leaves the background task alone; it reads
  the result only after a later explicit user request.

The managed explanation reply is exactly:

```text
视频会由原生插件一次派发到 AI-worker，后台依次执行 prepare、Whisper 音频、本地 Qwen 画面和 finalize；当前轮不等待，结果按任务编号另查。
```

Never describe this route as `VL`, `video-learning-pipeline`,
`DIRECTOR_BRAIN`, director-brain extraction, or direct full-video processing.

## Generic task submission

The generic entry is never a fallback for any video request. Use it only for a
non-video AI-worker task that the current message explicitly authorizes.

Write the task to a UTF-8 temporary file inside the current workspace, then run:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs \
  --prompt-file <task-file> \
  --task-id <stable-key> \
  --idempotency-key <stable-key> \
  --delivery none
```

Use `--planner-route`, `--executor-route`, or `--reviewer-route` only for a
user-requested registered route override. Delete the temporary task file after
a successful submission. Report only the returned task ID, status, and
duplicate flag.

## Stateless video worker chain

The managed client copies the source into a mode-0700 inbox and submits a random
media key; it does not place an arbitrary filesystem path in the task payload.
Mission Control / SQLite records the parent task before n8n runs these stages:

1. `prepare`: validate controlled media, segment the video, and create stage
   metadata;
2. `audio`: use the registered Whisper worker;
3. `vision`: use the registered local Qwen vision route;
4. `finalize`: merge audio, visual, and timeline evidence and persist the
   structured result.

Audio and vision may execute according to the workflow's controlled scheduling,
but OpenClaw never supervises them from the conversation. Minute-level
checkpoints resume the same task after a worker interruption; never create a new
task merely because a chat turn timed out or compacted.

## Multiple videos

For several videos in one directory, use one durable batch instead of repeated
single-video conversation requests:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs \
  --video-dir <directory> \
  --batch-id <stable-batch-key> \
  --prompt "分别分析每个视频的语音和画面，不要混合不同视频" \
  --delivery none
```

The non-recursive sorted batch is limited to 100 supported files and processes
one video at a time. Reuse the same batch ID for the same request. Do not launch
parallel per-video calls.

Query or resume that batch only in a later authorized turn:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --batch-status <stable-batch-key>
node skills/aiworker-task-flow/scripts/submit-task.mjs --resume-batch <stable-batch-key>
```

A batch ID is not a task ID. Use `--batch-status` for the batch and plain
`--status` only for an individual task ID returned by the batch summary.

## Later status query

Only after the user sends a new explicit progress or result request, query the
existing task. For wording such as `查一下刚才的视频`, use exactly the full task
ID from the most recent plugin receipt in the current conversation and perform
one status query:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --status <task-id>
```

Never turn a failed status query into a new submission. Report completion only
when this query returns `succeeded`. If the current conversation has no complete
task ID or several receipts make the reference ambiguous, ask the user for the
task ID. Do not call `memory_search`, scan Mission Control/SQLite, guess an ID,
or resubmit.
