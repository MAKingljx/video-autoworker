#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
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
transition_intent=""
transition_confirmation=""
transition_token_file=""
transition_capability=""
transition_journal=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --activate)
      activate_workflows=true
      ;;
    --no-activate)
      activate_workflows=false
      ;;
    --transition-intent|--transition-confirmation|--transition-token-file|--transition-capability|--transition-journal)
      if [[ "$#" -lt 2 || -z "$2" ]]; then
        printf 'Missing value for %s.\n' "$1" >&2
        exit 2
      fi
      case "$1" in
        --transition-intent) transition_intent="$2" ;;
        --transition-confirmation) transition_confirmation="$2" ;;
        --transition-token-file) transition_token_file="$2" ;;
        --transition-capability) transition_capability="$2" ;;
        --transition-journal) transition_journal="$2" ;;
      esac
      shift
      ;;
    -h|--help)
      printf 'Usage: %s --transition-intent PATH --transition-confirmation PATH \\\n' "$0"
      printf '  --transition-token-file PATH --transition-capability PATH --transition-journal DIR\n'
      printf 'Imports and publishes the two fixed managed workflows under a claimed upgrade journal.\n'
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

if [[ -z "$transition_intent" || -z "$transition_confirmation" \
  || -z "$transition_token_file" || -z "$transition_capability" || -z "$transition_journal" ]]; then
  printf 'Refusing workflow mutation without a complete current-confirmed transition capability.\n' >&2
  exit 1
fi
if [[ "$activate_workflows" != true ]]; then
  printf 'The managed transition importer must publish both fixed workflows.\n' >&2
  exit 1
fi

# Hold one physical lease for the complete offline mutation window. The
# LaunchAgent foreground wrapper acquires this same lease before starting n8n.
n8n_maintenance_lock_acquire import "$SCRIPT_DIR/n8n-maintenance-lock.mjs" || exit 1
trap 'n8n_maintenance_lock_release || true' EXIT

transition_anchor="$SCRIPT_DIR/n8n-workflow-transition-anchor.mjs"
"$N8N_NODE_BIN" "$transition_anchor" assert-tooling \
  --intent "$transition_intent" \
  --importer "$SCRIPT_DIR/n8n-import-workflows.sh"

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
if [[ "${#workflow_files[@]}" -ne 2 \
  || "${workflow_files[0]}" != "$AIWORKER_N8N_RUNTIME_DIR/workflows/aiworker-task-intake.json" \
  || "${workflow_files[1]}" != "$AIWORKER_N8N_RUNTIME_DIR/workflows/aiworker-video-analysis.json" ]]; then
  printf 'The managed transition importer accepts only the two bundled fixed workflows in order.\n' >&2
  exit 1
fi

if [[ -d "$N8N_USER_FOLDER" ]] && [[ -n "$(find "$N8N_USER_FOLDER" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  backup_stamp="$(date +%Y%m%d-%H%M%S)"
  backup_archive="$AIWORKER_N8N_BACKUP_DIR/n8n-state-before-workflow-import-$backup_stamp-$$.tar.gz"
  mkdir -p "$AIWORKER_N8N_BACKUP_DIR"
  chmod 700 "$AIWORKER_N8N_BACKUP_DIR"
  n8n_archive_state_without_runtime_locks "$N8N_USER_FOLDER" "$backup_archive"
  shasum -a 256 "$backup_archive" > "$backup_archive.sha256"
  env_backup="$AIWORKER_N8N_BACKUP_DIR/n8n-env-before-workflow-import-$backup_stamp"
  install -m 600 "$(n8n_env_file)" "$env_backup"
  shasum -a 256 "$env_backup" > "$env_backup.sha256"
  chmod 600 "$backup_archive" "$backup_archive.sha256"
  chmod 600 "$env_backup" "$env_backup.sha256"
  printf 'Backed up n8n state: %s\n' "$backup_archive"
  printf 'Backed up matching n8n environment: %s\n' "$env_backup"
fi

# One-way authorization boundary: validate the immutable pre-write intent,
# rollback package, current confirmation, externally supplied token,
# authoritative database, target release and both managed workflow sources.
"$N8N_NODE_BIN" "$transition_anchor" claim-import \
  --intent "$transition_intent" \
  --confirmation "$transition_confirmation" \
  --confirmation-token-file "$transition_token_file" \
  --capability "$transition_capability" \
  --journal-dir "$transition_journal"
"$N8N_NODE_BIN" "$transition_anchor" begin-mutation \
  --intent "$transition_intent" \
  --confirmation "$transition_confirmation" \
  --journal-dir "$transition_journal"

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

  workflow_status="$("$N8N_NODE_BIN" "$transition_anchor" workflow-status \
    --intent "$transition_intent" \
    --confirmation "$transition_confirmation" \
    --journal-dir "$transition_journal" \
    --id "$workflow_id")"
  workflow_complete="$("$N8N_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    process.stdout.write(value.complete === true ? "true" : "false");
  ' "$workflow_status")"
  if [[ "$workflow_complete" == true ]]; then
    printf 'Skipping journaled managed workflow during recovery: %s\n' "$workflow_id"
    continue
  fi
  target_report="$("$N8N_NODE_BIN" "$transition_anchor" verify-target \
    --intent "$transition_intent" \
    --confirmation "$transition_confirmation" \
    --journal-dir "$transition_journal" \
    --id "$workflow_id")"
  target_path="$("$N8N_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    process.stdout.write(String(value.path || ""));
  ' "$target_report")"
  workflow_file_physical="$(cd "$(dirname "$workflow_file")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$workflow_file")")"
  if [[ "$target_path" != "$workflow_file_physical" ]]; then
    printf 'Transition target does not match workflow import path: %s\n' "$workflow_id" >&2
    exit 1
  fi

  # n8n 2.31.6 imports workflows inactive in regular deployment mode. An
  # existing published workflow must be unpublished before a fixed-ID update.
  # Consume the n8n CLI output completely before matching. Piping directly to
  # `grep -q` lets grep close stdout after the first match; when more workflow
  # IDs follow, n8n receives EPIPE and its stack formatter can exhaust memory.
  listed_workflow_ids="$("$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" list:workflow --onlyId)"
  if grep -Fqx "$workflow_id" <<< "$listed_workflow_ids"; then
    printf 'Unpublishing existing workflow before fixed-ID update: %s\n' "$workflow_id"
    "$N8N_NODE_BIN" "$transition_anchor" assert-offline \
      --intent "$transition_intent" \
      --confirmation "$transition_confirmation" \
      --journal-dir "$transition_journal"
    "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" unpublish:workflow --id="$workflow_id"
  fi

  printf 'Importing workflow: %s\n' "$workflow_file"
  "$N8N_NODE_BIN" "$transition_anchor" assert-offline \
    --intent "$transition_intent" \
    --confirmation "$transition_confirmation" \
    --journal-dir "$transition_journal"
  "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" import:workflow --input="$workflow_file"

  listed_workflow_ids="$("$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" list:workflow --onlyId)"
  workflow_count="$(grep -Fxc "$workflow_id" <<< "$listed_workflow_ids" || true)"
  if [[ "$workflow_count" != "1" ]]; then
    printf 'Expected exactly one workflow with ID %s; found %s.\n' "$workflow_id" "$workflow_count" >&2
    exit 1
  fi

  if [[ "$activate_workflows" == true ]]; then
    printf 'Publishing workflow for production webhooks: %s\n' "$workflow_id"
    "$N8N_NODE_BIN" "$transition_anchor" assert-offline \
      --intent "$transition_intent" \
      --confirmation "$transition_confirmation" \
      --journal-dir "$transition_journal"
    "$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" publish:workflow --id="$workflow_id"
    active_workflow_ids="$("$N8N_NODE_BIN" "$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n" list:workflow --active=true --onlyId)"
    if ! grep -Fqx "$workflow_id" <<< "$active_workflow_ids"; then
      printf 'Workflow did not become active: %s\n' "$workflow_id" >&2
      exit 1
    fi
  fi
  "$N8N_NODE_BIN" "$transition_anchor" record-workflow \
    --intent "$transition_intent" \
    --confirmation "$transition_confirmation" \
    --journal-dir "$transition_journal" \
    --id "$workflow_id"
done

if [[ "$activate_workflows" == true ]]; then
  printf 'Workflow import and publication complete. Production webhooks will load on the next n8n start.\n'
else
  printf 'Workflow import complete without publication.\n'
fi
