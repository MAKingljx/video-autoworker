---
name: aiworker-task-flow
description: Use for AI-worker video learning, fragment summaries, controlled file export, directory intake, and task progress through the managed task-chain tool.
---

# AI-worker Task Flow

Use the installed `aiworker_analyze_video` OpenClaw tool. 用户不需要记忆 slash
命令。“查 S03E03 分析”“看一下这个文件第 3 段”“把摘要导出 Word”都是正常请求。

## 摘要与文件默认流程

1. 摘要查询默认用 `segments` 获取有界目录：按原始文件名、片段编号、时间码
   组织。首次 query 只复制当前用户消息里最小且明确的原始标题、文件名或
   season/episode（如 `S03E03`）；不追加旧上下文、猜标题、翻译或并行同义查询。
2. 一次调用并等待。多候选沿用原选择规则：先匹配用户指定对象，默认选择
   `completedAt` 最新的已完成记录；必要时比较 `updatedAt`。下一次仅传该
   精确 `taskId`，不再按名字搜索，不问用户要已返回的任务 ID。
3. 目录只用于定位，最多 20 条，默认 10 条；offset 是片段条目偏移。
   用户问具体部分时只用 `segment` 读取对应 `segmentIndex`（从 1 开始）。
   目录预览是局部内容，不能把第一页当作整个视频的整体结论。
4. 默认用中文三行回复：视频标题、当前状态、一句分析摘要；摘要必须说明是
   当前片段/已读范围。用户明确要求片段内容、目录或文件时按其要求回复。
   不添加解释、问句、建议或“如需全文”类后续引导。
5. 用户明确要求文件时直接调用 `export`：Word 用 `docx`，Markdown 用
   `markdown`。程序按顺序组装已存片段，不调用模型重新摘要，不需要逐页
   读取正文。禁止循环读取 100/200 个片段或历史 `result` 页后让模型拼成文件。
6. `export` 只返回已校验路径、文件名、格式、字节数、SHA-256 等元信息，
   不读取导出全文到模型上下文。只有用户明确要求发送文件时，才把工具返回的
   文件交给 OpenClaw 现有附件通道；不新增发送链，不自行伪造路径，生成不等于已发送。
7. 缺少片段摘要、未完成、歧义或失败时忠实转述。不得为了查询触发重学。
   旧数据来源会标明 `legacy_chapter`、`legacy_timeline` 或 `legacy_report`；
   不把旧整篇报告伪称为独立片段。

## Tool contract

```json
{"action":"submit_video","videoPath":"/absolute/path/video.mp4"}
{"action":"submit_directory","videoDirectory":"/absolute/path/series"}
{"action":"status","query":"S03E03"}
{"action":"segments","query":"S03E03","offset":0,"limit":10}
{"action":"segment","query":"exact task ID returned above","segmentIndex":3}
{"action":"export","query":"exact task ID returned above","format":"docx"}
{"action":"export","query":"S03E03","format":"markdown"}
{"action":"result","query":"S03E03","offset":0}
```

- `status` reads controlled registry/status. A formal platform record is
  authoritative; local durable registration is only a missing-record or
  temporary-unavailability fallback. Never describe a terminal task as queued.
- `segments` / `segment` read persisted summaries; they do not submit learning.
  Single summaries are bounded to 12 KiB; truncated output must be acknowledged.
- `export` creates a controlled local artifact; it is not a send operation or
  an arbitrary filesystem read. The managed runner checks fixed export root,
  format, file type, SHA-256 and bytes before returning metadata.
- `result` remains only for explicit historical report正文/全文 requests. It reads
  `output.summary`, falling back to `combinedText`, with byte `offset` paging.
  Do not use it to build a Word/Markdown file or as the default summary query.
- `not_registered` and `unavailable` are read-only outcomes. Do not infer
  progress, recover, retry, or resubmit.
- Single and directory submissions use stable task IDs and one persistent
  process-wide serial video lane. Return one receipt and stop after submission.
- If a duplicate requires confirmation, stop; only the user's next explicit
  confirmation can trigger `confirm_duplicate`. Never confirm automatically.
- Do not invoke `exec`, `find`, `grep`, SQLite, n8n, media tools or old
  `bot-learning` search as a substitute. No chat history, arbitrary files,
  credentials, or process-state search. This tool has no plugin sender allowlist;
  the release gate is maintenance-only.

## Runtime boundary

### Director-brain evidence projection

The versioned integration point from this task chain to the director brain is
strictly one-way and is not a user-facing tool action. After the authoritative
platform result is `succeeded`, trusted orchestration may pass the formal task
result and an already resolved director-brain `workId` through
`lib/director-brain-evidence.mjs` or
`scripts/project-director-evidence.mjs`. The transformer accepts only the
registered project, video-analysis task type, and formal result authority; it
validates material identity, media duration, timeline or chapter ranges,
analysis version, and confidence, then emits deterministic work-scoped
material-evidence items.

The transformer never opens Feishu or changes a task. Its output may only be
handed to the director-brain maintenance `project-evidence` entry, which owns
stable evidence IDs, idempotent creation, verification, and conflict failure.
The projection must never update, retry, cancel, resubmit, or infer the state
of the source task, queue, or n8n execution, and director-brain data must never
flow back into this task state machine.

Normal `status`, `segments`, `segment` and `result` conversations remain read-only.
`export` only writes its controlled artifact; it does not change learning tasks. Do not use `exec`
or call either projection script from a chat response, do not ask the user for
a work ID, and do not treat the presence of these source files as proof that
the remote production completion event is wired. Production orchestration must
resolve and authorize the work binding outside the model before invoking this
entry.

When Feishu explicitly requests the original saved segment summaries (for example,
“直读”“原文”“逐条发送”), the video plugin owns the reply dispatch before the
model runs. It pages until the real `totalSegments` is reached, uses a requested
count only as a send limit, and sends each saved summary as its own message. The
model must not summarize, rewrite, merge, or refill these messages. If one segment
fails, stop at that segment and retry only that segment on the next request.

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
