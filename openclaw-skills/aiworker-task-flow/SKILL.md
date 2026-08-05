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

## Submit

Write the requested task to a UTF-8 temporary file inside the current workspace,
then run:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs \
  --prompt-file <task-file> \
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
  --idempotency-key <stable-key> \
  --delivery none \
  --wait-seconds 600
```

Use `--vision-route <route-id>` only when the chosen route is a registered
OpenAI-compatible route with the `vision` capability. Do not select an OpenClaw
Agent route for the audio or frame worker. Video analysis intentionally rejects
`delivery=reply`; after `--wait-seconds` returns `succeeded`, summarize its
`output` in the current conversation.

## Status

Query a submitted task without reading unrelated task payloads:

```bash
node skills/aiworker-task-flow/scripts/submit-task.mjs --status <task-id>
```
