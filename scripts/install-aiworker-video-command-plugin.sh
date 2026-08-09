#!/usr/bin/env bash
set -euo pipefail

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
RUNTIME_VALIDATOR="$PLUGIN_DIR/scripts/validate-runtime-inspection.mjs"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
PROFILE_STATE_DB="$PROFILE_STATE_DIR/state/openclaw.sqlite"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
INSTALL_LOCK_DIR="$BACKUP_ROOT/.qwen-current-first-install.lock"
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

for command_name in cmp git grep hostname node openclaw sqlite3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  fi
done

openclaw_version="$(openclaw --version)"
case "$openclaw_version" in
  "OpenClaw 2026.7.1-2 ("*")") ;;
  *)
    printf 'Unsupported OpenClaw version for this installer: %s\n' "$openclaw_version" >&2
    exit 1
    ;;
esac

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
if [[ ! -f "$PROFILE_STATE_DB" ]]; then
  printf 'Required qwen-current plugin state database is missing.\n' >&2
  exit 1
fi

plugin_index_type() {
  local database_path="$1"
  local record_type
  record_type="$(sqlite3 -readonly "$database_path" \
    "SELECT COALESCE(json_type(install_records_json, '$.\"$PLUGIN_ID\"'), 'absent') FROM installed_plugin_index WHERE index_key = 'installed-plugin-index' ORDER BY generated_at_ms DESC LIMIT 1;")" \
    || return 1
  printf '%s\n' "${record_type:-absent}"
}

assert_plugin_index_absent() {
  local database_path="$1"
  local record_type
  record_type="$(plugin_index_type "$database_path")" || return 1
  if [[ "$record_type" != "absent" ]]; then
    printf 'Plugin install-index record must be absent, got: %s\n' "$record_type" >&2
    return 1
  fi
}

assert_plugin_index_present() {
  local database_path="$1"
  local record_type
  record_type="$(plugin_index_type "$database_path")" || return 1
  if [[ "$record_type" != "object" ]]; then
    printf 'Plugin install-index record must be an object, got: %s\n' "$record_type" >&2
    return 1
  fi
}

verify_doctor_report() {
  local report_path="$1"
  if ! grep -Fqx 'No plugin issues detected.' "$report_path"; then
    printf 'OpenClaw plugin doctor did not report a clean result.\n' >&2
    return 1
  fi
}

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

verify_first_install_state() {
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pluginId = process.argv[2];
    const plugins = config?.plugins ?? {};
    if (Array.isArray(plugins.allow) && plugins.allow.includes(pluginId)) {
      throw new Error("Target plugin is already present in the allowlist.");
    }
    if (plugins.entries && Object.prototype.hasOwnProperty.call(plugins.entries, pluginId)) {
      throw new Error("Target plugin already has a profile entry.");
    }
  ' "$PROFILE_CONFIG" "$PLUGIN_ID"
  if [[ -e "$INSTALLED_PLUGIN_DIR" ]]; then
    printf 'Target plugin directory already exists; this installer only permits a first install.\n' >&2
    return 1
  fi
  if openclaw --profile "$PROFILE" plugins inspect "$PLUGIN_ID" --json >/dev/null 2>&1; then
    printf 'Target plugin is already discoverable; this installer only permits a first install.\n' >&2
    return 1
  fi
  assert_plugin_index_absent "$PROFILE_STATE_DB"
}

verify_first_install_state

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
  "$RUNTIME_VALIDATOR"
  "$PLUGIN_DIR/scripts/run-isolated-video-command-qa.mjs"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Plugin source is incomplete: %s\n' "$required_file" >&2
    exit 1
  fi
done

node -e '
  const fs = require("node:fs");
  const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const pluginId = process.argv[3];
  const extensions = packageJson?.openclaw?.extensions;
  const schema = manifest?.configSchema;
  if (manifest?.id !== pluginId) throw new Error("Plugin manifest id mismatch.");
  if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== "./index.js") {
    throw new Error("Plugin package must declare only ./index.js.");
  }
  if (schema?.type !== "object" || schema?.additionalProperties !== false) {
    throw new Error("Plugin manifest must use a strict object config schema.");
  }
' "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/openclaw.plugin.json" "$PLUGIN_ID"
while IFS= read -r javascript_file; do
  node --check "$javascript_file"
done < <(find "$PLUGIN_DIR" -type f \( -name '*.js' -o -name '*.mjs' \) -print | LC_ALL=C sort)

run_isolated_runtime_check() {
  isolated_state_dir="$(mktemp -d "/tmp/aiworker-plugin-dry-run.XXXXXX")"
  isolated_config="$isolated_state_dir/openclaw.json"
  isolated_report="$isolated_state_dir/runtime-inspect.json"
  isolated_doctor="$isolated_state_dir/plugins-doctor.txt"

  cleanup_isolated_state() {
    if [[ -z "${isolated_state_dir:-}" || ! -d "$isolated_state_dir" ]]; then return; fi
    case "$isolated_state_dir" in
      /tmp/aiworker-plugin-dry-run.*|/private/tmp/aiworker-plugin-dry-run.*)
        rm -rf -- "$isolated_state_dir"
        ;;
      *)
        printf 'Refusing to clean unexpected isolated state path.\n' >&2
        return 1
        ;;
    esac
  }
  trap cleanup_isolated_state EXIT HUP INT TERM

  node -e '
    const fs = require("node:fs");
    const config = { plugins: { allow: [process.argv[2]] } };
    fs.writeFileSync(process.argv[1], `${JSON.stringify(config)}\n`, { mode: 0o600 });
  ' "$isolated_config" "$PLUGIN_ID"
  OPENCLAW_STATE_DIR="$isolated_state_dir" OPENCLAW_CONFIG_PATH="$isolated_config" \
    openclaw plugins install --force "$PLUGIN_DIR"
  assert_plugin_index_present "$isolated_state_dir/state/openclaw.sqlite"
  OPENCLAW_STATE_DIR="$isolated_state_dir" OPENCLAW_CONFIG_PATH="$isolated_config" \
    openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$isolated_report"
  node "$RUNTIME_VALIDATOR" "$isolated_report" "$PLUGIN_ID"
  NO_COLOR=1 OPENCLAW_STATE_DIR="$isolated_state_dir" OPENCLAW_CONFIG_PATH="$isolated_config" \
    openclaw plugins doctor > "$isolated_doctor"
  verify_doctor_report "$isolated_doctor"

  cleanup_isolated_state
  trap - EXIT HUP INT TERM
}

run_isolated_runtime_check

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Dry run passed static and isolated runtime checks: profile=%s plugin=%s\n' "$PROFILE" "$PLUGIN_ID"
  printf 'No qwen-current config, plugin, or service state was changed.\n'
  exit 0
fi

umask 077
stamp="$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$BACKUP_ROOT"
if ! mkdir "$INSTALL_LOCK_DIR"; then
  printf 'Another qwen-current plugin installation holds the first-install lock.\n' >&2
  exit 1
fi
lock_acquired=1
release_install_lock() {
  if [[ "${lock_acquired:-0}" -eq 0 ]]; then return; fi
  if ! rmdir "$INSTALL_LOCK_DIR"; then
    return 1
  fi
  lock_acquired=0
}
trap release_install_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

backup_dir="$(mktemp -d "$BACKUP_ROOT/$stamp.XXXXXX")"
install -m 600 "$PROFILE_CONFIG" "$backup_dir/openclaw.json"
chmod -R go-rwx "$backup_dir"
pre_doctor_report="$backup_dir/pre-install-plugins-doctor.txt"
NO_COLOR=1 openclaw --profile "$PROFILE" plugins doctor > "$pre_doctor_report"
verify_doctor_report "$pre_doctor_report"
verify_first_install_state

restore_failed_install() {
  install_status=$?
  trap - EXIT HUP INT TERM
  if [[ "$install_status" -eq 0 ]]; then return; fi
  set +e
  rollback_failed=0

  if [[ -e "$INSTALLED_PLUGIN_DIR" ]]; then
    cp -R -p "$INSTALLED_PLUGIN_DIR" "$backup_dir/failed-installed-extension" \
      || rollback_failed=1
  fi

  openclaw --profile "$PROFILE" plugins uninstall "$PLUGIN_ID" --force \
    > "$backup_dir/rollback-uninstall.txt" 2>&1
  if [[ "$?" -ne 0 ]]; then
    rollback_failed=1
  fi

  install -m 600 "$backup_dir/openclaw.json" "$PROFILE_CONFIG" || rollback_failed=1
  if [[ -e "$INSTALLED_PLUGIN_DIR" ]]; then
    mv "$INSTALLED_PLUGIN_DIR" "$backup_dir/failed-installed-extension-residual" \
      || rollback_failed=1
  fi
  cmp -s "$backup_dir/openclaw.json" "$PROFILE_CONFIG" || rollback_failed=1
  if openclaw --profile "$PROFILE" plugins inspect "$PLUGIN_ID" --json \
    > "$backup_dir/rollback-inspect.json" 2>&1; then
    rollback_failed=1
  fi
  assert_plugin_index_absent "$PROFILE_STATE_DB" || rollback_failed=1
  NO_COLOR=1 openclaw --profile "$PROFILE" plugins doctor \
    > "$backup_dir/rollback-doctor.txt" 2>&1 || rollback_failed=1
  verify_doctor_report "$backup_dir/rollback-doctor.txt" || rollback_failed=1

  if [[ "$rollback_failed" -ne 0 ]]; then
    release_install_lock || true
    printf 'ROLLBACK FAILED: qwen-current requires manual inspection; no success may be reported.\n' >&2
    printf 'Backup retained: %s\n' "$backup_dir" >&2
    exit 70
  fi

  release_install_lock || rollback_failed=1
  if [[ "$rollback_failed" -ne 0 ]]; then
    printf 'ROLLBACK FAILED: the installation lock could not be released.\n' >&2
    printf 'Backup retained: %s\n' "$backup_dir" >&2
    exit 70
  fi
  printf 'Install failed; the first-install plugin state and qwen-current config were restored.\n' >&2
  printf 'Backup retained: %s\n' "$backup_dir" >&2
  exit "$install_status"
}
trap restore_failed_install EXIT

openclaw --profile "$PROFILE" plugins install --force "$PLUGIN_DIR"
verify_explicit_allowlist post-install
if [[ ! -d "$INSTALLED_PLUGIN_DIR" ]]; then
  printf 'Installed plugin directory is missing.\n' >&2
  false
fi
assert_plugin_index_present "$PROFILE_STATE_DB"
runtime_report="$backup_dir/runtime-inspect.json"
doctor_report="$backup_dir/plugins-doctor.txt"
openclaw --profile "$PROFILE" plugins inspect "$PLUGIN_ID" --runtime --json > "$runtime_report"
node "$RUNTIME_VALIDATOR" "$runtime_report" "$PLUGIN_ID"
NO_COLOR=1 openclaw --profile "$PROFILE" plugins doctor > "$doctor_report"
verify_doctor_report "$doctor_report"
release_install_lock
trap - EXIT HUP INT TERM

printf 'Installed plugin for profile %s; the official config write may have refreshed that profile.\n' "$PROFILE"
printf 'Backup retained: %s\n' "$backup_dir"
printf 'Verify qwen-current PID and health, refresh only if required, then run isolated acceptance.\n'
