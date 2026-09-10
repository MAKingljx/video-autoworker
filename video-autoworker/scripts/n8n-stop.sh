#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../ops/n8n/lib/common.sh
source "$REPOSITORY_ROOT/ops/n8n/lib/common.sh"

n8n_load_environment
n8n_prepare_runtime_directories

if n8n_launch_job_loaded; then
  launchctl bootout "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"
  printf 'Stopped LaunchAgent %s.\n' "$AIWORKER_N8N_LAUNCH_LABEL"
fi

if ! n8n_pid_is_running; then
  rm -f "$AIWORKER_N8N_PID_FILE"
  if n8n_health_is_available; then
    printf 'n8n health endpoint still responds but no owned PID is available; refusing to claim it stopped.\n' >&2
    exit 1
  fi
  printf 'n8n is not running.\n'
  exit 0
fi

pid="$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")"
if ! n8n_process_is_owned "$pid"; then
  printf 'Refusing to stop PID %s because it is not the managed n8n process.\n' "$pid" >&2
  exit 1
fi

kill -TERM "$pid"
for attempt in $(seq 1 20); do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$AIWORKER_N8N_PID_FILE"
    printf 'n8n stopped cleanly.\n'
    exit 0
  fi
  sleep 1
done

printf 'n8n did not stop within 20 seconds; no SIGKILL was sent.\n' >&2
exit 1
