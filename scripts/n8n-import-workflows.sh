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

activate_workflows=true
workflow_files=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --activate)
      activate_workflows=true
      ;;
    --no-activate)
      activate_workflows=false
      ;;
    -h|--help)
      printf 'Usage: %s [--activate|--no-activate] [workflow.json ...]\n' "$0"
      printf 'Default: import all bundled workflows and publish them for production webhooks.\n'
      exit 0
      ;;
    --*)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
    *)
      workflow_files+=("$1")
      ;;
  esac
  shift
done

if n8n_pid_is_running || n8n_launch_job_loaded || n8n_health_is_available; then
  printf 'Refusing an offline CLI import while n8n is running.\n' >&2
  printf 'Run scripts/n8n-stop.sh, import, then scripts/n8n-start.sh.\n' >&2
  exit 1
fi

if [[ "${#workflow_files[@]}" -eq 0 ]]; then
  workflow_files=(
    "$AIWORKER_N8N_RUNTIME_DIR/workflows/aiworker-task-intake.json"
    "$AIWORKER_N8N_RUNTIME_DIR/workflows/aiworker-video-analysis.json"
  )
fi

if [[ -d "$N8N_USER_FOLDER" ]] && [[ -n "$(find "$N8N_USER_FOLDER" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  backup_stamp="$(date +%Y%m%d-%H%M%S)"
  backup_archive="$AIWORKER_N8N_BACKUP_DIR/n8n-state-before-workflow-import-$backup_stamp-$$.tar.gz"
  mkdir -p "$AIWORKER_N8N_BACKUP_DIR"
  chmod 700 "$AIWORKER_N8N_BACKUP_DIR"
  tar -czf "$backup_archive" -C "$(dirname "$N8N_USER_FOLDER")" "$(basename "$N8N_USER_FOLDER")"
  shasum -a 256 "$backup_archive" > "$backup_archive.sha256"
  env_backup="$AIWORKER_N8N_BACKUP_DIR/n8n-env-before-workflow-import-$backup_stamp"
  install -m 600 "$(n8n_env_file)" "$env_backup"
  shasum -a 256 "$env_backup" > "$env_backup.sha256"
  chmod 600 "$backup_archive" "$backup_archive.sha256"
  chmod 600 "$env_backup" "$env_backup.sha256"
  printf 'Backed up n8n state: %s\n' "$backup_archive"
  printf 'Backed up matching n8n environment: %s\n' "$env_backup"
fi

for workflow_file in "${workflow_files[@]}"; do
  if [[ ! -f "$workflow_file" ]]; then
    printf 'Workflow file not found: %s\n' "$workflow_file" >&2
    exit 1
  fi
  workflow_id="$("$N8N_NODE_BIN" -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const workflow = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!workflow.id || !workflow.name || !Array.isArray(workflow.nodes) || !workflow.connections) {
      throw new Error(`Invalid n8n workflow shape: ${path}`);
    }
    process.stdout.write(String(workflow.id));
  ' "$workflow_file")"

  # n8n 2.31.6 imports workflows inactive in regular deployment mode. An
  # existing published workflow must be unpublished before a fixed-ID update.
  if "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" list:workflow --onlyId | grep -Fqx "$workflow_id"; then
    printf 'Unpublishing existing workflow before fixed-ID update: %s\n' "$workflow_id"
    "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" unpublish:workflow --id="$workflow_id"
  fi

  printf 'Importing workflow: %s\n' "$workflow_file"
  "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" import:workflow --input="$workflow_file"

  workflow_count="$("$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" list:workflow --onlyId | grep -Fxc "$workflow_id" || true)"
  if [[ "$workflow_count" != "1" ]]; then
    printf 'Expected exactly one workflow with ID %s; found %s.\n' "$workflow_id" "$workflow_count" >&2
    exit 1
  fi

  if [[ "$activate_workflows" == true ]]; then
    printf 'Publishing workflow for production webhooks: %s\n' "$workflow_id"
    "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" publish:workflow --id="$workflow_id"
    if ! "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" list:workflow --active=true --onlyId | grep -Fqx "$workflow_id"; then
      printf 'Workflow did not become active: %s\n' "$workflow_id" >&2
      exit 1
    fi
  fi
done

if [[ "$activate_workflows" == true ]]; then
  printf 'Workflow import and publication complete. Production webhooks will load on the next n8n start.\n'
else
  printf 'Workflow import complete without publication.\n'
fi
