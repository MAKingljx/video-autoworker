#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../ops/n8n/lib/common.sh
source "$REPOSITORY_ROOT/ops/n8n/lib/common.sh"

n8n_load_environment

printf 'Environment: %s\n' "$(n8n_env_file)"
printf 'State: %s\n' "$N8N_USER_FOLDER"
printf 'Log: %s\n' "$AIWORKER_N8N_LOG_FILE"

if [[ -f "$AIWORKER_N8N_PROJECT_DIR/node_modules/n8n/package.json" ]]; then
  printf 'Installed version: %s\n' "$($N8N_NODE_BIN -p "require('$AIWORKER_N8N_PROJECT_DIR/node_modules/n8n/package.json').version")"
else
  printf 'Installed version: not installed\n'
fi

if n8n_launch_job_loaded; then
  printf 'LaunchAgent: loaded (%s)\n' "$AIWORKER_N8N_LAUNCH_LABEL"
else
  printf 'LaunchAgent: not loaded\n'
fi

if n8n_pid_is_running; then
  printf 'Process: running (PID %s)\n' "$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")"
else
  printf 'Process: not running\n'
fi

health_url="$(n8n_health_url)"
if curl --silent --show-error --fail --max-time 3 "$health_url" >/dev/null; then
  printf 'Health: healthy (%s)\n' "$health_url"
  exit 0
fi

printf 'Health: unavailable (%s)\n' "$health_url" >&2
exit 1
