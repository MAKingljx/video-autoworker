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

TEMPLATE="$AIWORKER_N8N_PROJECT_DIR/launchd/$AIWORKER_N8N_LAUNCH_LABEL.plist.template"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET="$TARGET_DIR/$AIWORKER_N8N_LAUNCH_LABEL.plist"
RENDERED="$AIWORKER_N8N_RUN_DIR/$AIWORKER_N8N_LAUNCH_LABEL.plist.rendered"
ENV_FILE="$(n8n_env_file)"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\\&apos;/g"
}

repo_xml="$(xml_escape "$AIWORKER_REPOSITORY_ROOT")"
env_xml="$(xml_escape "$ENV_FILE")"
node_dir_xml="$(xml_escape "$(dirname "$N8N_NODE_BIN")")"
log_dir_xml="$(xml_escape "$AIWORKER_N8N_LOG_DIR")"

sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

repo_replacement="$(sed_replacement "$repo_xml")"
env_replacement="$(sed_replacement "$env_xml")"
node_dir_replacement="$(sed_replacement "$node_dir_xml")"
log_dir_replacement="$(sed_replacement "$log_dir_xml")"

sed \
  -e "s|__REPOSITORY_ROOT__|$repo_replacement|g" \
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
fi
install -m 600 "$RENDERED" "$TARGET"
launchctl bootstrap "$(n8n_launch_domain)" "$TARGET"
launchctl enable "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"
launchctl kickstart -k "$(n8n_launch_domain)/$AIWORKER_N8N_LAUNCH_LABEL"

printf 'Installed and started LaunchAgent: %s\n' "$TARGET"
