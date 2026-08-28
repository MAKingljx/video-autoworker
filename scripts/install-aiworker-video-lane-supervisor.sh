#!/usr/bin/env bash
set -euo pipefail
umask 077

LABEL="ai.aiworker.video-lane-supervisor"
PROFILE="qwen-current"
AGENT_ID="second-original"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="${AIWORKER_EXPECTED_USER:-heisenbergs-1}"
EXPECTED_HOST="${AIWORKER_EXPECTED_HOST:-HEISENBERGS-1deMac-Studio.local}"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_SKILL="$REPOSITORY_ROOT/openclaw-skills/aiworker-task-flow"
TEMPLATE="$REPOSITORY_ROOT/ops/video-lane/launchd/$LABEL.plist.template"
VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-lane-supervisor.mjs"
WORKSPACE_ROOT="${AIWORKER_QWEN_WORKSPACE:-$HOME/AI-worker-second-original-workspace}"
INSTALLED_SKILL="$WORKSPACE_ROOT/skills/aiworker-task-flow"
WORKER_SCRIPT="$INSTALLED_SKILL/scripts/run-video-batch.mjs"
BATCH_ROOT="${AIWORKER_VIDEO_BATCH_DIR:-$HOME/ai-worker/state/video-autoworker/video-batches}"
LOG_DIR="${AIWORKER_VIDEO_LANE_LOG_DIR:-$HOME/Library/Logs/aiworker-video-lane}"
LAUNCH_AGENTS_DIR="${AIWORKER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
BACKUP_ROOT="${AIWORKER_VIDEO_LANE_BACKUP_ROOT:-$HOME/ai-worker/backups/video-lane-supervisor}"
PROFILE_CONFIG="$HOME/.openclaw-qwen-current/openclaw.json"
LOCK_DIR="$BACKUP_ROOT/.install.lock"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"
MODE=""
NODE_BIN="${AIWORKER_NODE_BIN:-}"
WORK_ROOT=""
LOCK_OWNED=0
BACKUP_DIR=""
COMMIT_STARTED=0
ROLLBACK_FAILED=0

usage() {
  printf 'Usage: %s (--dry-run|--apply|--uninstall)\n' "$0"
}

if [[ "$#" -ne 1 ]]; then
  usage >&2
  exit 2
fi
case "$1" in
  --dry-run) MODE="dry-run" ;;
  --apply) MODE="apply" ;;
  --uninstall) MODE="uninstall" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

for command_name in awk chmod cmp cp date dirname env hostname id install launchctl lsof mkdir mktemp mv node openclaw plutil rm rmdir shasum sleep stat; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done
if [[ -z "$NODE_BIN" ]]; then NODE_BIN="$(command -v node)"; fi

normalize_existing_dir() {
  local pathname="$1"
  local label="$2"
  [[ "$pathname" == /* && -d "$pathname" && ! -L "$pathname" ]] || {
    printf '%s must be an existing absolute regular directory: %s\n' "$label" "$pathname" >&2
    return 1
  }
  (cd "$pathname" && pwd -P)
}

assert_future_child_path() {
  local pathname="$1"
  local parent="$2"
  local label="$3"
  [[ "$pathname" == /* && "$(dirname "$pathname")" == "$parent" ]] || {
    printf '%s must be an approved direct child: %s\n' "$label" "$pathname" >&2
    return 1
  }
  [[ ! -L "$pathname" ]] || {
    printf '%s must not be a symlink: %s\n' "$label" "$pathname" >&2
    return 1
  }
}

assert_real_file() {
  local pathname="$1"
  local label="$2"
  [[ "$pathname" == /* && -f "$pathname" && ! -L "$pathname" ]] || {
    printf '%s must be an absolute regular file: %s\n' "$label" "$pathname" >&2
    return 1
  }
  [[ "$(cd "$(dirname "$pathname")" && pwd -P)/$(basename "$pathname")" == "$pathname" ]] || {
    printf '%s must be a physical path without symlink parents: %s\n' "$label" "$pathname" >&2
    return 1
  }
}

assert_safe_managed_dir() {
  local pathname="$1"
  local label="$2"
  if [[ -e "$pathname" || -L "$pathname" ]]; then
    [[ -d "$pathname" && ! -L "$pathname" && "$(stat -f '%Lp' "$pathname")" == "700" ]] || {
      printf '%s must be a mode-0700 regular directory: %s\n' "$label" "$pathname" >&2
      return 1
    }
  fi
}

run_clean_openclaw() {
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS openclaw "$@"
}

run_qwen_openclaw() {
  run_clean_openclaw --profile "$PROFILE" "$@"
}

listener_snapshot() {
  local port pids
  for port in 3017 5678 5679 18091 18789 18889 18989; do
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | LC_ALL=C sort -u | tr '\n' ',')" || return 1
    [[ -n "$pids" ]] || {
      printf 'Protected listener %s is missing.\n' "$port" >&2
      return 1
    }
    printf '%s=%s\n' "$port" "$pids"
  done
}

service_loaded() {
  launchctl print "$SERVICE" >/dev/null 2>&1
}

stop_service() {
  if service_loaded; then
    launchctl bootout "$DOMAIN" "$PLIST_PATH"
  fi
}

start_service() {
  launchctl enable "$SERVICE"
  launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  launchctl kickstart -k "$SERVICE"
}

wait_for_runtime() {
  local report_path="$1"
  local attempt
  for attempt in {1..50}; do
    if launchctl print "$SERVICE" > "$report_path" 2>/dev/null \
      && node "$VALIDATOR" runtime "$report_path" "$BATCH_ROOT/.global-video-worker.lock" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  launchctl print "$SERVICE" > "$report_path" 2>/dev/null || true
  node "$VALIDATOR" runtime "$report_path" "$BATCH_ROOT/.global-video-worker.lock"
}

write_backup_manifest() {
  local backup_dir="$1"
  local -a payloads=("STATE")
  if [[ -f "$backup_dir/$LABEL.plist" ]]; then payloads+=("$LABEL.plist"); fi
  (
    cd "$backup_dir"
    shasum -a 256 "${payloads[@]}"
  ) > "$backup_dir/MANIFEST.sha256"
  chmod 600 "$backup_dir/MANIFEST.sha256"
  shasum -a 256 "$backup_dir/MANIFEST.sha256" | awk '{print $1}' > "$backup_dir/.verified"
  chmod 600 "$backup_dir/.verified"
  node "$VALIDATOR" backup "$BACKUP_ROOT" "$backup_dir" >/dev/null
}

list_verified_backups() {
  node "$VALIDATOR" backup-list "$BACKUP_ROOT"
}

prune_verified_backups() {
  local candidate
  local -a backups=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && backups+=("$candidate")
  done < <(list_verified_backups)
  [[ "${#backups[@]}" -le 3 ]] || {
    printf 'Verified video-lane backup count is inconsistent; refusing automatic cleanup.\n' >&2
    return 1
  }
  if [[ "${#backups[@]}" -eq 3 ]]; then
    [[ "${backups[0]}" != "$BACKUP_DIR" ]] || {
      printf 'Newest backup ordering is inconsistent.\n' >&2
      return 1
    }
    node "$VALIDATOR" backup "$BACKUP_ROOT" "${backups[0]}" >/dev/null
    rm -rf -- "${backups[0]}"
  fi
  backups=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && backups+=("$candidate")
  done < <(list_verified_backups)
  [[ "${#backups[@]}" -le 2 && " ${backups[*]} " =~ " $BACKUP_DIR " ]] || {
    printf 'Video-lane backup retention did not converge to at most two verified backups.\n' >&2
    return 1
  }
}

restore_backup() {
  local backup_dir="$1"
  local state plist_present service_was_loaded
  state="$(node "$VALIDATOR" backup "$BACKUP_ROOT" "$backup_dir")" || return 1
  plist_present="$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(v.plistPresent?"1":"0")' "$state")"
  service_was_loaded="$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(v.serviceLoaded?"1":"0")' "$state")"
  stop_service || return 1
  if [[ "$plist_present" == "1" ]]; then
    install -d -m 700 "$LAUNCH_AGENTS_DIR" || return 1
    install -m 600 "$backup_dir/$LABEL.plist" "$PLIST_PATH" || return 1
  else
    rm -f -- "$PLIST_PATH" || return 1
  fi
  if [[ "$service_was_loaded" == "1" ]]; then
    start_service || return 1
    wait_for_runtime "$WORK_ROOT/rollback-launchctl.txt" || return 1
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ "$exit_code" -ne 0 && "$COMMIT_STARTED" == "1" && -n "$BACKUP_DIR" ]]; then
    if ! restore_backup "$BACKUP_DIR"; then
      printf 'ROLLBACK FAILED: video-lane LaunchAgent requires manual inspection. Backup: %s\n' "$BACKUP_DIR" >&2
      exit_code=1
      ROLLBACK_FAILED=1
    else
      printf 'Video-lane supervisor change failed; exact prior LaunchAgent state was restored.\n' >&2
    fi
  fi
  if [[ "$LOCK_OWNED" == "1" ]]; then
    rm -f -- "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" || exit_code=1
  fi
  if [[ -n "$WORK_ROOT" && "$ROLLBACK_FAILED" != "1" ]]; then
    case "$WORK_ROOT" in
      /tmp/aiworker-video-lane-supervisor.*|/private/tmp/aiworker-video-lane-supervisor.*)
        rm -rf -- "$WORK_ROOT" || exit_code=1
        ;;
      *) printf 'Refusing unexpected temporary cleanup path.\n' >&2; exit_code=1 ;;
    esac
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for path_label in \
  "$REPOSITORY_ROOT|Repository root" \
  "$SOURCE_SKILL|Canonical task-flow skill" \
  "$WORKSPACE_ROOT|second-original workspace" \
  "$INSTALLED_SKILL|Installed task-flow skill"; do
  pathname="${path_label%%|*}"
  label="${path_label#*|}"
  normalized="$(normalize_existing_dir "$pathname" "$label")"
  [[ "$normalized" == "$pathname" ]] || {
    printf '%s must not resolve through symlink parents: %s\n' "$label" "$pathname" >&2
    exit 1
  }
done
assert_real_file "$TEMPLATE" "LaunchAgent template"
assert_real_file "$VALIDATOR" "Video-lane validator"
assert_real_file "$WORKER_SCRIPT" "Installed video-lane worker"
assert_real_file "$NODE_BIN" "Node.js executable"
[[ -x "$NODE_BIN" ]] || { printf 'Node.js executable is not executable.\n' >&2; exit 1; }
[[ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" == "22" ]] || {
  printf 'Video-lane supervisor requires the validated Node.js 22 runtime.\n' >&2
  exit 1
}
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

for managed_path in "$BATCH_ROOT" "$LOG_DIR" "$LAUNCH_AGENTS_DIR" "$BACKUP_ROOT"; do
  [[ "$managed_path" == /* && "$(dirname "$managed_path")" != "/" ]] || {
    printf 'Managed video-lane paths must be specific normalized absolute paths: %s\n' "$managed_path" >&2
    exit 1
  }
done
assert_safe_managed_dir "$BATCH_ROOT" "Video batch root"
assert_safe_managed_dir "$LOG_DIR" "Video-lane log directory"
assert_safe_managed_dir "$BACKUP_ROOT" "Video-lane backup root"
if [[ -e "$LAUNCH_AGENTS_DIR" || -L "$LAUNCH_AGENTS_DIR" ]]; then
  normalize_existing_dir "$LAUNCH_AGENTS_DIR" "LaunchAgents directory" >/dev/null
fi
assert_future_child_path "$PLIST_PATH" "$LAUNCH_AGENTS_DIR" "Video-lane LaunchAgent plist"

[[ "$(id -un)" == "$EXPECTED_USER" && "$(hostname)" == "$EXPECTED_HOST" ]] || {
  printf 'Refusing non-production identity: user=%s host=%s\n' "$(id -un)" "$(hostname)" >&2
  exit 1
}
openclaw_version="$(run_clean_openclaw --version)"
case "$openclaw_version" in
  "OpenClaw $OPENCLAW_VERSION ("*")") ;;
  *) printf 'Unsupported OpenClaw version: %s\n' "$openclaw_version" >&2; exit 1 ;;
esac
node "$VALIDATOR" profile "$PROFILE_CONFIG" "$WORKSPACE_ROOT" >/dev/null
node "$VALIDATOR" skill-payload "$SOURCE_SKILL" "$INSTALLED_SKILL" >/dev/null
node --check "$WORKER_SCRIPT"

WORK_ROOT="$(mktemp -d /tmp/aiworker-video-lane-supervisor.XXXXXX)"
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"
chmod 700 "$WORK_ROOT"
RENDERED_PLIST="$WORK_ROOT/$LABEL.plist"
node "$VALIDATOR" render "$TEMPLATE" "$NODE_BIN" "$WORKER_SCRIPT" "$BATCH_ROOT" \
  "$INSTALLED_SKILL" "$HOME" "$NODE_BIN_DIR" "$LOG_DIR" > "$RENDERED_PLIST"
chmod 600 "$RENDERED_PLIST"
plutil -lint "$RENDERED_PLIST" >/dev/null
node "$VALIDATOR" plist "$RENDERED_PLIST" "$TEMPLATE" "$NODE_BIN" "$WORKER_SCRIPT" \
  "$BATCH_ROOT" "$INSTALLED_SKILL" "$HOME" "$NODE_BIN_DIR" "$LOG_DIR" >/dev/null

run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/qwen-gateway.json"
chmod 600 "$WORK_ROOT/qwen-gateway.json"
node "$VALIDATOR" gateway "$WORK_ROOT/qwen-gateway.json" >/dev/null
PROTECTED_BEFORE="$(listener_snapshot)"

if [[ "$MODE" == "dry-run" ]]; then
  current_loaded=0
  service_loaded && current_loaded=1
  if [[ -f "$PLIST_PATH" && ! -L "$PLIST_PATH" ]]; then
    node "$VALIDATOR" plist "$PLIST_PATH" "$TEMPLATE" "$NODE_BIN" "$WORKER_SCRIPT" \
      "$BATCH_ROOT" "$INSTALLED_SKILL" "$HOME" "$NODE_BIN_DIR" "$LOG_DIR" >/dev/null || true
  fi
  [[ "$(listener_snapshot)" == "$PROTECTED_BEFORE" ]] || {
    printf 'Dry-run changed a protected listener.\n' >&2
    exit 1
  }
  printf 'Video-lane supervisor dry-run passed: mode=%s target=%s loaded=%s\n' "$MODE" "$PLIST_PATH" "$current_loaded"
  printf 'No LaunchAgent, queue state, qwen-current, OpenClaw Gateway, n8n, or protected listener was changed.\n'
  exit 0
fi

install -d -m 700 "$BACKUP_ROOT"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf 'Another video-lane supervisor operation holds the install lock.\n' >&2
  exit 1
fi
LOCK_OWNED=1
chmod 700 "$LOCK_DIR"
printf '%s\n' "$$" > "$LOCK_DIR/pid"
chmod 600 "$LOCK_DIR/pid"

verified_before=0
while IFS= read -r candidate; do
  [[ -n "$candidate" ]] && verified_before=$((verified_before + 1))
done < <(list_verified_backups)
[[ "$verified_before" -le 2 ]] || {
  printf 'More than two verified video-lane backups already exist.\n' >&2
  exit 1
}

plist_present=0
service_was_loaded=0
[[ -f "$PLIST_PATH" && ! -L "$PLIST_PATH" ]] && plist_present=1
service_loaded && service_was_loaded=1

if [[ "$MODE" == "apply" && "$plist_present" == "1" ]] \
  && cmp -s "$PLIST_PATH" "$RENDERED_PLIST" && [[ "$service_was_loaded" == "1" ]]; then
  launchctl print "$SERVICE" > "$WORK_ROOT/current-launchctl.txt"
  if node "$VALIDATOR" runtime "$WORK_ROOT/current-launchctl.txt" "$BATCH_ROOT/.global-video-worker.lock" >/dev/null; then
    printf 'Video-lane supervisor is already current and healthy: %s\n' "$SERVICE"
    exit 0
  fi
fi
if [[ "$MODE" == "uninstall" && "$plist_present" == "0" && "$service_was_loaded" == "0" ]]; then
  printf 'Video-lane supervisor is already absent. Queue state and logs were preserved.\n'
  exit 0
fi

BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S).XXXXXX")"
chmod 700 "$BACKUP_DIR"
if [[ "$plist_present" == "1" ]]; then
  install -m 600 "$PLIST_PATH" "$BACKUP_DIR/$LABEL.plist"
fi
printf 'version=1\nplist_present=%s\nservice_loaded=%s\n' \
  "$plist_present" "$service_was_loaded" > "$BACKUP_DIR/STATE"
chmod 600 "$BACKUP_DIR/STATE"
write_backup_manifest "$BACKUP_DIR"

COMMIT_STARTED=1
stop_service
if [[ "$MODE" == "apply" ]]; then
  install -d -m 700 "$LAUNCH_AGENTS_DIR" "$BATCH_ROOT" "$LOG_DIR"
  install -m 600 "$RENDERED_PLIST" "$PLIST_PATH"
  node "$VALIDATOR" plist "$PLIST_PATH" "$TEMPLATE" "$NODE_BIN" "$WORKER_SCRIPT" \
    "$BATCH_ROOT" "$INSTALLED_SKILL" "$HOME" "$NODE_BIN_DIR" "$LOG_DIR" >/dev/null
  start_service
  wait_for_runtime "$WORK_ROOT/launchctl.txt"
else
  rm -f -- "$PLIST_PATH"
  [[ ! -e "$PLIST_PATH" && ! -L "$PLIST_PATH" ]] || {
    printf 'Video-lane LaunchAgent plist still exists after uninstall.\n' >&2
    exit 1
  }
fi

[[ "$(listener_snapshot)" == "$PROTECTED_BEFORE" ]] || {
  printf 'A protected listener changed during the video-lane supervisor operation.\n' >&2
  exit 1
}
run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/qwen-gateway-after.json"
node "$VALIDATOR" gateway "$WORK_ROOT/qwen-gateway-after.json" >/dev/null
prune_verified_backups
COMMIT_STARTED=0

if [[ "$MODE" == "apply" ]]; then
  printf 'Installed and verified the persistent global video-lane supervisor: %s\n' "$SERVICE"
  printf 'Login recovery, abnormal-exit recovery, and one-root lock ownership are active.\n'
else
  printf 'Uninstalled the video-lane supervisor; queue state, task IDs, batch IDs, logs, and backups were preserved.\n'
fi
printf 'Rollback backup: %s\n' "$BACKUP_DIR"
printf 'Protected listeners and qwen-current Gateway remained healthy.\n'
