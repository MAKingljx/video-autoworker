#!/usr/bin/env bash
set -euo pipefail

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
RETIRED_TOOL_NAME="aiworker_analyze_video"
PREVIOUS_VERSION="0.4.1"
PREVIOUS_SOURCE_SHA="e615d8dc68d089f11afe1581c1f56c614e01b796"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-command-upgrade.mjs"
STATUS_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-status-upgrade.mjs"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
PROFILE_STATE_DB="$PROFILE_STATE_DIR/state/openclaw.sqlite"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
INSTALL_LOCK_DIR="$BACKUP_ROOT/.qwen-current-first-install.lock"

MODE=""
TARGET_SHA=""
ROLLBACK_BACKUP=""
DIRECT_SESSION_KEY=""
SOURCE_FINGERPRINT=""
PREVIOUS_SOURCE_FINGERPRINT=""
PEER_LINK_TEXT=""
PEER_REAL_PATH=""
BASELINE_EFFECTIVE=""
BACKUP_DIR=""
LOCK_ACQUIRED=0

usage() {
  printf 'Usage: %s (--dry-run|--apply|--rollback) --target-sha <40-lowercase-hex> [--backup <absolute-status-upgrade-backup>]\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply|--rollback)
      [[ -z "$MODE" ]] || { usage >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --target-sha)
      [[ -z "$TARGET_SHA" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      TARGET_SHA="$2"
      shift 2
      ;;
    --backup)
      [[ -z "$ROLLBACK_BACKUP" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      ROLLBACK_BACKUP="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if [[ -z "$MODE" || ! "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  usage >&2
  exit 2
fi
if [[ "$MODE" == "rollback" ]]; then
  [[ "$ROLLBACK_BACKUP" == /* ]] || { usage >&2; exit 2; }
elif [[ -n "$ROLLBACK_BACKUP" ]]; then
  usage >&2
  exit 2
fi

for command_name in awk chmod cmp cp date env git hostname id install lsof mkdir mktemp node openclaw \
  rm rmdir shasum sqlite3 stat tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done

CANDIDATE_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$PLUGIN_DIR/package.json")"
MANIFEST_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$PLUGIN_DIR/openclaw.plugin.json")"
node "$STATUS_VALIDATOR" version "$CANDIDATE_VERSION" "$MANIFEST_VERSION" >/dev/null

run_clean_openclaw() {
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS openclaw "$@"
}

run_qwen_openclaw() {
  run_clean_openclaw --profile "$PROFILE" "$@"
}

run_isolated_openclaw() {
  local isolated_home="$1"
  local isolated_state="$2"
  local isolated_config="$3"
  shift 3
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
    OPENCLAW_HOME="$isolated_home" OPENCLAW_STATE_DIR="$isolated_state" \
    OPENCLAW_CONFIG_PATH="$isolated_config" NO_COLOR=1 openclaw "$@"
}

work_root="$(mktemp -d /tmp/aiworker-video-status-upgrade.XXXXXX)"
chmod 700 "$work_root"

cleanup_work_root() {
  [[ -d "${work_root:-}" ]] || return 0
  case "$work_root" in
    /tmp/aiworker-video-status-upgrade.*|/private/tmp/aiworker-video-status-upgrade.*)
      rm -rf -- "$work_root"
      ;;
    *) printf 'Refusing unexpected temporary cleanup path.\n' >&2; return 1 ;;
  esac
}

release_lock() {
  [[ "$LOCK_ACQUIRED" -eq 1 ]] || return 0
  rmdir "$INSTALL_LOCK_DIR" || return 1
  LOCK_ACQUIRED=0
}

write_index_record() {
  local output_path="$1"
  local record
  [[ -f "$PROFILE_STATE_DB" && ! -L "$PROFILE_STATE_DB" ]] || {
    printf 'qwen-current state database is missing or unsafe.\n' >&2
    return 1
  }
  record="$(sqlite3 -readonly "$PROFILE_STATE_DB" \
    "SELECT COALESCE(json_extract(install_records_json, '$.\"$PLUGIN_ID\"'), '') FROM installed_plugin_index WHERE index_key='installed-plugin-index' ORDER BY generated_at_ms DESC LIMIT 1;")" || return 1
  [[ -n "$record" ]] || { printf 'Plugin install-index record is absent.\n' >&2; return 1; }
  printf '%s\n' "$record" > "$output_path"
  chmod 600 "$output_path"
}

service_snapshot() {
  local port pids
  # qwen-current itself listens on 18889 and is the only service allowed to
  # refresh. Pin Mission Control, n8n, the shared Qwen backend, and both other
  # OpenClaw profiles to their production listener identities.
  for port in 3017 5678 5679 18091 18789 18989; do
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | LC_ALL=C sort -u | tr '\n' ',')" || return 1
    [[ -n "$pids" ]] || { printf 'Protected listener %s is missing.\n' "$port" >&2; return 1; }
    printf '%s=%s\n' "$port" "$pids"
  done
}

validate_git_target() {
  local remote_url branch head origin_main live_record
  remote_url="$(git -C "$REPOSITORY_ROOT" remote get-url origin)" || return 1
  case "$remote_url" in
    https://github.com/MAKingljx/video-autoworker|https://github.com/MAKingljx/video-autoworker.git|git@github.com:MAKingljx/video-autoworker.git) ;;
    *) printf 'Canonical Git remote mismatch.\n' >&2; return 1 ;;
  esac
  branch="$(git -C "$REPOSITORY_ROOT" symbolic-ref --short -q HEAD)" || return 1
  [[ "$branch" == "main" ]] || { printf 'Canonical checkout must be on main.\n' >&2; return 1; }
  [[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=normal)" ]] || {
    printf 'Canonical checkout must be clean.\n' >&2
    return 1
  }
  head="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')" || return 1
  origin_main="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'refs/remotes/origin/main^{commit}')" || return 1
  live_record="$(git -C "$REPOSITORY_ROOT" ls-remote --exit-code origin refs/heads/main)" || return 1
  [[ "$live_record" =~ ^([a-f0-9]{40})[[:space:]]+refs/heads/main$ ]] || {
    printf 'GitHub main evidence is malformed or ambiguous.\n' >&2
    return 1
  }
  [[ "$head" == "$TARGET_SHA" && "$origin_main" == "$TARGET_SHA" && "${BASH_REMATCH[1]}" == "$TARGET_SHA" ]] || {
    printf 'HEAD, local origin/main, live GitHub main, and target SHA must match.\n' >&2
    return 1
  }
}

assert_source_unchanged() {
  validate_git_target || return 1
  [[ "$(node "$VALIDATOR" payload-fingerprint "$PLUGIN_DIR")" == "$SOURCE_FINGERPRINT" ]] || {
    printf 'Canonical candidate payload changed after audit.\n' >&2
    return 1
  }
}

validate_host_and_source() {
  local actual_version
  actual_version="$(run_clean_openclaw --version)"
  case "$actual_version" in
    "OpenClaw $OPENCLAW_VERSION ("*")") ;;
    *) printf 'Unsupported OpenClaw version: %s\n' "$actual_version" >&2; return 1 ;;
  esac
  [[ "$(id -un)" == "$EXPECTED_USER" && "$(hostname)" == "$EXPECTED_HOST" ]] || {
    printf 'Refusing non-production identity.\n' >&2
    return 1
  }
  validate_git_target
  git -C "$REPOSITORY_ROOT" cat-file -e "$PREVIOUS_SOURCE_SHA^{commit}"
  git -C "$REPOSITORY_ROOT" merge-base --is-ancestor "$PREVIOUS_SOURCE_SHA" "$TARGET_SHA" || {
    printf 'Approved 0.4.1 source is not an ancestor of the target SHA.\n' >&2
    return 1
  }
  node --check "$STATUS_VALIDATOR"
  node "$VALIDATOR" source "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/openclaw.plugin.json" \
    "$PLUGIN_ID" "$CANDIDATE_VERSION" "$RETIRED_TOOL_NAME"
  SOURCE_FINGERPRINT="$(node "$VALIDATOR" payload-fingerprint "$PLUGIN_DIR")"
  local previous_extract="$work_root/previous-source"
  install -d -m 700 "$previous_extract"
  git -C "$REPOSITORY_ROOT" archive --format=tar "$PREVIOUS_SOURCE_SHA" \
    "openclaw-plugins/$PLUGIN_ID" | tar -xf - -C "$previous_extract"
  local previous_source="$previous_extract/openclaw-plugins/$PLUGIN_ID"
  node "$VALIDATOR" source "$previous_source/package.json" "$previous_source/openclaw.plugin.json" \
    "$PLUGIN_ID" "$PREVIOUS_VERSION" "$RETIRED_TOOL_NAME"
  PREVIOUS_SOURCE_FINGERPRINT="$(node "$VALIDATOR" payload-fingerprint "$previous_source")"
}

load_direct_session_and_effective() {
  local report_dir="$1"
  install -d -m 700 "$report_dir"
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$report_dir/gateway-status.json"
  run_qwen_openclaw gateway call sessions.list \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId:process.argv[1],search:"telegram:direct:",configuredAgentsOnly:true,includeGlobal:false,limit:200}))' "$AGENT_ID")" \
    --timeout 20000 --json > "$report_dir/sessions.json"
  DIRECT_SESSION_KEY="$(node "$VALIDATOR" session-select "$report_dir/sessions.json" "$AGENT_ID")"
  run_qwen_openclaw gateway call tools.catalog \
    --params '{"agentId":"second-original","includePlugins":true}' \
    --timeout 20000 --json > "$report_dir/tools-catalog.json"
  node "$VALIDATOR" live-hook-only "$report_dir/tools-catalog.json" \
    "$PLUGIN_ID" "$AGENT_ID" "$RETIRED_TOOL_NAME"
  run_qwen_openclaw gateway call tools.effective \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId:process.argv[1],sessionKey:process.argv[2]}))' "$AGENT_ID" "$DIRECT_SESSION_KEY")" \
    --timeout 20000 --json > "$report_dir/tools-effective.json"
  BASELINE_EFFECTIVE="$report_dir/tools-effective.json"
}

validate_current_hook() {
  local report_dir="$1"
  local expected_version="$2"
  local package_version installed_report
  install -d -m 700 "$report_dir"
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || { printf 'qwen-current config is unsafe.\n' >&2; return 1; }
  [[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || { printf 'Installed plugin is unsafe.\n' >&2; return 1; }
  package_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$INSTALLED_PLUGIN_DIR/package.json")"
  [[ "$package_version" == "$expected_version" ]] || { printf 'Installed plugin must be %s.\n' "$expected_version" >&2; return 1; }
  node "$VALIDATOR" telegram-policy "$PROFILE_CONFIG" "$AGENT_ID"
  if [[ "$expected_version" == "$PREVIOUS_VERSION" ]]; then
    local sender_hash
    sender_hash="$(node "$VALIDATOR" owner-sender-plan "$PROFILE_CONFIG" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).allowedSenderSha256))')"
    node "$VALIDATOR" sender-hash-config "$PROFILE_CONFIG" "$PLUGIN_ID" "$sender_hash"
  fi
  installed_report="$(node "$STATUS_VALIDATOR" installed-payload "$INSTALLED_PLUGIN_DIR")"
  printf '%s\n' "$installed_report" > "$report_dir/installed-payload.json"
  PEER_LINK_TEXT="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.peer.linkText)' "$installed_report")"
  PEER_REAL_PATH="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.peer.realPath)' "$installed_report")"
  local installed_fingerprint
  installed_fingerprint="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.fingerprint)' "$installed_report")"
  if [[ "$expected_version" == "$PREVIOUS_VERSION" ]]; then
    [[ "$installed_fingerprint" == "$PREVIOUS_SOURCE_FINGERPRINT" ]] || {
      printf 'Installed 0.4.1 payload does not match approved source %s.\n' "$PREVIOUS_SOURCE_SHA" >&2
      return 1
    }
  fi
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report_dir/runtime.json"
  node "$VALIDATOR" runtime-hook-only "$report_dir/runtime.json" "$PLUGIN_ID" "$expected_version" "$RETIRED_TOOL_NAME"
  write_index_record "$report_dir/index.json"
  node "$VALIDATOR" index-preflight "$report_dir/index.json" "$expected_version" \
    "$PLUGIN_DIR" "$BACKUP_ROOT" "$INSTALLED_PLUGIN_DIR" "$PLUGIN_ID" > "$report_dir/source-kind.txt"
  load_direct_session_and_effective "$report_dir/live"
}

validate_current_candidate() {
  local report_dir="$1"
  local owner_sender_hash candidate_sender_hash
  validate_current_hook "$report_dir" "$CANDIDATE_VERSION"
  node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" candidate "$PLUGIN_ID" "$AGENT_ID" \
    > "$report_dir/classifier-config.json"
  owner_sender_hash="$(node "$VALIDATOR" owner-sender-plan "$PROFILE_CONFIG" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).allowedSenderSha256))')"
  candidate_sender_hash="$(node -e 'const report=require(process.argv[1]);process.stdout.write(report.allowedSenderSha256 || "")' "$report_dir/classifier-config.json")"
  [[ "$candidate_sender_hash" == "$owner_sender_hash" ]] || {
    printf 'Candidate plugin sender hash does not match the authorized Telegram owner.\n' >&2
    return 1
  }
  node "$VALIDATOR" payload-match "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" "$SOURCE_FINGERPRINT" \
    "$PEER_LINK_TEXT" "$PEER_REAL_PATH" > "$report_dir/candidate-payload.json"
}

run_isolated_upgrade() {
  local isolated_root="$work_root/isolated"
  local isolated_home="$isolated_root/home"
  local isolated_state="$isolated_home/.openclaw"
  local isolated_config="$isolated_state/openclaw.json"
  local isolated_install="$isolated_state/extensions/$PLUGIN_ID"
  install -d -m 700 "$isolated_state"
  node - "$isolated_config" "$PLUGIN_ID" <<'NODE'
const { writeFileSync } = require('node:fs')
const [configPath, pluginId] = process.argv.slice(2)
writeFileSync(configPath, `${JSON.stringify({
  plugins: {
    allow: [pluginId],
    entries: { [pluginId]: { enabled: true, config: { allowedSenderSha256: 'a'.repeat(64) } } },
  },
  agents: { list: [{ id: 'second-original', tools: { profile: 'coding', allow: ['read'] } }] },
}, null, 2)}\n`, { mode: 0o600 })
NODE
  chmod 600 "$isolated_config"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins install --force "$INSTALLED_PLUGIN_DIR" > "$isolated_root/install-old.txt"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins inspect "$PLUGIN_ID" --runtime --json > "$isolated_root/runtime-old.json"
  node "$VALIDATOR" runtime-hook-only "$isolated_root/runtime-old.json" "$PLUGIN_ID" "$PREVIOUS_VERSION" "$RETIRED_TOOL_NAME"
  node "$STATUS_VALIDATOR" classifier-config "$isolated_config" baseline "$PLUGIN_ID" "$AGENT_ID"
  install -m 600 "$isolated_config" "$isolated_root/baseline-openclaw.json"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins install --force "$PLUGIN_DIR" > "$isolated_root/install-new.txt"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    config set "plugins.entries.$PLUGIN_ID.llm" \
    '{"allowAgentIdOverride":true}' --strict-json \
    > "$isolated_root/config-set-llm.txt"
  # The official installer may update volatile metadata. Rebuild from the
  # audited baseline so the isolated transition proves the same exact config
  # delta that the production primitive permits.
  node "$STATUS_VALIDATOR" classifier-config-candidate \
    "$isolated_root/baseline-openclaw.json" "$PLUGIN_ID" \
    > "$isolated_root/candidate-openclaw.json"
  install -m 600 "$isolated_root/candidate-openclaw.json" "$isolated_config"
  node "$STATUS_VALIDATOR" classifier-config "$isolated_config" candidate "$PLUGIN_ID" "$AGENT_ID"
  node "$STATUS_VALIDATOR" classifier-config-transition \
    "$isolated_root/baseline-openclaw.json" "$isolated_config" "$PLUGIN_ID" "$AGENT_ID" \
    > "$isolated_root/classifier-config-transition.json"
  node "$VALIDATOR" payload-match "$PLUGIN_DIR" "$isolated_install" "$SOURCE_FINGERPRINT" \
    "$PEER_LINK_TEXT" "$PEER_REAL_PATH" > "$isolated_root/payload-new.json"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins inspect "$PLUGIN_ID" --runtime --json > "$isolated_root/runtime-new.json"
  node "$VALIDATOR" runtime-hook-only "$isolated_root/runtime-new.json" "$PLUGIN_ID" "$CANDIDATE_VERSION" "$RETIRED_TOOL_NAME"
}

validate_live_candidate() {
  local report_dir="$1"
  install -d -m 700 "$report_dir"
  run_qwen_openclaw gateway restart --wait 60s --json > "$report_dir/gateway-restart.json" || return 1
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$report_dir/gateway-status.json" || return 1
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report_dir/runtime.json" || return 1
  node "$VALIDATOR" runtime-hook-only "$report_dir/runtime.json" "$PLUGIN_ID" "$CANDIDATE_VERSION" "$RETIRED_TOOL_NAME" || return 1
  run_qwen_openclaw gateway call tools.catalog \
    --params '{"agentId":"second-original","includePlugins":true}' --timeout 20000 --json > "$report_dir/tools-catalog.json" || return 1
  node "$VALIDATOR" live-hook-only "$report_dir/tools-catalog.json" "$PLUGIN_ID" "$AGENT_ID" "$RETIRED_TOOL_NAME" || return 1
  run_qwen_openclaw gateway call tools.effective \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId:process.argv[1],sessionKey:process.argv[2]}))' "$AGENT_ID" "$DIRECT_SESSION_KEY")" \
    --timeout 20000 --json > "$report_dir/tools-effective.json" || return 1
  node "$VALIDATOR" effective-hook-only "$BASELINE_EFFECTIVE" "$report_dir/tools-effective.json" \
    "$AGENT_ID" "$RETIRED_TOOL_NAME" || return 1
}

validate_installed_candidate() {
  local report_dir="$1"
  install -d -m 700 "$report_dir"
  node "$VALIDATOR" payload-match "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" "$SOURCE_FINGERPRINT" \
    "$PEER_LINK_TEXT" "$PEER_REAL_PATH" > "$report_dir/payload.json" || return 1
  write_index_record "$report_dir/index.json" || return 1
  node "$VALIDATOR" index "$report_dir/index.json" "$CANDIDATE_VERSION" "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" || return 1
}

install_and_validate_candidate() {
  run_qwen_openclaw plugins install --force "$PLUGIN_DIR" > "$BACKUP_DIR/install-candidate.txt" || return 1
  # The official installer updates volatile config metadata such as
  # meta.lastTouchedAt. Restore the audited profile bytes before loading the
  # candidate so the release changes only the plugin payload and install index.
  install -m 600 "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" || return 1
  cmp -s "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" || return 1
  run_qwen_openclaw config set "plugins.entries.$PLUGIN_ID.llm" \
    '{"allowAgentIdOverride":true}' --strict-json \
    > "$BACKUP_DIR/config-set-llm.txt" || return 1
  node "$STATUS_VALIDATOR" classifier-config-candidate "$BACKUP_DIR/openclaw.json" "$PLUGIN_ID" \
    > "$work_root/candidate-openclaw.json" || return 1
  install -m 600 "$work_root/candidate-openclaw.json" "$PROFILE_CONFIG" || return 1
  node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" candidate "$PLUGIN_ID" "$AGENT_ID" \
    > "$BACKUP_DIR/classifier-config.json" || return 1
  node "$STATUS_VALIDATOR" classifier-config-transition "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" \
    "$PLUGIN_ID" "$AGENT_ID" > "$BACKUP_DIR/classifier-config-transition.json" || return 1
  assert_source_unchanged || return 1
  validate_installed_candidate "$BACKUP_DIR/candidate-validation" || return 1
  validate_live_candidate "$BACKUP_DIR/live-validation" || return 1
  [[ "$(service_snapshot)" == "$protected_before" ]] || return 1
}

retire_previous_active_marker() {
  local marker backup_dir
  marker="$(node -e '
    const { readFileSync } = require("node:fs")
    const { dirname, join } = require("node:path")
    const record = JSON.parse(readFileSync(process.argv[1], "utf8"))
    const backupRoot = process.argv[2]
    const canonicalSource = process.argv[3]
    if (record.sourcePath === canonicalSource) process.exit(0)
    if (typeof record.sourcePath !== "string" || dirname(dirname(record.sourcePath)) !== backupRoot
      || record.sourcePath !== join(dirname(record.sourcePath), "previous-plugin")) process.exit(1)
    process.stdout.write(join(dirname(record.sourcePath), ".active-rollback-source.json"))
  ' "$current_index" "$BACKUP_ROOT" "$PLUGIN_DIR")" || return 1
  [[ -n "$marker" ]] || return 0
  backup_dir="${marker%/.active-rollback-source.json}"
  [[ -d "$backup_dir" && ! -L "$backup_dir" && "$(stat -f '%Lp' "$backup_dir")" == "700" ]] || return 1
  [[ -f "$marker" && ! -L "$marker" && "$(stat -f '%Lp' "$marker")" == "600" ]] || return 1
  [[ ! -e "$backup_dir/.verified" ]] || return 1
  rm -f -- "$marker" || return 1
  [[ ! -e "$marker" ]]
}

create_verified_backup() {
  local previous_report previous_fingerprint config_fingerprint stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/status-upgrade-$stamp.XXXXXX")"
  chmod 700 "$BACKUP_DIR"
  install -m 600 "$PROFILE_CONFIG" "$BACKUP_DIR/openclaw.json"
  cp -R -p "$INSTALLED_PLUGIN_DIR" "$BACKUP_DIR/previous-plugin"
  previous_report="$(node "$STATUS_VALIDATOR" installed-payload "$BACKUP_DIR/previous-plugin" "$PEER_LINK_TEXT" "$PEER_REAL_PATH")"
  previous_fingerprint="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.fingerprint)' "$previous_report")"
  config_fingerprint="$(node "$STATUS_VALIDATOR" config-fingerprint "$BACKUP_DIR/openclaw.json")"
  node "$STATUS_VALIDATOR" metadata "$PLUGIN_ID" "$CANDIDATE_VERSION" "$TARGET_SHA" \
    "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" "$SOURCE_FINGERPRINT" "$previous_fingerprint" \
    "$config_fingerprint" "$PEER_LINK_TEXT" "$PEER_REAL_PATH" > "$BACKUP_DIR/metadata.json"
  chmod 600 "$BACKUP_DIR/metadata.json"
  install -m 600 /dev/null "$BACKUP_DIR/.verified"
  if ! node "$STATUS_VALIDATOR" backup "$BACKUP_ROOT" "$BACKUP_DIR" "$TARGET_SHA" \
    "$CANDIDATE_VERSION" "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" > "$BACKUP_DIR/backup-validation.json"; then
    rm -f -- "$BACKUP_DIR/.verified"
    return 1
  fi
  chmod 600 "$BACKUP_DIR/backup-validation.json"
}

restore_previous() {
  local backup_dir="$1"
  local report_dir="$2"
  local failed=0
  local restored_fingerprint marker_fingerprint source_marker_fingerprint marker_temp
  set +e
  install -d -m 700 "$report_dir"
  run_qwen_openclaw plugins install --force "$backup_dir/previous-plugin" > "$report_dir/install-previous.txt" 2>&1 || failed=1
  install -m 600 "$backup_dir/openclaw.json" "$PROFILE_CONFIG" || failed=1
  cmp -s "$backup_dir/openclaw.json" "$PROFILE_CONFIG" || failed=1
  node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" baseline "$PLUGIN_ID" "$AGENT_ID" \
    > "$report_dir/classifier-config.json" 2>&1 || failed=1
  run_qwen_openclaw gateway restart --wait 60s --json > "$report_dir/gateway-restart.json" 2>&1 || failed=1
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$report_dir/gateway-status.json" 2>&1 || failed=1
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report_dir/runtime.json" 2>&1 || failed=1
  node "$VALIDATOR" runtime-hook-only "$report_dir/runtime.json" "$PLUGIN_ID" "$PREVIOUS_VERSION" "$RETIRED_TOOL_NAME" || failed=1
  run_qwen_openclaw gateway call tools.catalog \
    --params '{"agentId":"second-original","includePlugins":true}' --timeout 20000 --json \
    > "$report_dir/tools-catalog.json" 2>&1 || failed=1
  node "$VALIDATOR" live-hook-only "$report_dir/tools-catalog.json" \
    "$PLUGIN_ID" "$AGENT_ID" "$RETIRED_TOOL_NAME" || failed=1
  run_qwen_openclaw gateway call tools.effective \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId:process.argv[1],sessionKey:process.argv[2]}))' "$AGENT_ID" "$DIRECT_SESSION_KEY")" \
    --timeout 20000 --json > "$report_dir/tools-effective.json" 2>&1 || failed=1
  node "$VALIDATOR" effective-hook-only "$BASELINE_EFFECTIVE" "$report_dir/tools-effective.json" \
    "$AGENT_ID" "$RETIRED_TOOL_NAME" || failed=1
  local restored
  restored="$(node "$STATUS_VALIDATOR" installed-payload "$INSTALLED_PLUGIN_DIR" "$PEER_LINK_TEXT" "$PEER_REAL_PATH" 2>/dev/null)" || failed=1
  if [[ "$failed" -eq 0 ]]; then
    restored_fingerprint="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.fingerprint)' "$restored")"
    [[ "$restored_fingerprint" == \
      "$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.previousPayloadSha256)' "$backup_dir/metadata.json")" ]] || failed=1
  fi
  if [[ "$failed" -eq 0 ]]; then
    source_marker_fingerprint="$(node "$VALIDATOR" payload-fingerprint "$backup_dir/previous-plugin" 2>/dev/null)" || failed=1
    marker_fingerprint="$(node "$VALIDATOR" payload-fingerprint "$INSTALLED_PLUGIN_DIR" 2>/dev/null)" || failed=1
    [[ "$source_marker_fingerprint" == "$marker_fingerprint" ]] || failed=1
  fi
  if [[ "$failed" -eq 0 ]]; then
    marker_temp="$(mktemp "$backup_dir/.active-rollback-source.json.tmp.XXXXXX")" || failed=1
  fi
  if [[ "$failed" -eq 0 ]]; then
    node "$VALIDATOR" marker-create "$PLUGIN_ID" "$PREVIOUS_VERSION" \
      "$backup_dir/previous-plugin" "$marker_fingerprint" > "$marker_temp" || failed=1
  fi
  if [[ "$failed" -eq 0 ]]; then
    install -m 600 "$marker_temp" "$backup_dir/.active-rollback-source.json" || failed=1
  fi
  [[ -z "${marker_temp:-}" ]] || rm -f -- "$marker_temp" || failed=1
  if [[ "$failed" -eq 0 ]]; then
    write_index_record "$report_dir/index.json" || failed=1
    node "$VALIDATOR" index-preflight "$report_dir/index.json" "$PREVIOUS_VERSION" \
      "$PLUGIN_DIR" "$BACKUP_ROOT" "$INSTALLED_PLUGIN_DIR" "$PLUGIN_ID" \
      > "$report_dir/source-kind.txt" 2>&1 || failed=1
  fi
  if [[ "$failed" -eq 0 ]]; then
    rm -f -- "$backup_dir/.verified" || failed=1
  fi
  if [[ "$failed" -eq 0 && -e "$backup_dir/.verified" ]]; then
    failed=1
  fi
  if [[ "$failed" -eq 0 ]]; then
    retire_previous_active_marker || failed=1
  fi
  set -e
  return "$failed"
}

recover_candidate_after_failed_explicit_rollback() {
  local backup_dir="$1"
  local candidate_config="$2"
  local report_dir="$3"
  local failed=0
  set +e
  install -d -m 700 "$report_dir"
  run_qwen_openclaw plugins install --force "$PLUGIN_DIR" > "$report_dir/install-candidate.txt" 2>&1 || failed=1
  install -m 600 "$candidate_config" "$PROFILE_CONFIG" || failed=1
  cmp -s "$candidate_config" "$PROFILE_CONFIG" || failed=1
  node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" candidate "$PLUGIN_ID" "$AGENT_ID" \
    > "$report_dir/classifier-config.json" 2>&1 || failed=1
  assert_source_unchanged > "$report_dir/source-validation.txt" 2>&1 || failed=1
  validate_installed_candidate "$report_dir/installed" > "$report_dir/installed-validation.txt" 2>&1 || failed=1
  validate_live_candidate "$report_dir/live" > "$report_dir/live-validation.txt" 2>&1 || failed=1
  [[ "$(service_snapshot)" == "$protected_before" ]] || failed=1
  if [[ "$failed" -eq 0 ]]; then
    rm -f -- "$backup_dir/.active-rollback-source.json" || failed=1
    install -m 600 /dev/null "$backup_dir/.verified" || failed=1
    node "$STATUS_VALIDATOR" backup "$BACKUP_ROOT" "$backup_dir" "$TARGET_SHA" \
      "$CANDIDATE_VERSION" "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" \
      > "$report_dir/reverified-backup.json" 2>&1 || failed=1
  fi
  if [[ "$failed" -ne 0 ]]; then
    rm -f -- "$backup_dir/.verified" || true
  fi
  set -e
  return "$failed"
}

finish() {
  local status=$?
  trap - EXIT HUP INT TERM
  release_lock || status=70
  cleanup_work_root || status=70
  exit "$status"
}

trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

validate_host_and_source
SOURCE_FINGERPRINT="$(node "$VALIDATOR" payload-fingerprint "$PLUGIN_DIR")"
protected_before="$(service_snapshot)"
preflight="$work_root/preflight"
if [[ "$MODE" == "rollback" ]]; then
  validate_current_candidate "$preflight"
  config_before="$(node "$STATUS_VALIDATOR" config-fingerprint "$PROFILE_CONFIG")"
else
  validate_current_hook "$preflight" "$PREVIOUS_VERSION"
  node "$STATUS_VALIDATOR" classifier-config "$PROFILE_CONFIG" baseline "$PLUGIN_ID" "$AGENT_ID" \
    > "$preflight/classifier-config.json"
  config_before="$(node "$STATUS_VALIDATOR" config-fingerprint "$PROFILE_CONFIG")"
  installed_before="$(node "$STATUS_VALIDATOR" installed-payload "$INSTALLED_PLUGIN_DIR" "$PEER_LINK_TEXT" "$PEER_REAL_PATH")"
  index_before="$(shasum -a 256 "$preflight/index.json" | awk '{print $1}')"
  run_isolated_upgrade
  [[ "$(node "$STATUS_VALIDATOR" config-fingerprint "$PROFILE_CONFIG")" == "$config_before" ]] || {
    printf 'Dry-run changed qwen-current config.\n' >&2; exit 1;
  }
  [[ "$(node "$STATUS_VALIDATOR" installed-payload "$INSTALLED_PLUGIN_DIR" "$PEER_LINK_TEXT" "$PEER_REAL_PATH")" == "$installed_before" ]] || {
    printf 'Dry-run changed the installed plugin.\n' >&2; exit 1;
  }
  write_index_record "$work_root/index-after-dry-run.json"
  [[ "$(shasum -a 256 "$work_root/index-after-dry-run.json" | awk '{print $1}')" == "$index_before" ]] || {
    printf 'Dry-run changed the qwen-current install index.\n' >&2; exit 1;
  }
  [[ "$(service_snapshot)" == "$protected_before" ]] || { printf 'Dry-run changed a protected listener.\n' >&2; exit 1; }

  if [[ "$MODE" == "dry-run" ]]; then
    printf 'Dry run passed the controlled %s to %s hook-owned classifier transition at %s.\n' \
      "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA"
    printf 'No production profile, plugin, listener, Mission Control, n8n, or task state was changed.\n'
    printf 'The candidate release gate remains closed until the final release activation verifies task-flow schema v2 and the lane supervisor.\n'
    exit 0
  fi
fi

umask 077
if [[ -e "$BACKUP_ROOT" ]]; then
  [[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" && "$(stat -f '%Lp' "$BACKUP_ROOT")" == "700" ]] || {
    printf 'Backup root must be a real mode-0700 directory.\n' >&2; exit 1;
  }
else
  install -d -m 700 "$BACKUP_ROOT"
fi
node "$VALIDATOR" backup-retention-baseline "$BACKUP_ROOT" 2 > "$work_root/retention-baseline.json"
mkdir "$INSTALL_LOCK_DIR" || { printf 'Another qwen-current plugin operation holds the lock.\n' >&2; exit 1; }
LOCK_ACQUIRED=1

assert_source_unchanged
[[ "$(service_snapshot)" == "$protected_before" ]] || { printf 'Protected listener changed before mutation.\n' >&2; exit 1; }
if [[ "$MODE" == "rollback" ]]; then
  validate_current_candidate "$work_root/locked-preflight"
else
  validate_current_hook "$work_root/locked-preflight" "$PREVIOUS_VERSION"
fi
current_index="$work_root/locked-preflight/index.json"

if [[ "$MODE" == "rollback" ]]; then
  node "$STATUS_VALIDATOR" backup "$BACKUP_ROOT" "$ROLLBACK_BACKUP" "$TARGET_SHA" \
    "$CANDIDATE_VERSION" "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" > "$work_root/rollback-backup.json"
  candidate_config="$work_root/candidate-openclaw.json"
  install -m 600 "$PROFILE_CONFIG" "$candidate_config"
  if ! restore_previous "$ROLLBACK_BACKUP" "$work_root/rollback"; then
    if recover_candidate_after_failed_explicit_rollback \
      "$ROLLBACK_BACKUP" "$candidate_config" "$work_root/recover-candidate"; then
      printf 'Rollback failed; the audited %s candidate/config/runtime/live state was fully restored.\n' \
        "$CANDIDATE_VERSION" >&2
      exit 1
    fi
    printf 'ROLLBACK AND CANDIDATE RECOVERY FAILED: qwen-current requires manual inspection.\n' >&2
    exit 70
  fi
  [[ "$(service_snapshot)" == "$protected_before" ]] || { printf 'A protected listener changed during rollback.\n' >&2; exit 70; }
  printf 'Rolled back %s from %s to exact %s payload and qwen-current config.\n' \
    "$PLUGIN_ID" "$CANDIDATE_VERSION" "$PREVIOUS_VERSION"
  printf 'Only qwen-current was refreshed; Mission Control 3017 and n8n were untouched.\n'
  exit 0
fi

create_verified_backup
if ! install_and_validate_candidate; then
  if restore_previous "$BACKUP_DIR" "$BACKUP_DIR/automatic-rollback" \
    && [[ "$(service_snapshot)" == "$protected_before" ]]; then
    printf 'Upgrade failed; exact %s payload and qwen-current config were restored.\n' "$PREVIOUS_VERSION" >&2
    printf 'Verified recovery point: %s\n' "$BACKUP_DIR" >&2
    exit 1
  fi
  printf 'ROLLBACK FAILED: qwen-current requires manual inspection. Recovery point: %s\n' "$BACKUP_DIR" >&2
  exit 70
fi

if ! node "$VALIDATOR" backup-retention-enforce "$BACKUP_ROOT" "$BACKUP_DIR" "$current_index" 2 \
  > "$BACKUP_DIR/retention.json"; then
  printf 'Upgrade passed, but verified-backup retention failed; qwen-current requires manual inspection.\n' >&2
  exit 70
fi
chmod 600 "$BACKUP_DIR/retention.json"
if ! retire_previous_active_marker; then
  printf 'Upgrade passed, but the previous active rollback marker could not be retired safely.\n' >&2
  exit 70
fi

printf 'Upgraded %s from %s to %s at approved target %s.\n' \
  "$PLUGIN_ID" "$PREVIOUS_VERSION" "$CANDIDATE_VERSION" "$TARGET_SHA"
printf 'Verified full canonical/installed payload fingerprints and retained at most two verified backups.\n'
printf 'Runtime and live Gateway expose only before_dispatch; effective tools are unchanged.\n'
printf 'qwen-current config changed only by adding plugins.entries.%s.llm={allowAgentIdOverride:true} and plugins.entries.%s.config.releaseReady=false.\n' "$PLUGIN_ID" "$PLUGIN_ID"
printf 'The candidate release gate remains closed. The final orchestrator must install and verify task-flow schema v2 and the lane supervisor before it activates video dispatch.\n'
printf 'Only qwen-current was refreshed; Mission Control 3017 and n8n were untouched.\n'
printf 'Rollback: %s --rollback --target-sha %s --backup %s\n' "$0" "$TARGET_SHA" "$BACKUP_DIR"
