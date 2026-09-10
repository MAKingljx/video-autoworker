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

repository_commit="$(git -C "$AIWORKER_REPOSITORY_ROOT" rev-parse HEAD 2>/dev/null || true)"
runtime_commit="$(tr -d '[:space:]' < "$AIWORKER_N8N_RUNTIME_CURRENT/SOURCE_COMMIT" 2>/dev/null || true)"
if [[ -n "$(git -C "$AIWORKER_REPOSITORY_ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  printf 'Refusing to install a LaunchAgent from a dirty Git worktree.\n' >&2
  exit 1
fi
if [[ ! "$repository_commit" =~ ^[0-9a-f]{40}$ || "$runtime_commit" != "$repository_commit" ]]; then
  printf 'Generated runtime does not match the checked-out Git commit. Run scripts/n8n-install.sh first.\n' >&2
  exit 1
fi
runtime_target="$(readlink "$AIWORKER_N8N_RUNTIME_CURRENT" 2>/dev/null || true)"
case "$runtime_target" in
  "$AIWORKER_N8N_RUNTIME_ROOT/releases/"*) ;;
  *)
    printf 'Generated runtime current link has an unexpected target: %s\n' "${runtime_target:-<empty>}" >&2
    exit 1
    ;;
esac
case "$runtime_target" in
  "$HOME/Documents"|"$HOME/Documents"/*|"$HOME/Desktop"|"$HOME/Desktop"/*|"$HOME/Downloads"|"$HOME/Downloads"/*)
    printf 'Generated runtime target is inside a macOS privacy-protected directory: %s\n' "$runtime_target" >&2
    exit 1
    ;;
esac
if ! n8n_release_matches_repository_source "$runtime_target"; then
  printf 'Generated runtime source integrity validation failed: %s\n' "$runtime_target" >&2
  exit 1
fi
if [[ ! -x "$AIWORKER_N8N_RUNTIME_CURRENT/scripts/n8n-start.sh" ]]; then
  printf 'Generated runtime start script is unavailable: %s\n' "$AIWORKER_N8N_RUNTIME_CURRENT/scripts/n8n-start.sh" >&2
  exit 1
fi
if ! n8n_launch_job_loaded && (n8n_pid_is_running || n8n_health_is_available); then
  printf 'n8n is already running outside the LaunchAgent; stop it before installing the service.\n' >&2
  exit 1
fi

TEMPLATE="$AIWORKER_N8N_SOURCE_DIR/launchd/$AIWORKER_N8N_LAUNCH_LABEL.plist.template"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET="$TARGET_DIR/$AIWORKER_N8N_LAUNCH_LABEL.plist"
RENDERED="$AIWORKER_N8N_RUN_DIR/$AIWORKER_N8N_LAUNCH_LABEL.plist.rendered"
ENV_FILE="$(n8n_env_file)"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\\&apos;/g"
}

runtime_root_xml="$(xml_escape "$AIWORKER_N8N_RUNTIME_ROOT")"
env_xml="$(xml_escape "$ENV_FILE")"
node_dir_xml="$(xml_escape "$(dirname "$N8N_NODE_BIN")")"
log_dir_xml="$(xml_escape "$AIWORKER_N8N_LOG_DIR")"

sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

runtime_root_replacement="$(sed_replacement "$runtime_root_xml")"
env_replacement="$(sed_replacement "$env_xml")"
node_dir_replacement="$(sed_replacement "$node_dir_xml")"
log_dir_replacement="$(sed_replacement "$log_dir_xml")"

sed \
  -e "s|__RUNTIME_ROOT__|$runtime_root_replacement|g" \
  -e "s|__ENV_FILE__|$env_replacement|g" \
  -e "s|__NODE_BIN_DIR__|$node_dir_replacement|g" \
  -e "s|__LOG_DIR__|$log_dir_replacement|g" \
  "$TEMPLATE" > "$RENDERED"
plutil -lint "$RENDERED" >/dev/null

mkdir -p "$TARGET_DIR"
if [[ -f "$TARGET" ]] && ! cmp -s "$RENDERED" "$TARGET"; then
  backup_dir="$HOME/ai-worker/backups/n8n-launchagent-$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$backup_dir"
  cp "$TARGET" "$backup_dir/"
  printf 'Backed up previous LaunchAgent to %s\n' "$backup_dir"
fi

if n8n_launch_job_loaded; then
  launchctl bootout "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"
  for attempt in $(seq 1 30); do
    if ! n8n_pid_is_running && ! n8n_health_is_available; then
      break
    fi
    sleep 1
  done
  if n8n_pid_is_running || n8n_health_is_available; then
    printf 'Previous n8n process did not stop after unloading the LaunchAgent.\n' >&2
    exit 1
  fi
fi
install -m 600 "$RENDERED" "$TARGET"
launchctl bootstrap "$(n8n_launch_domain)" "$TARGET"
launchctl enable "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"
launchctl kickstart -k "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"

for attempt in $(seq 1 60); do
  if n8n_launch_job_loaded && n8n_pid_is_running && n8n_health_is_available; then
    printf 'Installed and started LaunchAgent: %s\n' "$TARGET"
    printf 'n8n is healthy: %s\n' "$(n8n_health_url)"
    exit 0
  fi
  sleep 1
done

printf 'LaunchAgent was installed but no owned healthy n8n process appeared within 60 seconds.\n' >&2
printf 'Inspect %s and %s/n8n.error.log.\n' "$AIWORKER_N8N_LOG_FILE" "$AIWORKER_N8N_LOG_DIR" >&2
exit 1
