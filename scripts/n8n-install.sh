#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../ops/n8n/lib/common.sh
source "$REPOSITORY_ROOT/ops/n8n/lib/common.sh"

ENV_FILE="$(n8n_env_file)"
ENV_TEMPLATE="$AIWORKER_N8N_SOURCE_DIR/.env.example"

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

case "$AIWORKER_N8N_RUNTIME_ROOT" in
  /*) ;;
  *)
    printf 'AIWORKER_N8N_RUNTIME_ROOT must be an absolute path: %s\n' "$AIWORKER_N8N_RUNTIME_ROOT" >&2
    exit 1
    ;;
esac
case "$AIWORKER_N8N_RUNTIME_ROOT" in
  "$AIWORKER_REPOSITORY_ROOT"|"$AIWORKER_REPOSITORY_ROOT"/*)
    printf 'AIWORKER_N8N_RUNTIME_ROOT must be outside the Git repository: %s\n' "$AIWORKER_N8N_RUNTIME_ROOT" >&2
    exit 1
    ;;
  "$HOME/Documents"|"$HOME/Documents"/*|"$HOME/Desktop"|"$HOME/Desktop"/*|"$HOME/Downloads"|"$HOME/Downloads"/*)
    printf 'AIWORKER_N8N_RUNTIME_ROOT cannot use a macOS privacy-protected user directory: %s\n' "$AIWORKER_N8N_RUNTIME_ROOT" >&2
    exit 1
    ;;
esac

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

source_commit="$(git -C "$AIWORKER_REPOSITORY_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'A full Git commit is required to build the n8n runtime.\n' >&2
  exit 1
fi
if [[ -n "$(git -C "$AIWORKER_REPOSITORY_ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  printf 'Refusing to build the production runtime from a dirty Git worktree.\n' >&2
  exit 1
fi

source_origin="$(git -C "$AIWORKER_REPOSITORY_ROOT" remote get-url origin 2>/dev/null || printf 'unknown')"
source_origin="$(printf '%s' "$source_origin" | sed -E \
  -e 's#((https?|ssh)://)[^/@]+@#\1#' \
  -e 's#([?&])(access_token|token|auth|password|key)=[^&]*#\1redacted=1#g')"
lock_sha="$(shasum -a 256 "$AIWORKER_N8N_SOURCE_DIR/package-lock.json" | awk '{print $1}')"
workflow_sha="$(shasum -a 256 "$AIWORKER_N8N_SOURCE_DIR/workflows/aiworker-task-intake.json" | awk '{print $1}')"
expected_runtime_source_manifest_sha="$(n8n_runtime_source_manifest_sha256 "$AIWORKER_REPOSITORY_ROOT")"
release_root="$AIWORKER_N8N_RUNTIME_ROOT/releases"
release_dir="$release_root/$source_commit"

install -d -m 700 "$AIWORKER_N8N_RUNTIME_ROOT" "$release_root"
runtime_root_physical="$(cd "$AIWORKER_N8N_RUNTIME_ROOT" && pwd -P)"
case "$runtime_root_physical" in
  "$AIWORKER_REPOSITORY_ROOT"|"$AIWORKER_REPOSITORY_ROOT"/*|"$HOME/Documents"|"$HOME/Documents"/*|"$HOME/Desktop"|"$HOME/Desktop"/*|"$HOME/Downloads"|"$HOME/Downloads"/*)
    printf 'Resolved n8n runtime root is not safe for LaunchAgent execution: %s\n' "$runtime_root_physical" >&2
    exit 1
    ;;
esac
if [[ -e "$AIWORKER_N8N_RUNTIME_CURRENT" && ! -L "$AIWORKER_N8N_RUNTIME_CURRENT" ]]; then
  printf 'Runtime current path exists but is not a symlink: %s\n' "$AIWORKER_N8N_RUNTIME_CURRENT" >&2
  exit 1
fi

if [[ ! -d "$release_dir" ]]; then
  staging_dir="$(mktemp -d "$release_root/.staging-${source_commit:0:12}.XXXXXX")"
  install -d -m 700 \
    "$staging_dir/scripts" \
    "$staging_dir/ops/n8n/lib" \
    "$staging_dir/ops/n8n/workflows"

  for control_script in n8n-start.sh n8n-stop.sh n8n-status.sh n8n-import-workflows.sh; do
    install -m 700 "$SCRIPT_DIR/$control_script" "$staging_dir/scripts/$control_script"
  done
  install -m 700 "$AIWORKER_N8N_SOURCE_DIR/lib/common.sh" "$staging_dir/ops/n8n/lib/common.sh"
  install -m 600 "$AIWORKER_N8N_SOURCE_DIR/.env.example" "$staging_dir/ops/n8n/.env.example"
  install -m 600 "$AIWORKER_N8N_SOURCE_DIR/package.json" "$staging_dir/ops/n8n/package.json"
  install -m 600 "$AIWORKER_N8N_SOURCE_DIR/package-lock.json" "$staging_dir/ops/n8n/package-lock.json"
  install -m 600 \
    "$AIWORKER_N8N_SOURCE_DIR/workflows/aiworker-task-intake.json" \
    "$staging_dir/ops/n8n/workflows/aiworker-task-intake.json"

  printf 'Installing pinned n8n runtime in staged release %s...\n' "$source_commit"
  (
    cd "$staging_dir/ops/n8n"
    "$N8N_NPM_BIN" ci --omit=dev --no-audit --no-fund
  )

  staged_version="$($N8N_NODE_BIN -p "require('$staging_dir/ops/n8n/node_modules/n8n/package.json').version")"
  if [[ "$staged_version" != "2.31.6" ]]; then
    printf 'Unexpected n8n version: %s (expected 2.31.6)\n' "$staged_version" >&2
    exit 1
  fi

  printf '%s\n' "$source_commit" > "$staging_dir/SOURCE_COMMIT"
  n8n_runtime_source_manifest "$staging_dir" > "$staging_dir/RUNTIME_SOURCE_SHA256SUMS"
  runtime_source_manifest_sha="$(shasum -a 256 "$staging_dir/RUNTIME_SOURCE_SHA256SUMS" | awk '{print $1}')"
  if [[ "$runtime_source_manifest_sha" != "$expected_runtime_source_manifest_sha" ]]; then
    printf 'Staged runtime does not match the clean Git source.\n' >&2
    exit 1
  fi
  {
    printf 'source_origin=%s\n' "$source_origin"
    printf 'source_commit=%s\n' "$source_commit"
    printf 'package_lock_sha256=%s\n' "$lock_sha"
    printf 'workflow_sha256=%s\n' "$workflow_sha"
    printf 'runtime_source_manifest_sha256=%s\n' "$runtime_source_manifest_sha"
    printf 'n8n_version=%s\n' "$staged_version"
    printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$staging_dir/SOURCE_MANIFEST"
  chmod 600 "$staging_dir/SOURCE_COMMIT" "$staging_dir/SOURCE_MANIFEST" "$staging_dir/RUNTIME_SOURCE_SHA256SUMS"
  mv "$staging_dir" "$release_dir"
else
  release_commit="$(tr -d '[:space:]' < "$release_dir/SOURCE_COMMIT" 2>/dev/null || true)"
  release_version="$($N8N_NODE_BIN -p "require('$release_dir/ops/n8n/node_modules/n8n/package.json').version" 2>/dev/null || true)"
  if [[ "$release_commit" != "$source_commit" \
    || "$release_version" != "2.31.6" \
    || ! -f "$release_dir/SOURCE_MANIFEST" \
    || ! -f "$release_dir/RUNTIME_SOURCE_SHA256SUMS" ]] \
    || ! grep -Fqx "package_lock_sha256=$lock_sha" "$release_dir/SOURCE_MANIFEST" \
    || ! grep -Fqx "workflow_sha256=$workflow_sha" "$release_dir/SOURCE_MANIFEST" \
    || ! n8n_release_matches_repository_source "$release_dir"; then
    printf 'Existing runtime release failed validation: %s\n' "$release_dir" >&2
    exit 1
  fi
  printf 'Reusing validated n8n runtime release: %s\n' "$release_dir"
fi

if [[ -d "$N8N_USER_FOLDER" ]] && [[ -n "$(find "$N8N_USER_FOLDER" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  backup_stamp="$(date +%Y%m%d-%H%M%S)"
  release_backup="$AIWORKER_N8N_BACKUP_DIR/pre-release-$backup_stamp-${source_commit:0:12}"
  install -d -m 700 "$release_backup"
  state_archive="$release_backup/n8n-state.tar.gz"
  tar -czf "$state_archive" -C "$(dirname "$N8N_USER_FOLDER")" "$(basename "$N8N_USER_FOLDER")"
  install -m 600 "$ENV_FILE" "$release_backup/n8n.env"
  previous_release="$(readlink "$AIWORKER_N8N_RUNTIME_CURRENT" 2>/dev/null || printf 'none')"
  if [[ "$previous_release" != "none" && -f "$previous_release/SOURCE_MANIFEST" ]]; then
    install -m 600 "$previous_release/SOURCE_MANIFEST" "$release_backup/previous-release-manifest"
  fi
  install -m 600 "$release_dir/SOURCE_MANIFEST" "$release_backup/target-release-manifest"
  {
    printf 'previous_release=%s\n' "$previous_release"
    printf 'target_release=%s\n' "$release_dir"
  } > "$release_backup/RELEASE_TRANSITION"
  checksum_targets=("$state_archive" "$release_backup/n8n.env" "$release_backup/target-release-manifest" "$release_backup/RELEASE_TRANSITION")
  if [[ -f "$release_backup/previous-release-manifest" ]]; then
    checksum_targets+=("$release_backup/previous-release-manifest")
  fi
  shasum -a 256 "${checksum_targets[@]}" > "$release_backup/SHA256SUMS"
  chmod 600 "${checksum_targets[@]}" "$release_backup/SHA256SUMS"
  printf 'Backed up state and matching environment before release switch: %s\n' "$release_backup"
fi

activation_link="$AIWORKER_N8N_RUNTIME_ROOT/.current-next-${source_commit:0:12}-$$"
if [[ -e "$activation_link" || -L "$activation_link" ]]; then
  printf 'Temporary runtime activation path already exists: %s\n' "$activation_link" >&2
  exit 1
fi
ln -s "$release_dir" "$activation_link"
if [[ "$(readlink "$activation_link" 2>/dev/null || true)" != "$release_dir" ]]; then
  printf 'Failed to prepare runtime activation link: %s\n' "$activation_link" >&2
  exit 1
fi
"$N8N_NODE_BIN" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
  "$activation_link" "$AIWORKER_N8N_RUNTIME_CURRENT"
if [[ "$(readlink "$AIWORKER_N8N_RUNTIME_CURRENT" 2>/dev/null || true)" != "$release_dir" ]]; then
  printf 'Failed to activate generated n8n runtime: %s\n' "$release_dir" >&2
  exit 1
fi
installed_version="$($N8N_NODE_BIN -p "require('$AIWORKER_N8N_RUNTIME_DIR/node_modules/n8n/package.json').version")"

printf 'n8n %s installed successfully.\n' "$installed_version"
printf 'Active generated runtime: %s -> %s\n' "$AIWORKER_N8N_RUNTIME_CURRENT" "$release_dir"
printf 'Source commit: %s\n' "$source_commit"
printf 'Runtime state: %s\n' "$N8N_USER_FOLDER"
printf 'Logs: %s\n' "$AIWORKER_N8N_LOG_DIR"
printf 'PID/runtime files: %s\n' "$AIWORKER_N8N_RUN_DIR"
