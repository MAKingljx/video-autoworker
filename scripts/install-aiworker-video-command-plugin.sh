#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
TOOL_ID="aiworker_analyze_video"
SUPPORTED_PREVIOUS_VERSIONS=("0.5.8" "0.5.9" "0.5.10" "0.5.11" "0.5.12" "0.5.13")
CURRENT_VERSION="0.5.14"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_DIR="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
RUNTIME_VALIDATOR="$PLUGIN_DIR/scripts/validate-runtime-inspection.mjs"
SHARED_INSTALL_GATE="$REPOSITORY_ROOT/scripts/verify-shared-runtime-install-gate.mjs"
SHARED_DEPLOYMENT_LOCK_HELPER="$REPOSITORY_ROOT/scripts/lib/shared-deployment-lock.sh"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/$PLUGIN_ID"
MODE=""
TARGET_SHA=""
ROLLBACK_BACKUP=""
WORK_ROOT=""
BACKUP_DIR=""
BEFORE_CONFIG_SHA=""
BEFORE_LISTENERS=""
LEGACY_SENDER_HASH_PRESENT=0
MIGRATED_CONFIG=""
MIGRATED_CONFIG_SHA=""
DEPLOYMENT_RUN_DIR="${AIWORKER_BG_RUN_DIR:-$REPOSITORY_ROOT/.run/blue-green}"
DEPLOYMENT_LOCK_DIR="$DEPLOYMENT_RUN_DIR/.deployment.lock"
MISSION_CONTROL_DB_PATH="${AIWORKER_BG_LIVE_DB_PATH:-}"
N8N_DB_PATH="${AIWORKER_BG_N8N_DB_PATH:-}"
LEGACY_BOOTSTRAP_ATTEMPT_DIR="${AIWORKER_BG_LEGACY_BOOTSTRAP_ATTEMPT_DIR:-}"
VIDEO_BATCH_ROOT="${AIWORKER_VIDEO_BATCH_DIR:-$HOME/ai-worker/state/video-autoworker/video-batches}"

[[ -f "$SHARED_DEPLOYMENT_LOCK_HELPER" && ! -L "$SHARED_DEPLOYMENT_LOCK_HELPER" ]] || {
  printf 'Shared deployment lock helper is unavailable.\n' >&2
  exit 1
}
# shellcheck source=scripts/lib/shared-deployment-lock.sh
. "$SHARED_DEPLOYMENT_LOCK_HELPER"

usage() {
  printf 'Usage: %s (--dry-run|--apply|--rollback) --target-sha <40-lowercase-hex-sha> [--backup <absolute-backup>]\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply|--rollback)
      [[ -z "$MODE" ]] || { usage >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --target-sha)
      [[ -z "$TARGET_SHA" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      TARGET_SHA="$2"
      shift 2
      ;;
    --backup)
      [[ -z "$ROLLBACK_BACKUP" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      ROLLBACK_BACKUP="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" && "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || { usage >&2; exit 2; }
[[ "$MODE" == "rollback" || -z "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }
[[ "$MODE" != "rollback" || -n "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }
EXPECTED_SOURCE_COMMIT="$TARGET_SHA"
EXPECTED_RELEASE_ID="$TARGET_SHA-runtime"

for command_name in awk chmod cmp cp date env find git hostname id install lsof mkdir mktemp node openclaw readlink rm shasum sort stat tr; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  }
done

run_qwen_openclaw() {
  env -u OPENCLAW_PROFILE -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH \
    -u OPENCLAW_HOME -u OPENCLAW_INCLUDE_ROOTS \
    openclaw --profile "$PROFILE" "$@"
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]]; then
    case "$WORK_ROOT" in
      /tmp/aiworker-video-current-release.*|/private/tmp/aiworker-video-current-release.*)
        rm -rf -- "$WORK_ROOT"
        ;;
      *) printf 'Refusing unexpected temporary cleanup path.\n' >&2; status=70 ;;
    esac
  fi
  if [[ "$DEPLOYMENT_LOCK_OWNED" == 1 ]]; then
    if ! release_shared_deployment_lock; then status=70; fi
  fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-video-current-release.XXXXXX)"
chmod 700 "$WORK_ROOT"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

read_version() {
  node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$1"
}

is_supported_previous_version() {
  local candidate="$1" supported
  for supported in "${SUPPORTED_PREVIOUS_VERSIONS[@]}"; do
    [[ "$candidate" == "$supported" ]] && return 0
  done
  return 1
}

verify_shared_install_gate() {
  local -a gate_arguments=(
    --mission-control-db-path "$MISSION_CONTROL_DB_PATH"
    --n8n-db-path "$N8N_DB_PATH"
    --video-batch-root "$VIDEO_BATCH_ROOT"
    --expected-source-commit "$EXPECTED_SOURCE_COMMIT"
    --expected-release-id "$EXPECTED_RELEASE_ID"
  )
  if [[ -n "$LEGACY_BOOTSTRAP_ATTEMPT_DIR" ]]; then
    gate_arguments+=(--legacy-attempt-dir "$LEGACY_BOOTSTRAP_ATTEMPT_DIR")
  fi
  node "$SHARED_INSTALL_GATE" "${gate_arguments[@]}" >/dev/null || {
    printf 'Shared video-command replacement requires paused intake, zero active tasks, and zero pending director outbox rows.\n' >&2
    return 1
  }
}

listener_snapshot() {
  local port
  for port in 3017 5678 5679 18091 18789 18889 18989; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || {
      printf 'Protected listener %s is missing.\n' "$port" >&2
      return 1
    }
    printf '%s=ready\n' "$port"
  done
}

validate_git_target() {
  local remote_url branch head origin_main live_record
  remote_url="$(git -C "$REPOSITORY_ROOT" remote get-url origin)"
  case "$remote_url" in
    https://github.com/MAKingljx/video-autoworker|https://github.com/MAKingljx/video-autoworker.git|git@github.com:MAKingljx/video-autoworker.git) ;;
    *) printf 'Canonical Git remote mismatch.\n' >&2; return 1 ;;
  esac
  branch="$(git -C "$REPOSITORY_ROOT" symbolic-ref --short -q HEAD)"
  [[ "$branch" == "main" ]] || { printf 'Canonical checkout must be on main.\n' >&2; return 1; }
  [[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=normal)" ]] || {
    printf 'Canonical checkout must be clean.\n' >&2
    return 1
  }
  git -C "$REPOSITORY_ROOT" fetch --prune origin >/dev/null
  head="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')"
  origin_main="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'refs/remotes/origin/main^{commit}')"
  live_record="$(git -C "$REPOSITORY_ROOT" ls-remote --exit-code origin refs/heads/main)"
  [[ "$head" == "$TARGET_SHA" && "$origin_main" == "$TARGET_SHA" \
    && "$live_record" == "$TARGET_SHA"$'\trefs/heads/main' ]] || {
    printf 'HEAD, origin/main, live GitHub main, and target SHA must match.\n' >&2
    return 1
  }
}

validate_source() {
  [[ "$(id -un)" == "$EXPECTED_USER" && "$(hostname)" == "$EXPECTED_HOST" ]] || {
    printf 'Refusing non-production identity.\n' >&2
    return 1
  }
  case "$(openclaw --version)" in
    "OpenClaw $OPENCLAW_VERSION ("*")") ;;
    *) printf 'Unsupported OpenClaw version.\n' >&2; return 1 ;;
  esac
  validate_git_target
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || return 1
  [[ -d "$PLUGIN_DIR" && ! -L "$PLUGIN_DIR" ]] || return 1
  [[ -f "$SHARED_INSTALL_GATE" && ! -L "$SHARED_INSTALL_GATE" ]] || return 1
  [[ -f "$SHARED_DEPLOYMENT_LOCK_HELPER" && ! -L "$SHARED_DEPLOYMENT_LOCK_HELPER" ]] || return 1
  [[ "$(read_version "$PLUGIN_DIR/package.json")" == "$CURRENT_VERSION" ]] || return 1
  [[ "$(read_version "$PLUGIN_DIR/openclaw.plugin.json")" == "$CURRENT_VERSION" ]] || return 1
  node - "$PROFILE_CONFIG" "$PLUGIN_DIR/openclaw.plugin.json" "$PLUGIN_ID" "$AGENT_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [configPath, manifestPath, pluginId, agentId, toolId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const entry = config?.plugins?.entries?.[pluginId]
if (!entry || entry.config?.releaseReady !== true || entry.llm?.allowAgentIdOverride !== true) {
  throw new Error('plugin release gate or LLM override policy is not ready')
}
if (JSON.stringify(manifest?.activation?.onCapabilities) !== JSON.stringify(['hook', 'tool'])) {
  throw new Error('plugin must expose exactly hook and tool capabilities')
}
if (JSON.stringify(manifest?.contracts?.tools) !== JSON.stringify([toolId])) {
  throw new Error('plugin tool contract mismatch')
}
if (manifest?.toolMetadata?.[toolId]?.optional !== true) {
  throw new Error('plugin tool must remain optional')
}
if (JSON.stringify(manifest?.configSchema) !== JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: { releaseReady: { type: 'boolean' } },
})) {
  throw new Error('plugin config schema must contain only the current release gate')
}
const agents = Array.isArray(config?.agents?.list) ? config.agents.list : []
const targets = agents.filter(agent => agent?.id === agentId)
if (targets.length !== 1) throw new Error('target agent must exist exactly once')
const grants = ['allow', 'alsoAllow'].flatMap(key =>
  Array.isArray(targets[0]?.tools?.[key]) ? targets[0].tools[key].filter(id => id === toolId) : [])
if (grants.length !== 1) throw new Error('target agent must grant the direct tool exactly once')
for (const agent of agents) {
  if (agent?.id === agentId) continue
  for (const key of ['allow', 'alsoAllow']) {
    if (Array.isArray(agent?.tools?.[key]) && agent.tools[key].includes(toolId)) {
      throw new Error('direct tool is granted to another agent')
    }
  }
}
for (const key of ['allow', 'alsoAllow']) {
  if (Array.isArray(config?.tools?.[key]) && config.tools[key].includes(toolId)) {
    throw new Error('direct tool must not be granted globally')
  }
}
NODE
  LEGACY_SENDER_HASH_PRESENT="$(node - "$PROFILE_CONFIG" "$PLUGIN_ID" <<'NODE'
const fs = require('node:fs')
const [configPath, pluginId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const pluginConfig = config?.plugins?.entries?.[pluginId]?.config
if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) process.exit(1)
if (!Object.prototype.hasOwnProperty.call(pluginConfig, 'allowedSenderSha256')) {
  process.stdout.write('0')
} else if (/^[a-f0-9]{64}$/u.test(pluginConfig.allowedSenderSha256)) {
  process.stdout.write('1')
} else {
  process.exit(1)
}
NODE
  )" || return 1
  while IFS= read -r javascript_file; do
    node --check "$javascript_file"
  done < <(find "$PLUGIN_DIR" -type f \( -name '*.js' -o -name '*.mjs' \) -print | LC_ALL=C sort)
}

validate_config_migration() {
  local before_path="$1" after_path="$2"
  node - "$before_path" "$after_path" "$PLUGIN_ID" <<'NODE'
const fs = require('node:fs')
const [beforePath, afterPath, pluginId] = process.argv.slice(2)
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'))
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'))
const expected = structuredClone(before)
const pluginConfig = expected?.plugins?.entries?.[pluginId]?.config
if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) process.exit(1)
delete pluginConfig.allowedSenderSha256
if (JSON.stringify(expected) !== JSON.stringify(after)) {
  throw new Error('qwen-current config changed beyond the retired sender hash removal')
}
NODE
}

validate_installed_version() {
  local expected="$1"
  [[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || return 1
  [[ "$(read_version "$INSTALLED_PLUGIN_DIR/package.json")" == "$expected" ]]
}

validate_runtime_payload_matches() {
  local source_dir="$1"
  node - "$source_dir" "$INSTALLED_PLUGIN_DIR" <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [sourceRoot, installedRoot] = process.argv.slice(2)

function digest(pathname) {
  return createHash('sha256').update(fs.readFileSync(pathname)).digest('hex')
}

function runtimeFiles(root) {
  const files = ['index.js', 'openclaw.plugin.json', 'package.json']
  for (const directory of ['lib', 'scripts']) {
    const base = path.join(root, directory)
    if (!fs.statSync(base, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('runtime payload directory is missing: ' + directory)
    }
    const visit = (pathname, relative) => {
      for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) {
        const child = path.join(pathname, entry.name)
        const childRelative = path.posix.join(relative, entry.name)
        if (entry.isSymbolicLink()) throw new Error('runtime payload symlink is forbidden')
        if (entry.isDirectory()) visit(child, childRelative)
        else if (entry.isFile()) files.push(childRelative)
        else throw new Error('unsupported runtime payload object')
      }
    }
    visit(base, directory)
  }
  return new Map(files.sort().map(relative => [relative, digest(path.join(root, relative))]))
}

const source = runtimeFiles(sourceRoot)
const installed = runtimeFiles(installedRoot)
if (source.size !== installed.size
  || [...source].some(([relative, value]) => installed.get(relative) !== value)) {
  throw new Error('installed runtime payload differs from the canonical source')
}
NODE
}

validate_runtime() {
  local expected="$1" report="$2" catalog="$3"
  run_qwen_openclaw gateway status --deep --require-rpc --json > "$WORK_ROOT/gateway-status.json" \
    || return 1
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$report" \
    || return 1
  node "$RUNTIME_VALIDATOR" "$report" "$PLUGIN_ID" "$expected" || return 1
  run_qwen_openclaw gateway call tools.catalog \
    --params "{\"agentId\":\"$AGENT_ID\",\"includePlugins\":true}" \
    --timeout 20000 --json > "$catalog" || return 1
  node - "$catalog" "$PLUGIN_ID" "$AGENT_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [reportPath, pluginId, agentId, toolId] = process.argv.slice(2)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const matches = (report?.groups ?? [])
  .flatMap(group => (group?.tools ?? []).map(tool => ({ group, tool })))
  .filter(({ tool }) => tool?.id === toolId)
if (report?.agentId !== agentId || matches.length !== 1) process.exit(1)
const { group, tool } = matches[0]
if (group?.pluginId !== pluginId || group?.source !== 'plugin'
  || tool?.pluginId !== pluginId || tool?.source !== 'plugin' || tool?.optional !== true) {
  process.exit(1)
}
NODE
}

write_tree_manifest() {
  local tree_root="$1" output_path="$2"
  (
    cd "$tree_root"
    while IFS= read -r path; do
      local_path="${path#./}"
      case "$local_path" in
        MANIFEST.sha256|.verified) continue ;;
      esac
      mode="$(stat -f '%Lp' "$path")"
      if [[ -L "$path" ]]; then
        target="$(readlink "$path")"
        digest="$(printf '%s' "$target" | shasum -a 256 | awk '{print $1}')"
        printf '%s\tsymlink\t%s\t%s\t%s\n' "$local_path" "$mode" "$digest" "$target"
      elif [[ -d "$path" ]]; then
        printf '%s\tdirectory\t%s\t-\t-\n' "$local_path" "$mode"
      elif [[ -f "$path" ]]; then
        digest="$(shasum -a 256 "$path" | awk '{print $1}')"
        printf '%s\tfile\t%s\t%s\t-\n' "$local_path" "$mode" "$digest"
      else
        printf 'Unsupported backup object: %s\n' "$path" >&2
        return 1
      fi
    done < <(LC_ALL=C find . -mindepth 1 -print | LC_ALL=C sort)
  ) > "$output_path"
}

write_backup_manifest() {
  write_tree_manifest "$BACKUP_DIR" "$BACKUP_DIR/MANIFEST.sha256"
  chmod 600 "$BACKUP_DIR/MANIFEST.sha256"
  shasum -a 256 "$BACKUP_DIR/MANIFEST.sha256" | awk '{print $1}' > "$BACKUP_DIR/.verified"
  chmod 600 "$BACKUP_DIR/.verified"
}

verify_backup() {
  local candidate="$1" candidate_name actual_manifest expected_digest actual_digest metadata
  [[ "${candidate%/*}" == "$BACKUP_ROOT" ]] || return 1
  candidate_name="${candidate##*/}"
  [[ "$candidate_name" =~ ^current-release-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$ ]] || return 1
  [[ -d "$candidate" && ! -L "$candidate" && "$(stat -f '%Lp' "$candidate")" == "700" ]] || return 1
  for required in openclaw.json metadata.json MANIFEST.sha256 .verified; do
    [[ -f "$candidate/$required" && ! -L "$candidate/$required" ]] || return 1
  done
  [[ -d "$candidate/previous-plugin" && ! -L "$candidate/previous-plugin" ]] || return 1
  actual_manifest="$WORK_ROOT/verify-${candidate_name}.manifest"
  write_tree_manifest "$candidate" "$actual_manifest"
  cmp -s "$actual_manifest" "$candidate/MANIFEST.sha256" || return 1
  expected_digest="$(tr -d '[:space:]' < "$candidate/.verified")"
  actual_digest="$(shasum -a 256 "$candidate/MANIFEST.sha256" | awk '{print $1}')"
  [[ "$expected_digest" =~ ^[a-f0-9]{64}$ && "$expected_digest" == "$actual_digest" ]] || return 1
  metadata="$(node - "$candidate/metadata.json" "$candidate/previous-plugin/package.json" <<'NODE'
const fs = require('node:fs')
const [metadataPath, packagePath] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
const previous = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
if (value?.schemaVersion !== 1 || value?.previousVersion !== previous
  || typeof value?.candidateVersion !== 'string'
  || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.candidateVersion)
  || !/^[a-f0-9]{40}$/u.test(value.targetSha)
  || !/^[a-f0-9]{64}$/u.test(value.configSha256)) process.exit(1)
process.stdout.write([value.previousVersion, value.candidateVersion, value.configSha256].join('\t'))
NODE
  )" || return 1
  config_sha="$(shasum -a 256 "$candidate/openclaw.json" | awk '{print $1}')"
  [[ "$config_sha" == "$(printf '%s' "$metadata" | awk -F '\t' '{print $3}')" ]] || return 1
  printf '%s\n' "$metadata"
}

restore_backup() {
  local candidate="$1" metadata previous_version
  metadata="$(verify_backup "$candidate")" || return 1
  previous_version="$(printf '%s' "$metadata" | awk -F '\t' '{print $1}')"
  run_qwen_openclaw plugins install --force "$candidate/previous-plugin" \
    > "$WORK_ROOT/restore-install.txt" 2>&1 || return 1
  install -m 600 "$candidate/openclaw.json" "$PROFILE_CONFIG" || return 1
  run_qwen_openclaw gateway restart --wait 60s --json \
    > "$WORK_ROOT/restore-restart.json" || return 1
  validate_installed_version "$previous_version" || return 1
  validate_runtime_payload_matches "$candidate/previous-plugin" || return 1
  validate_runtime "$previous_version" "$WORK_ROOT/runtime-restored.json" \
    "$WORK_ROOT/catalog-restored.json" || return 1
  [[ "$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')" \
    == "$(printf '%s' "$metadata" | awk -F '\t' '{print $3}')" ]] || return 1
  [[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]] || return 1
}

enforce_retention() {
  local candidate remove_count=0
  local -a backups=()
  shopt -s nullglob
  for candidate in "$BACKUP_ROOT"/current-release-*; do
    [[ -d "$candidate" && ! -L "$candidate" ]] && backups+=("$candidate")
  done
  shopt -u nullglob
  if [[ "${#backups[@]}" -le 2 ]]; then return; fi
  remove_count=$((${#backups[@]} - 2))
  for candidate in "${backups[@]:0:$remove_count}"; do
    verify_backup "$candidate" >/dev/null || return 1
  done
  for candidate in "${backups[@]:0:$remove_count}"; do
    rm -rf -- "$candidate" || return 1
  done
}

validate_source
[[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || {
  printf 'Installed plugin directory is missing or unsafe.\n' >&2
  exit 1
}
installed_version="$(read_version "$INSTALLED_PLUGIN_DIR/package.json")"
BEFORE_CONFIG_SHA="$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')"
BEFORE_LISTENERS="$(listener_snapshot)"
validate_runtime "$installed_version" "$WORK_ROOT/runtime-before.json" "$WORK_ROOT/catalog-before.json"

if [[ "$MODE" == "rollback" ]]; then
  acquire_shared_deployment_lock
  verify_shared_install_gate
  metadata="$(verify_backup "$ROLLBACK_BACKUP")" || {
    printf 'Rollback backup is not a verified current-release recovery point.\n' >&2
    exit 1
  }
  candidate_version="$(printf '%s' "$metadata" | awk -F '\t' '{print $2}')"
  [[ "$installed_version" == "$candidate_version" ]] || {
    printf 'Installed version does not match the rollback backup candidate.\n' >&2
    exit 1
  }
  restore_backup "$ROLLBACK_BACKUP"
  printf 'Rolled back qwen-current from %s to %s using the explicit verified backup.\n' \
    "$candidate_version" "$(printf '%s' "$metadata" | awk -F '\t' '{print $1}')"
  exit 0
fi

if [[ "$installed_version" == "$CURRENT_VERSION" ]]; then
  [[ "$LEGACY_SENDER_HASH_PRESENT" == "0" ]] || {
    printf 'Current plugin config still contains the retired sender hash.\n' >&2
    exit 1
  }
  validate_runtime_payload_matches "$PLUGIN_DIR"
  printf 'Current plugin %s is already installed and passed runtime validation.\n' "$CURRENT_VERSION"
  printf 'No plugin, config, gateway, queue, n8n, media, database, or scheduler state changed.\n'
  exit 0
fi
is_supported_previous_version "$installed_version" || {
  printf 'Unsupported installed plugin version: %s\n' "$installed_version" >&2
  exit 1
}

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Current plugin release dry-run passed for %s -> %s at %s.\n' \
    "$installed_version" "$CURRENT_VERSION" "$TARGET_SHA"
  printf 'No plugin, config, gateway, queue, n8n, media, database, or scheduler state changed.\n'
  exit 0
fi

acquire_shared_deployment_lock

if [[ -L "$BACKUP_ROOT" ]]; then
  printf 'Backup root must not be a symlink.\n' >&2
  exit 1
fi
if [[ -e "$BACKUP_ROOT" ]]; then
  [[ -d "$BACKUP_ROOT" && "$(stat -f '%Lp' "$BACKUP_ROOT")" == "700" ]] || {
    printf 'Backup root must be a mode-0700 directory.\n' >&2
    exit 1
  }
else
  install -d -m 700 "$BACKUP_ROOT"
fi

BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/current-release-$(date +%Y%m%d-%H%M%S).XXXXXX")"
chmod 700 "$BACKUP_DIR"
install -m 600 "$PROFILE_CONFIG" "$BACKUP_DIR/openclaw.json"
cp -R -p "$INSTALLED_PLUGIN_DIR" "$BACKUP_DIR/previous-plugin"
printf '{"schemaVersion":1,"previousVersion":"%s","candidateVersion":"%s","targetSha":"%s","configSha256":"%s"}\n' \
  "$installed_version" "$CURRENT_VERSION" "$TARGET_SHA" "$BEFORE_CONFIG_SHA" > "$BACKUP_DIR/metadata.json"
chmod 600 "$BACKUP_DIR/metadata.json"
write_backup_manifest
verify_backup "$BACKUP_DIR" >/dev/null

MIGRATED_CONFIG="$WORK_ROOT/openclaw-migrated.json"
migration_failed=0
if ! node - "$BACKUP_DIR/openclaw.json" "$MIGRATED_CONFIG" "$PLUGIN_ID" <<'NODE'
const fs = require('node:fs')
const [beforePath, outputPath, pluginId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(beforePath, 'utf8'))
const pluginConfig = config?.plugins?.entries?.[pluginId]?.config
if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) process.exit(1)
delete pluginConfig.allowedSenderSha256
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
NODE
then
  migration_failed=1
fi
if [[ "$migration_failed" -eq 0 ]]; then
  validate_config_migration "$BACKUP_DIR/openclaw.json" "$MIGRATED_CONFIG" || migration_failed=1
fi
if [[ "$migration_failed" -eq 0 ]]; then
  MIGRATED_CONFIG_SHA="$(shasum -a 256 "$MIGRATED_CONFIG" | awk '{print $1}')" || migration_failed=1
fi
if [[ "$migration_failed" -ne 0 ]]; then
  printf 'Could not build the offline config migration; live plugin, config, and Gateway were not changed.\n' >&2
  exit 1
fi

verify_shared_install_gate
apply_failed=0
install -m 600 "$MIGRATED_CONFIG" "$PROFILE_CONFIG" || apply_failed=1
if [[ "$apply_failed" -eq 0 ]]; then
  validate_config_migration "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 ]]; then
  run_qwen_openclaw plugins install --force "$PLUGIN_DIR" > "$WORK_ROOT/install-current.txt" 2>&1 || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 ]]; then
  install -m 600 "$MIGRATED_CONFIG" "$PROFILE_CONFIG" || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 ]]; then
  run_qwen_openclaw gateway restart --wait 60s --json > "$WORK_ROOT/gateway-restart.json" || apply_failed=1
fi
if [[ "$apply_failed" -eq 0 ]]; then
  validate_installed_version "$CURRENT_VERSION" || apply_failed=1
  validate_runtime_payload_matches "$PLUGIN_DIR" || apply_failed=1
  validate_runtime "$CURRENT_VERSION" "$WORK_ROOT/runtime-current.json" "$WORK_ROOT/catalog-current.json" || apply_failed=1
  [[ "$(shasum -a 256 "$PROFILE_CONFIG" | awk '{print $1}')" == "$MIGRATED_CONFIG_SHA" ]] || apply_failed=1
  validate_config_migration "$BACKUP_DIR/openclaw.json" "$PROFILE_CONFIG" || apply_failed=1
  [[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]] || apply_failed=1
fi
if [[ "$apply_failed" -ne 0 ]]; then
  if ! restore_backup "$BACKUP_DIR"; then
    printf 'ROLLBACK FAILED: qwen-current requires manual inspection. Backup: %s\n' "$BACKUP_DIR" >&2
    exit 70
  fi
  printf 'Current plugin install failed; exact %s plugin and config were restored.\n' "$installed_version" >&2
  exit 1
fi

if ! enforce_retention; then
  if ! restore_backup "$BACKUP_DIR"; then
    printf 'ROLLBACK FAILED after backup-retention error. Backup: %s\n' "$BACKUP_DIR" >&2
    exit 70
  fi
  printf 'Backup retention failed; exact %s plugin and config were restored.\n' "$installed_version" >&2
  exit 1
fi
printf 'Installed the single current qwen-current plugin chain: %s -> %s at %s.\n' \
  "$installed_version" "$CURRENT_VERSION" "$TARGET_SHA"
printf 'Only the retired sender hash, plugin payload, and qwen-current Gateway changed; queue, n8n, media, database, and scheduler state were preserved.\n'
printf 'Verified rollback point: %s\n' "$BACKUP_DIR"
