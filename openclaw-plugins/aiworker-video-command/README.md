# AI-worker Video Command plugin

This is a Git-managed, pre-production OpenClaw `0.2.0` plugin candidate for the
`qwen-current` profile. It keeps the deterministic Telegram command handled by
the global `before_dispatch` decision hook, before normal agent dispatch:

```text
分析视频 <absolute-video-path>
```

The entire single-line remainder is the path, so unquoted Chinese characters,
spaces, and parentheses are supported. Matching outer quotes are removed.
Relative paths, newlines, negating phrases, and extensions outside `.mp4`,
`.mov`, `.mkv`, `.webm`, and `.m4v` are rejected. File existence and media
validation remain the responsibility of the installed, versioned
`submit-task.mjs` workflow.

For other affirmative wording such as `帮我分析一下这个视频 <absolute-path>`,
the same plugin exposes the optional `aiworker_analyze_video` tool only to the
authorized `second-original` Telegram direct-message context. The model chooses
the tool, while the plugin—not the model—validates the request, pins the only
path, derives the stable task identity, and permits one runner submission.

## Runtime contract

- Scope is Telegram private chats only. Group chats and events without an
  explicit `isGroup: false` classification are handled with a short rejection
  and never submitted. WhatsApp remains out of scope until a separate channel
  acceptance test.
- Profile/agent scope comes from installing only into `qwen-current`.
- Existing OpenClaw owner and channel allowlists remain the authorization
  boundary. The plugin neither broadens nor replaces them.
- Natural-language input is classified as match, blocked, or unrelated.
  Questions, method requests, negative or conditional wording, missing or
  multiple paths, URLs, relative paths, unsupported formats, and ambiguous
  attachment references cannot reach the submission runner.
- Natural-language admission is bound to the exact inbound content and stable
  Telegram identity, then copied into the host `runContext`. A missing,
  malformed, cleared, unbound, or divergent host state fails closed. The tool
  hook requires matching event/context run ID, tool-call ID, agent, session,
  tool name, and path; every other tool is blocked for that admitted run.
- Concurrent messages are queued by session and exact content. An ambiguous
  duplicate is rejected rather than assigned the wrong message identity.
  Tool-call admission uses a session-scoped key, rejects cross-run collisions,
  and atomically shares one submission promise for repeated execution of the
  same admitted call.
- The hook parses only `event.content`. It does not parse `event.body`, which
  can be the structured agent-facing body.
- A missing/non-finite timestamp or conflicting event/context identity field
  is handled with a short error and never submitted. The task/idempotency key
  is a SHA-256 digest over a version prefix plus length-prefixed channel,
  account, conversation, session, sender, finite timestamp, and exact content.
  No path or identity text is embedded in the key.
- The runner uses `execFile` with an argument array and the installed absolute
  script path. It always passes `--video-file`, identical `--task-id` and
  `--idempotency-key`, `--delivery none`, and `--wait-seconds 0`.
- A timed-out submit is followed by one `--status <same-task-id>` query. The
  command is never resubmitted.
- Successful replies have exactly this user-facing shape:

  ```text
  已提交：taskId=<id>，status=<status>，duplicate=<true|false>。
  ```

  Error replies are short and never include the path, command, child stderr,
  or credentials.

This contract targets OpenClaw `2026.7.1-2`. Its installed declarations define
`before_dispatch(event, context)` as a decision hook returning
`{ handled, text? }`. The event has required `content` plus optional `channel`,
`isGroup`, `sessionKey`, `senderId`, and `timestamp`; context provides optional
`channelId`, `accountId`, `conversationId`, `sessionKey`, and `senderId`.

The inspected production runtime calls `runBeforeDispatch(...)` for the normal
message path whenever a handler is registered. It passes command-facing
`hookContext.content`, uses `bodyForAgent ?? body` only for the separate `body`
field, and, on the first handled result, sends `{ text }` then completes without
invoking the agent. No plugin-owned conversation binding is required.

## Installation gate

The legacy first-install gate below accepts only a `0.1.0` source. It fails
closed against the current `0.2.0` tree because a fresh `0.2.0` install would
also need the per-agent optional-tool grant, and that fresh-install workflow has
not been delivered. Existing production `0.1.0` installations must use the
controlled upgrade section below. Do not use this legacy command with the
current candidate.

For a historical `0.1.0` first install, first fast-forward the production host
to the exact approved `0.1.0` commit and keep it clean, then run:

```bash
bash scripts/install-aiworker-video-command-plugin.sh --dry-run
bash scripts/install-aiworker-video-command-plugin.sh --apply
```

The script refuses any user/host/profile other than the production
`heisenbergs-1` `qwen-current` target. Its dry run checks the clean canonical
Git checkout, manifest/package contract, strict config schema, and JavaScript
syntax, then performs a real official install inside mode-0700 temporary
`OPENCLAW_HOME` and state roots, followed by runtime inspection and a plugin
doctor pass. The exact temporary root is removed afterward; `qwen-current` is
inspected under before/after fingerprints but is not intentionally changed. Real approvals, default config, and default extension
paths, plus the target plugin index in the default and `qwen-current` state, are
fingerprinted before and after to detect the known high-risk isolation escapes. The installer
also clears inherited OpenClaw home/state/config overrides for every production-profile
CLI call, so `--profile qwen-current` cannot be redirected by the caller environment. It
intentionally does not call `plugins validate`, because
OpenClaw `2026.7.1-2` defines that command only for generated
`defineToolPlugin` metadata, not hook-only native plugins. Apply mode creates a
mode-0700 timestamped backup of the profile config. Apply also holds a
profile-specific first-install lock, records a clean production plugin-doctor
baseline, and repeats the first-install checks immediately before mutation. It
is deliberately limited
to a first install: the target ID must be absent from the allowlist, profile
entries, runtime discovery, and extension directory. It also requires a
non-empty explicit plugin allowlist, then invokes only the official command:

```bash
openclaw --profile qwen-current plugins install --force <plugin-directory>
```

It does not edit npm `dist`, install into another profile, or explicitly invoke
a service restart. The official OpenClaw install/uninstall configuration write
may refresh `qwen-current`; no other profile, Mission Control, or n8n service is
in scope. Before committing the install, it verifies that the plugin ID was
added to that allowlist, the installed directory exists, and official runtime
inspection reports the expected plugin ID as `loaded`, includes the registered
`before_dispatch` typed hook, and has no error diagnostic; it then runs
`plugins doctor`. Any failure first calls the official plugin uninstall command
to remove its install-index record and files, restores the saved configuration,
then proves the target is no longer discoverable. A failed uninstall or residual
state is reported as a rollback failure and never as a successful recovery.
After installation, the rollout must verify or explicitly refresh only
`ai.openclaw.qwen-current`, then run an isolated Telegram acceptance test before
production use.

### Controlled 0.1.0 to 0.2.0 upgrade

The `0.2.0` release supports only upgrading an existing path-source `0.1.0`
installation; fresh `0.2.0` installation is not delivered. Use the dedicated
upgrade gate—the first-install script and `plugins update` are not upgrade
paths:

```bash
bash scripts/upgrade-aiworker-video-command-plugin.sh --dry-run
bash scripts/upgrade-aiworker-video-command-plugin.sh --apply
```

The gate is pinned to OpenClaw `2026.7.1-2`, the production identity, a clean
canonical checkout, and the unique `qwen-current` `second-original` agent. It
preserves that agent's existing `tools.allow` and appends only
`aiworker_analyze_video` to its `tools.alsoAllow`; every other agent and profile
must remain free of the plugin and tool grant. Apply holds the shared profile
lock, creates a mode-0700 backup, and uses only official
`plugins install --force` for replacement. On failure it officially reinstalls
the backed-up `0.1.0` tree and restores the original config. The gate reads the
plugin index only through SQLite read-only queries; it does not edit SQLite,
or submit an AI-worker task. Before marking the backup verified, apply invokes
the official profile-scoped `gateway restart` for `qwen-current`, requires
`gateway status --deep --require-rpc`, and calls the live Gateway
`tools.catalog` RPC for `second-original`. Success requires the active plugin
registry group for `aiworker-video-command` to expose the optional
`aiworker_analyze_video` tool. That capability is exclusive to `0.2.0`, while
the already-validated config proves the exact per-agent `tools.alsoAllow`
grant. A failure in restart, RPC health, or catalog validation occurs while
rollback remains armed: the script officially reinstalls `0.1.0`, restores the
original config, restarts only `qwen-current` again, and requires the live
catalog to omit the `0.2.0` tool. Failure of that recovery is reported as a
rollback failure. The script never restarts Mission Control, n8n, or another
OpenClaw profile. The controlled acceptance request must not run until apply
returns success.

The installed package includes a deterministic isolated harness:

```bash
node ~/.openclaw-qwen-current/extensions/aiworker-video-command/scripts/run-isolated-video-command-qa.mjs \
  --video-file /absolute/controlled-qa.mp4 \
  --timestamp-ms 1786238400000 \
  --qa-id release-qa-1
```

It invokes the installed `before_dispatch` handler once with a synthetic,
private Telegram-shaped event and the real task runner, then emits one redacted
JSON receipt. Although ingress is synthetic, a successful run creates one real
AI-worker task in the active production control plane with `delivery=none` and
no harness-side status query. This proves the installed native handler, parser,
stable key, runner, and AI-worker submission boundary without invoking the
OpenClaw agent/model path. Downstream Whisper, Qwen, and workflow stages run
asynchronously as normal and must be verified separately by task ID. It is not
proof that a real Telegram inbound message reached the hook; that final ingress
check still requires one real allowlisted private message from the user.

## Rollback boundary

For a completed `0.2.0` upgrade, use only the exact upgrade backup printed by
the script. Officially reinstall its `previous-plugin` directory, restore its
mode-0600 `openclaw.json`, and verify the old runtime/index/doctor state before
refreshing only `qwen-current`. Do not copy an old extension over a live install
or edit the OpenClaw SQLite index directly.

If a mutating apply fails and automatic rollback succeeds, the official force
reinstall makes the install index point to that upgrade backup's
`previous-plugin` directory. Only after the old runtime, index, doctor output,
and installed payload fingerprint pass does the installer write a mode-0600
`.active-rollback-source.json` marker. While the current index references that
path, the entire mode-0700 upgrade directory is an active install source: do
not delete, move, rename, or archive it. A later preflight accepts only the
canonical source or this exact marked, non-symlinked, fingerprint-matching
`previous-plugin` shape under the controlled backup root; arbitrary backup
paths fail closed. The next successful apply rewrites the index to the
canonical `0.2.0` source, after which the old marker is no longer active and
the backup may be handled under the explicit retention policy.

Automatic rollback also restarts only `qwen-current`, requires its deep RPC
status, and proves through the live `second-original` catalog that
`aiworker_analyze_video` is absent before writing the active-source marker.

The legacy first-install rollback below applies only to the historical `0.1.0`
flow.

The installer prints the exact backup directory. To roll back, set
`BACKUP_DIR` to that one directory and verify it contains `openclaw.json`:

```bash
openclaw --profile qwen-current plugins uninstall aiworker-video-command --force
install -m 600 "$BACKUP_DIR/openclaw.json" "$HOME/.openclaw-qwen-current/openclaw.json"
```

If `$BACKUP_DIR/extension` exists, restore that prior installed directory to
`$HOME/.openclaw-qwen-current/extensions/aiworker-video-command` before the
restart. Then restart only `ai.openclaw.qwen-current` and verify Gateway and
Telegram health. Do not restart or rebuild Mission Control (`3017`) or n8n.

If an official install command fails, the applicable installer restores the
approved configuration and prior plugin state, then validates the result. An
official config write or reinstall can refresh `qwen-current`; no other profile,
Mission Control, or n8n service is in scope. Failed evidence is retained in the
exact backup rather than broadly cleaned.
