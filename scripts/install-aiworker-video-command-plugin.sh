#!/usr/bin/env bash
set -euo pipefail

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
MODE="dry-run"

usage() {
  printf 'Usage: %s [--dry-run|--apply]\n' "$0"
}

case "${1:---dry-run}" in
  --dry-run) MODE="dry-run" ;;
  --apply) MODE="apply" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [[ "$#" -gt 1 ]]; then
  usage >&2
  exit 2
fi

for command_name in git hostname node openclaw; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  fi
done

actual_user="$(id -un)"
actual_host="$(hostname)"
if [[ "$actual_user" != "$EXPECTED_USER" || "$actual_host" != "$EXPECTED_HOST" ]]; then
  printf 'Refusing non-production identity: user=%s host=%s\n' "$actual_user" "$actual_host" >&2
  exit 1
fi
if [[ ! -f "$PROFILE_CONFIG" ]]; then
  printf 'Required qwen-current profile config is missing.\n' >&2
  exit 1
fi

verify_explicit_allowlist() {
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const allow = config?.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      console.error("qwen-current must use a non-empty explicit plugin allowlist.");
      process.exit(1);
    }
    if (process.argv[2] === "post-install" && !allow.includes(process.argv[3])) {
      console.error("Installed plugin is missing from the explicit allowlist.");
      process.exit(1);
    }
  ' "$PROFILE_CONFIG" "$1" "$PLUGIN_ID"
}

verify_explicit_allowlist pre-install

remote_url="$(git -C "$REPOSITORY_ROOT" remote get-url origin)"
case "$remote_url" in
  https://github.com/MAKingljx/video-autoworker|https://github.com/MAKingljx/video-autoworker.git|git@github.com:MAKingljx/video-autoworker.git) ;;
  *) printf 'Canonical Git remote mismatch.\n' >&2; exit 1 ;;
esac
if [[ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=normal)" ]]; then
  printf 'Canonical Git checkout must be clean.\n' >&2
  exit 1
fi

required_files=(
  "$PLUGIN_DIR/package.json"
  "$PLUGIN_DIR/openclaw.plugin.json"
  "$PLUGIN_DIR/index.js"
  "$PLUGIN_DIR/lib/before-dispatch.js"
  "$PLUGIN_DIR/lib/parse-video-command.js"
  "$PLUGIN_DIR/lib/runner.js"
  "$PLUGIN_DIR/lib/stable-message-key.js"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Plugin source is incomplete: %s\n' "$required_file" >&2
    exit 1
  fi
done

node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"))' \
  "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/openclaw.plugin.json"
while IFS= read -r javascript_file; do
  node --check "$javascript_file"
done < <(find "$PLUGIN_DIR" -type f -name '*.js' -print | LC_ALL=C sort)
openclaw --profile "$PROFILE" plugins validate --root "$PLUGIN_DIR" --entry index.js

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Dry run passed: profile=%s plugin=%s\n' "$PROFILE" "$PLUGIN_ID"
  printf 'No config, plugin, or service state was changed.\n'
  exit 0
fi

umask 077
stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$BACKUP_ROOT/$stamp"
install -d -m 700 "$backup_dir"
install -m 600 "$PROFILE_CONFIG" "$backup_dir/openclaw.json"
if [[ -d "$INSTALLED_PLUGIN_DIR" ]]; then
  cp -R -p "$INSTALLED_PLUGIN_DIR" "$backup_dir/extension"
fi
chmod -R go-rwx "$backup_dir"

restore_failed_install() {
  install_status=$?
  if [[ "$install_status" -eq 0 ]]; then return; fi

  if [[ -e "$INSTALLED_PLUGIN_DIR" ]]; then
    mv "$INSTALLED_PLUGIN_DIR" "$backup_dir/failed-installed-extension"
  fi
  if [[ -d "$backup_dir/extension" ]]; then
    cp -R -p "$backup_dir/extension" "$INSTALLED_PLUGIN_DIR"
  fi
  install -m 600 "$backup_dir/openclaw.json" "$PROFILE_CONFIG"
  printf 'Install failed; prior qwen-current config and plugin files were restored.\n' >&2
  printf 'Backup retained: %s\n' "$backup_dir" >&2
  exit "$install_status"
}
trap restore_failed_install ERR

openclaw --profile "$PROFILE" plugins install --force "$PLUGIN_DIR"
verify_explicit_allowlist post-install
if [[ ! -d "$INSTALLED_PLUGIN_DIR" ]]; then
  printf 'Installed plugin directory is missing.\n' >&2
  false
fi
trap - ERR

printf 'Installed plugin for profile %s without restarting services.\n' "$PROFILE"
printf 'Backup retained: %s\n' "$backup_dir"
printf 'A separately authorized qwen-current-only restart and isolated acceptance test are still required.\n'
