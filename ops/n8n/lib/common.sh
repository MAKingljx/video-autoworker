#!/bin/bash

set -euo pipefail

AIWORKER_N8N_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIWORKER_N8N_SOURCE_DIR="$(cd "$AIWORKER_N8N_LIB_DIR/.." && pwd)"
AIWORKER_REPOSITORY_ROOT="$(cd "$AIWORKER_N8N_SOURCE_DIR/../.." && pwd)"
AIWORKER_N8N_LAUNCH_LABEL="com.video-autoworker.n8n"

n8n_env_file() {
  printf '%s\n' "${AIWORKER_N8N_ENV_FILE:-$HOME/.config/video-autoworker/n8n.env}"
}

n8n_load_environment() {
  local env_file override_node override_npm override_runtime_root override_user_folder override_log_dir override_run_dir
  local override_backup_dir override_pid_file override_log_file override_listen_address
  local override_host override_port override_protocol override_encryption_key
  env_file="$(n8n_env_file)"
  if [[ ! -f "$env_file" ]]; then
    printf 'n8n environment file not found: %s\n' "$env_file" >&2
    printf 'Run scripts/n8n-install.sh first, or set AIWORKER_N8N_ENV_FILE.\n' >&2
    return 1
  fi

  # Explicit process environment wins over the external file. This supports a
  # one-off alternate Node 22 path or isolated validation without editing it.
  override_node="${N8N_NODE_BIN:-}"
  override_npm="${N8N_NPM_BIN:-}"
  override_runtime_root="${AIWORKER_N8N_RUNTIME_ROOT:-}"
  override_user_folder="${N8N_USER_FOLDER:-}"
  override_log_dir="${AIWORKER_N8N_LOG_DIR:-}"
  override_run_dir="${AIWORKER_N8N_RUN_DIR:-}"
  override_backup_dir="${AIWORKER_N8N_BACKUP_DIR:-}"
  override_pid_file="${AIWORKER_N8N_PID_FILE:-}"
  override_log_file="${AIWORKER_N8N_LOG_FILE:-}"
  override_listen_address="${N8N_LISTEN_ADDRESS:-}"
  override_host="${N8N_HOST:-}"
  override_port="${N8N_PORT:-}"
  override_protocol="${N8N_PROTOCOL:-}"
  override_encryption_key="${N8N_ENCRYPTION_KEY:-}"

  set -a
  # The external file is an administrator-owned shell-compatible env file.
  # shellcheck disable=SC1090
  source "$env_file"
  set +a

  [[ -n "$override_node" ]] && N8N_NODE_BIN="$override_node"
  [[ -n "$override_npm" ]] && N8N_NPM_BIN="$override_npm"
  [[ -n "$override_runtime_root" ]] && AIWORKER_N8N_RUNTIME_ROOT="$override_runtime_root"
  [[ -n "$override_user_folder" ]] && N8N_USER_FOLDER="$override_user_folder"
  [[ -n "$override_log_dir" ]] && AIWORKER_N8N_LOG_DIR="$override_log_dir"
  [[ -n "$override_run_dir" ]] && AIWORKER_N8N_RUN_DIR="$override_run_dir"
  [[ -n "$override_backup_dir" ]] && AIWORKER_N8N_BACKUP_DIR="$override_backup_dir"
  [[ -n "$override_pid_file" ]] && AIWORKER_N8N_PID_FILE="$override_pid_file"
  [[ -n "$override_log_file" ]] && AIWORKER_N8N_LOG_FILE="$override_log_file"
  [[ -n "$override_listen_address" ]] && N8N_LISTEN_ADDRESS="$override_listen_address"
  [[ -n "$override_host" ]] && N8N_HOST="$override_host"
  [[ -n "$override_port" ]] && N8N_PORT="$override_port"
  [[ -n "$override_protocol" ]] && N8N_PROTOCOL="$override_protocol"
  [[ -n "$override_encryption_key" ]] && N8N_ENCRYPTION_KEY="$override_encryption_key"

  if [[ -z "${N8N_NODE_BIN:-}" ]]; then
    if [[ -x "$HOME/ai-worker/node/current/bin/node" ]]; then
      N8N_NODE_BIN="$HOME/ai-worker/node/current/bin/node"
    else
      N8N_NODE_BIN="$(command -v node || true)"
    fi
  fi
  if [[ -z "${N8N_NPM_BIN:-}" ]]; then
    if [[ -x "$(dirname "$N8N_NODE_BIN")/npm" ]]; then
      N8N_NPM_BIN="$(dirname "$N8N_NODE_BIN")/npm"
    else
      N8N_NPM_BIN="$(command -v npm || true)"
    fi
  fi

  AIWORKER_N8N_RUNTIME_ROOT="${AIWORKER_N8N_RUNTIME_ROOT:-$HOME/ai-worker/services/video-autoworker-n8n}"
  AIWORKER_N8N_RUNTIME_CURRENT="$AIWORKER_N8N_RUNTIME_ROOT/current"
  AIWORKER_N8N_RUNTIME_DIR="$AIWORKER_N8N_RUNTIME_CURRENT/ops/n8n"
  N8N_USER_FOLDER="${N8N_USER_FOLDER:-$HOME/ai-worker/state/n8n}"
  AIWORKER_N8N_LOG_DIR="${AIWORKER_N8N_LOG_DIR:-$HOME/ai-worker/logs/n8n}"
  AIWORKER_N8N_RUN_DIR="${AIWORKER_N8N_RUN_DIR:-$HOME/ai-worker/run/n8n}"
  AIWORKER_N8N_BACKUP_DIR="${AIWORKER_N8N_BACKUP_DIR:-$HOME/ai-worker/backups/n8n}"
  AIWORKER_N8N_PID_FILE="${AIWORKER_N8N_PID_FILE:-$AIWORKER_N8N_RUN_DIR/n8n.pid}"
  AIWORKER_N8N_LOG_FILE="${AIWORKER_N8N_LOG_FILE:-$AIWORKER_N8N_LOG_DIR/n8n.log}"
  N8N_LISTEN_ADDRESS="${N8N_LISTEN_ADDRESS:-127.0.0.1}"
  N8N_HOST="${N8N_HOST:-127.0.0.1}"
  N8N_PORT="${N8N_PORT:-5678}"
  N8N_PROTOCOL="${N8N_PROTOCOL:-http}"

  export N8N_NODE_BIN N8N_NPM_BIN N8N_USER_FOLDER
  export AIWORKER_N8N_RUNTIME_ROOT AIWORKER_N8N_RUNTIME_CURRENT AIWORKER_N8N_RUNTIME_DIR
  export AIWORKER_N8N_LOG_DIR AIWORKER_N8N_RUN_DIR AIWORKER_N8N_BACKUP_DIR
  export AIWORKER_N8N_PID_FILE AIWORKER_N8N_LOG_FILE
  export N8N_LISTEN_ADDRESS N8N_HOST N8N_PORT N8N_PROTOCOL
  export PATH="$(dirname "$N8N_NODE_BIN"):$PATH"
}

n8n_prepare_runtime_directories() {
  umask 077
  mkdir -p "$N8N_USER_FOLDER" "$AIWORKER_N8N_LOG_DIR" "$AIWORKER_N8N_RUN_DIR"
  chmod 700 "$N8N_USER_FOLDER" "$AIWORKER_N8N_LOG_DIR" "$AIWORKER_N8N_RUN_DIR"
}

n8n_require_node() {
  if [[ -z "${N8N_NODE_BIN:-}" || ! -x "$N8N_NODE_BIN" ]]; then
    printf 'Node executable is unavailable: %s\n' "${N8N_NODE_BIN:-<empty>}" >&2
    return 1
  fi

  "$N8N_NODE_BIN" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 22)) {
      console.error(`n8n 2.31.6 requires Node >=22.22; found ${process.versions.node}`);
      process.exit(1);
    }
  '
}

n8n_require_encryption_key() {
  if [[ -z "${N8N_ENCRYPTION_KEY:-}" || "${#N8N_ENCRYPTION_KEY}" -lt 32 ]]; then
    printf 'N8N_ENCRYPTION_KEY must contain at least 32 characters in the external environment.\n' >&2
    printf 'Run scripts/n8n-install.sh to create it safely.\n' >&2
    return 1
  fi
}

n8n_require_installation() {
  local cli="$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/bin/n8n"
  if [[ ! -f "$cli" ]]; then
    printf 'n8n is not installed under %s\n' "$AIWORKER_N8N_RUNTIME_DIR" >&2
    printf 'Run scripts/n8n-install.sh first.\n' >&2
    return 1
  fi
}

n8n_runtime_source_manifest() {
  local source_root="${1:-$AIWORKER_REPOSITORY_ROOT}"
  (
    cd "$source_root"
    shasum -a 256 \
      scripts/n8n-start.sh \
      scripts/n8n-stop.sh \
      scripts/n8n-status.sh \
      scripts/n8n-import-workflows.sh \
      ops/n8n/.env.example \
      ops/n8n/lib/common.sh \
      ops/n8n/package.json \
      ops/n8n/package-lock.json \
      ops/n8n/workflows/aiworker-task-intake.json \
      ops/n8n/workflows/aiworker-video-analysis.json
  )
}

n8n_runtime_source_manifest_sha256() {
  n8n_runtime_source_manifest "${1:-$AIWORKER_REPOSITORY_ROOT}" \
    | shasum -a 256 \
    | awk '{print $1}'
}

n8n_release_matches_repository_source() {
  local release_dir="$1" expected_manifest_sha actual_manifest_sha
  [[ -f "$release_dir/SOURCE_MANIFEST" && -f "$release_dir/RUNTIME_SOURCE_SHA256SUMS" ]] || return 1
  expected_manifest_sha="$(n8n_runtime_source_manifest_sha256 "$AIWORKER_REPOSITORY_ROOT")"
  actual_manifest_sha="$(shasum -a 256 "$release_dir/RUNTIME_SOURCE_SHA256SUMS" | awk '{print $1}')"
  [[ "$actual_manifest_sha" == "$expected_manifest_sha" ]] || return 1
  grep -Fqx "runtime_source_manifest_sha256=$expected_manifest_sha" "$release_dir/SOURCE_MANIFEST" || return 1
  (cd "$release_dir" && shasum -a 256 -c RUNTIME_SOURCE_SHA256SUMS >/dev/null 2>&1)
}

n8n_health_url() {
  printf '%s://%s:%s/healthz\n' "$N8N_PROTOCOL" "$N8N_HOST" "$N8N_PORT"
}

n8n_health_is_available() {
  curl --silent --show-error --fail --max-time 2 "$(n8n_health_url)" >/dev/null 2>&1
}

n8n_pid_is_running() {
  [[ -f "$AIWORKER_N8N_PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$AIWORKER_N8N_PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null && n8n_process_is_owned "$pid"
}

n8n_process_is_owned() {
  local pid="$1" command_line current_target
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command_line" == *"$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/"* ]]; then
    return 0
  fi
  current_target="$(readlink "$AIWORKER_N8N_RUNTIME_CURRENT" 2>/dev/null || true)"
  [[ -n "$current_target" && "$command_line" == *"$current_target/ops/n8n/node_modules/n8n/"* ]]
}

n8n_launch_domain() {
  printf 'gui/%s\n' "$(id -u)"
}

n8n_launch_job_loaded() {
  launchctl print "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL" >/dev/null 2>&1
}
