#!/usr/bin/env bash
set -euo pipefail

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
TOOL_NAME="aiworker_analyze_video"
BASELINE_VERSION="0.1.0"
OLD_VERSION="0.2.0"
NEW_VERSION="0.3.0"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-command-upgrade.mjs"
POLICY_HELPER="$REPOSITORY_ROOT/scripts/lib/aiworker-video-command-upgrade-policy.mjs"
RELEASE_ROLLBACK_VALIDATOR="$REPOSITORY_ROOT/scripts/validate-aiworker-video-release-rollback.mjs"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
PROFILE_STATE_DB="$PROFILE_STATE_DIR/state/openclaw.sqlite"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
ACTIVE_ROLLBACK_MARKER=".active-rollback-source.json"
# Share the existing qwen-current plugin-install lock with the first installer.
INSTALL_LOCK_DIR="$BACKUP_ROOT/.qwen-current-first-install.lock"
MODE=""
TARGET_SHA=""
ALLOWED_SENDER_SHA256=""
INITIAL_ALLOWED_SENDER_SHA256=""
OPENCLAW_PEER_LINK_TEXT=""
OPENCLAW_PEER_REAL_PATH=""
INITIAL_OPENCLAW_PEER_LINK_TEXT=""
INITIAL_OPENCLAW_PEER_REAL_PATH=""

OTHER_PROFILE_NAMES=("default" "gpt-main" "qwen-weixin-new")
OTHER_PROFILE_DIRS=(
  "$HOME/.openclaw"
  "$HOME/.openclaw-gpt-main"
  "$HOME/.openclaw-qwen-weixin-new"
)

run_clean_openclaw() {
  env -u OPENCLAW_PROFILE \
    -u OPENCLAW_STATE_DIR \
    -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME \
    -u OPENCLAW_INCLUDE_ROOTS \
    openclaw "$@"
}

run_qwen_openclaw() {
  run_clean_openclaw --profile "$PROFILE" "$@"
}

run_isolated_openclaw() {
  local isolated_home="$1"
  local isolated_state="$2"
  local isolated_config="$3"
  shift 3
  env -u OPENCLAW_PROFILE \
    -u OPENCLAW_STATE_DIR \
    -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME \
    -u OPENCLAW_INCLUDE_ROOTS \
    OPENCLAW_HOME="$isolated_home" \
    OPENCLAW_STATE_DIR="$isolated_state" \
    OPENCLAW_CONFIG_PATH="$isolated_config" \
    NO_COLOR=1 \
    openclaw "$@"
}

usage() {
  printf 'Usage: %s (--dry-run|--apply) --target-sha <40-lowercase-hex-sha>\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply)
      if [[ -n "$MODE" ]]; then usage >&2; exit 2; fi
      MODE="${1#--}"
      shift
      ;;
    --target-sha)
      if [[ -n "$TARGET_SHA" || "$#" -lt 2 ]]; then usage >&2; exit 2; fi
      TARGET_SHA="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done
if [[ -z "$MODE" || ! "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  usage >&2
  exit 2
fi

for command_name in awk chmod cmp cp date env git hostname id install mkdir mktemp node openclaw \
  rm rmdir shasum sqlite3 stat; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  fi
done

work_root="$(mktemp -d "/tmp/aiworker-video-command-upgrade.XXXXXX")"
chmod 700 "$work_root"

cleanup_work_root() {
  if [[ -z "${work_root:-}" || ! -d "$work_root" ]]; then return; fi
  case "$work_root" in
    /tmp/aiworker-video-command-upgrade.*|/private/tmp/aiworker-video-command-upgrade.*)
      rm -rf -- "$work_root"
      ;;
    *)
      printf 'Refusing to remove an unexpected temporary path.\n' >&2
      return 1
      ;;
  esac
}

trap cleanup_work_root EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fingerprint_path() {
  node - "$1" <<'NODE'
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, readlinkSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const root = process.argv[2]
const hash = createHash('sha256')

function visit(pathname, relative) {
  let stat
  try {
    stat = lstatSync(pathname)
  } catch (error) {
    if (error.code === 'ENOENT' && relative === '.') {
      process.stdout.write('absent\n')
      process.exit(0)
    }
    throw error
  }
  hash.update(`${relative}\0${stat.mode & 0o7777}\0${stat.size}\0`)
  if (stat.isSymbolicLink()) {
    hash.update(`link\0${readlinkSync(pathname)}\0`)
    return
  }
  if (stat.isFile()) {
    hash.update('file\0')
    hash.update(readFileSync(pathname))
    hash.update('\0')
    return
  }
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem object: ${relative}`)
  hash.update('dir\0')
  for (const name of readdirSync(pathname).sort()) {
    visit(join(pathname, name), relative === '.' ? name : `${relative}/${name}`)
  }
}

visit(root, '.')
process.stdout.write(`${hash.digest('hex')}\n`)
NODE
}

fingerprint_plugin_payload() {
  node - "$1" <<'NODE'
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, readlinkSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const root = process.argv[2]
const hash = createHash('sha256')

function visit(pathname, relative) {
  const stat = lstatSync(pathname)
  hash.update(`${relative}\0`)
  if (stat.isSymbolicLink()) {
    hash.update(`link\0${readlinkSync(pathname)}\0`)
    return
  }
  if (stat.isFile()) {
    hash.update('file\0')
    hash.update(readFileSync(pathname))
    hash.update('\0')
    return
  }
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem object: ${relative}`)
  hash.update('dir\0')
  for (const name of readdirSync(pathname).sort()) {
    visit(join(pathname, name), relative === '.' ? name : `${relative}/${name}`)
  }
}

visit(root, '.')
process.stdout.write(`${hash.digest('hex')}\n`)
NODE
}

write_index_record() {
  local database_path="$1"
  local output_path="$2"
  local record
  if [[ ! -f "$database_path" || -L "$database_path" ]]; then
    printf 'Plugin state database is missing or unsafe.\n' >&2
    return 1
  fi
  record="$(sqlite3 -readonly "$database_path" \
    "SELECT COALESCE(json_extract(install_records_json, '$.\"$PLUGIN_ID\"'), '') FROM installed_plugin_index WHERE index_key = 'installed-plugin-index' ORDER BY generated_at_ms DESC LIMIT 1;")" \
    || return 1
  if [[ -z "$record" ]]; then
    printf 'Target plugin install-index record is absent.\n' >&2
    return 1
  fi
  printf '%s\n' "$record" > "$output_path"
}

prepare_isolated_sqlite_read() {
  local isolated_root="$1"
  local database_path="$2"
  local isolated_home="$isolated_root/home"
  local isolated_state="$isolated_home/.openclaw"
  local isolated_database_dir="$isolated_state/state"
  local expected_database="$isolated_database_dir/openclaw.sqlite"
  if [[ ! -d "$isolated_root" || -L "$isolated_root" \
    || ! -d "$isolated_home" || -L "$isolated_home" \
    || ! -d "$isolated_state" || -L "$isolated_state" \
    || ! -d "$isolated_database_dir" || -L "$isolated_database_dir" \
    || ! -f "$database_path" || -L "$database_path" \
    || "$database_path" != "$expected_database" ]]; then
    printf 'Isolated OpenClaw state database is missing or outside its disposable root.\n' >&2
    return 1
  fi
  # OpenClaw creates this disposable database in WAL mode. A newly closed WAL
  # database can lack the transient -shm sidecar that macOS sqlite3 -readonly
  # needs. Prime only this exact temporary database with query_only; the formal
  # index read below and every production/profile database read stay read-only.
  sqlite3 "$database_path" \
    'PRAGMA query_only = ON; SELECT 1 FROM sqlite_schema LIMIT 1;' >/dev/null
}

assert_index_absent() {
  local database_path="$1"
  local record
  if [[ -L "$database_path" ]]; then
    printf 'Other-profile state database must not be a symlink.\n' >&2
    return 1
  fi
  if [[ ! -e "$database_path" ]]; then return; fi
  if [[ ! -f "$database_path" ]]; then
    printf 'Other-profile state database is unsafe.\n' >&2
    return 1
  fi
  record="$(sqlite3 -readonly "$database_path" \
    "SELECT COALESCE(json_extract(install_records_json, '$.\"$PLUGIN_ID\"'), '') FROM installed_plugin_index WHERE index_key = 'installed-plugin-index' ORDER BY generated_at_ms DESC LIMIT 1;")" \
    || return 1
  if [[ -n "$record" ]]; then
    printf 'Another profile contains the target plugin install record.\n' >&2
    return 1
  fi
}

profile_snapshot() {
  local approvals_fingerprint
  local config_fingerprint
  local extension_fingerprint
  local index_record
  local index_path="$work_root/snapshot-index-$RANDOM.json"
  approvals_fingerprint="$(fingerprint_path "$PROFILE_STATE_DIR/exec-approvals.json")" || return 1
  config_fingerprint="$(fingerprint_path "$PROFILE_CONFIG")" || return 1
  extension_fingerprint="$(fingerprint_path "$INSTALLED_PLUGIN_DIR")" || return 1
  write_index_record "$PROFILE_STATE_DB" "$index_path" || return 1
  index_record="$(shasum -a 256 "$index_path" | awk '{print $1}')" || return 1
  printf '%s\n%s\n%s\n%s\n' \
    "$approvals_fingerprint" "$config_fingerprint" "$extension_fingerprint" "$index_record"
}

validate_other_profiles() {
  local report_dir="$1"
  local index
  local name
  local state_dir
  local config_path
  local approvals_path
  local state_db
  local extension_dir
  for index in "${!OTHER_PROFILE_NAMES[@]}"; do
    name="${OTHER_PROFILE_NAMES[$index]}"
    state_dir="${OTHER_PROFILE_DIRS[$index]}"
    config_path="$state_dir/openclaw.json"
    approvals_path="$state_dir/exec-approvals.json"
    state_db="$state_dir/state/openclaw.sqlite"
    extension_dir="$state_dir/extensions/$PLUGIN_ID"
    if [[ ! -f "$config_path" || -L "$config_path" ]]; then
      printf 'Required other-profile config is missing or unsafe: %s\n' "$name" >&2
      return 1
    fi
    node "$VALIDATOR" other-profile "$config_path" "$PLUGIN_ID" "$TOOL_NAME"
    if [[ -e "$extension_dir" || -L "$extension_dir" ]]; then
      printf 'Another profile has the target extension: %s\n' "$name" >&2
      return 1
    fi
    assert_index_absent "$state_db"
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$name" \
      "$(fingerprint_path "$config_path")" \
      "$(fingerprint_path "$approvals_path")" \
      "$(fingerprint_path "$extension_dir")" \
      "target-index-absent" \
      >> "$report_dir/other-profiles.snapshot"
  done
}

other_profiles_snapshot() {
  local snapshot_dir="$1"
  install -d -m 700 "$snapshot_dir"
  : > "$snapshot_dir/other-profiles.snapshot"
  validate_other_profiles "$snapshot_dir"
  shasum -a 256 "$snapshot_dir/other-profiles.snapshot" | awk '{print $1}'
}

validate_source_and_host() {
  local actual_host
  local actual_user
  local openclaw_version
  local remote_url

  openclaw_version="$(run_clean_openclaw --version)" || return 1
  case "$openclaw_version" in
    "OpenClaw $OPENCLAW_VERSION ("*")") ;;
    *)
      printf 'Unsupported OpenClaw version: %s\n' "$openclaw_version" >&2
      return 1
      ;;
  esac

  actual_user="$(id -un)" || return 1
  actual_host="$(hostname)" || return 1
  if [[ "$actual_user" != "$EXPECTED_USER" || "$actual_host" != "$EXPECTED_HOST" ]]; then
    printf 'Refusing non-production identity: user=%s host=%s\n' "$actual_user" "$actual_host" >&2
    return 1
  fi

  remote_url="$(git -C "$REPOSITORY_ROOT" remote get-url origin)" || return 1
  case "$remote_url" in
    https://github.com/MAKingljx/video-autoworker|https://github.com/MAKingljx/video-autoworker.git|git@github.com:MAKingljx/video-autoworker.git) ;;
    *) printf 'Canonical Git remote mismatch.\n' >&2; return 1 ;;
  esac
  validate_canonical_checkout remote

  if [[ ! -f "$VALIDATOR" || ! -f "$POLICY_HELPER" \
    || ! -f "$RELEASE_ROLLBACK_VALIDATOR" || ! -f "$PLUGIN_DIR/package.json" \
    || ! -f "$PLUGIN_DIR/openclaw.plugin.json" || ! -f "$PLUGIN_DIR/index.js" ]]; then
    printf 'Upgrade source is incomplete.\n' >&2
    return 1
  fi
  node --check "$VALIDATOR"
  node --check "$RELEASE_ROLLBACK_VALIDATOR"
  node "$VALIDATOR" source \
    "$PLUGIN_DIR/package.json" \
    "$PLUGIN_DIR/openclaw.plugin.json" \
    "$PLUGIN_ID" \
    "$NEW_VERSION" \
    "$TOOL_NAME"
}

validate_canonical_checkout() {
  local head_commit
  local origin_main_commit
  local remote_main_record
  local remote_main_commit
  local verify_remote="${1:-local}"

  if [[ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=normal)" ]]; then
    printf 'Canonical Git checkout must be clean.\n' >&2
    return 1
  fi
  head_commit="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')" || return 1
  origin_main_commit="$(git -C "$REPOSITORY_ROOT" rev-parse --verify \
    'refs/remotes/origin/main^{commit}')" || return 1
  if [[ ! "$head_commit" =~ ^[a-f0-9]{40}$ \
    || ! "$origin_main_commit" =~ ^[a-f0-9]{40}$ ]]; then
    printf 'Canonical Git commit evidence is malformed.\n' >&2
    return 1
  fi
  if [[ "$head_commit" != "$TARGET_SHA" || "$origin_main_commit" != "$TARGET_SHA" ]]; then
    printf 'Canonical checkout must satisfy HEAD=origin/main=approved target SHA.\n' >&2
    return 1
  fi
  if [[ "$verify_remote" == "remote" ]]; then
    remote_main_record="$(git -C "$REPOSITORY_ROOT" ls-remote --exit-code \
      origin refs/heads/main)" || return 1
    if [[ ! "$remote_main_record" =~ ^([a-f0-9]{40})[[:space:]]+refs/heads/main$ ]]; then
      printf 'Canonical remote main evidence is malformed or ambiguous.\n' >&2
      return 1
    fi
    remote_main_commit="${BASH_REMATCH[1]}"
    if [[ "$remote_main_commit" != "$TARGET_SHA" ]]; then
      printf 'GitHub origin main does not equal the approved target SHA.\n' >&2
      return 1
    fi
  fi
}

assert_audited_source() {
  local current_fingerprint
  validate_canonical_checkout || return 1
  current_fingerprint="$(node "$VALIDATOR" payload-fingerprint "$PLUGIN_DIR")" || return 1
  if [[ "$current_fingerprint" != "$source_plugin_fingerprint" ]]; then
    printf 'Canonical plugin payload changed after release audit.\n' >&2
    return 1
  fi
}

validate_old_install_files() {
  if [[ ! -d "$INSTALLED_PLUGIN_DIR" || -L "$INSTALLED_PLUGIN_DIR" ]]; then
    printf 'The installed 0.2.0 plugin directory is missing or unsafe.\n' >&2
    return 1
  fi
  node - "$INSTALLED_PLUGIN_DIR/package.json" "$INSTALLED_PLUGIN_DIR/openclaw.plugin.json" \
    "$PLUGIN_ID" "$OLD_VERSION" <<'NODE'
const { readFileSync } = require('node:fs')
const [packagePath, manifestPath, pluginId, oldVersion] = process.argv.slice(2)
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (packageJson.version !== oldVersion) throw new Error(`installed plugin must be ${oldVersion}`)
if (manifest.id !== pluginId) throw new Error('installed plugin id mismatch')
const declaredTools = manifest?.contracts?.tools ?? []
if (JSON.stringify(manifest?.activation?.onCapabilities) !== JSON.stringify(['hook', 'tool'])) {
  throw new Error('installed 0.2.0 capability declaration mismatch')
}
if (JSON.stringify(declaredTools) !== JSON.stringify(['aiworker_analyze_video'])) {
  throw new Error('installed 0.2.0 optional tool contract mismatch')
}
if (manifest?.toolMetadata?.aiworker_analyze_video?.optional !== true) {
  throw new Error('installed 0.2.0 optional tool metadata mismatch')
}
NODE
}

select_restore_plan() {
  local report_dir="$1"
  local plan_path="$report_dir/restore-plan.json"
  node "$VALIDATOR" baseline-select \
    "$BACKUP_ROOT" \
    "$PROFILE_CONFIG" \
    "$INSTALLED_PLUGIN_DIR" \
    "$PLUGIN_ID" \
    "$AGENT_ID" \
    "$TOOL_NAME" \
    "$BASELINE_VERSION" \
    "$OLD_VERSION" \
    > "$plan_path" || return 1
  chmod 600 "$plan_path" || return 1
  AGENT_INDEX="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.agentIndex))' "$plan_path")" || return 1
  RESTORE_AGENT_TOOLS="$(node -e 'const p=require(process.argv[1]); process.stdout.write(JSON.stringify(p.restoreTools))' "$plan_path")" || return 1
  BASELINE_CONFIG_PATH="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.baselineConfigPath)' "$plan_path")" || return 1
  EFFECTIVE_BASELINE_REPORT="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.effectiveBaselinePath)' "$plan_path")" || return 1
  RESTORE_PLAN_REPORT="$plan_path"
  if [[ ! "$AGENT_INDEX" =~ ^[0-9]+$ || -z "$RESTORE_AGENT_TOOLS" \
    || ! -f "$BASELINE_CONFIG_PATH" || ! -f "$EFFECTIVE_BASELINE_REPORT" ]]; then
    printf 'Validator returned an invalid 0.3 restoration plan.\n' >&2
    return 1
  fi
  node "$VALIDATOR" config-known-v02 \
    "$BASELINE_CONFIG_PATH" "$PROFILE_CONFIG" "$EFFECTIVE_BASELINE_REPORT" \
    "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME"
}

load_owner_sender_policy() {
  local plan
  local owner_count
  local sender_hash
  plan="$(node "$VALIDATOR" owner-sender-plan "$PROFILE_CONFIG")" || return 1
  owner_count="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(String(p.ownerCount))' \
    "$plan")" || return 1
  sender_hash="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.allowedSenderSha256 ?? "")' \
    "$plan")" || return 1
  if [[ "$owner_count" != "1" || ! "$sender_hash" =~ ^[a-f0-9]{64}$ ]]; then
    printf 'Owner sender policy validator returned an invalid redacted plan.\n' >&2
    return 1
  fi
  ALLOWED_SENDER_SHA256="$sender_hash"
}

verify_plugin_sender_hash() {
  local config_path="$1"
  node "$VALIDATOR" sender-hash-config \
    "$config_path" "$PLUGIN_ID" "$ALLOWED_SENDER_SHA256"
}

capture_live_v02_effective() {
  local report_dir="$1"
  local sessions_report
  local current_report="$report_dir/live-tools-effective-v02.json"
  install -d -m 700 "$report_dir" || return 1
  sessions_report="$(mktemp "$work_root/live-sessions.XXXXXX.json")" || return 1
  chmod 600 "$sessions_report" || return 1
  run_qwen_openclaw gateway status --deep --require-rpc --json \
    > "$report_dir/live-gateway-status-baseline.json" || return 1
  run_qwen_openclaw gateway call sessions.list \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId: process.argv[1], search: "telegram:direct:", configuredAgentsOnly: true, includeGlobal: false, limit: 200}))' "$AGENT_ID")" \
    --timeout 20000 --json > "$sessions_report" || return 1
  DIRECT_SESSION_KEY="$(node "$VALIDATOR" session-select "$sessions_report" "$AGENT_ID")" || return 1
  rm -f -- "$sessions_report" || return 1
  run_qwen_openclaw gateway call tools.effective \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId: process.argv[1], sessionKey: process.argv[2]}))' "$AGENT_ID" "$DIRECT_SESSION_KEY")" \
    --timeout 20000 --json > "$current_report" || return 1
  node "$VALIDATOR" effective-v02 "$EFFECTIVE_BASELINE_REPORT" "$current_report" \
    "$AGENT_ID" "$TOOL_NAME" || return 1
  CURRENT_V02_EFFECTIVE_REPORT="$current_report"
}

validate_pre_upgrade_index() {
  local record_path="$1"
  local report_path="$2"
  node "$VALIDATOR" index-preflight \
    "$record_path" \
    "$OLD_VERSION" \
    "$PLUGIN_DIR" \
    "$BACKUP_ROOT" \
    "$INSTALLED_PLUGIN_DIR" \
    "$PLUGIN_ID" \
    > "$report_path"
}

validate_current_state() {
  local report_dir="$1"
  local current_index="$report_dir/current-index.json"
  local runtime_report="$report_dir/runtime-old.json"
  local doctor_report="$report_dir/doctor-old.txt"
  local peer_report="$report_dir/openclaw-peer-link.json"

  if [[ ! -f "$PROFILE_CONFIG" || -L "$PROFILE_CONFIG" ]]; then
    printf 'Required qwen-current config is missing or unsafe.\n' >&2
    return 1
  fi
  if [[ ! -f "$PROFILE_STATE_DB" || -L "$PROFILE_STATE_DB" ]]; then
    printf 'Required qwen-current state database is missing or unsafe.\n' >&2
    return 1
  fi

  validate_old_install_files
  node "$VALIDATOR" peer-link "$INSTALLED_PLUGIN_DIR" > "$peer_report"
  OPENCLAW_PEER_LINK_TEXT="$(node -e \
    'const p=require(process.argv[1]); process.stdout.write(p.linkText)' "$peer_report")"
  OPENCLAW_PEER_REAL_PATH="$(node -e \
    'const p=require(process.argv[1]); process.stdout.write(p.realPath)' "$peer_report")"
  write_index_record "$PROFILE_STATE_DB" "$current_index"
  validate_pre_upgrade_index "$current_index" "$report_dir/current-source-kind.txt"

  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$runtime_report"
  node "$VALIDATOR" runtime-v02 "$runtime_report" "$PLUGIN_ID" "$OLD_VERSION" "$TOOL_NAME"
  NO_COLOR=1 run_qwen_openclaw plugins doctor > "$doctor_report"
  node "$VALIDATOR" doctor-v02 "$doctor_report" "$PLUGIN_ID"

  select_restore_plan "$report_dir"
  load_owner_sender_policy
  capture_live_v02_effective "$report_dir"

  run_qwen_openclaw config set \
    "agents.list[$AGENT_INDEX].tools" \
    "$RESTORE_AGENT_TOOLS" \
    --strict-json \
    --dry-run \
    > "$report_dir/config-set-dry-run.txt"
}

run_isolated_upgrade() {
  local isolated_root="$work_root/isolated"
  local isolated_home="$isolated_root/home"
  local isolated_state="$isolated_home/.openclaw"
  local isolated_config="$isolated_state/openclaw.json"
  local isolated_index="$isolated_root/index.json"
  local isolated_install="$isolated_state/extensions/$PLUGIN_ID"

  install -d -m 700 "$isolated_home" "$isolated_state"
  node - "$isolated_config" "$PLUGIN_ID" <<'NODE'
const { writeFileSync } = require('node:fs')
const [configPath, pluginId] = process.argv.slice(2)
writeFileSync(configPath, `${JSON.stringify({ plugins: { allow: [pluginId] } })}\n`, { mode: 0o600 })
NODE

  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins install --force "$INSTALLED_PLUGIN_DIR" \
    > "$isolated_root/install-old.txt"
  prepare_isolated_sqlite_read "$isolated_root" "$isolated_state/state/openclaw.sqlite"
  write_index_record "$isolated_state/state/openclaw.sqlite" "$isolated_index"
  node "$VALIDATOR" index "$isolated_index" "$OLD_VERSION" "$INSTALLED_PLUGIN_DIR" "$isolated_install"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins inspect "$PLUGIN_ID" --runtime --json \
    > "$isolated_root/runtime-old.json"
  node "$VALIDATOR" runtime-v02 "$isolated_root/runtime-old.json" \
    "$PLUGIN_ID" "$OLD_VERSION" "$TOOL_NAME"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins doctor > "$isolated_root/doctor-old.txt"
  node "$VALIDATOR" doctor-v02 "$isolated_root/doctor-old.txt" "$PLUGIN_ID"

  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins install --force "$PLUGIN_DIR" \
    > "$isolated_root/install-new.txt"
  node "$VALIDATOR" payload-match \
    "$PLUGIN_DIR" "$isolated_install" "$source_plugin_fingerprint" \
    "$OPENCLAW_PEER_LINK_TEXT" "$OPENCLAW_PEER_REAL_PATH" \
    > "$isolated_root/installed-payload.json"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    config set \
      "plugins.entries.$PLUGIN_ID.config.allowedSenderSha256" \
      "\"$ALLOWED_SENDER_SHA256\"" \
      --strict-json \
    > "$isolated_root/config-set-sender-hash.txt"
  verify_plugin_sender_hash "$isolated_config"
  prepare_isolated_sqlite_read "$isolated_root" "$isolated_state/state/openclaw.sqlite"
  write_index_record "$isolated_state/state/openclaw.sqlite" "$isolated_index"
  node "$VALIDATOR" index "$isolated_index" "$NEW_VERSION" "$PLUGIN_DIR" "$isolated_install"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins inspect "$PLUGIN_ID" --runtime --json \
    > "$isolated_root/runtime-new.json"
  node "$VALIDATOR" runtime-v03 "$isolated_root/runtime-new.json" \
    "$PLUGIN_ID" "$NEW_VERSION" "$TOOL_NAME"
  run_isolated_openclaw "$isolated_home" "$isolated_state" "$isolated_config" \
    plugins doctor > "$isolated_root/doctor-new.txt"
  node "$VALIDATOR" doctor-v03 "$isolated_root/doctor-new.txt" "$PLUGIN_ID"
}

validate_final_state() {
  local report_dir="$1"
  local expected_source_path="$2"
  local expected_version="$3"
  local runtime_mode="$4"
  local index_report="$report_dir/final-index.json"

  write_index_record "$PROFILE_STATE_DB" "$index_report"
  node "$VALIDATOR" index "$index_report" "$expected_version" \
    "$expected_source_path" "$INSTALLED_PLUGIN_DIR"
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report_dir/final-runtime.json"
  node "$VALIDATOR" "$runtime_mode" "$report_dir/final-runtime.json" \
    "$PLUGIN_ID" "$expected_version" "$TOOL_NAME"
  NO_COLOR=1 run_qwen_openclaw plugins doctor > "$report_dir/final-doctor.txt"
  if [[ "$runtime_mode" == "runtime-v03" ]]; then
    node "$VALIDATOR" doctor-v03 "$report_dir/final-doctor.txt" "$PLUGIN_ID"
  else
    node "$VALIDATOR" doctor-v02 "$report_dir/final-doctor.txt" "$PLUGIN_ID"
  fi
}

refresh_and_validate_live_gateway() {
  local report_dir="$1"
  local runtime_mode="$2"
  local baseline_report="$3"
  local catalog_report="$report_dir/live-tools-catalog.json"
  local effective_report="$report_dir/live-tools-effective.json"

  install -d -m 700 "$report_dir" || return 1
  run_qwen_openclaw gateway restart --wait 60s --json \
    > "$report_dir/gateway-restart.json" || return 1
  run_qwen_openclaw gateway status --deep --require-rpc --json \
    > "$report_dir/gateway-status.json" || return 1
  run_qwen_openclaw gateway call tools.catalog \
    --params '{"agentId":"second-original","includePlugins":true}' \
    --timeout 20000 \
    --json \
    > "$catalog_report" || return 1
  node "$VALIDATOR" "$runtime_mode" "$catalog_report" \
    "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME" || return 1
  run_qwen_openclaw gateway call tools.effective \
    --params "$(node -e 'process.stdout.write(JSON.stringify({agentId: process.argv[1], sessionKey: process.argv[2]}))' "$AGENT_ID" "$DIRECT_SESSION_KEY")" \
    --timeout 20000 --json > "$effective_report" || return 1
  if [[ "$runtime_mode" == "live-v03" ]]; then
    node "$VALIDATOR" effective-v03 "$baseline_report" "$effective_report" \
      "$AGENT_ID" "$TOOL_NAME" || return 1
  else
    node "$VALIDATOR" effective-v02 "$baseline_report" "$effective_report" \
      "$AGENT_ID" "$TOOL_NAME" || return 1
  fi
}

validate_source_and_host
source_commit_before="$TARGET_SHA"
source_plugin_fingerprint="$(node "$VALIDATOR" payload-fingerprint "$PLUGIN_DIR")"
preflight_dir="$work_root/preflight"
install -d -m 700 "$preflight_dir"
qwen_snapshot_before="$(profile_snapshot)"
other_snapshot_before="$(other_profiles_snapshot "$work_root/other-before")"
validate_current_state "$preflight_dir"
INITIAL_ALLOWED_SENDER_SHA256="$ALLOWED_SENDER_SHA256"
INITIAL_OPENCLAW_PEER_LINK_TEXT="$OPENCLAW_PEER_LINK_TEXT"
INITIAL_OPENCLAW_PEER_REAL_PATH="$OPENCLAW_PEER_REAL_PATH"
run_isolated_upgrade
qwen_snapshot_after="$(profile_snapshot)"
other_snapshot_after="$(other_profiles_snapshot "$work_root/other-after")"
if [[ "$qwen_snapshot_after" != "$qwen_snapshot_before" ]]; then
  printf 'Dry-run checks changed protected qwen-current state.\n' >&2
  exit 1
fi
if [[ "$other_snapshot_after" != "$other_snapshot_before" ]]; then
  printf 'Dry-run checks changed another OpenClaw profile.\n' >&2
  exit 1
fi

if [[ "$MODE" == "dry-run" ]]; then
  cleanup_work_root
  trap - EXIT HUP INT TERM
  printf 'Dry run passed the controlled %s to %s upgrade checks.\n' "$OLD_VERSION" "$NEW_VERSION"
  printf 'No qwen-current config, installed plugin, index, or other profile was changed.\n'
  exit 0
fi

umask 077
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

node "$VALIDATOR" backup-retention-baseline "$BACKUP_ROOT" 2 \
  > "$work_root/backup-retention-baseline.json"

release_install_lock() {
  if [[ "${lock_acquired:-0}" -eq 0 ]]; then return; fi
  if ! rmdir "$INSTALL_LOCK_DIR"; then
    return 1
  fi
  lock_acquired=0
}

if ! mkdir "$INSTALL_LOCK_DIR"; then
  printf 'Another qwen-current plugin installation holds the profile lock.\n' >&2
  exit 1
fi
lock_acquired=1

pre_mutation_exit_handler() {
  local status=$?
  trap - EXIT HUP INT TERM
  release_install_lock || status=70
  cleanup_work_root || status=70
  exit "$status"
}

trap pre_mutation_exit_handler EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$(mktemp -d "$BACKUP_ROOT/upgrade-$stamp.XXXXXX")"
chmod 700 "$backup_dir"
apply_reports="$backup_dir/reports"
install -d -m 700 "$apply_reports"

# Re-check all mutable preconditions while holding the shared profile lock.
validate_source_and_host
if [[ "$TARGET_SHA" != "$source_commit_before" \
  || "$(node "$VALIDATOR" payload-fingerprint "$PLUGIN_DIR")" != "$source_plugin_fingerprint" ]]; then
  printf 'Canonical upgrade source changed after dry-run validation.\n' >&2
  exit 1
fi
validate_current_state "$apply_reports"
if [[ "$ALLOWED_SENDER_SHA256" != "$INITIAL_ALLOWED_SENDER_SHA256" ]]; then
  printf 'The unique Telegram command owner changed after dry-run validation.\n' >&2
  exit 1
fi
if [[ "$OPENCLAW_PEER_LINK_TEXT" != "$INITIAL_OPENCLAW_PEER_LINK_TEXT" \
  || "$OPENCLAW_PEER_REAL_PATH" != "$INITIAL_OPENCLAW_PEER_REAL_PATH" ]]; then
  printf 'The verified OpenClaw peer link changed after dry-run validation.\n' >&2
  exit 1
fi
other_apply_before="$(other_profiles_snapshot "$work_root/other-apply-before")"
install -m 600 "$PROFILE_CONFIG" "$backup_dir/openclaw-current.json"
install -m 600 "$BASELINE_CONFIG_PATH" "$backup_dir/pre-0.2-openclaw.json"
install -m 600 "$EFFECTIVE_BASELINE_REPORT" "$backup_dir/pre-0.2-effective-tools.json"
install -m 600 "$CURRENT_V02_EFFECTIVE_REPORT" "$backup_dir/current-0.2-effective-tools.json"
node "$VALIDATOR" owner-sender-plan "$PROFILE_CONFIG" \
  > "$backup_dir/owner-sender-policy.json"
chmod 600 "$backup_dir/owner-sender-policy.json"
cp -R -p "$INSTALLED_PLUGIN_DIR" "$backup_dir/previous-plugin"
write_index_record "$PROFILE_STATE_DB" "$backup_dir/install-index-old.json"
printf '%s\n' "$TARGET_SHA" > "$backup_dir/source-commit.txt"
printf '%s\n' "$source_plugin_fingerprint" > "$backup_dir/source-plugin-payload-sha256.txt"
previous_plugin_fingerprint="$(node "$RELEASE_ROLLBACK_VALIDATOR" previous-plugin-fingerprint \
  "$backup_dir/previous-plugin" "$OPENCLAW_PEER_LINK_TEXT" "$OPENCLAW_PEER_REAL_PATH")"
printf '%s\n' "$previous_plugin_fingerprint" > "$backup_dir/previous-plugin-payload-sha256.txt"
chmod 600 \
  "$backup_dir/source-commit.txt" \
  "$backup_dir/source-plugin-payload-sha256.txt" \
  "$backup_dir/previous-plugin-payload-sha256.txt"

if ! cmp -s "$PROFILE_CONFIG" "$backup_dir/openclaw-current.json"; then
  printf 'Profile config changed while the backup was created.\n' >&2
  exit 1
fi
if [[ "$(fingerprint_path "$INSTALLED_PLUGIN_DIR")" != \
  "$(fingerprint_path "$backup_dir/previous-plugin")" ]]; then
  printf 'Installed plugin backup verification failed.\n' >&2
  exit 1
fi
validate_pre_upgrade_index \
  "$backup_dir/install-index-old.json" \
  "$backup_dir/pre-upgrade-source-kind.txt"
node "$VALIDATOR" config-known-v02 \
  "$backup_dir/pre-0.2-openclaw.json" \
  "$backup_dir/openclaw-current.json" \
  "$backup_dir/pre-0.2-effective-tools.json" \
  "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME"

rollback_required=0
rollback_failed=0

rollback_upgrade() {
  local failed_status="$1"
  local active_installed_fingerprint=""
  local active_marker_path="$backup_dir/$ACTIVE_ROLLBACK_MARKER"
  local active_marker_temp=""
  local active_source_fingerprint=""
  set +e
  rollback_failed=0

  rm -f -- "$backup_dir/.verified"
  if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi

  run_qwen_openclaw plugins install --force "$backup_dir/previous-plugin" \
    > "$backup_dir/rollback-install-old.txt" 2>&1
  if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  install -m 600 "$backup_dir/openclaw-current.json" "$PROFILE_CONFIG"
  if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  if ! cmp -s "$backup_dir/openclaw-current.json" "$PROFILE_CONFIG"; then rollback_failed=1; fi

  install -d -m 700 "$backup_dir/rollback-reports"
  if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  validate_final_state "$backup_dir/rollback-reports" \
    "$backup_dir/previous-plugin" "$OLD_VERSION" runtime-v02 \
    > "$backup_dir/rollback-validation.txt" 2>&1
  if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  other_apply_after="$(other_profiles_snapshot "$work_root/other-rollback-after")"
  if [[ "$?" -ne 0 || "$other_apply_after" != "$other_apply_before" ]]; then rollback_failed=1; fi

  if [[ "$rollback_failed" -eq 0 ]]; then
    refresh_and_validate_live_gateway "$backup_dir/rollback-live-gateway" live-v02 \
      "$backup_dir/pre-0.2-effective-tools.json" \
      > "$backup_dir/rollback-live-gateway-validation.txt" 2>&1
    if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  fi

  if [[ "$rollback_failed" -eq 0 ]]; then
    if ! active_source_fingerprint="$(fingerprint_plugin_payload "$backup_dir/previous-plugin")"; then
      rollback_failed=1
    fi
    if ! active_installed_fingerprint="$(fingerprint_plugin_payload "$INSTALLED_PLUGIN_DIR")"; then
      rollback_failed=1
    fi
    if [[ -z "$active_source_fingerprint" \
      || "$active_source_fingerprint" != "$active_installed_fingerprint" ]]; then
      rollback_failed=1
    fi
  fi
  if [[ "$rollback_failed" -eq 0 ]]; then
    if ! active_marker_temp="$(mktemp "$backup_dir/$ACTIVE_ROLLBACK_MARKER.tmp.XXXXXX")"; then
      rollback_failed=1
    fi
  fi
  if [[ "$rollback_failed" -eq 0 ]]; then
    node "$VALIDATOR" marker-create \
      "$PLUGIN_ID" \
      "$OLD_VERSION" \
      "$backup_dir/previous-plugin" \
      "$active_source_fingerprint" \
      > "$active_marker_temp"
    if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  fi
  if [[ "$rollback_failed" -eq 0 ]]; then
    install -m 600 "$active_marker_temp" "$active_marker_path"
    if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  fi
  if [[ -n "$active_marker_temp" ]]; then
    rm -f -- "$active_marker_temp"
    if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  fi
  if [[ "$rollback_failed" -eq 0 ]]; then
    validate_pre_upgrade_index \
      "$backup_dir/rollback-reports/final-index.json" \
      "$backup_dir/rollback-reports/active-source-kind.txt" \
      > "$backup_dir/rollback-active-source-validation.txt" 2>&1
    if [[ "$?" -ne 0 ]]; then rollback_failed=1; fi
  fi

  if [[ "$rollback_failed" -ne 0 ]]; then
    release_install_lock || true
    cleanup_work_root || true
    printf 'ROLLBACK FAILED: qwen-current requires manual inspection; no success may be reported.\n' >&2
    printf 'Backup retained: %s\n' "$backup_dir" >&2
    exit 70
  fi
  if ! release_install_lock; then
    cleanup_work_root || true
    printf 'ROLLBACK FAILED: the profile lock could not be released.\n' >&2
    printf 'Backup retained: %s\n' "$backup_dir" >&2
    exit 70
  fi
  cleanup_work_root || true
  printf 'Upgrade failed; official 0.2.0 reinstall and exact current-config restoration succeeded.\n' >&2
  printf 'Backup retained: %s\n' "$backup_dir" >&2
  exit "$failed_status"
}

upgrade_exit_handler() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$status" -ne 0 && "${rollback_required:-0}" -eq 1 ]]; then
    rollback_upgrade "$status"
  fi
  release_install_lock || status=70
  cleanup_work_root || status=70
  exit "$status"
}

trap upgrade_exit_handler EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rollback_required=1
run_qwen_openclaw config set \
  "agents.list[$AGENT_INDEX].tools" \
  "$RESTORE_AGENT_TOOLS" \
  --strict-json \
  > "$apply_reports/config-set.txt"
node "$VALIDATOR" config-restored \
  "$backup_dir/openclaw-current.json" \
  "$PROFILE_CONFIG" \
  "$backup_dir/pre-0.2-openclaw.json" \
  "$backup_dir/pre-0.2-effective-tools.json" \
  "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME"

assert_audited_source
run_qwen_openclaw plugins install --force "$PLUGIN_DIR" \
  > "$apply_reports/install-new.txt"
assert_audited_source
node "$VALIDATOR" payload-match \
  "$PLUGIN_DIR" "$INSTALLED_PLUGIN_DIR" "$source_plugin_fingerprint" \
  "$OPENCLAW_PEER_LINK_TEXT" "$OPENCLAW_PEER_REAL_PATH" \
  > "$apply_reports/installed-payload.json"
run_qwen_openclaw config set \
  "plugins.entries.$PLUGIN_ID.config.allowedSenderSha256" \
  "\"$ALLOWED_SENDER_SHA256\"" \
  --strict-json \
  > "$apply_reports/config-set-sender-hash.txt"
verify_plugin_sender_hash "$PROFILE_CONFIG"
node "$VALIDATOR" config-restored \
  "$backup_dir/openclaw-current.json" \
  "$PROFILE_CONFIG" \
  "$backup_dir/pre-0.2-openclaw.json" \
  "$backup_dir/pre-0.2-effective-tools.json" \
  "$PLUGIN_ID" "$AGENT_ID" "$TOOL_NAME" "$ALLOWED_SENDER_SHA256"
validate_final_state "$apply_reports" "$PLUGIN_DIR" "$NEW_VERSION" runtime-v03
other_apply_after="$(other_profiles_snapshot "$work_root/other-apply-after")"
if [[ "$other_apply_after" != "$other_apply_before" ]]; then
  printf 'Another OpenClaw profile changed during the upgrade.\n' >&2
  false
fi
refresh_and_validate_live_gateway "$apply_reports/live-gateway" live-v03 \
  "$backup_dir/pre-0.2-effective-tools.json"

if [[ "$(node "$RELEASE_ROLLBACK_VALIDATOR" previous-plugin-fingerprint \
  "$backup_dir/previous-plugin" "$OPENCLAW_PEER_LINK_TEXT" "$OPENCLAW_PEER_REAL_PATH")" \
  != "$(awk 'NF { print; exit }' "$backup_dir/previous-plugin-payload-sha256.txt")" ]]; then
  printf 'The previous-plugin rollback payload changed before backup verification.\n' >&2
  false
fi
install -m 600 /dev/null "$backup_dir/.verified"
node "$VALIDATOR" backup-retention-enforce \
  "$BACKUP_ROOT" \
  "$backup_dir" \
  "$apply_reports/final-index.json" \
  2 \
  > "$apply_reports/backup-retention.json"
rollback_required=0
if ! release_install_lock; then
  printf 'Upgrade validation passed, but the profile lock could not be released.\n' >&2
  exit 70
fi
cleanup_work_root
trap - EXIT HUP INT TERM

printf 'Upgraded %s from %s to %s for %s/%s.\n' \
  "$PLUGIN_ID" "$OLD_VERSION" "$NEW_VERSION" "$PROFILE" "$AGENT_ID"
printf 'The complete pre-0.2 second-original tools object was restored from the unique verified 0.2 upgrade backup.\n'
printf 'Backup retained: %s\n' "$backup_dir"
printf 'Only qwen-current was restarted through the official Gateway service command.\n'
printf 'Runtime inspection proved only before_dispatch and no plugin tool contract.\n'
printf 'Installed plugin payload matches approved target %s and its audited canonical source.\n' "$TARGET_SHA"
printf 'Plugin config contains only the SHA-256 gate for the unique canonical Telegram command owner.\n'
printf 'The live Gateway catalog omits %s and the Telegram direct session effective tools equal the pre-0.2 baseline exactly.\n' \
  "$TOOL_NAME"
printf 'No production AI-worker task was submitted.\n'
