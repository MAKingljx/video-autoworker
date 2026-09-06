#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../ops/n8n/lib/common.sh
source "$REPOSITORY_ROOT/ops/n8n/lib/common.sh"

n8n_load_environment
n8n_require_node
n8n_require_encryption_key
n8n_require_installation
n8n_prepare_runtime_directories

STARTUP_WITNESS_HELPER="$AIWORKER_N8N_RUNTIME_CURRENT/scripts/n8n-startup-witness.mjs"
STARTUP_WITNESS_FILE="$AIWORKER_N8N_RUN_DIR/n8n.complete-ready.json"
N8N_CLI="$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n"
RUNTIME_TARGET="$(readlink "$AIWORKER_N8N_RUNTIME_CURRENT" 2>/dev/null || true)"

complete_startup_ready() {
  local result expected_pid expected_commit
  [[ -n "$RUNTIME_TARGET" && -f "$STARTUP_WITNESS_HELPER" && ! -L "$STARTUP_WITNESS_HELPER" ]] || return 1
  result="$("$N8N_NODE_BIN" "$STARTUP_WITNESS_HELPER" verify \
    --pid-file "$AIWORKER_N8N_PID_FILE" \
    --runtime-root "$RUNTIME_TARGET" \
    --node-bin "$N8N_NODE_BIN" \
    --cli "$N8N_CLI" \
    --witness "$STARTUP_WITNESS_FILE" \
    --readiness-url "$(n8n_health_url)/readiness" 2>/dev/null)" || return 1
  expected_pid="$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")"
  expected_commit="$(basename "$RUNTIME_TARGET")"
  "$N8N_NODE_BIN" -e '
    const [source, pid, commit] = process.argv.slice(1)
    let value
    try { value = JSON.parse(source) } catch { process.exit(1) }
    const keys = Object.keys(value || {}).sort().join(",")
    if (keys !== "observedAt,pid,schema,sourceCommit"
      || value.schema !== "video-autoworker-n8n-complete-startup-witness/v1"
      || value.pid !== Number(pid) || value.sourceCommit !== commit
      || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0) process.exit(1)
  ' "$result" "$expected_pid" "$expected_commit"
}

wait_for_complete_startup() {
  local attempt
  for attempt in $(seq 1 120); do
    if complete_startup_ready; then
      printf 'n8n is completely ready: %s\n' "$(n8n_health_url)/readiness"
      return 0
    fi
    sleep 1
  done
  printf 'n8n did not complete startup within 120 seconds. Check %s\n' "$AIWORKER_N8N_LOG_FILE" >&2
  return 1
}

run_foreground() {
  local lock_dir="$AIWORKER_N8N_RUN_DIR/start.lock"
  local stdout_fifo="$AIWORKER_N8N_RUN_DIR/n8n.stdout.$$.fifo"
  n8n_maintenance_lock_acquire start "$SCRIPT_DIR/n8n-maintenance-lock.mjs" || exit 1
  cleanup_start() {
    rm -f "$stdout_fifo"
    rm -f "$lock_dir/pid"
    rmdir "$lock_dir" 2>/dev/null || true
    n8n_maintenance_lock_release || true
  }
  trap cleanup_start EXIT
  if ! mkdir "$lock_dir" 2>/dev/null; then
    local lock_owner=""
    [[ -f "$lock_dir/pid" ]] && lock_owner="$(tr -d '[:space:]' < "$lock_dir/pid")"
    if [[ "$lock_owner" =~ ^[0-9]+$ ]] && kill -0 "$lock_owner" 2>/dev/null; then
      printf 'n8n start is already in progress (PID %s).\n' "$lock_owner" >&2
      exit 1
    fi
    rm -f "$lock_dir/pid"
    rmdir "$lock_dir" 2>/dev/null || true
    mkdir "$lock_dir"
  fi
  printf '%s\n' "$$" > "$lock_dir/pid"

  if n8n_pid_is_running; then
    local existing_pid
    existing_pid="$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")"
    complete_startup_ready || {
      printf 'n8n is running without a valid complete-startup witness (PID %s).\n' "$existing_pid" >&2
      exit 1
    }
    printf 'n8n is already completely ready (PID %s).\n' "$existing_pid"
    exit 0
  fi
  rm -f "$AIWORKER_N8N_PID_FILE"
  if [[ -e "$STARTUP_WITNESS_FILE" ]]; then
    "$N8N_NODE_BIN" "$STARTUP_WITNESS_HELPER" clear-stale --witness "$STARTUP_WITNESS_FILE"
  fi
  [[ ! -e "$stdout_fifo" && ! -L "$stdout_fifo" ]] || {
    printf 'n8n startup stdout FIFO already exists: %s\n' "$stdout_fifo" >&2
    exit 1
  }
  mkfifo "$stdout_fifo"
  chmod 600 "$stdout_fifo"

  "$N8N_NODE_BIN" "$N8N_CLI" start > "$stdout_fifo" &
  local child_pid=$!
  local child_start=""
  for _ in $(seq 1 50); do
    child_start="$(/bin/ps -p "$child_pid" -o lstart= 2>/dev/null | sed -e 's/^ *//' -e 's/ *$//' || true)"
    [[ -n "$child_start" ]] && break
    sleep 0.02
  done
  [[ -n "$child_start" ]] || {
    kill -TERM "$child_pid" 2>/dev/null || true
    printf 'Unable to capture the n8n child start identity.\n' >&2
    exit 1
  }
  local pid_tmp="$AIWORKER_N8N_PID_FILE.tmp.$$"
  printf '%s\n' "$child_pid" > "$pid_tmp"
  mv "$pid_tmp" "$AIWORKER_N8N_PID_FILE"
  chmod 600 "$AIWORKER_N8N_PID_FILE"
  "$N8N_NODE_BIN" "$STARTUP_WITNESS_HELPER" observe \
    --pid-file "$AIWORKER_N8N_PID_FILE" \
    --runtime-root "$RUNTIME_TARGET" \
    --node-bin "$N8N_NODE_BIN" \
    --cli "$N8N_CLI" \
    --witness "$STARTUP_WITNESS_FILE" \
    --expected-origin "http://$N8N_HOST:$N8N_PORT" \
    --expected-pid "$child_pid" \
    --expected-start "$child_start" < "$stdout_fifo" &
  local observer_pid=$!

  forward_signal() {
    kill -TERM "$child_pid" 2>/dev/null || true
  }
  trap forward_signal TERM INT HUP

  process_running() {
    local state
    state="$(/bin/ps -p "$1" -o state= 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -n "$state" && "$state" != Z* ]]
  }
  while process_running "$child_pid" && process_running "$observer_pid"; do
    sleep 1
  done
  if process_running "$child_pid" && ! process_running "$observer_pid"; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
  if ! process_running "$child_pid" && process_running "$observer_pid"; then
    kill -TERM "$observer_pid" 2>/dev/null || true
  fi
  set +e
  wait "$child_pid"
  local exit_code=$?
  wait "$observer_pid"
  local observer_exit=$?
  set -e
  if [[ "$exit_code" == 0 && "$observer_exit" != 0 ]]; then
    exit_code="$observer_exit"
  fi
  if [[ -e "$STARTUP_WITNESS_FILE" ]]; then
    if ! "$N8N_NODE_BIN" "$STARTUP_WITNESS_HELPER" clear \
      --witness "$STARTUP_WITNESS_FILE" --expected-pid "$child_pid" \
      --expected-start "$child_start"; then
      exit_code=1
    fi
  fi
  rm -f "$stdout_fifo"
  if [[ -f "$AIWORKER_N8N_PID_FILE" ]] && [[ "$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")" == "$child_pid" ]]; then
    rm -f "$AIWORKER_N8N_PID_FILE"
  fi
  cleanup_start
  trap - EXIT TERM INT HUP
  exit "$exit_code"
}

if [[ "${1:-}" == "--foreground" ]]; then
  run_foreground
fi

if n8n_pid_is_running; then
  wait_for_complete_startup
  exit 0
fi
if n8n_health_is_available; then
  printf 'n8n health responds without an owned completely-ready process.\n' >&2
  exit 1
fi

PLIST_PATH="$HOME/Library/LaunchAgents/$AIWORKER_N8N_LAUNCH_LABEL.plist"
if [[ -f "$PLIST_PATH" ]]; then
  if ! n8n_launch_job_loaded; then
    launchctl bootstrap "$(n8n_launch_domain)" "$PLIST_PATH"
  fi
  launchctl enable "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"
  launchctl kickstart -k "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"
else
  if n8n_pid_is_running; then
    printf 'n8n is already running (PID %s).\n' "$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")"
  else
    nohup /bin/bash "$SCRIPT_DIR/n8n-start.sh" --foreground >> "$AIWORKER_N8N_LOG_FILE" 2>&1 < /dev/null &
    printf 'Started n8n wrapper in the background (PID %s).\n' "$!"
  fi
fi

wait_for_complete_startup
