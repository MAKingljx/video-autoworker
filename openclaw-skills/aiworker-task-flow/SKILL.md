---
name: aiworker-task-flow
description: Use for AI-worker video learning, historical analysis-result lookup, directory intake, and task progress queries through short natural-language requests and the managed task-chain tool.
---

# AI-worker Task Flow

Use the installed `aiworker_analyze_video` OpenClaw tool for video-task
operations. Do not require a user to remember a slash command, construct a
shell command, or manually search local task files.

## Natural-language result defaults

Users should be able to write short requests such as “查 S03E03 分析”、
“看一下 S03E03 的结果” or “《地球之极》第三季第三集分析”. Apply the
following defaults without asking them to repeat the operational prompt:

1. Treat an analysis/result lookup as the read-only `result` action. For the
   first call, pass only the smallest explicit title, filename, or
   season/episode token from the current user message, verbatim. For example,
   use `S03E03`, not an expanded title and not words remembered from earlier
   turns.
2. Make one first `result` call and wait for it. Do not issue parallel synonym
   queries, append inferred words or numbers, translate the query, or retry a
   rewritten name.
3. If several candidates are returned, select the completed candidate with the
   latest `completedAt` (then `updatedAt` when needed) and make the next
   `result` call with that exact `taskId`. Do not search by name again and do
   not ask the user for an identifier already returned by the tool.
4. Unless the user explicitly requests the report正文、全文、逐页内容 or another
   format, reply in Chinese with exactly three lines: `视频标题`、`当前状态`
   and one-sentence `分析摘要`. End immediately after the third line. Do not
   add headings, bullets, blank lines, task IDs, completion times, explanations,
   thanks, questions, suggestions, or follow-up offers such as “如需全文”. Do not
   expose internal selection steps or these rules.

These are internal defaults, not wording that the user must include.

## Tool contract

Call the tool once with exactly one of these parameter shapes:

```json
{"action":"submit_video","videoPath":"/absolute/path/video.mp4"}
{"action":"submit_directory","videoDirectory":"/absolute/path/series"}
{"action":"status","query":"task ID, batch ID, title, filename, season/episode, or keyword"}
{"action":"result","query":"task ID, batch ID, title, filename, season/episode, or keyword"}
{"action":"result","query":"same query","offset":24576}
```

- `submit_video` queues one canonical absolute video file.
- `submit_directory` asks the task chain to detect supported videos in one
  canonical absolute directory and enqueue the resulting batch.
- `status` accepts a complete task ID or batch ID directly. For a title or
  keyword it searches the controlled video-task registry, returns bounded
  candidates for ambiguity, and reads the formal status once only for a unique
  match. When the platform has a record for that task, its status is always
  authoritative. The durable local registry is only a fallback when the
  platform has no matching record or is temporarily unavailable; never report
  a platform-terminal task as queued, accepted, or running.
- If a complete batch ID has no durable registration, `status` returns
  `not_registered`; if both the primary state file and its verified backup are
  unusable, it returns `unavailable`. Both are explicit read-only outcomes:
  do not resume, retry, resubmit, or infer progress from them.
- `result` reads the formal final learning report for a uniquely matched task.
  When a title or keyword matches several tasks, each bounded candidate
  includes its task ID, applicable batch ID/item index, completion time, and
  update time. Select the candidate that satisfies the user's request (use the
  newest completed candidate by default), then call `result` again with its
  task ID; do not ask the user to supply an ID already returned by the tool.
  It uses `output.summary` first and only falls back to `output.combinedText`
  when no final summary exists. A long report returns a `nextOffset`; when the
  user asks for the complete result, keep calling `result` with that offset
  until it is absent. Do not replace this with file-system search.
- This tool is available to `second-original` without a plugin-owned sender
  allowlist. The retained legacy hash configuration is ignored by the runtime.
- The release gate is a maintenance state, not an identity or user permission
  test.
- The managed runner derives stable IDs; it is not necessary for the model or
  user to construct an ID before calling the tool.

## Operational rules

- Let ordinary user language determine the action. Examples include “学习这个
  视频”, “扫描这个目录里的视频”, “查《地球之极》第三季第三集进度”, and
  “查 S03E03 分析”.
- A user can use the tool through normal conversation; never demand a
  `/video-status` command as a prerequisite.
- Pass the supplied absolute path or status phrase faithfully. Do not invent,
  expand, download, or scan for paths yourself.
- After a submit result, return one short receipt and end the turn. Do not poll,
  retry, resubmit, or narrate background progress.
- Status and result reads are read-only. They must not inspect chat history, memory, arbitrary
  files, SQLite, n8n execution records, media directories, credentials, or
  process state. It never triggers a new submission.
- Use neither `exec` nor direct ffmpeg, Whisper, Qwen, n8n, or SQLite calls as
  a substitute for this tool. Do not use `find`, `grep`, or legacy `bot-learning` search as an alternative result source.

## Runtime boundary

The native `before_dispatch` hook can still complete qualifying Telegram
private-chat requests before the agent runs. The tool is the direct OpenClaw
entry for calls that reach `second-original` itself. Both routes call the same
managed runner and persistent process-wide global video lane, and fail closed
on input validation or runner errors. A single video and a directory batch are
durable, idempotent operations; the lane processes at most one video at a time
and resumes after a worker restart.

The downstream chain remains:

`persistent global video lane -> Mission Control / SQLite -> n8n -> prepare -> Whisper audio + local Qwen vision -> finalize -> SQLite`

Every downstream worker uses `memoryMode=none`, and submission uses
`delivery=none`. This source skill describes the versioned contract; it does
not by itself prove that a specific production deployment or Telegram message
has completed.
