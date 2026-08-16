#!/usr/bin/env bash
set -euo pipefail
umask 077

PROFILE="qwen-current"
PLUGIN_ID="aiworker-video-command"
AGENT_ID="second-original"
TOOL_ID="aiworker_analyze_video"
EXPECTED_VERSION="0.5.4"
OPENCLAW_VERSION="2026.7.1-2"
EXPECTED_USER="heisenbergs-1"
EXPECTED_HOST="HEISENBERGS-1deMac-Studio.local"
SESSION_SEARCH="qa-direct-tool-"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROFILE_STATE_DIR="$HOME/.openclaw-qwen-current"
PROFILE_CONFIG="$PROFILE_STATE_DIR/openclaw.json"
INSTALLED_PLUGIN_DIR="$PROFILE_STATE_DIR/extensions/$PLUGIN_ID"
BACKUP_ROOT="$HOME/ai-worker/backups/aiworker-video-command-direct-tool"
POLICY_HELPER="$REPOSITORY_ROOT/scripts/lib/direct-tool-access-policy.mjs"
WORK_ROOT=""
MODE=""
TARGET_SHA=""
ROLLBACK_BACKUP=""
BACKUP_DIR=""
BEFORE_LISTENERS=""

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
[[ "$MODE" != "rollback" || -n "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }

for command_name in awk chmod cmp cp date git hostname id install lsof mkdir mktemp node openclaw rm shasum; do
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
      /tmp/aiworker-video-direct-tool-access.*|/private/tmp/aiworker-video-direct-tool-access.*)
        rm -rf -- "$WORK_ROOT"
        ;;
      *) printf 'Refusing unexpected temporary cleanup path.\n' >&2; status=70 ;;
    esac
  fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-video-direct-tool-access.XXXXXX)"
chmod 700 "$WORK_ROOT"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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
  head="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')"
  origin_main="$(git -C "$REPOSITORY_ROOT" rev-parse --verify 'refs/remotes/origin/main^{commit}')"
  live_record="$(git -C "$REPOSITORY_ROOT" ls-remote --exit-code origin refs/heads/main)"
  [[ "$head" == "$TARGET_SHA" && "$origin_main" == "$TARGET_SHA" \
    && "$live_record" == "$TARGET_SHA"$'\trefs/heads/main' ]] || {
    printf 'HEAD, origin/main, live GitHub main, and target SHA must match.\n' >&2
    return 1
  }
}

validate_identity_and_source() {
  [[ "$(id -un)" == "$EXPECTED_USER" && "$(hostname)" == "$EXPECTED_HOST" ]] || {
    printf 'Refusing non-production identity.\n' >&2
    return 1
  }
  case "$(openclaw --version)" in
    "OpenClaw $OPENCLAW_VERSION ("*")" ) ;;
    *) printf 'Unsupported OpenClaw version.\n' >&2; return 1 ;;
  esac
  validate_git_target
  [[ -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] || return 1
  [[ -d "$INSTALLED_PLUGIN_DIR" && ! -L "$INSTALLED_PLUGIN_DIR" ]] || return 1
  [[ "$(node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$INSTALLED_PLUGIN_DIR/package.json")" == "$EXPECTED_VERSION" ]] || return 1
  run_qwen_openclaw plugins inspect "$PLUGIN_ID" --runtime --json > "$WORK_ROOT/runtime.json"
  node "$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID/scripts/validate-runtime-inspection.mjs" \
    "$WORK_ROOT/runtime.json" "$PLUGIN_ID" "$EXPECTED_VERSION"
}

validate_pre_access_config() {
  node - "$PROFILE_CONFIG" "$AGENT_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [configPath, agentId, toolId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const agents = config?.agents?.list
if (!Array.isArray(agents)) throw new Error('agents.list must be an array')
const targets = agents.filter(agent => agent?.id === agentId)
if (targets.length !== 1) throw new Error('second-original must exist exactly once')
const target = targets[0]
if (!Array.isArray(target?.tools?.allow) || target.tools.allow.includes(toolId)) {
  throw new Error('second-original tools.allow is not the expected baseline')
}
if (target.tools.alsoAllow !== undefined) throw new Error('second-original already has alsoAllow; refusing blind merge')
for (const agent of agents) {
  if (agent?.id === agentId) continue
  for (const key of ['allow', 'alsoAllow']) {
    if (Array.isArray(agent?.tools?.[key]) && agent.tools[key].includes(toolId)) {
      throw new Error(`another agent grants ${toolId}`)
    }
  }
}
for (const key of ['allow', 'alsoAllow']) {
  if (Array.isArray(config?.tools?.[key]) && config.tools[key].includes(toolId)) {
    throw new Error(`global tools.${key} grants ${toolId}`)
  }
}
NODE
}

find_direct_session() {
  local sessions_report="$WORK_ROOT/sessions.json"
  run_qwen_openclaw gateway call sessions.list \
    --params "{\"agentId\":\"$AGENT_ID\",\"search\":\"$SESSION_SEARCH\",\"configuredAgentsOnly\":true,\"includeGlobal\":false,\"limit\":200}" \
    --timeout 20000 --json > "$sessions_report"
  node - "$sessions_report" "$AGENT_ID" "$SESSION_SEARCH" <<'NODE'
const fs = require('node:fs')
const [reportPath, agentId, search] = process.argv.slice(2)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const prefix = `agent:${agentId}:`
const matches = (report.sessions || [])
  .filter(session => typeof session?.key === 'string'
    && session.key.startsWith(prefix)
    && session.key.includes(search)
    && !session.key.includes(':telegram:'))
if (matches.length !== 1) throw new Error(`expected one direct session containing ${search}`)
process.stdout.write(matches[0].key)
NODE
}

capture_baseline() {
  DIRECT_SESSION_KEY="$(find_direct_session)"
  run_qwen_openclaw gateway call tools.catalog \
    --params "{\"agentId\":\"$AGENT_ID\",\"includePlugins\":true}" \
    --timeout 20000 --json > "$WORK_ROOT/tools-catalog.json"
  validate_effective absent "$WORK_ROOT/tools-effective-before.json" "$DIRECT_SESSION_KEY"
}

validate_effective() {
  local expected="$1" report="$2" session_key="$3"
  run_qwen_openclaw gateway call tools.effective \
    --params "{\"agentId\":\"$AGENT_ID\",\"sessionKey\":\"$session_key\"}" \
    --timeout 20000 --json > "$report"
  node - "$report" "$AGENT_ID" "$TOOL_ID" "$expected" <<'NODE'
const fs = require('node:fs')
const [reportPath, agentId, toolId, expected] = process.argv.slice(2)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
if (report.agentId !== agentId || !Array.isArray(report.groups)) throw new Error('invalid tools.effective report')
const matches = report.groups.flatMap(group => (Array.isArray(group?.tools) ? group.tools : [])
  .filter(tool => tool?.id === toolId))
if (expected === 'present') {
  if (matches.length !== 1 || matches[0].source !== 'plugin' || matches[0].pluginId !== 'aiworker-video-command') {
    throw new Error('direct video tool is not effective exactly once')
  }
} else if (matches.length !== 0) {
  throw new Error('direct video tool remains effective after rollback')
}
NODE
}

validate_effective_exact() {
  local report="$1" session_key="$2"
  run_qwen_openclaw gateway call tools.effective \
    --params "{\"agentId\":\"$AGENT_ID\",\"sessionKey\":\"$session_key\"}" \
    --timeout 20000 --json > "$report"
  node - "$WORK_ROOT/tools-effective-before.json" "$report" "$AGENT_ID" "$TOOL_ID" <<'NODE'
const fs = require('node:fs')
const [beforePath, afterPath, agentId, toolId] = process.argv.slice(2)
const read = pathname => JSON.parse(fs.readFileSync(pathname, 'utf8'))
const ids = report => new Set(report.groups.flatMap(group => (group.tools || []).map(tool => tool.id)))
const before = read(beforePath)
const after = read(afterPath)
if (before.agentId !== agentId || after.agentId !== agentId) throw new Error('effective report agent mismatch')
const expected = ids(before)
expected.add(toolId)
const actual = ids(after)
if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) {
  throw new Error('effective tools differ from the baseline plus the direct video tool')
}
const matches = after.groups.flatMap(group => (group.tools || []).filter(tool => tool.id === toolId))
if (matches.length !== 1 || matches[0].source !== 'plugin' || matches[0].pluginId !== 'aiworker-video-command') {
  throw new Error('direct video tool is not effective exactly once')
}
NODE
}

restore_config() {
  local backup="$1"
  install -m 600 "$backup/openclaw.json" "$PROFILE_CONFIG"
  run_qwen_openclaw gateway restart --wait 60s --json > "$backup/rollback-restart.json"
  validate_pre_access_config
  local session_key
  session_key="$(find_direct_session)"
  validate_effective absent "$backup/tools-effective-after-rollback.json" "$session_key"
}

enforce_retention() {
  node - "$BACKUP_ROOT" <<'NODE'
const { existsSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const root = process.argv[2]
if (!existsSync(root)) process.exit(0)
const entries = readdirSync(root)
  .filter(name => /^direct-tool-access-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u.test(name))
  .map(name => ({ path: join(root, name), time: statSync(join(root, name)).mtimeMs }))
  .filter(entry => statSync(entry.path).isDirectory()
    && existsSync(join(entry.path, '.verified'))
    && statSync(join(entry.path, '.verified')).isFile())
  .sort((left, right) => right.time - left.time)
for (const entry of entries.slice(2)) rmSync(entry.path, { recursive: true, force: true })
NODE
}

validate_identity_and_source
if [[ "$MODE" == "rollback" ]]; then
  [[ -d "$ROLLBACK_BACKUP" && "$ROLLBACK_BACKUP" == "$BACKUP_ROOT"/direct-tool-access-* ]] || {
    printf 'Rollback backup is outside the approved family.\n' >&2
    exit 1
  }
  [[ -f "$ROLLBACK_BACKUP/openclaw.json" && -f "$ROLLBACK_BACKUP/metadata.json" ]] || exit 1
else
  validate_pre_access_config
fi
BEFORE_LISTENERS="$(listener_snapshot)"

if [[ "$MODE" == "dry-run" ]]; then
  capture_baseline
  node "$POLICY_HELPER" build "$PROFILE_CONFIG" "$WORK_ROOT/tools-effective-before.json" \
    "$WORK_ROOT/tools-catalog.json" "$AGENT_ID" "$TOOL_ID" "$WORK_ROOT/candidate.json"
  node "$POLICY_HELPER" validate "$PROFILE_CONFIG" "$WORK_ROOT/tools-effective-before.json" \
    "$WORK_ROOT/tools-catalog.json" "$AGENT_ID" "$TOOL_ID" "$WORK_ROOT/candidate.json"
  printf 'Direct video tool access dry-run passed at %s.\n' "$TARGET_SHA"
  printf 'No config, gateway, queue, n8n, media, or database state changed.\n'
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  restore_config "$ROLLBACK_BACKUP"
  [[ "$(listener_snapshot)" == "$BEFORE_LISTENERS" ]] || exit 1
  printf 'Rolled back direct video tool access for %s.\n' "$AGENT_ID"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/direct-tool-access-$(date +%Y%m%d-%H%M%S).XXXXXX")"
chmod 700 "$BACKUP_DIR"
install -m 600 "$PROFILE_CONFIG" "$BACKUP_DIR/openclaw.json"
printf '{"schemaVersion":1,"agentId":"%s","toolId":"%s","version":"%s","targetSha":"%s"}\n' \
  "$AGENT_ID" "$TOOL_ID" "$EXPECTED_VERSION" "$TARGET_SHA" > "$BACKUP_DIR/metadata.json"
chmod 600 "$BACKUP_DIR/metadata.json"

capture_baseline
node "$POLICY_HELPER" build "$BACKUP_DIR/openclaw.json" "$WORK_ROOT/tools-effective-before.json" \
  "$WORK_ROOT/tools-catalog.json" "$AGENT_ID" "$TOOL_ID" "$WORK_ROOT/candidate.json"
node "$POLICY_HELPER" validate "$BACKUP_DIR/openclaw.json" "$WORK_ROOT/tools-effective-before.json" \
  "$WORK_ROOT/tools-catalog.json" "$AGENT_ID" "$TOOL_ID" "$WORK_ROOT/candidate.json"
install -m 600 "$WORK_ROOT/candidate.json" "$PROFILE_CONFIG"

run_qwen_openclaw gateway restart --wait 60s --json > "$BACKUP_DIR/gateway-restart.json"
if ! validate_effective_exact "$BACKUP_DIR/tools-effective-after-apply.json" "$DIRECT_SESSION_KEY" \
  || [[ "$(listener_snapshot)" != "$BEFORE_LISTENERS" ]]; then
  restore_config "$BACKUP_DIR"
  exit 1
fi
install -m 600 /dev/null "$BACKUP_DIR/.verified"
enforce_retention
printf 'Enabled %s for %s with profile coding plus one additive allow and an exact deny set.\n' "$TOOL_ID" "$AGENT_ID"
printf 'Config backup: %s\n' "$BACKUP_DIR"
