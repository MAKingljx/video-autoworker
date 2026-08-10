## Current AI-worker Video Analysis Memory

- The local candidate has one conversation ingress component: the native
  `aiworker-video-command` `before_dispatch` hook. It classifies both the exact
  `分析视频 <绝对路径>` command and affirmative natural-language single-video
  requests before `second-original` runs.
- A valid execution request reaches one shared runner and one
  `aiworker-task-flow` submission. OpenClaw returns only the short acceptance
  receipt, does not monitor the background task in that turn, and checks status
  only after a later explicit user request.
- A new-task receipt says `已提交，任务编号：<taskId>。结果请稍后查询。`; an
  idempotent duplicate says `任务已存在，任务编号：<taskId>。结果请稍后查询。`.
  Runtime status and duplicate fields remain internal.
- In the authorized Telegram private chat, method, architecture, capability,
  example, conditional, and negative video-shaped messages are answered
  directly by the loaded native hook with a managed short response. They use
  zero tools: neither the model nor any tool starts, and they never submit.
  Clearly affirmative but invalid private-chat inputs receive
  one short rejection
  instead of a guessed path. Only a later explicit status request may call the
  bounded status client.
- The managed explanation reply is
  `视频会由原生插件一次派发到 AI-worker，后台依次执行 prepare、Whisper 音频、本地 Qwen 画面和 finalize；当前轮不等待，结果按任务编号另查。`.
- The native plugin is the only single-video conversation entry. If it is absent
  or unavailable, fail closed; never fall back to a generic task, `exec`, direct
  media commands, or filesystem discovery.
- For `查一下刚才的视频`, use only the full task ID in the current
  conversation's most recent plugin receipt. If it is absent or ambiguous, ask
  for the ID; never call `memory_search`, search memory, scan the database,
  guess, or resubmit.
- OpenClaw performs Telegram DM allowlist/pairing admission before the hook. The
  plugin then validates private-chat and stable session/sender identity and
  compares the sender with the domain-separated SHA-256 configured from the
  unique Telegram command owner. Pairing another user does not grant video
  dispatch; multi-user dispatch requires an explicit sender-policy change.
- The downstream chain is Mission Control / SQLite -> n8n -> prepare -> Whisper
  audio + local Qwen vision -> finalize -> SQLite. Every worker uses
  `memoryMode=none`; video submission uses `delivery=none`, so completed output
  is not automatically returned to Telegram.
- Older `VL`, `video-learning-pipeline`, `DIRECTOR_BRAIN`, director-brain
  extraction, direct full-video processing, and model-selected video-entry
  designs are historical and must not guide this candidate.
- This file records the local target contract, not proof of GitHub mainline or
  production deployment. Promote it only with implementation, tests,
  deployment, and production acceptance evidence.
