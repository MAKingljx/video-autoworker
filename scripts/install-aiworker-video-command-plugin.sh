#!/usr/bin/env bash
set -euo pipefail

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
SOURCE_VERSION="0.3.0"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
RUNTIME_VALIDATOR="$PLUGIN_DIR/scripts/validate-runtime-inspection.mjs"
DOCTOR_VALIDATOR="$PLUGIN_DIR/scripts/validate-plugin-doctor.mjs"
ABSENCE_VALIDATOR="$PLUGIN_DIR/scripts/validate-plugin-absence.mjs"
UPGRADE_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-command-upgrade.mjs"
UPGRADE_POLICY_HELPER="$REPOSITORY_ROOT/scripts/lib/aiworker-video-command-upgrade-policy.mjs"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
PROFILE_STATE_DB="$PROFILE_STATE_DIR/state/openclaw.sqlite"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
INSTALL_LOCK_DIR="$BACKUP_ROOT/.qwen-current-first-install.lock"
MODE="dry-run"
ALLOWED_SENDER_SHA256=""
INITIAL_ALLOWED_SENDER_SHA256=""

run_qwen_openclaw() {
  env -u OPENCLAW_PROFILE \
    -u OPENCLAW_STATE_DIR \
    -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME \
    -u OPENCLAW_INCLUDE_ROOTS \
    openclaw --profile "$PROFILE" "$@"
}

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

for command_name in cmp env git hostname node openclaw shasum sqlite3 stat; do
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

prepare_isolated_sqlite_read() {
  local database_path="$1"
  if [[ ! -f "$database_path" ]]; then
    printf 'Isolated OpenClaw state database is missing.\n' >&2
    return 1
  fi
  # OpenClaw creates this database in WAL mode. A brand-new closed database can
  # lack the transient -shm sidecar, which macOS sqlite3 -readonly cannot create.
  # Open it only inside the disposable state with query_only before the strict
  # read-only install-index assertion below.
  sqlite3 "$database_path" \
    'PRAGMA query_only = ON; SELECT 1 FROM sqlite_schema LIMIT 1;' >/dev/null
}

fingerprint_plugin_index() {
  local database_path="$1"
  local record_fingerprint
  if [[ ! -e "$database_path" ]]; then
    printf 'database-absent\n'
    return
  fi
  record_fingerprint="$(sqlite3 -readonly "$database_path" \
    "SELECT COALESCE((SELECT CASE WHEN json_type(install_records_json, '$.\"$PLUGIN_ID\"') IS NULL THEN 'record-absent' ELSE json_type(install_records_json, '$.\"$PLUGIN_ID\"') || ':' || lower(hex(CAST(json_extract(install_records_json, '$.\"$PLUGIN_ID\"') AS BLOB))) END FROM installed_plugin_index WHERE index_key = 'installed-plugin-index' ORDER BY generated_at_ms DESC LIMIT 1), 'row-absent');")" \
    || return 1
  printf 'database-present:%s\n' "$record_fingerprint"
}

verify_doctor_report() {
  local report_path="$1"
  node "$DOCTOR_VALIDATOR" "$report_path" "$PLUGIN_ID"
}

fingerprint_real_path() {
  local target_path="$1"
  local metadata
  local digest
  if [[ ! -e "$target_path" && ! -L "$target_path" ]]; then
    printf 'absent\n'
    return
  fi
  if [[ -L "$target_path" ]]; then
    metadata="$(stat -f '%d:%i:%p:%z:%m:%c' "$target_path")" || return 1
    printf 'symlink:%s\n' "$metadata"
    return
  fi
  if [[ -f "$target_path" ]]; then
    metadata="$(stat -f '%d:%i:%p:%z:%m:%c' "$target_path")" || return 1
    digest="$(shasum -a 256 "$target_path")" || return 1
    printf 'file:%s:%s\n' "$metadata" "$digest"
    return
  fi
  metadata="$(stat -f '%d:%i:%p:%z:%m:%c' "$target_path")" || return 1
  printf 'other:%s\n' "$metadata"
}

protected_default_snapshot() {
  local approvals_fingerprint
  local config_fingerprint
  local extension_fingerprint
  local index_fingerprint
  approvals_fingerprint="$(fingerprint_real_path "$HOME/.openclaw/exec-approvals.json")" || return 1
  config_fingerprint="$(fingerprint_real_path "$HOME/.openclaw/openclaw.json")" || return 1
  extension_fingerprint="$(fingerprint_real_path "$HOME/.openclaw/extensions/$PLUGIN_ID")" || return 1
  index_fingerprint="$(fingerprint_plugin_index "$HOME/.openclaw/state/openclaw.sqlite")" || return 1
  printf '%s\n%s\n%s\n%s\n' \
    "$approvals_fingerprint" "$config_fingerprint" "$extension_fingerprint" "$index_fingerprint"
}

protected_qwen_snapshot() {
  local config_fingerprint
  local extension_fingerprint
  local index_fingerprint
  config_fingerprint="$(fingerprint_real_path "$PROFILE_CONFIG")" || return 1
  extension_fingerprint="$(fingerprint_real_path "$INSTALLED_PLUGIN_DIR")" || return 1
  index_fingerprint="$(fingerprint_plugin_index "$PROFILE_STATE_DB")" || return 1
  printf '%s\n%s\n%s\n' "$config_fingerprint" "$extension_fingerprint" "$index_fingerprint"
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

verify_telegram_ingress_policy() {
  node "$UPGRADE_VALIDATOR" telegram-policy "$PROFILE_CONFIG" "$AGENT_ID"
}

load_owner_sender_policy() {
  local plan
  local owner_count
  local sender_hash
  plan="$(node "$UPGRADE_VALIDATOR" owner-sender-plan "$PROFILE_CONFIG")" || return 1
  owner_count="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(String(p.ownerCount))' "$plan")" \
    || return 1
  sender_hash="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.allowedSenderSha256 ?? "")' "$plan")" \
    || return 1
  if [[ "$owner_count" != "1" || ! "$sender_hash" =~ ^[a-f0-9]{64}$ ]]; then
    printf 'Owner sender policy validator returned an invalid redacted plan.\n' >&2
    return 1
  fi
  ALLOWED_SENDER_SHA256="$sender_hash"
}

verify_plugin_sender_hash() {
  local config_path="$1"
  node "$UPGRADE_VALIDATOR" sender-hash-config \
    "$config_path" "$PLUGIN_ID" "$ALLOWED_SENDER_SHA256"
}

verify_explicit_allowlist pre-install
verify_telegram_ingress_policy
load_owner_sender_policy
INITIAL_ALLOWED_SENDER_SHA256="$ALLOWED_SENDER_SHA256"

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
  assert_plugin_index_absent "$PROFILE_STATE_DB"
}

verify_target_not_discoverable() {
  local report_path="$1"
  if ! run_qwen_openclaw plugins inspect --all --json > "$report_path"; then
    printf 'Unable to inspect the complete qwen-current plugin registry.\n' >&2
    return 1
  fi
  node "$ABSENCE_VALIDATOR" "$report_path" "$PLUGIN_ID"
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
  "$PLUGIN_DIR/lib/dispatch-identity.js"
  "$PLUGIN_DIR/lib/natural-video-request.js"
  "$PLUGIN_DIR/lib/parse-video-command.js"
  "$PLUGIN_DIR/lib/runner.js"
  "$PLUGIN_DIR/lib/short-receipt.js"
  "$PLUGIN_DIR/lib/stable-message-key.js"
  "$PLUGIN_DIR/lib/video-path-policy.js"
  "$PLUGIN_DIR/lib/video-request-router.js"
  "$PLUGIN_DIR/lib/video-task-result.js"
  "$RUNTIME_VALIDATOR"
  "$DOCTOR_VALIDATOR"
  "$ABSENCE_VALIDATOR"
  "$UPGRADE_VALIDATOR"
  "$UPGRADE_POLICY_HELPER"
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
  const sourceVersion = process.argv[4];
  const extensions = packageJson?.openclaw?.extensions;
  const schema = manifest?.configSchema;
  if (packageJson?.version !== sourceVersion) {
    throw new Error(`Fresh install accepts only hook-only source version ${sourceVersion}.`);
  }
  if (manifest?.id !== pluginId) throw new Error("Plugin manifest id mismatch.");
  if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== "./index.js") {
    throw new Error("Plugin package must declare only ./index.js.");
  }
  if (schema?.type !== "object" || schema?.additionalProperties !== false) {
    throw new Error("Plugin manifest must use a strict object config schema.");
  }
  if (JSON.stringify(manifest?.activation?.onCapabilities) !== JSON.stringify(["hook"])) {
    throw new Error("Fresh 0.3 install must declare only the hook capability.");
  }
  if (manifest?.contracts !== undefined || manifest?.toolMetadata !== undefined) {
    throw new Error("Fresh 0.3 install must not declare any tool contract or tool metadata.");
  }
  const senderHashSchema = manifest?.configSchema?.properties?.allowedSenderSha256;
  if (JSON.stringify(senderHashSchema) !== JSON.stringify({
    type: "string",
    pattern: "^[a-f0-9]{64}$",
  })) {
    throw new Error("Fresh 0.3 install must declare the lowercase SHA-256 sender gate.");
  }
' "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/openclaw.plugin.json" "$PLUGIN_ID" "$SOURCE_VERSION"
while IFS= read -r javascript_file; do
  node --check "$javascript_file"
done < <(find "$PLUGIN_DIR" -type f \( -name '*.js' -o -name '*.mjs' \) -print | LC_ALL=C sort)

run_isolated_runtime_check() {
  isolated_root="$(mktemp -d "/tmp/aiworker-plugin-dry-run.XXXXXX")"
  isolated_home_dir="$isolated_root/home"
  isolated_state_dir="$isolated_home_dir/.openclaw"
  isolated_config="$isolated_state_dir/openclaw.json"
  isolated_report="$isolated_root/runtime-inspect.json"
  isolated_doctor="$isolated_root/plugins-doctor.txt"
  qwen_absence_report="$isolated_root/qwen-current-plugins-before.json"

  cleanup_isolated_state() {
    if [[ -z "${isolated_root:-}" || ! -d "$isolated_root" ]]; then return; fi
    case "$isolated_root" in
      /tmp/aiworker-plugin-dry-run.*|/private/tmp/aiworker-plugin-dry-run.*)
        rm -rf -- "$isolated_root"
        ;;
      *)
        printf 'Refusing to clean unexpected isolated state path.\n' >&2
        return 1
        ;;
    esac
  }
  trap cleanup_isolated_state EXIT HUP INT TERM

  default_snapshot_before="$(protected_default_snapshot)" || return 1
  qwen_snapshot_before="$(protected_qwen_snapshot)" || return 1

  install -d -m 700 "$isolated_home_dir" "$isolated_state_dir"

  node -e '
    const fs = require("node:fs");
    const config = { plugins: { allow: [process.argv[2]] } };
    fs.writeFileSync(process.argv[1], `${JSON.stringify(config)}\n`, { mode: 0o600 });
  ' "$isolated_config" "$PLUGIN_ID"
  isolated_status=0
  if ! verify_target_not_discoverable "$qwen_absence_report"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! env -u OPENCLAW_PROFILE -u OPENCLAW_INCLUDE_ROOTS \
      OPENCLAW_HOME="$isolated_home_dir" \
      OPENCLAW_STATE_DIR="$isolated_state_dir" \
      OPENCLAW_CONFIG_PATH="$isolated_config" \
      NO_COLOR=1 \
      openclaw plugins install --force "$PLUGIN_DIR"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! env -u OPENCLAW_PROFILE -u OPENCLAW_INCLUDE_ROOTS \
      OPENCLAW_HOME="$isolated_home_dir" \
      OPENCLAW_STATE_DIR="$isolated_state_dir" \
      OPENCLAW_CONFIG_PATH="$isolated_config" \
      NO_COLOR=1 \
      openclaw config set \
        "plugins.entries.$PLUGIN_ID.config.allowedSenderSha256" \
        "\"$ALLOWED_SENDER_SHA256\"" \
        --strict-json; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! verify_plugin_sender_hash "$isolated_config"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! prepare_isolated_sqlite_read "$isolated_state_dir/state/openclaw.sqlite"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! assert_plugin_index_present "$isolated_state_dir/state/openclaw.sqlite"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! env -u OPENCLAW_PROFILE -u OPENCLAW_INCLUDE_ROOTS \
      OPENCLAW_HOME="$isolated_home_dir" \
      OPENCLAW_STATE_DIR="$isolated_state_dir" \
      OPENCLAW_CONFIG_PATH="$isolated_config" \
      NO_COLOR=1 \
      openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$isolated_report"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! node "$RUNTIME_VALIDATOR" "$isolated_report" "$PLUGIN_ID" "$SOURCE_VERSION"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! env -u OPENCLAW_PROFILE -u OPENCLAW_INCLUDE_ROOTS \
      OPENCLAW_HOME="$isolated_home_dir" \
      OPENCLAW_STATE_DIR="$isolated_state_dir" \
      OPENCLAW_CONFIG_PATH="$isolated_config" \
      NO_COLOR=1 \
      openclaw plugins doctor > "$isolated_doctor"; then
    isolated_status=1
  fi
  if [[ "$isolated_status" -eq 0 ]] \
    && ! verify_doctor_report "$isolated_doctor"; then
    isolated_status=1
  fi

  cleanup_isolated_state
  trap - EXIT HUP INT TERM

  default_snapshot_after="$(protected_default_snapshot)" || return 1
  qwen_snapshot_after="$(protected_qwen_snapshot)" || return 1
  if [[ "$default_snapshot_after" != "$default_snapshot_before" ]] \
    || [[ "$qwen_snapshot_after" != "$qwen_snapshot_before" ]]; then
    printf 'Isolated plugin check changed a protected OpenClaw path or plugin index.\n' >&2
    return 1
  fi
  if [[ "$isolated_status" -ne 0 ]]; then
    printf 'Isolated OpenClaw plugin installation check failed.\n' >&2
    return 1
  fi
}

run_isolated_runtime_check

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Dry run passed static and isolated runtime checks: profile=%s plugin=%s\n' "$PROFILE" "$PLUGIN_ID"
  printf 'No qwen-current config, plugin, or service state was changed.\n'
  exit 0
fi

umask 077
stamp="$(date +%Y%m%d-%H%M%S)"
if [[ -L "$BACKUP_ROOT" ]]; then
  printf 'Backup root must not be a symlink.\n' >&2
  exit 1
fi
if [[ -e "$BACKUP_ROOT" ]]; then
  backup_mode="$(stat -f '%Lp' "$BACKUP_ROOT")" || exit 1
  if [[ ! -d "$BACKUP_ROOT" || "$backup_mode" != "700" ]]; then
    printf 'Existing backup root must be a mode-0700 directory.\n' >&2
    exit 1
  fi
else
  install -d -m 700 "$BACKUP_ROOT"
fi
verified_backup_count=0
shopt -s nullglob
for verified_marker in "$BACKUP_ROOT"/*/.verified; do
  if [[ -f "$verified_marker" && ! -L "$verified_marker" ]]; then
    verified_backup_count=$((verified_backup_count + 1))
  fi
done
shopt -u nullglob
if [[ "$verified_backup_count" -ge 2 ]]; then
  printf 'Two verified plugin backups already exist; archive one explicitly before applying.\n' >&2
  exit 1
fi
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
preflight_absence_report="$backup_dir/pre-install-plugins-all.json"
preflight_profile_before="$(protected_qwen_snapshot)"
preflight_status=0
if ! NO_COLOR=1 run_qwen_openclaw plugins doctor > "$pre_doctor_report"; then
  preflight_status=1
fi
if [[ "$preflight_status" -eq 0 ]] && ! verify_doctor_report "$pre_doctor_report"; then
  preflight_status=1
fi
if ! verify_target_not_discoverable "$preflight_absence_report"; then
  preflight_status=1
fi
preflight_profile_after="$(protected_qwen_snapshot)" || preflight_status=1
if [[ "$preflight_profile_after" != "$preflight_profile_before" ]]; then
  printf 'OpenClaw pre-install inspection changed protected qwen-current state.\n' >&2
  preflight_status=1
fi
if [[ "$preflight_status" -ne 0 ]]; then
  printf 'qwen-current pre-install inspection failed.\n' >&2
  exit 1
fi
verify_first_install_state
verify_telegram_ingress_policy
load_owner_sender_policy
if [[ "$ALLOWED_SENDER_SHA256" != "$INITIAL_ALLOWED_SENDER_SHA256" ]]; then
  printf 'The unique Telegram command owner changed after dry-run validation.\n' >&2
  exit 1
fi
node "$UPGRADE_VALIDATOR" owner-sender-plan "$PROFILE_CONFIG" \
  > "$backup_dir/owner-sender-policy.json"
chmod 600 "$backup_dir/owner-sender-policy.json"

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

  run_qwen_openclaw plugins uninstall "$PLUGIN_ID" --force \
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
  if run_qwen_openclaw plugins inspect "$PLUGIN_ID" --json \
    > "$backup_dir/rollback-inspect.json" 2>&1; then
    rollback_failed=1
  fi
  assert_plugin_index_absent "$PROFILE_STATE_DB" || rollback_failed=1
  NO_COLOR=1 run_qwen_openclaw plugins doctor \
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

run_qwen_openclaw plugins install --force "$PLUGIN_DIR"
run_qwen_openclaw config set \
  "plugins.entries.$PLUGIN_ID.config.allowedSenderSha256" \
  "\"$ALLOWED_SENDER_SHA256\"" \
  --strict-json
load_owner_sender_policy
if [[ "$ALLOWED_SENDER_SHA256" != "$INITIAL_ALLOWED_SENDER_SHA256" ]]; then
  printf 'The unique Telegram command owner changed during installation.\n' >&2
  false
fi
verify_plugin_sender_hash "$PROFILE_CONFIG"
verify_explicit_allowlist post-install
verify_telegram_ingress_policy
if [[ ! -d "$INSTALLED_PLUGIN_DIR" ]]; then
  printf 'Installed plugin directory is missing.\n' >&2
  false
fi
assert_plugin_index_present "$PROFILE_STATE_DB"
runtime_report="$backup_dir/runtime-inspect.json"
doctor_report="$backup_dir/plugins-doctor.txt"
run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$runtime_report"
node "$RUNTIME_VALIDATOR" "$runtime_report" "$PLUGIN_ID" "$SOURCE_VERSION"
NO_COLOR=1 run_qwen_openclaw plugins doctor > "$doctor_report"
verify_doctor_report "$doctor_report"
release_install_lock
install -m 600 /dev/null "$backup_dir/.verified"
trap - EXIT HUP INT TERM

printf 'Installed plugin for profile %s; the official config write may have refreshed that profile.\n' "$PROFILE"
printf 'Backup retained: %s\n' "$backup_dir"
printf 'Verify qwen-current PID and health, refresh only if required, then run isolated acceptance.\n'
