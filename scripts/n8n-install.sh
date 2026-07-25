#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../ops/n8n/lib/common.sh
source "$REPOSITORY_ROOT/ops/n8n/lib/common.sh"

ENV_FILE="$(n8n_env_file)"
ENV_TEMPLATE="$AIWORKER_N8N_PROJECT_DIR/.env.example"

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  mkdir -p "$(dirname "$ENV_FILE")"
  cp "$ENV_TEMPLATE" "$ENV_FILE"

  bootstrap_node="${N8N_NODE_BIN:-}"
  if [[ -z "$bootstrap_node" && -x "$HOME/ai-worker/node/current/bin/node" ]]; then
    bootstrap_node="$HOME/ai-worker/node/current/bin/node"
  fi
  if [[ -z "$bootstrap_node" ]]; then
    bootstrap_node="$(command -v node || true)"
  fi
  if [[ -z "$bootstrap_node" || ! -x "$bootstrap_node" ]]; then
    printf 'Node is required to generate the external encryption key.\n' >&2
    exit 1
  fi
  bootstrap_npm="${N8N_NPM_BIN:-}"
  if [[ -z "$bootstrap_npm" && -x "$(dirname "$bootstrap_node")/npm" ]]; then
    bootstrap_npm="$(dirname "$bootstrap_node")/npm"
  fi
  if [[ -z "$bootstrap_npm" ]]; then
    bootstrap_npm="$(command -v npm || true)"
  fi

  encryption_key="$($bootstrap_node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  env_tmp="$ENV_FILE.tmp.$$"
  awk -v key="$encryption_key" -v node_bin="$bootstrap_node" -v npm_bin="$bootstrap_npm" '
    /^N8N_NODE_BIN=/ { print "N8N_NODE_BIN=\"" node_bin "\""; next }
    /^N8N_NPM_BIN=/ { print "N8N_NPM_BIN=\"" npm_bin "\""; next }
    /^N8N_ENCRYPTION_KEY=/ { print "N8N_ENCRYPTION_KEY=\"" key "\""; next }
    { print }
  ' "$ENV_FILE" > "$env_tmp"
  mv "$env_tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf 'Created external n8n environment: %s\n' "$ENV_FILE"
else
  chmod 600 "$ENV_FILE"
  printf 'Keeping existing n8n environment: %s\n' "$ENV_FILE"
fi

n8n_load_environment
n8n_require_node
n8n_prepare_runtime_directories

if n8n_pid_is_running || n8n_launch_job_loaded || n8n_health_is_available; then
  printf 'Refusing to replace n8n dependencies while the service is running.\n' >&2
  printf 'Run scripts/n8n-stop.sh and verify scripts/n8n-status.sh before reinstalling.\n' >&2
  exit 1
fi

if [[ -z "${N8N_ENCRYPTION_KEY:-}" ]]; then
  printf 'N8N_ENCRYPTION_KEY is empty in %s\n' "$ENV_FILE" >&2
  exit 1
fi
if [[ "${#N8N_ENCRYPTION_KEY}" -lt 32 ]]; then
  printf 'N8N_ENCRYPTION_KEY in %s must contain at least 32 characters.\n' "$ENV_FILE" >&2
  exit 1
fi
if [[ -z "${N8N_NPM_BIN:-}" || ! -x "$N8N_NPM_BIN" ]]; then
  printf 'npm executable is unavailable: %s\n' "${N8N_NPM_BIN:-<empty>}" >&2
  exit 1
fi

printf 'Installing pinned n8n runtime from package-lock.json...\n'
(
  cd "$AIWORKER_N8N_PROJECT_DIR"
  "$N8N_NPM_BIN" ci --omit=dev --no-audit --no-fund
)

installed_version="$($N8N_NODE_BIN -p "require('$AIWORKER_N8N_PROJECT_DIR/node_modules/n8n/package.json').version")"
if [[ "$installed_version" != "2.31.6" ]]; then
  printf 'Unexpected n8n version: %s (expected 2.31.6)\n' "$installed_version" >&2
  exit 1
fi

printf 'n8n %s installed successfully.\n' "$installed_version"
printf 'Runtime state: %s\n' "$N8N_USER_FOLDER"
printf 'Logs: %s\n' "$AIWORKER_N8N_LOG_DIR"
printf 'PID/runtime files: %s\n' "$AIWORKER_N8N_RUN_DIR"
