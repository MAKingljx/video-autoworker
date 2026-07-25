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

if n8n_health_is_available; then
  if n8n_pid_is_running; then
    if n8n_launch_job_loaded; then
      printf 'n8n is already healthy under the LaunchAgent: %s\n' "$(n8n_health_url)"
    else
      printf 'n8n is already healthy under the managed background process: %s\n' "$(n8n_health_url)"
    fi
    exit 0
  fi
  printf 'n8n health responds without an owned process; refusing to treat it as managed.\n' >&2
  exit 1
fi

run_foreground() {
  local lock_dir="$AIWORKER_N8N_RUN_DIR/start.lock"
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
  trap 'rm -f "$lock_dir/pid"; rmdir "$lock_dir" 2>/dev/null || true' EXIT

  if n8n_pid_is_running; then
    local existing_pid
    existing_pid="$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")"
    printf 'n8n is already running (PID %s).\n' "$existing_pid"
    exit 0
  fi
  rm -f "$AIWORKER_N8N_PID_FILE"

  "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" start &
  local child_pid=$!
  local pid_tmp="$AIWORKER_N8N_PID_FILE.tmp.$$"
  printf '%s\n' "$child_pid" > "$pid_tmp"
  mv "$pid_tmp" "$AIWORKER_N8N_PID_FILE"
  chmod 600 "$AIWORKER_N8N_PID_FILE"

  forward_signal() {
    kill -TERM "$child_pid" 2>/dev/null || true
  }
  trap forward_signal TERM INT HUP

  set +e
  wait "$child_pid"
  local exit_code=$?
  set -e
  if [[ -f "$AIWORKER_N8N_PID_FILE" ]] && [[ "$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")" == "$child_pid" ]]; then
    rm -f "$AIWORKER_N8N_PID_FILE"
  fi
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
  trap - EXIT TERM INT HUP
  exit "$exit_code"
}

wait_for_health() {
  local health_url attempt
  health_url="$(n8n_health_url)"
  for attempt in $(seq 1 30); do
    if curl --silent --show-error --fail --max-time 2 "$health_url" >/dev/null 2>&1; then
      printf 'n8n is healthy: %s\n' "$health_url"
      return 0
    fi
    sleep 1
  done
  printf 'n8n did not become healthy within 30 seconds. Check %s\n' "$AIWORKER_N8N_LOG_FILE" >&2
  return 1
}

if [[ "${1:-}" == "--foreground" ]]; then
  run_foreground
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

wait_for_health
