# AI-worker Video Command plugin

This directory contains the hook-only `0.4.0` implementation of the native
OpenClaw single-video ingress. The files describe the release contract; runtime
and production acceptance still require their own evidence.

## Business contract

For an authorized Telegram private message, one `before_dispatch` hook owns
both supported conversation forms before the chat model runs:

```text
分析视频 /absolute/path/video.mp4
帮我分析一下这个视频 /absolute/path/video.mp4
```

The exact command is deliberately path-only. Put preferences such as “不要等待”
or “不要回投” in the natural-language form; appending prose to the exact form
is rejected instead of guessed.

An affirmative request with exactly one supported absolute local video path is
validated and sent once through the shared runner. The runner invokes the
installed `aiworker-task-flow` client with identical stable task/idempotency
keys, `delivery=none`, `wait-seconds=0`, and plugin-only
`--no-trigger-recovery`. A trigger error therefore cannot start an internal
status lookup. A timeout or the client's exit-75 acceptance-boundary error
returns the same stable task number with an unconfirmed receipt for a later
explicit query; other execution failures return one short failure. The hook
then ends the turn without retrying or monitoring.

Qwen does not choose a video execution tool, build a shell command, inspect the
media, or monitor the submitted task. While the plugin is loaded, method,
architecture, capability, example, conditional, and negative video messages in
the authorized Telegram private chat are handled by the same `before_dispatch`
hook with one fixed short answer and zero model or tool calls. Unrelated private
chat alone passes to `second-original`. Telegram groups and other channels are
outside this hook-owned conversation guarantee and never gain video execution
through this plugin.
A later explicit status request is the only video-related exception. A clearly
affirmative request with an invalid execution input is handled with one short
rejection.

## Request outcomes

These outcomes apply to the authorized Telegram private-chat scope:

| Input | Outcome |
|---|---|
| Exact command with one valid path | Submit once and return a short receipt |
| Affirmative natural language with one valid path | Submit once and return the same receipt |
| `只分析/仅分析这个视频` with one valid path | Submit once; `只/仅` alone is not execution negation |
| Request limited to only picture, audio, subtitles, or another partial modality | Reject because the current entry supports only the complete audio-visual chain |
| Method, question, negative, conditional, or example | Brief managed answer; zero tools and zero submission |
| Missing, multiple, relative, URL, malformed, or unsupported path | Return one short rejection |
| Unrelated message | Do not claim it |

Supported extensions are `.mp4`, `.mov`, `.mkv`, `.webm`, and `.m4v`.
Paths containing spaces must use one matching pair of quotes. The plugin never
guesses a path, searches the filesystem, downloads an attachment, expands shell
syntax, or processes media itself.

## Module boundaries

- `parse-video-command.js` and `natural-video-request.js` recognize only their
  respective message grammar and intent.
- `video-path-policy.js` is the single extension, quoting, absolute-path, and
  canonical-path policy shared by both parsers.
- `video-request-router.js` combines command, natural-language, and status
  classification into `submit`, `status`, `respond`, `reject`, or `pass`.
- `dispatch-identity.js` validates the Telegram private-chat and consistent
  session/sender identity, then derives the stable task key.
- `before-dispatch.js` coordinates routing, identity, one runner call, and the
  final response.
- `runner.js` owns the fixed installed-client argument array and validates its
  structured response.
- `video-task-result.js` is the single status/duplicate validation policy.
- `video-task-id.js` validates and extracts canonical video task identifiers.
- `recent-task-store.js` retains only the bounded, non-sensitive recent-task
  pointer needed by an explicit status request.
- `status-request.js` recognizes explicit progress/result queries and resolves
  their task identifier without monitoring.
- `status-runner.js` invokes the installed one-shot status client and validates
  its structured response.
- `video-status-result.js` renders one concise terminal or in-progress reply.
- `json-command.js` provides the shared bounded JSON subprocess boundary.
- `short-receipt.js` exposes only a
  human-readable task number and later-query hint.
- `scripts/run-installed-video-status-qa.mjs` is the installed-runtime status
  acceptance harness; it does not submit or poll a task.

Keep parsing, identity, execution, and presentation separate. Do not add model
tool selection, host run-state coordination, direct media analysis, or n8n
polling back into this plugin.

## Runtime boundary

- Scope execution to authorized Telegram private messages. Reject an applicable
  Telegram group execution request; leave group conversation and other channels
  outside this plugin's hook-owned response scope.
- Reuse the Telegram DM allowlist/pairing admission completed by OpenClaw before
  the hook, then apply a narrower plugin-owned sender gate. The installer
  requires exactly one canonical `telegram:<positive-numeric-id>` entry in
  `commands.ownerAllowFrom`, derives a domain-separated SHA-256 value, and
  stores only that hash as `allowedSenderSha256` in plugin config. Other
  non-wildcard, explicitly channel-scoped command owners may remain.
  `before_dispatch`
  compares the consistent Telegram sender identity to this hash before any
  submission, so later pairing approvals do not expand the video entry.
- Derive the stable identity from consistent trusted event/context fields and
  the exact current message. Never expose raw identity fields in the task ID.
- Call the runner at most once for one handled message. A timeout or uncertain
  acceptance-boundary result must return the stable task number for a later
  explicit query and must not trigger a new submission.
- For a new task, return exactly:

  ```text
  已提交，任务编号：<id>。结果请稍后查询。
  ```

- For an idempotent duplicate, return exactly:

  ```text
  任务已存在，任务编号：<id>。结果请稍后查询。
  ```

- Keep status and duplicate fields in internal validation and audit data; do not
  show them to an ordinary user.

- For a timeout or exit-75 acceptance-boundary error, return exactly:

  ```text
  提交状态暂未确认，任务编号：<id>。请稍后查询。
  ```

- Keep rejection and failure replies short. Never include the video path,
  command, child output, logs, or credentials.
- End the turn after a receipt, rejection, or failure. Do not run a same-turn
  status lookup, inspect Mission Control or n8n, wait, retry, resubmit, or send
  progress narration.

The downstream work remains outside the plugin:

`Mission Control / SQLite -> n8n -> prepare -> Whisper audio + local Qwen vision -> finalize -> SQLite`

Every model worker uses `memoryMode=none`. Video submission uses
`delivery=none`; completed output is read only after a later explicit user
request.

For `查一下刚才的视频`, use only the complete task ID from the most recent
plugin receipt in the current conversation and run one status query. If the ID
is absent or several receipts are ambiguous, ask for the task ID. Do not search
memory, scan SQLite, guess an ID, or resubmit.

## Plugin-absence contract

This native hook is the only single-video conversation execution entry. The
zero-model and zero-tool guarantees above are structural only while the plugin
is loaded. Production deployment must fail unless live runtime inspection
proves that `before_dispatch` is loaded. The workspace rule provides a
defensive degraded-mode reply when the hook is unavailable:

```text
未提交：视频入口当前不可用。
```

That workspace defense must not be reported as equivalent to a loaded hook.
Never fall back to a generic AI-worker task, `exec`, direct `submit-task.mjs`,
filesystem discovery, ffmpeg, Whisper, Qwen, or a retired video-learning flow.

## Validation boundary

Validate the local candidate with the plugin unit suite and the workspace
contract suite. Acceptance must cover exact and natural-language submission,
fixed zero-tool video explanations, unrelated-chat pass-through, invalid-input
rejection, stable idempotency, one runner call, short receipts, degraded plugin
absence behavior, and zero same-turn status queries.

Do not treat local tests as production evidence. The fresh installer accepts
only a first install of hook-only `0.3.0`; it proves the manifest has no tool
contract, performs a real isolated official install, and leaves production
untouched in dry-run mode.

The controlled upgrade gate accepts only an installed `0.2.0`. Before any
write, it finds exactly one compatible verified prior upgrade backup, proves
the current `second-original.tools` object is the known `0.2.0` transformation,
and recovers the complete pre-`0.2.0` tools object from that backup. It also
requires Telegram DM policy to be omitted/default-pairing, `pairing`, or
`allowlist`, rejects `open`, and requires exactly one Telegram binding to the
unique `second-original` agent. Fresh install and upgrade both require the
single canonical Telegram command owner, retain only its count and sender hash
as redacted evidence, and write only `allowedSenderSha256` to plugin config.
Both modes require the explicitly approved commit:

```bash
bash scripts/upgrade-aiworker-video-command-plugin.sh --dry-run --target-sha <40-lowercase-commit-sha>
bash scripts/upgrade-aiworker-video-command-plugin.sh --apply --target-sha <same-commit-sha>
```

The gate requires clean `HEAD`, local `origin/main`, and the live GitHub
`refs/heads/main` to equal that SHA. Under the shared profile lock it rechecks
HEAD and the audited source-payload fingerprint immediately before and after
the official install, then proves the installed payload has the same fingerprint.
The only normalized installer artifact is `node_modules/openclaw`: it must be
the sole `node_modules` entry and retain the exact pre-upgrade link text and
resolved directory; every other installed path remains part of the comparison.

Dry-run performs a real isolated `0.2.0 -> 0.3.0` official force-install. Apply
uses only the official config and plugin install commands, restarts only
`qwen-current`, and proves runtime has only `before_dispatch`, the live catalog
has no plugin tool, and the Telegram session effective tools equal the original
baseline. Failure officially reinstalls the backed-up `0.2.0`, restores the
exact current config (including removal of the 0.3-only sender hash), restarts
only `qwen-current`, and proves the old runtime and effective policy returned.
Backups are mode 0700, redacted owner evidence is mode 0600, and the shared lock
remains mandatory. A changed install first creates and fully verifies its new
recovery point; only after every runtime and live-Gateway gate passes may the
installer remove the exact oldest unprotected verified backup and converge the
shared family to at most two. A failed install or rollback never prunes existing
verified recovery points.

After promotion, verify Mission Control / SQLite, one n8n video-analysis
execution, `prepare/audio/vision/finalize`, `memoryMode=none`, `delivery=none`,
service health, and temporary residue separately.

### Controlled 0.3.0 to 0.4.0 status-query release

The earlier upgrade entry is intentionally limited to its one-time
`0.2.0 -> 0.3.0` tool-removal migration. Do not reuse that migration to deploy
`0.4.0`. The hook-only status-query release has a separate, config-preserving
entry:

```bash
bash scripts/upgrade-aiworker-video-command-status-plugin.sh --dry-run --target-sha <approved-0.4.0-sha>
bash scripts/upgrade-aiworker-video-command-status-plugin.sh --apply --target-sha <same-approved-0.4.0-sha>
```

It accepts only installed `0.3.0` and source `0.4.0`. The gate requires a clean
canonical `main` whose `HEAD`, local `origin/main`, and live GitHub `main` all
equal the explicit target SHA. The installed recovery payload must also match
the immutable `0.3.0` source commit `3c385f19308b4d36cf624d3c95a20cc65acaf903`,
which must be an ancestor of the target. Dry-run performs an isolated official force
install and fingerprints production state before and after. Apply makes and
validates a complete `0.3.0` plugin/config recovery point, enforces the shared
two-backup limit, installs only through the official OpenClaw command, and
refreshes only `qwen-current`.

Success requires the canonical and installed payload fingerprints to match,
runtime and live Gateway inspection to expose only `before_dispatch`, the
Telegram direct-session effective tools and qwen-current config to remain
unchanged, and the protected `3017`, `5678`, `5679`, `18091`, `gpt-main`, and
`qwen-weixin-new` listener identities to remain unchanged. It does not submit a
task or restart Mission Control or n8n.

The successful apply prints the exact verified backup path. Use that path and
the same approved target SHA for an explicit rollback:

```bash
bash scripts/upgrade-aiworker-video-command-status-plugin.sh --rollback \
  --target-sha <same-approved-0.4.0-sha> \
  --backup /absolute/path/to/status-upgrade-YYYYMMDD-HHMMSS.suffix
```

Any failed apply automatically reinstalls the fingerprinted `0.3.0` payload,
restores the exact saved qwen-current config, refreshes only qwen-current, and
revalidates the live hook-only/runtime/tool boundary. A failed rollback attempts
to restore the audited `0.4.0` candidate and accepts that compensation only
after config, index, payload, runtime, live catalog, effective tools, and all
protected listeners pass again. If compensation is incomplete, it exits for
manual inspection rather than reporting success.
