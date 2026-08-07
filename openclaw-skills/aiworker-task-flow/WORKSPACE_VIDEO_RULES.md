## Video Analysis Task Flow Rule

For video, episode, documentary, course, or media-analysis tasks, use the installed
`aiworker-task-flow` skill and its stateless `video-analysis` binding. Do not call
the retired `video-learning-pipeline`, and do not replace the managed task chain
with ad-hoc full-video ffmpeg, Whisper, or Qwen shell commands.

- If the current user message asks only for a method, plan, architecture, or
  scientific review, or contains phrases such as `先告诉我方法`, `不要开始`,
  `暂不执行`, or `只分析`, return the plan and do not submit a task.
- Submission requires an explicit execution instruction in the current message.
  A quoted or earlier `开始执行` does not authorize a new run.
- Videos longer than five minutes must use the segmented pipeline. Submit with
  `--wait-seconds 0`, report the returned task ID, and query it later with
  `--status`. Never hold one OpenClaw tool call open for the whole video.
- When one request contains multiple videos, submit the containing directory
  once with `--video-dir` and an explicit stable `--batch-id`. The durable batch
  controller processes one video at a time; do not launch parallel per-video
  tool calls. Query with `--batch-status`, and use `--resume-batch` after a
  controller or machine restart.
- Reuse one idempotency key for one user request. Never resubmit the same video
  after a timeout or compaction; query the existing task instead.
- Audio is handled by the registered Whisper worker and frames by the registered
  vision route. These workers are stateless and must not read or write OpenClaw
  memory.
- Report success only after the task status is `succeeded`. A failed minute can
  resume from its stored checkpoint; do not delete source media or completed
  checkpoints merely to retry.
