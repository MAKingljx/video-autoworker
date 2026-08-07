---
name: aiworker-task-flow
description: Submit a durable background task through the local Video AutoWorker and n8n pipeline, choose registered local or cloud model routes per node, and optionally return the final result to the current OpenClaw conversation.
---

# AI-worker Task Flow

Use this skill when a user asks to hand a task to the AI-worker workflow,
background queue, n8n task chain, or routed local/cloud model pipeline.

## Boundary

- Submit only to the loopback Video AutoWorker endpoint at `127.0.0.1:3017`.
- Do not put passwords, API keys, tokens, private keys, cookies, or credentials in
  the task input.
- Use one stable idempotency key for one user request. Reusing it returns the
  existing task and must not create a duplicate side effect.
- Pass the same stable identifier to both `--task-id` and `--idempotency-key`;
  do not let the submission script generate a random task ID for a durable run.
- Use `delivery=none` for dry runs or when the user did not ask for a channel
  reply. Use `delivery=reply` only when the current session key is known, or when
  both the current channel and target are known.
- The n8n workflow may bind different registered routes to `planner`,
  `executor`, and `reviewer`; do not assume every node uses the same model.
- Use `--planner-route`, `--executor-route`, or `--reviewer-route` only for a
  user-requested per-task override. The route IDs must already exist in the
  platform registry and never contain credentials.
- The workflow returns a task ID immediately. Do not claim the model task has
  finished until its run status is `succeeded`.
- For video analysis, OpenClaw only submits and reads the finished task. Audio
  and frame workers use stateless local executors and never receive an OpenClaw
  session key or memory directory.
- A request for only a method, plan, architecture, or review is not execution
  authorization. If the current message says `先告诉我方法`, `不要开始`,
  `暂不执行`, or `只分析`, answer without calling this script.
- Execute only after the current user message explicitly authorizes execution.
  Do not treat quoted text or an earlier `开始执行` as authorization for a new run.

## Submit

Write the requested task to a UTF-8 temporary file inside the current workspace,
then run:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs \
  --prompt-file <task-file> \
  --task-id <stable-key> \
  --idempotency-key <stable-key> \
  --delivery none
```

Optional per-task model choices can be added without changing the saved n8n
workflow:

```bash
  --planner-route <route-id> \
  --executor-route <route-id> \
  --reviewer-route <route-id>
```

To return the completed result to an existing OpenClaw session:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs \
  --prompt-file <task-file> \
  --task-id <stable-key> \
  --idempotency-key <stable-key> \
  --delivery reply \
  --session-key <current-session-key>
```

If a session key is unavailable, provide both `--channel` and `--target` instead.
Delete the temporary task file after a successful submission. Report the
returned `taskId`, `status`, and whether the request was a duplicate.

## Stateless Video Analysis

When the user asks to analyze one local video, submit it through the dedicated
`video-analysis` binding. The script copies the source into a mode-0700 managed
inbox and sends only a random media key; never put an arbitrary filesystem path
in the task payload.

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs \
  --video-file <local-video> \
  --prompt "分别分析语音和画面，再合并结果" \
  --task-id <stable-key> \
  --idempotency-key <stable-key> \
  --delivery none \
  --wait-seconds 0
```

Use `--vision-route <route-id>` only when the chosen route is a registered
OpenAI-compatible route with the `vision` capability. Do not select an OpenClaw
Agent route for the audio or frame worker. Video analysis intentionally rejects
`delivery=reply`. For videos longer than five minutes, always submit
asynchronously with `--wait-seconds 0`, report the task ID, and use `--status` in
later bounded calls. Never keep one OpenClaw tool call open for the whole video,
and never resubmit after a wait timeout or session compaction. The minute-level
audio, vision, chapter, and final checkpoints resume the same task.

## Multiple Videos

When one user request contains several local videos in the same directory, use
one durable batch instead of launching several `--video-file` commands. The
batch controller runs outside the conversation, submits only one video at a
time, waits for its terminal status, then starts the next video. This protects
the single local Qwen slot and avoids overlapping Whisper/ffmpeg workloads.

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs \
  --video-dir <directory> \
  --batch-id <stable-batch-key> \
  --prompt "分别分析每个视频的语音和画面，不要混合不同视频" \
  --delivery none
```

The directory scan is non-recursive, sorted, and limited to 100 supported video
files. Reuse the same `--batch-id` for the same user request. The command returns
immediately with the batch summary; it must not wait for all videos.

Query the durable batch without reading unrelated task payloads:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --batch-status <stable-batch-key>
```

A batch ID is not a task ID. Always describe batch progress with
`--batch-status <stable-batch-key>`; never tell the user to pass a batch ID to
`--status`. The plain `--status` option is only for one individual task ID
returned inside the batch summary.

If the controller or machine restarts, resume pending work without resubmitting
completed items:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --resume-batch <stable-batch-key>
```

Report the batch ID, counts, current video, and failed item names. Query an
individual returned task ID with `--status` when its full analysis is needed.
Do not paste all video outputs into one OpenClaw context.

## Status

Query a submitted task without reading unrelated task payloads:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --status <task-id>
```
