#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
TOOL_NAME="aiworker_analyze_video"
OLD_VERSION="0.2.0"
NEW_VERSION="0.3.0"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_SOURCE="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
ROLLBACK_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-release-rollback.mjs"
UPGRADE_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-command-upgrade.mjs"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
PROFILE_STATE_DB="$PROFILE_STATE_DIR/state/openclaw.sqlite"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
PLUGIN_BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
TASK_BACKUP_ROOT="$HOME/ai-worker/backups/aiworker-task-flow-skill"
RELEASE_TRANSACTION_ROOT="$HOME/ai-worker/backups/aiworker-video-release-rollback"
WORKSPACE_ROOT="${AIWORKER_QWEN_WORKSPACE:-$HOME/AI-worker-second-original-workspace}"
PLUGIN_LOCK_DIR="$PLUGIN_BACKUP_ROOT/.qwen-current-first-install.lock"
TASK_LOCK_DIR="$WORKSPACE_ROOT/.aiworker-task-flow-install.lock"

MODE=""
PLUGIN_BACKUP=""
TASK_FLOW_BACKUP=""
TARGET_SHA=""
PLUGIN_LOCK_OWNED=0
TASK_LOCK_OWNED=0
MUTATION_STARTED=0
TRANSACTION_COMPLETE=0
ROLLBACK_OF_ROLLBACK_SUCCEEDED=0
ACTIVE_MARKER_CREATED=0
VERIFIED_MARKER_REMOVED=0
TRANSACTION_DIR=""
DIRECT_SESSION_KEY=""
ALLOWED_SENDER_SHA256=""
SOURCE_PLUGIN_FINGERPRINT=""
OPENCLAW_PEER_LINK_TEXT=""
OPENCLAW_PEER_REAL_PATH=""
PROTECTED_PID_SNAPSHOT=""

run_clean_openclaw() {
  env -u OPENCLAW_PROFILE \
    -u OPENCLAW_STATE_DIR \
    -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME \
    -u OPENCLAW_INCLUDE_ROOTS \
    openclaw "$@"
}

run_qwen_openclaw() {
  run_clean_openclaw --profile "$PROFILE" "$@"
}

usage() {
  printf 'Usage: %s [--dry-run|--apply] --plugin-backup ABSOLUTE_PATH --task-flow-backup ABSOLUTE_PATH --target-sha 40_HEX_SHA\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run)
      [[ -z "$MODE" ]] || { printf 'Conflicting or duplicate rollback mode.\n' >&2; exit 2; }
      MODE="dry-run"; shift ;;
    --apply)
      [[ -z "$MODE" ]] || { printf 'Conflicting or duplicate rollback mode.\n' >&2; exit 2; }
      MODE="apply"; shift ;;
    --plugin-backup)
      [[ "$#" -ge 2 && -z "$PLUGIN_BACKUP" ]] || { usage >&2; exit 2; }
      PLUGIN_BACKUP="$2"; shift 2 ;;
    --task-flow-backup)
      [[ "$#" -ge 2 && -z "$TASK_FLOW_BACKUP" ]] || { usage >&2; exit 2; }
      TASK_FLOW_BACKUP="$2"; shift 2 ;;
    --target-sha)
      [[ "$#" -ge 2 && -z "$TARGET_SHA" ]] || { usage >&2; exit 2; }
      TARGET_SHA="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ -z "$MODE" || -z "$PLUGIN_BACKUP" || -z "$TASK_FLOW_BACKUP" || -z "$TARGET_SHA" ]]; then
  usage >&2
  exit 2
fi

for command_name in awk chmod cmp cp date env git hostname id install lsof mkdir mktemp node \
  openclaw rm rmdir shasum sqlite3 stat; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  fi
done

TEST_FAILPOINT="${AIWORKER_RELEASE_ROLLBACK_TEST_FAILPOINT:-}"
RECOVERY_TEST_FAILPOINT="${AIWORKER_RELEASE_ROLLBACK_TEST_RECOVERY_FAILPOINT:-}"
if [[ ( -n "$TEST_FAILPOINT" || -n "$RECOVERY_TEST_FAILPOINT" ) \
  && "${AIWORKER_RELEASE_ROLLBACK_TESTING:-0}" != "1" ]]; then
  printf 'Release rollback failure injection is test-only.\n' >&2
  exit 1
fi
case "$TEST_FAILPOINT" in
  ""|after-task-flow|after-plugin-install|after-live-restart) ;;
  *) printf 'Unknown release rollback test failpoint: %s\n' "$TEST_FAILPOINT" >&2; exit 1 ;;
esac
case "$RECOVERY_TEST_FAILPOINT" in
  ""|before-marker-transition|after-verified-before-active-delete|active-delete-failure) ;;
  *) printf 'Unknown release rollback recovery test failpoint: %s\n' "$RECOVERY_TEST_FAILPOINT" >&2; exit 1 ;;
esac

maybe_fail() {
  if [[ "$TEST_FAILPOINT" == "$1" ]]; then
    printf 'Injected release rollback failure at %s.\n' "$1" >&2
    return 97
  fi
}

fingerprint() {
  node "$ROLLBACK_VALIDATOR" fingerprint "$1"
}

plugin_full_fingerprint() {
  node "$UPGRADE_VALIDATOR" payload-fingerprint "$1"
}

write_index_record() {
  local output_path="$1"
  local record
  if [[ ! -f "$PROFILE_STATE_DB" || -L "$PROFILE_STATE_DB" ]]; then
    printf 'Plugin state database is missing or unsafe.\n' >&2
    return 1
  fi
  record="$(sqlite3 -readonly "$PROFILE_STATE_DB" \
    "SELECT COALESCE(json_extract(install_records_json, '$.\"$PLUGIN_ID\"'), '') FROM installed_plugin_index WHERE index_key = 'installed-plugin-index' ORDER BY generated_at_ms DESC LIMIT 1;")" \
    || return 1
  if [[ -z "$record" ]]; then
    printf 'Target plugin install-index record is absent.\n' >&2
    return 1
  fi
  printf '%s\n' "$record" > "$output_path"
  chmod 600 "$output_path"
}

protected_pids() {
  local mission_control_pid n8n_pids
  mission_control_pid="$(lsof -nP -iTCP:3017 -sTCP:LISTEN -t | LC_ALL=C sort -u | tr '\n' ',')" || return 1
  n8n_pids="$({ lsof -nP -iTCP:5678 -sTCP:LISTEN -t; lsof -nP -iTCP:5679 -sTCP:LISTEN -t; } | LC_ALL=C sort -u | tr '\n' ',')" || return 1
  if [[ -z "$mission_control_pid" || -z "$n8n_pids" ]]; then
    printf 'Protected Mission Control or n8n listener is missing.\n' >&2
    return 1
  fi
  printf '3017=%s\n5678-5679=%s\n' "$mission_control_pid" "$n8n_pids"
}

qwen_protected_snapshot() {
  local report_dir="$1"
  local index_path="$report_dir/qwen-index-snapshot.json"
  local index_digest
  install -d -m 700 "$report_dir"
  write_index_record "$index_path"
  index_digest="$(shasum -a 256 "$index_path" | awk '{print $1}')"
  printf '%s\n%s\n%s\n' \
    "$(fingerprint "$PROFILE_CONFIG")" \
    "$(plugin_full_fingerprint "$INSTALLED_PLUGIN_DIR")" \
    "$index_digest"
}

validate_repository_and_host() {
  local actual_host actual_user live_remote_sha openclaw_version origin_main_sha remote_url
  node "$ROLLBACK_VALIDATOR" approved-sha "$TARGET_SHA" >/dev/null
  actual_user="$(id -un)"
  actual_host="$(hostname)"
  if [[ "$actual_user" != "$EXPECTED_USER" || "$actual_host" != "$EXPECTED_HOST" ]]; then
    printf 'Refusing non-production identity: user=%s host=%s\n' "$actual_user" "$actual_host" >&2
    return 1
  fi
  openclaw_version="$(run_clean_openclaw --version)"
  case "$openclaw_version" in
    "OpenClaw $OPENCLAW_VERSION ("*")") ;;
    *) printf 'Unsupported OpenClaw version: %s\n' "$openclaw_version" >&2; return 1 ;;
  esac
  remote_url="$(git -C "$REPOSITORY_ROOT" remote get-url origin)"
  case "$remote_url" in
    https://github.com/MAKingljx/video-autoworker|https://github.com/MAKingljx/video-autoworker.git|git@github.com:MAKingljx/video-autoworker.git) ;;
    *) printf 'Canonical Git remote mismatch.\n' >&2; return 1 ;;
  esac
  if [[ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=normal)" ]]; then
    printf 'Canonical Git checkout must be clean.\n' >&2
    return 1
  fi
  if [[ "$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)" != "$TARGET_SHA" ]]; then
    printf 'Canonical checkout is not the explicitly approved release SHA.\n' >&2
    return 1
  fi
  origin_main_sha="$(git -C "$REPOSITORY_ROOT" rev-parse refs/remotes/origin/main)"
  live_remote_sha="$(git -C "$REPOSITORY_ROOT" ls-remote --exit-code origin refs/heads/main | awk 'NF { print $1; exit }')"
  if [[ "$origin_main_sha" != "$TARGET_SHA" || "$live_remote_sha" != "$TARGET_SHA" ]]; then
    printf 'Approved SHA must equal HEAD, local origin/main, and live origin main.\n' >&2
    return 1
  fi
  for protected_root in "$PROFILE_STATE_DIR" "$WORKSPACE_ROOT"; do
    if [[ ! -d "$protected_root" || -L "$protected_root" \
      || "$(cd "$protected_root" && pwd -P)" != "$protected_root" ]]; then
      printf 'Protected production root is missing, non-canonical, or symlinked: %s\n' "$protected_root" >&2
      return 1
    fi
  done
  for source_path in "$PLUGIN_SOURCE" "$ROLLBACK_VALIDATOR" "$UPGRADE_VALIDATOR"; do
    if [[ ! -e "$source_path" || -L "$source_path" ]]; then
      printf 'Release rollback source is incomplete or unsafe.\n' >&2
      return 1
    fi
  done
  node --check "$ROLLBACK_VALIDATOR"
}

prepare_transaction_root() {
  if [[ -L "$RELEASE_TRANSACTION_ROOT" \
    || ( -e "$RELEASE_TRANSACTION_ROOT" && ! -d "$RELEASE_TRANSACTION_ROOT" ) ]]; then
    printf 'Release rollback transaction root is unsafe.\n' >&2
    return 1
  fi
  if [[ ! -e "$RELEASE_TRANSACTION_ROOT" ]]; then
    install -d -m 700 "$RELEASE_TRANSACTION_ROOT"
  fi
  if [[ "$(stat -f '%Lp' "$RELEASE_TRANSACTION_ROOT")" != "700" \
    || "$(cd "$RELEASE_TRANSACTION_ROOT" && pwd -P)" != "$RELEASE_TRANSACTION_ROOT" ]]; then
    printf 'Release rollback transaction root must be a canonical mode-0700 directory.\n' >&2
    return 1
  fi
}

validate_explicit_backups() {
  local report_dir="$1"
  node "$ROLLBACK_VALIDATOR" plugin-backup \
    "$PLUGIN_BACKUP_ROOT" "$PLUGIN_BACKUP" "$TARGET_SHA" "$INSTALLED_PLUGIN_DIR" \
    "$REPOSITORY_ROOT" "$PLUGIN_SOURCE" \
    > "$report_dir/plugin-backup.json"
  node "$ROLLBACK_VALIDATOR" task-backup \
    "$TASK_BACKUP_ROOT" "$TASK_FLOW_BACKUP" \
    > "$report_dir/task-flow-backup.json"
  node "$UPGRADE_VALIDATOR" config-known-v02 \
    "$PLUGIN_BACKUP/pre-0.2-openclaw.json" \
    "$PLUGIN_BACKUP/openclaw-current.json" \
    "$PLUGIN_BACKUP/pre-0.2-effective-tools.json" \
    "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME"
}

validate_current_v03_files() {
  local report_dir="$1"
  if [[ ! -f "$PROFILE_CONFIG" || -L "$PROFILE_CONFIG" \
    || ! -d "$INSTALLED_PLUGIN_DIR" || -L "$INSTALLED_PLUGIN_DIR" ]]; then
    printf 'Current qwen-current 0.3 state is missing or unsafe.\n' >&2
    return 1
  fi
  node - "$INSTALLED_PLUGIN_DIR/package.json" "$INSTALLED_PLUGIN_DIR/openclaw.plugin.json" <<'NODE'
const { readFileSync } = require('node:fs')
const [packagePath, manifestPath] = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (packageJson.version !== '0.3.0') throw new Error('installed plugin must be 0.3.0')
if (manifest.id !== 'aiworker-video-command') throw new Error('installed plugin id mismatch')
if (JSON.stringify(manifest?.activation?.onCapabilities) !== JSON.stringify(['hook'])) {
  throw new Error('installed 0.3.0 capability declaration mismatch')
}
NODE
  SOURCE_PLUGIN_FINGERPRINT="$(awk 'NF { print; exit }' "$PLUGIN_BACKUP/source-plugin-payload-sha256.txt")"
  if [[ ! "$SOURCE_PLUGIN_FINGERPRINT" =~ ^[a-f0-9]{64}$ \
    || "$(node "$UPGRADE_VALIDATOR" payload-fingerprint "$PLUGIN_SOURCE")" != "$SOURCE_PLUGIN_FINGERPRINT" ]]; then
    printf 'Approved 0.3 source payload fingerprint mismatch.\n' >&2
    return 1
  fi
  local peer_report
  peer_report="$(node "$UPGRADE_VALIDATOR" peer-link "$INSTALLED_PLUGIN_DIR")"
  OPENCLAW_PEER_LINK_TEXT="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.linkText)' "$peer_report")"
  OPENCLAW_PEER_REAL_PATH="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.realPath)' "$peer_report")"
  node "$UPGRADE_VALIDATOR" payload-match \
    "$PLUGIN_SOURCE" "$INSTALLED_PLUGIN_DIR" "$SOURCE_PLUGIN_FINGERPRINT" \
    "$OPENCLAW_PEER_LINK_TEXT" "$OPENCLAW_PEER_REAL_PATH" \
    > "$report_dir/installed-payload-v03.json"
  write_index_record "$report_dir/current-index.json"
  node "$UPGRADE_VALIDATOR" index "$report_dir/current-index.json" \
    "$NEW_VERSION" "$PLUGIN_SOURCE" "$INSTALLED_PLUGIN_DIR"
  ALLOWED_SENDER_SHA256="$(node "$UPGRADE_VALIDATOR" owner-sender-plan "$PROFILE_CONFIG" \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).allowedSenderSha256))')"
  node "$UPGRADE_VALIDATOR" sender-hash-config \
    "$PROFILE_CONFIG" "$PLUGIN_ID" "$ALLOWED_SENDER_SHA256"
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report_dir/runtime-v03.json"
  node "$UPGRADE_VALIDATOR" runtime-v03 "$report_dir/runtime-v03.json" \
    "$PLUGIN_ID" "$NEW_VERSION" "$TOOL_NAME"
}

capture_and_validate_live() {
  local report_dir="$1"
  local live_mode="$2"
  local effective_mode="$3"
  local sessions_report="$report_dir/sessions.json"
  install -d -m 700 "$report_dir"
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$report_dir/gateway-status.json"
  if [[ -z "$DIRECT_SESSION_KEY" ]]; then
    run_qwen_openclaw gateway call sessions.list \
      --params "$(node -e 'process.stdout.write(JSON.stringify({agentId: process.argv[1], search: "telegram:direct:", configuredAgentsOnly: true, includeGlobal: false, limit: 200}))' "$AGENT_ID")" \
      --timeout 20000 --json > "$sessions_report"
    DIRECT_SESSION_KEY="$(node "$UPGRADE_VALIDATOR" session-select "$sessions_report" "$AGENT_ID")"
  fi
  run_qwen_openclaw gateway call tools.catalog \
    --params '{"agentId":"second-original","includePlugins":true}' \
    --timeout 20000 --json > "$report_dir/tools-catalog.json"
  node "$UPGRADE_VALIDATOR" "$live_mode" "$report_dir/tools-catalog.json" \
    "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME"
  run_qwen_openclaw gateway call tools.effective \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId: process.argv[1], sessionKey: process.argv[2]}))' "$AGENT_ID" "$DIRECT_SESSION_KEY")" \
    --timeout 20000 --json > "$report_dir/tools-effective.json"
  node "$UPGRADE_VALIDATOR" "$effective_mode" \
    "$PLUGIN_BACKUP/pre-0.2-effective-tools.json" "$report_dir/tools-effective.json" \
    "$AGENT_ID" "$TOOL_NAME"
}

preflight() {
  local report_dir="$1"
  install -d -m 700 "$report_dir"
  validate_repository_and_host
  validate_explicit_backups "$report_dir"
  validate_current_v03_files "$report_dir"
  capture_and_validate_live "$report_dir/live-v03" live-v03 effective-v03
  PROTECTED_PID_SNAPSHOT="$(protected_pids)"
}

release_locks() {
  local failed=0
  if [[ "$TASK_LOCK_OWNED" == "1" ]]; then
    rm -f -- "$TASK_LOCK_DIR/pid" || failed=1
    rmdir "$TASK_LOCK_DIR" || failed=1
    TASK_LOCK_OWNED=0
  fi
  if [[ "$PLUGIN_LOCK_OWNED" == "1" ]]; then
    rmdir "$PLUGIN_LOCK_DIR" || failed=1
    PLUGIN_LOCK_OWNED=0
  fi
  [[ "$failed" == "0" ]]
}

acquire_locks() {
  if ! mkdir "$PLUGIN_LOCK_DIR"; then
    printf 'Another qwen-current plugin operation holds the profile lock.\n' >&2
    return 1
  fi
  chmod 700 "$PLUGIN_LOCK_DIR"
  PLUGIN_LOCK_OWNED=1
  if ! mkdir "$TASK_LOCK_DIR"; then
    printf 'Another task-flow operation holds the workspace lock.\n' >&2
    release_locks || true
    return 1
  fi
  chmod 700 "$TASK_LOCK_DIR"
  printf '%s\n' "$$" > "$TASK_LOCK_DIR/pid"
  chmod 600 "$TASK_LOCK_DIR/pid"
  TASK_LOCK_OWNED=1
}

snapshot_current_v03() {
  prepare_transaction_root
  TRANSACTION_DIR="$(mktemp -d "$RELEASE_TRANSACTION_ROOT/rollback-$(date +%Y%m%d-%H%M%S).XXXXXX")"
  chmod 700 "$TRANSACTION_DIR"
  install -d -m 700 "$TRANSACTION_DIR/current-plugin" "$TRANSACTION_DIR/reports"
  rm -rf -- "$TRANSACTION_DIR/current-plugin"
  cp -R -p "$INSTALLED_PLUGIN_DIR" "$TRANSACTION_DIR/current-plugin"
  install -m 600 "$PROFILE_CONFIG" "$TRANSACTION_DIR/openclaw-v03.json"
  write_index_record "$TRANSACTION_DIR/index-v03.json"
  node "$ROLLBACK_VALIDATOR" task-snapshot \
    "$WORKSPACE_ROOT" "$TRANSACTION_DIR/task-current" \
    > "$TRANSACTION_DIR/reports/task-snapshot.json"
  if [[ "$(plugin_full_fingerprint "$TRANSACTION_DIR/current-plugin")" != "$(plugin_full_fingerprint "$INSTALLED_PLUGIN_DIR")" ]] \
    || ! cmp -s "$TRANSACTION_DIR/openclaw-v03.json" "$PROFILE_CONFIG"; then
    printf 'Current 0.3 transaction snapshot verification failed.\n' >&2
    return 1
  fi
  node "$UPGRADE_VALIDATOR" index "$TRANSACTION_DIR/index-v03.json" \
    "$NEW_VERSION" "$PLUGIN_SOURCE" "$INSTALLED_PLUGIN_DIR"
  printf 'schema_version=1\ntarget_sha=%s\nplugin_backup=%s\ntask_flow_backup=%s\n' \
    "$TARGET_SHA" "$PLUGIN_BACKUP" "$TASK_FLOW_BACKUP" > "$TRANSACTION_DIR/TRANSACTION"
  chmod 600 "$TRANSACTION_DIR/TRANSACTION"
  install -m 600 /dev/null "$TRANSACTION_DIR/.snapshot-verified"
}

write_active_marker() {
  local fingerprint_value marker_temp marker_path
  fingerprint_value="$(plugin_full_fingerprint "$PLUGIN_BACKUP/previous-plugin")"
  marker_path="$PLUGIN_BACKUP/.active-rollback-source.json"
  marker_temp="$(mktemp "$TRANSACTION_DIR/active-marker.XXXXXX")"
  node "$UPGRADE_VALIDATOR" marker-create \
    "$PLUGIN_ID" "$OLD_VERSION" "$PLUGIN_BACKUP/previous-plugin" "$fingerprint_value" \
    > "$marker_temp"
  install -m 600 "$marker_temp" "$marker_path"
  rm -f -- "$marker_temp"
  ACTIVE_MARKER_CREATED=1
}

activate_plugin_rollback_source() {
  local marker_mode
  marker_mode="$(stat -f '%Lp' "$PLUGIN_BACKUP/.active-rollback-source.json")"
  if [[ "$marker_mode" != "600" || ! -f "$PLUGIN_BACKUP/.verified" \
    || -L "$PLUGIN_BACKUP/.verified" ]]; then
    printf 'Active rollback source transition preconditions failed.\n' >&2
    return 1
  fi
  rm -f -- "$PLUGIN_BACKUP/.verified"
  VERIFIED_MARKER_REMOVED=1
  if [[ -e "$PLUGIN_BACKUP/.verified" || -L "$PLUGIN_BACKUP/.verified" ]]; then
    printf 'Verified marker remained after active-source transition.\n' >&2
    return 1
  fi
}

active_marker_matches_saved() {
  local active_marker="$1"
  local saved_marker="$2"
  [[ -f "$active_marker" && ! -L "$active_marker" \
    && "$(stat -f '%Lp' "$active_marker" 2>/dev/null)" == "600" ]] \
    && cmp -s "$saved_marker" "$active_marker"
}

compensate_recovery_marker_transition() {
  local saved_marker="$1"
  local verified_created="$2"
  local report_path="$3"
  local active_marker="$PLUGIN_BACKUP/.active-rollback-source.json"
  local compensation_failed=0

  if ! active_marker_matches_saved "$active_marker" "$saved_marker"; then
    if [[ -d "$active_marker" && ! -L "$active_marker" ]]; then
      printf 'active marker compensation found an unsafe directory\n' >> "$report_path"
      compensation_failed=1
    else
      rm -f -- "$active_marker" \
        || { printf 'active marker compensation cleanup failed\n' >> "$report_path"; compensation_failed=1; }
      if [[ "$compensation_failed" == "0" ]]; then
        install -m 600 "$saved_marker" "$active_marker" \
          || { printf 'active marker compensation restore failed\n' >> "$report_path"; compensation_failed=1; }
      fi
    fi
  fi
  if ! active_marker_matches_saved "$active_marker" "$saved_marker"; then
    printf 'active marker compensation verification failed\n' >> "$report_path"
    compensation_failed=1
  fi

  if [[ "$verified_created" == "1" ]]; then
    if [[ -e "$PLUGIN_BACKUP/.verified" || -L "$PLUGIN_BACKUP/.verified" ]]; then
      if [[ ! -f "$PLUGIN_BACKUP/.verified" || -L "$PLUGIN_BACKUP/.verified" \
        || "$(stat -f '%Lp' "$PLUGIN_BACKUP/.verified" 2>/dev/null)" != "600" \
        || "$(stat -f '%z' "$PLUGIN_BACKUP/.verified" 2>/dev/null)" != "0" ]]; then
        printf 'refusing to delete a changed recovery verified marker\n' >> "$report_path"
        compensation_failed=1
      else
        rm -f -- "$PLUGIN_BACKUP/.verified" \
          || { printf 'recovery verified marker compensation cleanup failed\n' >> "$report_path"; compensation_failed=1; }
      fi
    fi
    if [[ -e "$PLUGIN_BACKUP/.verified" || -L "$PLUGIN_BACKUP/.verified" ]]; then
      printf 'recovery verified marker remained after compensation\n' >> "$report_path"
      compensation_failed=1
    fi
  fi

  [[ "$compensation_failed" == "0" ]]
}

finalize_recovery_marker_transition() {
  local report_path="$1"
  local active_marker="$PLUGIN_BACKUP/.active-rollback-source.json"
  local saved_marker="$TRANSACTION_DIR/active-marker-before-v03-transition.json"
  local verified_created=0
  local delete_status=0

  if [[ "$ACTIVE_MARKER_CREATED" != "1" || ! -f "$active_marker" || -L "$active_marker" \
    || "$(stat -f '%Lp' "$active_marker" 2>/dev/null)" != "600" ]]; then
    printf 'active marker transition precondition failed\n' >> "$report_path"
    return 1
  fi
  install -m 600 "$active_marker" "$saved_marker" || return 1
  if ! cmp -s "$saved_marker" "$active_marker"; then
    printf 'active marker transaction snapshot mismatch\n' >> "$report_path"
    return 1
  fi

  if [[ "$VERIFIED_MARKER_REMOVED" == "1" ]]; then
    if [[ -e "$PLUGIN_BACKUP/.verified" || -L "$PLUGIN_BACKUP/.verified" ]]; then
      printf 'verified marker unexpectedly exists before recovery transition\n' >> "$report_path"
      return 1
    fi
    if ! install -m 600 /dev/null "$PLUGIN_BACKUP/.verified"; then
      printf 'verified marker restoration failed\n' >> "$report_path"
      return 1
    fi
    verified_created=1
  fi
  if [[ ! -f "$PLUGIN_BACKUP/.verified" || -L "$PLUGIN_BACKUP/.verified" \
    || "$(stat -f '%Lp' "$PLUGIN_BACKUP/.verified" 2>/dev/null)" != "600" \
    || "$(stat -f '%z' "$PLUGIN_BACKUP/.verified" 2>/dev/null)" != "0" ]]; then
    printf 'verified marker post-restore validation failed\n' >> "$report_path"
    compensate_recovery_marker_transition "$saved_marker" "$verified_created" "$report_path" || true
    return 1
  fi
  if [[ "$RECOVERY_TEST_FAILPOINT" == "after-verified-before-active-delete" ]]; then
    printf 'injected failure after verified creation and before active deletion\n' >> "$report_path"
    compensate_recovery_marker_transition "$saved_marker" "$verified_created" "$report_path" || true
    return 1
  fi

  if [[ "$RECOVERY_TEST_FAILPOINT" == "active-delete-failure" ]]; then
    printf 'injected active marker delete failure\n' >> "$report_path"
    delete_status=97
  else
    rm -f -- "$active_marker" || delete_status=$?
  fi
  if [[ "$delete_status" != "0" \
    || -e "$active_marker" || -L "$active_marker" ]]; then
    printf 'active marker deletion or post-check failed; compensating\n' >> "$report_path"
    compensate_recovery_marker_transition "$saved_marker" "$verified_created" "$report_path" || true
    return 1
  fi

  ACTIVE_MARKER_CREATED=0
  VERIFIED_MARKER_REMOVED=0
}

restore_release_v02() {
  local report_dir="$TRANSACTION_DIR/reports/restore-v02"
  install -d -m 700 "$report_dir"
  node "$ROLLBACK_VALIDATOR" task-restore \
    "$WORKSPACE_ROOT" "$TASK_FLOW_BACKUP" "$WORKSPACE_ROOT/.aiworker-release-rollback.stage" \
    > "$report_dir/task-restore.txt"
  maybe_fail after-task-flow

  run_qwen_openclaw plugins install --force "$PLUGIN_BACKUP/previous-plugin" \
    > "$report_dir/install-v02.txt"
  install -m 600 "$PLUGIN_BACKUP/openclaw-current.json" "$PROFILE_CONFIG"
  if [[ "$(plugin_full_fingerprint "$PLUGIN_BACKUP/previous-plugin")" != "$(plugin_full_fingerprint "$INSTALLED_PLUGIN_DIR")" ]]; then
    printf 'Installed rollback plugin does not match the explicit 0.2 backup.\n' >&2
    return 1
  fi
  node "$UPGRADE_VALIDATOR" config-known-v02 \
    "$PLUGIN_BACKUP/pre-0.2-openclaw.json" "$PROFILE_CONFIG" \
    "$PLUGIN_BACKUP/pre-0.2-effective-tools.json" "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME"
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report_dir/runtime-v02.json"
  node "$UPGRADE_VALIDATOR" runtime-v02 "$report_dir/runtime-v02.json" \
    "$PLUGIN_ID" "$OLD_VERSION" "$TOOL_NAME"
  write_index_record "$report_dir/index-v02.json"
  node "$UPGRADE_VALIDATOR" index "$report_dir/index-v02.json" \
    "$OLD_VERSION" "$PLUGIN_BACKUP/previous-plugin" "$INSTALLED_PLUGIN_DIR"
  node "$ROLLBACK_VALIDATOR" index-equivalent \
    "$PLUGIN_BACKUP/install-index-old.json" "$report_dir/index-v02.json" \
    "$PLUGIN_BACKUP/previous-plugin" "$INSTALLED_PLUGIN_DIR" \
    > "$report_dir/index-restoration.json"
  write_active_marker
  node "$UPGRADE_VALIDATOR" index-preflight \
    "$report_dir/index-v02.json" "$OLD_VERSION" "$PLUGIN_SOURCE" \
    "$PLUGIN_BACKUP_ROOT" "$INSTALLED_PLUGIN_DIR" "$PLUGIN_ID" \
    > "$report_dir/active-source-kind.txt"
  activate_plugin_rollback_source
  maybe_fail after-plugin-install

  run_qwen_openclaw gateway restart --wait 60s --json > "$report_dir/gateway-restart.json"
  capture_and_validate_live "$report_dir/live-v02" live-v02 effective-v02
  maybe_fail after-live-restart
  node "$ROLLBACK_VALIDATOR" task-compare "$WORKSPACE_ROOT" "$TASK_FLOW_BACKUP" \
    > "$report_dir/task-final.txt"
  cmp -s "$PLUGIN_BACKUP/openclaw-current.json" "$PROFILE_CONFIG"
  if [[ "$(protected_pids)" != "$PROTECTED_PID_SNAPSHOT" ]]; then
    printf 'Protected Mission Control or n8n listener PID changed during release rollback.\n' >&2
    return 1
  fi
}

restore_current_v03() {
  local failed=0
  local report_dir="$TRANSACTION_DIR/reports/rollback-of-rollback-v03"
  set +e
  install -d -m 700 "$report_dir" || failed=1
  : > "$report_dir/validation.txt"
  node "$ROLLBACK_VALIDATOR" task-restore \
    "$WORKSPACE_ROOT" "$TRANSACTION_DIR/task-current" "$WORKSPACE_ROOT/.aiworker-release-forward-restore.stage" \
    > "$report_dir/task-restore.txt" 2>&1 || { printf 'task restore failed\n' >> "$report_dir/validation.txt"; failed=1; }
  run_qwen_openclaw plugins install --force "$PLUGIN_SOURCE" \
    > "$report_dir/install-v03.txt" 2>&1 || { printf 'plugin install failed\n' >> "$report_dir/validation.txt"; failed=1; }
  install -m 600 "$TRANSACTION_DIR/openclaw-v03.json" "$PROFILE_CONFIG" \
    || { printf 'config restore failed\n' >> "$report_dir/validation.txt"; failed=1; }
  node "$UPGRADE_VALIDATOR" payload-match \
    "$PLUGIN_SOURCE" "$INSTALLED_PLUGIN_DIR" "$SOURCE_PLUGIN_FINGERPRINT" \
    "$OPENCLAW_PEER_LINK_TEXT" "$OPENCLAW_PEER_REAL_PATH" \
    >> "$report_dir/validation.txt" 2>&1 \
    || { printf 'plugin payload restoration mismatch\n' >> "$report_dir/validation.txt"; failed=1; }
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json \
    > "$report_dir/runtime-v03.json" 2>&1 || { printf 'runtime inspection failed\n' >> "$report_dir/validation.txt"; failed=1; }
  node "$UPGRADE_VALIDATOR" runtime-v03 "$report_dir/runtime-v03.json" \
    "$PLUGIN_ID" "$NEW_VERSION" "$TOOL_NAME" >> "$report_dir/validation.txt" 2>&1 || failed=1
  write_index_record "$report_dir/index-v03.json" || { printf 'index read failed\n' >> "$report_dir/validation.txt"; failed=1; }
  node "$UPGRADE_VALIDATOR" index "$report_dir/index-v03.json" \
    "$NEW_VERSION" "$PLUGIN_SOURCE" "$INSTALLED_PLUGIN_DIR" >> "$report_dir/validation.txt" 2>&1 || failed=1
  run_qwen_openclaw gateway restart --wait 60s --json \
    > "$report_dir/gateway-restart.json" 2>&1 || { printf 'gateway restart failed\n' >> "$report_dir/validation.txt"; failed=1; }
  capture_and_validate_live "$report_dir/live-v03" live-v03 effective-v03 \
    >> "$report_dir/validation.txt" 2>&1 || failed=1
  node "$ROLLBACK_VALIDATOR" task-compare "$WORKSPACE_ROOT" "$TRANSACTION_DIR/task-current" \
    >> "$report_dir/validation.txt" 2>&1 || failed=1
  cmp -s "$TRANSACTION_DIR/openclaw-v03.json" "$PROFILE_CONFIG" \
    || { printf 'config byte comparison failed\n' >> "$report_dir/validation.txt"; failed=1; }
  if [[ "$(protected_pids 2>/dev/null)" != "$PROTECTED_PID_SNAPSHOT" ]]; then
    printf 'protected PID comparison failed\n' >> "$report_dir/validation.txt"
    failed=1
  fi
  if [[ "$RECOVERY_TEST_FAILPOINT" == "before-marker-transition" ]]; then
    printf 'injected recovery validation failure before marker transition\n' >> "$report_dir/validation.txt"
    failed=1
  fi
  if [[ "$failed" == "0" && "$ACTIVE_MARKER_CREATED" == "1" ]]; then
    finalize_recovery_marker_transition "$report_dir/validation.txt" || failed=1
  fi
  set -e
  [[ "$failed" == "0" ]]
}

cleanup_transaction() {
  if [[ -z "$TRANSACTION_DIR" || ! -e "$TRANSACTION_DIR" ]]; then return; fi
  case "$TRANSACTION_DIR" in
    "$RELEASE_TRANSACTION_ROOT"/rollback-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].*)
      rm -rf -- "$TRANSACTION_DIR"
      ;;
    *) printf 'Refusing to remove an unexpected release transaction path.\n' >&2; return 1 ;;
  esac
}

on_exit() {
  local status=$?
  local cleanup_status=0
  trap - EXIT HUP INT TERM
  if [[ "$status" -ne 0 && "$MUTATION_STARTED" == "1" && "$TRANSACTION_COMPLETE" != "1" ]]; then
    if restore_current_v03; then
      ROLLBACK_OF_ROLLBACK_SUCCEEDED=1
      printf 'Release rollback failed; the complete approved 0.3 state was restored.\n' >&2
    else
      status=70
      printf 'ROLLBACK OF ROLLBACK FAILED: mixed state may exist; no success may be reported.\n' >&2
      printf 'Transaction evidence retained: %s\n' "$TRANSACTION_DIR" >&2
    fi
  fi
  release_locks || cleanup_status=1
  if [[ "$status" == "0" || "$ROLLBACK_OF_ROLLBACK_SUCCEEDED" == "1" ]]; then
    cleanup_transaction || cleanup_status=1
  fi
  if [[ "$cleanup_status" != "0" && "$status" == "0" ]]; then status=70; fi
  exit "$status"
}

preflight_root="$(mktemp -d /tmp/aiworker-video-release-rollback-check.XXXXXX)"
chmod 700 "$preflight_root"
trap 'rm -rf -- "$preflight_root"' EXIT
preflight "$preflight_root"
qwen_before="$(qwen_protected_snapshot "$preflight_root/qwen-before")"
workspace_skill_before="$(fingerprint "$WORKSPACE_ROOT/skills/aiworker-task-flow")"
agents_before="$(fingerprint "$WORKSPACE_ROOT/AGENTS.md")"
memory_before="$(fingerprint "$WORKSPACE_ROOT/MEMORY.md")"
preflight "$preflight_root/recheck"
if [[ "$qwen_before" != "$(qwen_protected_snapshot "$preflight_root/qwen-after")" \
  || "$workspace_skill_before" != "$(fingerprint "$WORKSPACE_ROOT/skills/aiworker-task-flow")" \
  || "$agents_before" != "$(fingerprint "$WORKSPACE_ROOT/AGENTS.md")" \
  || "$memory_before" != "$(fingerprint "$WORKSPACE_ROOT/MEMORY.md")" ]]; then
  printf 'Release rollback dry-run changed protected state.\n' >&2
  exit 1
fi
if [[ "$MODE" == "dry-run" ]]; then
  rm -rf -- "$preflight_root"
  trap - EXIT
  printf 'Release rollback dry run passed for explicit plugin and task-flow backups at %s.\n' "$TARGET_SHA"
  printf 'No qwen-current, workspace, Mission Control, or n8n state was changed.\n'
  exit 0
fi

rm -rf -- "$preflight_root"
trap - EXIT
acquire_locks
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
locked_preflight="$(mktemp -d /tmp/aiworker-video-release-rollback-locked.XXXXXX)"
chmod 700 "$locked_preflight"
preflight "$locked_preflight"
rm -rf -- "$locked_preflight"
snapshot_current_v03
MUTATION_STARTED=1
restore_release_v02
TRANSACTION_COMPLETE=1
if ! release_locks; then
  printf 'Release rollback state is consistent, but a lock could not be released.\n' >&2
  exit 70
fi
cleanup_transaction
trap - EXIT HUP INT TERM

printf 'Restored the explicit 0.2 plugin/config and pre-0.3 task-flow workspace state.\n'
printf 'The install index now safely points to the verified 0.2 backup payload; the prior record was semantically validated, not byte-copied onto a 0.3 source path.\n'
printf 'Only qwen-current Gateway was restarted; Mission Control 3017 and n8n listener PIDs were unchanged.\n'
