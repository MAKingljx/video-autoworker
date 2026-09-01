#!/usr/bin/env bash
set -euo pipefail
umask 077

PLUGIN_ID="aiworker-director-brain"
TOOL_ID="aiworker_director_brain"
DEFAULT_AGENT_ID="second-original"

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLUGIN_SOURCE="$REPOSITORY_ROOT/openclaw-plugins/$PLUGIN_ID"
SKILL_SOURCE="$REPOSITORY_ROOT/openclaw-skills/$PLUGIN_ID"
SERVICE_SOURCE="$REPOSITORY_ROOT/scripts/lib/feishu-director-brain.mjs"
SERVICE_CLI_SOURCE="$REPOSITORY_ROOT/scripts/feishu-director-brain.mjs"
SCHEMA_SOURCE="$REPOSITORY_ROOT/ops/feishu-director-brain/schema.json"
SHARED_INSTALL_GATE="$REPOSITORY_ROOT/scripts/verify-shared-runtime-install-gate.mjs"
SHARED_DEPLOYMENT_LOCK_HELPER="$REPOSITORY_ROOT/scripts/lib/shared-deployment-lock.sh"
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

MODE=""
PROFILE=""
STATE_DIR=""
WORKSPACE=""
AGENT_ID="$DEFAULT_AGENT_ID"
BACKUP_ROOT=""
ROLLBACK_BACKUP=""
ROLLBACK_SOURCE_ORIGINAL=""
ROLLBACK_SOURCE_CLAIM=""
ROLLBACK_SOURCE_CLAIM_ROOT=""
ROLLBACK_SOURCE_ROOT_IDENTITY=""
ROLLBACK_SOURCE_STATE_IDENTITY=""
ROLLBACK_SOURCE_MANIFEST_IDENTITY=""
ROLLBACK_SOURCE_CONFIG_IDENTITY=""
ROLLBACK_SOURCE_PLUGIN_IDENTITY=""
ROLLBACK_SOURCE_SKILL_IDENTITY=""
WORK_ROOT=""
LOCK_DIR=""
LOCK_OWNED=0
DEPLOYMENT_LOCK_OWNED=0
COMMIT_STARTED=0
COMMIT_COMPLETE=0
PLUGIN_OLD_MOVED=0
PLUGIN_NEW_ACTIVATED=0
PLUGIN_NEW_IDENTITY=""
PLUGIN_PREVIOUS_IDENTITY=""
PLUGIN_PREVIOUS_VERIFIED=0
SKILL_OLD_MOVED=0
SKILL_NEW_ACTIVATED=0
SKILL_NEW_IDENTITY=""
SKILL_PREVIOUS_IDENTITY=""
SKILL_PREVIOUS_VERIFIED=0
CONFIG_OLD_MOVED=0
CONFIG_NEW_ACTIVATED=0
CONFIG_NEW_IDENTITY=""
CONFIG_PREVIOUS_VERIFIED=0
CONFIG_DRIFT_ROOT=""
CONFIG_DRIFT_ARTIFACT=""
CONFIG_RETIRED_ROOT=""
CONFIG_RETIRED_ARTIFACT=""
PLUGIN_RETIRED_ROOT=""
PLUGIN_RETIRED_ARTIFACT=""
SKILL_RETIRED_ROOT=""
SKILL_RETIRED_ARTIFACT=""
PLUGIN_DRIFT_ROOT=""
PLUGIN_DRIFT_ARTIFACT=""
SKILL_DRIFT_ROOT=""
SKILL_DRIFT_ARTIFACT=""
DEFERRED_SIGNAL_STATUS=0
PLUGIN_PREVIOUS=""
SKILL_PREVIOUS=""
CONFIG_PREVIOUS=""
PLUGIN_NEXT=""
SKILL_NEXT=""
CONFIG_NEXT=""
PREFLIGHT_CONFIG_SHA256=""
LOCKED_CONFIG_SHA256=""
LOCKED_CONFIG_IDENTITY=""
CONFIG_PREVIOUS_IDENTITY=""
SAFETY_BACKUP=""
EXTENSIONS_CREATED=0
SKILLS_CREATED=0

usage() {
  printf '%s\n' \
    "Usage:" \
    "  $0 --dry-run --profile <name> --state-dir <absolute-path> --workspace <absolute-path> [--agent <id>] [--backup-root <absolute-path>]" \
    "  $0 --apply   --profile <name> --state-dir <absolute-path> --workspace <absolute-path> [--agent <id>] [--backup-root <absolute-path>]" \
    "  $0 --rollback --profile <name> --state-dir <absolute-path> --workspace <absolute-path> --backup <absolute-path> [--agent <id>] [--backup-root <absolute-path>]"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply|--rollback)
      [[ -z "$MODE" ]] || { usage >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --profile)
      [[ -z "$PROFILE" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      PROFILE="$2"
      shift 2
      ;;
    --state-dir)
      [[ -z "$STATE_DIR" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      STATE_DIR="$2"
      shift 2
      ;;
    --workspace)
      [[ -z "$WORKSPACE" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      WORKSPACE="$2"
      shift 2
      ;;
    --agent)
      [[ "$AGENT_ID" == "$DEFAULT_AGENT_ID" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      AGENT_ID="$2"
      shift 2
      ;;
    --backup-root)
      [[ -z "$BACKUP_ROOT" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      BACKUP_ROOT="$2"
      shift 2
      ;;
    --backup)
      [[ -z "$ROLLBACK_BACKUP" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      ROLLBACK_BACKUP="$2"
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

[[ -n "$MODE" && -n "$PROFILE" && -n "$STATE_DIR" && -n "$WORKSPACE" ]] || {
  usage >&2
  exit 2
}
[[ "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  printf 'OpenClaw profile name is invalid.\n' >&2
  exit 2
}
[[ "$AGENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
  printf 'OpenClaw agent ID is invalid.\n' >&2
  exit 2
}
case "$STATE_DIR:$WORKSPACE" in
  /*:/*) ;;
  *) printf 'State directory and workspace must be absolute paths.\n' >&2; exit 2 ;;
esac
[[ "$MODE" == "rollback" || -z "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }
[[ "$MODE" != "rollback" || "$ROLLBACK_BACKUP" == /* ]] || { usage >&2; exit 2; }

for required_command in chmod cmp cp date diff env find git grep install ln mkdir mktemp mv node pwd readlink rm rmdir sed shasum stat; do
  command -v "$required_command" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$required_command" >&2
    exit 1
  }
done
if [[ -x /usr/bin/git && ! -L /usr/bin/git ]]; then
  GIT_COMMAND=/usr/bin/git
else
  GIT_COMMAND="$(command -v git)"
fi
case "$GIT_COMMAND" in
  /*) ;;
  *) printf 'Git command must resolve to an absolute path.\n' >&2; exit 1 ;;
esac
EXPECTED_SOURCE_COMMIT="$(env \
  -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
  -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM \
  "$GIT_COMMAND" -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')" || {
  printf 'Could not resolve the director-brain source commit.\n' >&2
  exit 1
}
[[ "$EXPECTED_SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || {
  printf 'Director-brain source commit must be one full lowercase Git commit.\n' >&2
  exit 1
}
EXPECTED_RELEASE_ID="$EXPECTED_SOURCE_COMMIT-runtime"

regular_directory() {
  [[ -d "$1" && ! -L "$1" ]]
}

regular_file() {
  [[ -f "$1" && ! -L "$1" ]]
}

tree_has_symlink() {
  find "$1" -type l -print -quit | grep -q .
}

validate_tree_path_names() {
  local root="$1"
  while IFS= read -r pathname; do
    local relative="${pathname#"$root"/}"
    [[ "$pathname" != *$'\n'* && "$pathname" != *$'\t'* \
      && "$relative" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  done < <(find "$root" -mindepth 1 -print)
}

[[ "$STATE_DIR" == / ]] || STATE_DIR="${STATE_DIR%/}"
[[ "$WORKSPACE" == / ]] || WORKSPACE="${WORKSPACE%/}"
regular_directory "$STATE_DIR" || {
  printf 'OpenClaw state directory must be an existing regular directory: %s\n' "$STATE_DIR" >&2
  exit 1
}
regular_directory "$WORKSPACE" || {
  printf 'OpenClaw workspace must be an existing regular directory: %s\n' "$WORKSPACE" >&2
  exit 1
}
STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"
WORKSPACE="$(cd "$WORKSPACE" && pwd -P)"
HOME_ROOT="$(cd "$HOME" && pwd -P)"

resolve_planned_directory() {
  node - "$1" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const input = process.argv[2]
let existing = path.resolve(input)
const suffix = []
while (!fs.existsSync(existing)) {
  const parent = path.dirname(existing)
  if (parent === existing) throw new Error('planned_path_has_no_existing_ancestor')
  suffix.unshift(path.basename(existing))
  existing = parent
}
if (!fs.statSync(existing).isDirectory()) throw new Error('planned_path_ancestor_not_directory')
process.stdout.write(path.join(fs.realpathSync(existing), ...suffix))
NODE
}

reject_git_worktree_path() {
  local label="$1" pathname="$2" existing="$2"
  while [[ ! -d "$existing" ]]; do
    [[ "$existing" != / ]] || break
    existing="$(dirname "$existing")"
  done
  local cursor="$existing" marker gitdir_target
  while :; do
    marker="$cursor/.git"
    if [[ -L "$marker" ]]; then
      printf 'Unable to verify the Git boundary for %s: symlink .git marker at %s\n' \
        "$label" "$cursor" >&2
      return 1
    fi
    if [[ -d "$marker" ]]; then
      printf '%s must be outside every Git worktree: %s\n' "$label" "$pathname" >&2
      return 1
    fi
    if [[ -f "$marker" ]]; then
      gitdir_target="$(node - "$marker" "$cursor" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [marker, worktreeRoot] = process.argv.slice(2)
const content = fs.readFileSync(marker, 'utf8')
const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(content)
if (!match) throw new Error('gitfile_format_invalid')
const target = path.resolve(worktreeRoot, match[1])
const value = fs.lstatSync(target)
if (value.isSymbolicLink() || !value.isDirectory()) throw new Error('gitfile_target_invalid')
process.stdout.write(fs.realpathSync(target))
NODE
)" || {
        printf 'Unable to verify the Git boundary for %s: invalid .git file at %s\n' \
          "$label" "$cursor" >&2
        return 1
      }
      [[ -n "$gitdir_target" ]] || {
        printf 'Unable to verify the Git boundary for %s: empty gitdir target at %s\n' \
          "$label" "$cursor" >&2
        return 1
      }
      printf '%s must be outside every Git worktree: %s\n' "$label" "$pathname" >&2
      return 1
    fi
    if [[ -e "$marker" ]]; then
      printf 'Unable to verify the Git boundary for %s: unsupported .git object at %s\n' \
        "$label" "$cursor" >&2
      return 1
    fi
    [[ "$cursor" != / ]] || break
    cursor="$(dirname "$cursor")"
  done
  local probe_output probe_status=0
  probe_output="$(env -i \
    PATH="$(dirname "$GIT_COMMAND"):/usr/bin:/bin" \
    LC_ALL=C \
    LANG=C \
    HOME=/var/empty \
    XDG_CONFIG_HOME=/var/empty \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    "$GIT_COMMAND" -C "$existing" rev-parse \
      --is-inside-work-tree --is-inside-git-dir 2>&1)" || probe_status=$?
  if [[ "$probe_status" == 0 ]]; then
    printf '%s must be outside every Git worktree: %s\n' "$label" "$pathname" >&2
    return 1
  fi
  if [[ "$probe_status" != 0 && "$probe_output" != "fatal: not a git repository"* ]]; then
    printf 'Unable to verify the Git boundary for %s: %s\n' "$label" "$pathname" >&2
    return 1
  fi
}

secure_prepare_backup_root() {
  node - "$BACKUP_ROOT" <<'NODE' || return 1
const fs = require('node:fs')
const path = require('node:path')
const target = path.resolve(process.argv[2])
const parsed = path.parse(target)
let current = parsed.root
for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, component)
  let value
  try {
    value = fs.lstatSync(current)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    try {
      fs.mkdirSync(current, { mode: 0o700 })
    } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') throw mkdirError
    }
    value = fs.lstatSync(current)
  }
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw new Error(`backup_root_component_invalid:${current}`)
  }
}
const directoryFd = fs.openSync(
  target,
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
)
try {
  const finalValue = fs.fstatSync(directoryFd)
  if (!finalValue.isDirectory()) throw new Error('backup_root_final_object_invalid')
  fs.fchmodSync(directoryFd, 0o700)
} finally {
  fs.closeSync(directoryFd)
}
NODE
  regular_directory "$BACKUP_ROOT" || return 1
  local physical_root
  physical_root="$(cd "$BACKUP_ROOT" && pwd -P)" || return 1
  if [[ "$physical_root" != "$BACKUP_ROOT" ]]; then
    printf 'Backup root changed physical location after its directory claim.\n' >&2
    return 1
  fi
  reject_git_worktree_path 'Backup root' "$physical_root" || return 1
}

reject_overly_broad_path() {
  local label="$1" pathname="$2"
  case "$pathname" in
    /|"$HOME_ROOT"|"$REPOSITORY_ROOT")
      printf '%s must not resolve to an overly broad directory: %s\n' "$label" "$pathname" >&2
      return 1
      ;;
  esac
}

paths_overlap() {
  local left="$1" right="$2"
  [[ "$left" == "$right" || "$left/" == "$right/"* || "$right/" == "$left/"* ]]
}

reject_path_overlap() {
  local left_label="$1" left="$2" right_label="$3" right="$4"
  if paths_overlap "$left" "$right"; then
    printf '%s must not overlap %s: %s <-> %s\n' \
      "$left_label" "$right_label" "$left" "$right" >&2
    return 1
  fi
}

validate_effective_backup_root() {
  local label="$1" root="$2"
  reject_overly_broad_path "$label" "$root" || return 1
  reject_git_worktree_path "$label" "$root" || return 1
  if [[ "$root" == "$STATE_DIR" || "$root" == "$WORKSPACE" ]]; then
    printf '%s must not equal the OpenClaw state directory or workspace.\n' "$label" >&2
    return 1
  fi
  case "$root/" in
    "$INSTALLED_PLUGIN/"*|"$INSTALLED_SKILL/"*)
      printf '%s must be outside managed plugin and Skill targets.\n' "$label" >&2
      return 1
      ;;
  esac
  # A backup root may live in a dedicated descendant such as STATE_DIR/backups,
  # but it must never contain a managed source/target. Otherwise the rescue
  # backup or a later rollback can recursively copy its own input.
  for managed in \
    "$PROFILE_CONFIG" \
    "$INSTALLED_PLUGIN" \
    "$INSTALLED_SKILL" \
    "$STATE_DIR/extensions" \
    "$WORKSPACE/skills"; do
    case "$managed/" in
      "$root/"*)
        printf '%s must not contain a managed copy source or target: %s\n' "$label" "$managed" >&2
        return 1
        ;;
    esac
  done
}

validate_effective_rollback_backup() {
  local backup="$1"
  reject_overly_broad_path 'Rollback backup' "$backup" || return 1
  reject_git_worktree_path 'Rollback backup' "$backup" || return 1
  if [[ "$backup" == "$STATE_DIR" || "$backup" == "$WORKSPACE" ]]; then
    printf 'Rollback backup must not equal the OpenClaw state directory or workspace.\n' >&2
    return 1
  fi
  case "$backup/" in
    "$INSTALLED_PLUGIN/"*|"$INSTALLED_SKILL/"*)
      printf 'Rollback backup must be outside managed plugin and Skill targets.\n' >&2
      return 1
      ;;
  esac
  for managed in \
    "$PROFILE_CONFIG" \
    "$INSTALLED_PLUGIN" \
    "$INSTALLED_SKILL" \
    "$STATE_DIR/extensions" \
    "$WORKSPACE/skills" \
    "$WORK_ROOT" \
    "$DESIRED_CONFIG" \
    "$DESIRED_PLUGIN" \
    "$DESIRED_SKILL"; do
    case "$managed/" in
      "$backup/"*)
        printf 'Rollback backup must not contain a managed copy source or target: %s\n' "$managed" >&2
        return 1
        ;;
    esac
  done
}

validate_rollback_copy_endpoints() {
  local backup="$1"
  local backup_config backup_plugin backup_skill
  backup_config="$(cd "$(dirname "$backup/openclaw.json")" && pwd -P)/$(basename "$backup/openclaw.json")"
  reject_path_overlap 'Rollback config member' "$backup_config" \
    'active profile config' "$PROFILE_CONFIG" || return 1
  if grep -q '^plugin_present=1$' "$backup/STATE"; then
    backup_plugin="$(cd "$backup/plugin" && pwd -P)" || return 1
    reject_path_overlap 'Rollback plugin member' "$backup_plugin" \
      'managed plugin target' "$INSTALLED_PLUGIN" || return 1
    reject_path_overlap 'Rollback plugin member' "$backup_plugin" \
      'plugin activation parent' "$STATE_DIR/extensions" || return 1
  fi
  if grep -q '^skill_present=1$' "$backup/STATE"; then
    backup_skill="$(cd "$backup/skill" && pwd -P)" || return 1
    reject_path_overlap 'Rollback Skill member' "$backup_skill" \
      'managed Skill target' "$INSTALLED_SKILL" || return 1
    reject_path_overlap 'Rollback Skill member' "$backup_skill" \
      'Skill activation parent' "$WORKSPACE/skills" || return 1
  fi
  for endpoint in "$WORK_ROOT" "$DESIRED_CONFIG" "$DESIRED_PLUGIN" "$DESIRED_SKILL"; do
    reject_path_overlap 'Rollback backup' "$backup" 'installer transaction path' "$endpoint" || return 1
  done
}

reject_overly_broad_path 'OpenClaw state directory' "$STATE_DIR" || exit 1
reject_overly_broad_path 'OpenClaw workspace' "$WORKSPACE" || exit 1
PROFILE_CONFIG="$STATE_DIR/openclaw.json"
INSTALLED_PLUGIN="$STATE_DIR/extensions/$PLUGIN_ID"
INSTALLED_SKILL="$WORKSPACE/skills/$PLUGIN_ID"
BACKUP_ROOT="${BACKUP_ROOT:-$STATE_DIR/backups/$PLUGIN_ID}"
case "$BACKUP_ROOT" in
  /*) BACKUP_ROOT="$(resolve_planned_directory "$BACKUP_ROOT")" || {
    printf 'Backup root could not be resolved through an existing directory ancestor.\n' >&2
    exit 1
  } ;;
  *) printf 'Backup root must be an absolute path.\n' >&2; exit 2 ;;
esac
reject_overly_broad_path 'Backup root' "$BACKUP_ROOT" || exit 1
reject_git_worktree_path 'OpenClaw state directory' "$STATE_DIR" || exit 1
validate_effective_backup_root 'Backup root' "$BACKUP_ROOT" || exit 1

regular_file "$PROFILE_CONFIG" || {
  printf 'OpenClaw profile config must be an existing regular file: %s\n' "$PROFILE_CONFIG" >&2
  exit 1
}

validate_agent_workspace() {
  local pathname="$1"
  node - "$pathname" "$AGENT_ID" "$WORKSPACE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [pathname, agentId, expectedWorkspace] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(pathname, 'utf8'))
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('profile_config_invalid')
}
const agents = Array.isArray(config.agents?.list) ? config.agents.list : []
const targets = agents.filter(agent => agent?.id === agentId)
if (targets.length === 0) throw new Error('target_agent_missing')
if (targets.length > 1) throw new Error('target_agent_ambiguous')
const configuredWorkspace = targets[0]?.workspace
if (typeof configuredWorkspace !== 'string' || configuredWorkspace.length === 0) {
  throw new Error('target_agent_workspace_missing')
}
if (!path.isAbsolute(configuredWorkspace)) {
  throw new Error('target_agent_workspace_invalid')
}
let resolvedWorkspace
try {
  resolvedWorkspace = fs.realpathSync(configuredWorkspace)
} catch {
  throw new Error('target_agent_workspace_invalid')
}
if (resolvedWorkspace !== expectedWorkspace) {
  throw new Error('target_agent_workspace_mismatch')
}
NODE
}

for target in "$INSTALLED_PLUGIN" "$INSTALLED_SKILL"; do
  if [[ -L "$target" || ( -e "$target" && ! -d "$target" ) ]]; then
    printf 'Managed target must be a regular directory: %s\n' "$target" >&2
    exit 1
  fi
  if [[ -d "$target" ]] && { tree_has_symlink "$target" || ! validate_tree_path_names "$target"; }; then
    printf 'Managed target contains an unsupported symlink or path name: %s\n' "$target" >&2
    exit 1
  fi
done
for managed_root in "$STATE_DIR/extensions" "$WORKSPACE/skills"; do
  if [[ -L "$managed_root" || ( -e "$managed_root" && ! -d "$managed_root" ) ]]; then
    printf 'Managed root must be a regular directory: %s\n' "$managed_root" >&2
    exit 1
  fi
done
regular_file "$SHARED_INSTALL_GATE" || {
  printf 'Shared runtime install gate is unavailable: %s\n' "$SHARED_INSTALL_GATE" >&2
  exit 1
}
regular_file "$SHARED_DEPLOYMENT_LOCK_HELPER" || {
  printf 'Shared deployment lock helper is unavailable: %s\n' "$SHARED_DEPLOYMENT_LOCK_HELPER" >&2
  exit 1
}

if [[ "$MODE" != "rollback" ]]; then
  validate_agent_workspace "$PROFILE_CONFIG"
  for source_file in \
    "$PLUGIN_SOURCE/index.js" \
    "$PLUGIN_SOURCE/openclaw.plugin.json" \
    "$PLUGIN_SOURCE/package.json" \
    "$PLUGIN_SOURCE/lib/director-brain-tool.js" \
    "$SKILL_SOURCE/SKILL.md" \
    "$SERVICE_SOURCE" \
    "$SERVICE_CLI_SOURCE" \
    "$SCHEMA_SOURCE"; do
    regular_file "$source_file" || {
      printf 'Director-brain source is incomplete: %s\n' "$source_file" >&2
      exit 1
    }
  done
  for source_tree in "$PLUGIN_SOURCE/lib" "$SKILL_SOURCE"; do
    if tree_has_symlink "$source_tree" || ! validate_tree_path_names "$source_tree"; then
      printf 'Director-brain source contains an unsupported symlink or path name: %s\n' "$source_tree" >&2
      exit 1
    fi
  done
  node --check "$PLUGIN_SOURCE/index.js"
  node --check "$PLUGIN_SOURCE/lib/director-brain-tool.js"
  node --check "$SERVICE_CLI_SOURCE"
  node --check "$SERVICE_SOURCE"
fi

TEST_FAILPOINT="${AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_FAILPOINT:-}"
TEST_SYNC_DIR="${AIWORKER_DIRECTOR_BRAIN_INSTALL_TEST_SYNC_DIR:-}"
if [[ ( -n "$TEST_FAILPOINT" || -n "$TEST_SYNC_DIR" ) \
  && "${AIWORKER_DIRECTOR_BRAIN_INSTALL_TESTING:-0}" != "1" ]]; then
  printf 'Installer failure injection is available only in an explicit test environment.\n' >&2
  exit 1
fi
case "$TEST_FAILPOINT" in
  ""|after-plugin|after-skill|after-config|backup-plugin-copy-failed|\
    plugin-old-move-failed|plugin-new-move-failed|\
    skill-old-move-failed|skill-new-move-failed|\
    config-old-move-failed|config-new-move-failed|\
    signal-after-plugin-old-move|signal-after-plugin-new-move|\
    signal-after-skill-old-move|signal-after-skill-new-move|\
    signal-after-config-old-move|signal-after-config-new-move|\
    plugin-old-move-reported-failed|plugin-new-move-reported-failed|\
    skill-old-move-reported-failed|skill-new-move-reported-failed|\
    config-old-move-reported-failed|config-new-move-reported-failed|\
    config-previous-drift|config-active-drift|config-active-replacement|config-final-check-barrier|\
    config-concurrent-before-activation|rollback-source-before-copy|\
    config-previous-open-fd|config-previous-postcheck-open-fd|\
    config-retain-path-replace|signal-during-finalization|plugin-retain-move-failed|\
    plugin-retain-postcheck-failed|skill-retain-postcheck-failed|\
    config-retain-postmove-mode-drift|backup-root-ancestor-swap|\
    plugin-active-replacement|skill-active-replacement) ;;
  *) printf 'Unknown installer test failpoint: %s\n' "$TEST_FAILPOINT" >&2; exit 1 ;;
esac
if [[ -n "$TEST_SYNC_DIR" ]]; then
  regular_directory "$TEST_SYNC_DIR" || {
    printf 'Installer test sync directory must be an existing regular directory.\n' >&2
    exit 1
  }
  TEST_SYNC_DIR="$(cd "$TEST_SYNC_DIR" && pwd -P)"
fi
if [[ ( "$TEST_FAILPOINT" == "config-previous-open-fd" \
  || "$TEST_FAILPOINT" == "config-previous-postcheck-open-fd" \
  || "$TEST_FAILPOINT" == "config-retain-path-replace" \
  || "$TEST_FAILPOINT" == "backup-root-ancestor-swap" \
  || "$TEST_FAILPOINT" == "plugin-active-replacement" \
  || "$TEST_FAILPOINT" == "skill-active-replacement" \
  || "$TEST_FAILPOINT" == "config-active-replacement" \
  || "$TEST_FAILPOINT" == "config-final-check-barrier" \
  || "$TEST_FAILPOINT" == "rollback-source-before-copy" ) \
  && -z "$TEST_SYNC_DIR" ]]; then
  printf 'The selected installer failpoint requires a test sync directory.\n' >&2
  exit 1
fi

wait_for_test_barrier() {
  local ready_name="$1" continue_name="$2" label="$3"
  install -m 600 /dev/null "$TEST_SYNC_DIR/$ready_name"
  local released=0
  for _ in {1..200}; do
    if [[ -f "$TEST_SYNC_DIR/$continue_name" ]]; then
      released=1
      break
    fi
    sleep 0.05
  done
  if [[ "$released" != 1 ]]; then
    printf 'Timed out waiting for %s test synchronization.\n' "$label" >&2
    return 1
  fi
}

path_mode() {
  stat -f '%Lp' "$1"
}

path_sha256() {
  local digest
  digest="$(shasum -a 256 "$1")" || return 1
  printf '%s' "${digest%% *}"
}

path_identity() {
  stat -f '%d:%i' "$1" 2>/dev/null || stat -c '%d:%i' "$1"
}

verify_activated_config_identity() {
  regular_file "$PROFILE_CONFIG" \
    && [[ -n "$CONFIG_NEW_IDENTITY" ]] \
    && [[ "$(path_identity "$PROFILE_CONFIG" 2>/dev/null || true)" == "$CONFIG_NEW_IDENTITY" ]]
}

TREE_RETAINED_ROOT=""
TREE_RETAINED_ARTIFACT=""
TREE_RETAINED_SOURCE_MOVED=0
TREE_RETAINED_VERIFIED=0

retain_previous_tree() {
  local previous="$1"
  local parent="$2"
  local prefix="$3"
  local verified_backup="$4"
  local move_failpoint="$5"
  local postcheck_failpoint="$6"
  local move_status=0

  TREE_RETAINED_SOURCE_MOVED=0
  TREE_RETAINED_VERIFIED=0
  TREE_RETAINED_ROOT="$(mktemp -d "$parent/$prefix.retired.XXXXXX")" || return 1
  chmod 700 "$TREE_RETAINED_ROOT" || {
    rmdir "$TREE_RETAINED_ROOT" 2>/dev/null || true
    TREE_RETAINED_ROOT=""
    return 1
  }
  TREE_RETAINED_ARTIFACT="$TREE_RETAINED_ROOT/payload"
  [[ -z "$move_failpoint" || "$TEST_FAILPOINT" != "$move_failpoint" ]] || return 99
  mv "$previous" "$TREE_RETAINED_ARTIFACT" || move_status=$?
  if [[ ! -e "$previous" && ! -L "$previous" ]] \
    && regular_directory "$TREE_RETAINED_ARTIFACT"; then
    TREE_RETAINED_SOURCE_MOVED=1
    if [[ -n "$postcheck_failpoint" && "$TEST_FAILPOINT" == "$postcheck_failpoint" ]]; then
      return 99
    fi
    if trees_equal "$TREE_RETAINED_ARTIFACT" "$verified_backup"; then
      TREE_RETAINED_VERIFIED=1
      return 0
    fi
  fi
  [[ "$move_status" != 0 ]] || move_status=1
  return "$move_status"
}

write_tree_manifest() {
  local tree_root="$1" output="$2"
  if ! (
    cd "$tree_root" || return 1
    local mode digest
    mode="$(path_mode .)" || return 1
    printf '.\tdirectory\t%s\t-\n' "$mode" || return 1
    while IFS= read -r relative; do
      if [[ -d "$relative" ]]; then
        mode="$(path_mode "$relative")" || return 1
        printf '%s\tdirectory\t%s\t-\n' "$relative" "$mode" || return 1
      elif [[ -f "$relative" ]]; then
        mode="$(path_mode "$relative")" || return 1
        digest="$(path_sha256 "$relative")" || return 1
        printf '%s\tfile\t%s\t%s\n' "$relative" "$mode" "$digest" || return 1
      else
        printf 'Unsupported tree object: %s\n' "$relative" >&2
        return 1
      fi
    done < <(LC_ALL=C find . -mindepth 1 -print | LC_ALL=C sort)
  ) > "$output"; then
    rm -f -- "$output"
    return 1
  fi
  chmod 600 "$output" || return 1
}

trees_equal() {
  local left="$1" right="$2" left_manifest="$WORK_ROOT/left.$$.manifest" right_manifest="$WORK_ROOT/right.$$.manifest"
  [[ -d "$left" && ! -L "$left" && -d "$right" && ! -L "$right" ]] || return 1
  write_tree_manifest "$left" "$left_manifest" || return 1
  write_tree_manifest "$right" "$right_manifest" || return 1
  cmp -s "$left_manifest" "$right_manifest"
}

copy_tree_exact() {
  local source="$1" destination="$2"
  mkdir -m 700 "$destination" || return 1
  cp -R "$source/." "$destination/" || return 1
  while IFS= read -r directory; do chmod 700 "$directory" || return 1; done < <(find "$destination" -type d -print)
  while IFS= read -r file; do chmod 600 "$file" || return 1; done < <(find "$destination" -type f -print)
}

copy_tree_preserve() {
  local source="$1" destination="$2"
  local source_mode
  mkdir -m 700 "$destination" || return 1
  if [[ "$TEST_FAILPOINT" == "backup-plugin-copy-failed" && "$destination" == */plugin ]]; then
    printf 'Injected failure while copying the plugin rollback point.\n' >&2
    return 99
  fi
  cp -pR "$source/." "$destination/" || return 1
  source_mode="$(path_mode "$source")" || return 1
  chmod "$source_mode" "$destination" || return 1
}

build_source_payload() {
  local plugin_destination="$1" skill_destination="$2"
  mkdir -m 700 "$plugin_destination"
  install -m 600 "$PLUGIN_SOURCE/index.js" "$plugin_destination/index.js"
  install -m 600 "$PLUGIN_SOURCE/openclaw.plugin.json" "$plugin_destination/openclaw.plugin.json"
  install -m 600 "$PLUGIN_SOURCE/package.json" "$plugin_destination/package.json"
  copy_tree_exact "$PLUGIN_SOURCE/lib" "$plugin_destination/lib"
  mkdir -m 700 -p "$plugin_destination/runtime/scripts/lib" "$plugin_destination/runtime/ops/feishu-director-brain"
  install -m 600 "$SERVICE_CLI_SOURCE" "$plugin_destination/runtime/scripts/feishu-director-brain.mjs"
  install -m 600 "$SERVICE_SOURCE" "$plugin_destination/runtime/scripts/lib/feishu-director-brain.mjs"
  install -m 600 "$SCHEMA_SOURCE" "$plugin_destination/runtime/ops/feishu-director-brain/schema.json"
  copy_tree_exact "$SKILL_SOURCE" "$skill_destination"
}

render_config() {
  local input="$1" output="$2"
  node - "$input" "$output" "$PLUGIN_ID" "$TOOL_ID" "$AGENT_ID" <<'NODE'
const fs = require('node:fs')
const [input, output, pluginId, toolId, agentId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(input, 'utf8'))
if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('profile_config_invalid')
if (config.plugins?.enabled === false) throw new Error('profile_plugins_disabled')
const agents = Array.isArray(config.agents?.list) ? config.agents.list : []
const targets = agents.filter(agent => agent?.id === agentId)
if (targets.length !== 1) throw new Error('target_agent_must_exist_exactly_once')
for (const agent of agents) {
  if (agent?.id === agentId) continue
  for (const key of ['allow', 'alsoAllow']) {
    if (Array.isArray(agent?.tools?.[key]) && agent.tools[key].includes(toolId)) {
      throw new Error('director_brain_tool_granted_to_other_agent')
    }
  }
}
for (const key of ['allow', 'alsoAllow']) {
  if (Array.isArray(config.tools?.[key]) && config.tools[key].includes(toolId)) {
    throw new Error('director_brain_tool_must_not_be_global')
  }
}
config.plugins ??= {}
config.plugins.entries ??= {}
if (config.plugins.allow !== undefined && !Array.isArray(config.plugins.allow)) {
  throw new Error('plugin_allowlist_invalid')
}
const explicitlyEnabled = Object.entries(config.plugins.entries)
  .filter(([, entry]) => entry?.enabled === true)
  .map(([id]) => id)
if (config.plugins.allow === undefined) {
  config.plugins.allow = [...new Set([...explicitlyEnabled, pluginId])]
} else if (!config.plugins.allow.includes(pluginId)) {
  config.plugins.allow = [...config.plugins.allow, pluginId]
}
config.plugins.entries[pluginId] = {
  enabled: true,
  config: {
    releaseReady: true,
    targetAgentId: agentId,
  },
}
const target = targets[0]
target.tools ??= {}
for (const key of ['allow', 'alsoAllow']) {
  if (Array.isArray(target.tools[key])) {
    target.tools[key] = target.tools[key].filter(value => value !== toolId)
  }
}
const grantKey = Array.isArray(target.tools.allow) ? 'allow' : 'alsoAllow'
target.tools[grantKey] ??= []
target.tools[grantKey].push(toolId)
fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
NODE
}

validate_config() {
  local pathname="$1"
  node - "$pathname" "$PLUGIN_ID" "$TOOL_ID" "$AGENT_ID" <<'NODE'
const fs = require('node:fs')
const [pathname, pluginId, toolId, agentId] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(pathname, 'utf8'))
const entry = config?.plugins?.entries?.[pluginId]
if (entry?.enabled !== true || entry?.config?.releaseReady !== true || entry?.config?.targetAgentId !== agentId) {
  throw new Error('director_brain_plugin_config_invalid')
}
if (!Array.isArray(config?.plugins?.allow) || !config.plugins.allow.includes(pluginId)) {
  throw new Error('director_brain_plugin_allowlist_missing')
}
const agents = Array.isArray(config?.agents?.list) ? config.agents.list : []
const target = agents.filter(agent => agent?.id === agentId)
if (target.length !== 1) throw new Error('target_agent_must_exist_exactly_once')
const grants = ['allow', 'alsoAllow'].flatMap(key =>
  Array.isArray(target[0]?.tools?.[key]) ? target[0].tools[key].filter(value => value === toolId) : [])
if (grants.length !== 1) throw new Error('director_brain_tool_grant_invalid')
for (const agent of agents) {
  if (agent?.id === agentId) continue
  if (['allow', 'alsoAllow'].some(key => Array.isArray(agent?.tools?.[key]) && agent.tools[key].includes(toolId))) {
    throw new Error('director_brain_tool_granted_to_other_agent')
  }
}
NODE
}

write_backup_tree_manifest() {
  local backup="$1" output="$2"
  if ! (
    cd "$backup"
    printf '.\tdirectory\t%s\t-\n' "$(path_mode .)"
    while IFS= read -r relative; do
      [[ "$relative" == "./MANIFEST.sha256" ]] && continue
      if [[ -d "$relative" ]]; then
        printf '%s\tdirectory\t%s\t-\n' "$relative" "$(path_mode "$relative")"
      elif [[ -f "$relative" ]]; then
        printf '%s\tfile\t%s\t%s\n' "$relative" "$(path_mode "$relative")" "$(path_sha256 "$relative")"
      else
        printf 'Unsupported backup object: %s\n' "$relative" >&2
        return 1
      fi
    done < <(LC_ALL=C find . -mindepth 1 -print | LC_ALL=C sort)
  ) > "$output"; then
    rm -f -- "$output"
    return 1
  fi
  chmod 600 "$output"
}

write_backup_manifest() {
  local backup="$1" temporary="$WORK_ROOT/backup.$$.manifest"
  write_backup_tree_manifest "$backup" "$temporary" || return 1
  install -m 600 "$temporary" "$backup/MANIFEST.sha256" || return 1
}

verify_backup() {
  local backup="$1" expected_parent="${2:-$BACKUP_ROOT}"
  regular_directory "$backup" || return 1
  [[ "$(dirname "$backup")" == "$expected_parent" ]] || return 1
  [[ "$(basename "$backup")" =~ ^[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$ ]] || return 1
  regular_file "$backup/STATE" && regular_file "$backup/MANIFEST.sha256" || return 1
  tree_has_symlink "$backup" && return 1
  validate_tree_path_names "$backup" || return 1
  node - "$backup/STATE" "$PROFILE" "$STATE_DIR" "$WORKSPACE" "$AGENT_ID" <<'NODE' || return 1
const fs = require('node:fs')
const [pathname, profile, stateDir, workspace, agentId] = process.argv.slice(2)
const lines = fs.readFileSync(pathname, 'utf8').trimEnd().split('\n')
const values = Object.fromEntries(lines.map(line => {
  const index = line.indexOf('=')
  if (index < 1) throw new Error('backup_state_invalid')
  return [line.slice(0, index), line.slice(index + 1)]
}))
if (lines.length !== 8 || values.version !== '1' || values.profile !== profile
  || values.state_dir !== stateDir || values.workspace !== workspace || values.agent !== agentId
  || !['0', '1'].includes(values.plugin_present) || !['0', '1'].includes(values.skill_present)) {
  throw new Error('backup_state_mismatch')
}
NODE
  local actual_manifest="$WORK_ROOT/verified-backup.$$.manifest"
  write_backup_tree_manifest "$backup" "$actual_manifest" || return 1
  cmp -s "$backup/MANIFEST.sha256" "$actual_manifest" || return 1
  local plugin_present skill_present
  plugin_present="$(sed -n 's/^plugin_present=//p' "$backup/STATE")"
  skill_present="$(sed -n 's/^skill_present=//p' "$backup/STATE")"
  regular_file "$backup/openclaw.json" || return 1
  if [[ "$plugin_present" == 1 ]]; then regular_directory "$backup/plugin" || return 1; else [[ ! -e "$backup/plugin" ]] || return 1; fi
  if [[ "$skill_present" == 1 ]]; then regular_directory "$backup/skill" || return 1; else [[ ! -e "$backup/skill" ]] || return 1; fi
}

capture_rollback_source_identities() {
  local backup="$1"
  verify_backup "$backup" || return 1
  ROLLBACK_SOURCE_ROOT_IDENTITY="$(path_identity "$backup")" || return 1
  ROLLBACK_SOURCE_STATE_IDENTITY="$(path_identity "$backup/STATE")" || return 1
  ROLLBACK_SOURCE_MANIFEST_IDENTITY="$(path_identity "$backup/MANIFEST.sha256")" || return 1
  ROLLBACK_SOURCE_CONFIG_IDENTITY="$(path_identity "$backup/openclaw.json")" || return 1
  ROLLBACK_SOURCE_PLUGIN_IDENTITY=""
  ROLLBACK_SOURCE_SKILL_IDENTITY=""
  if grep -q '^plugin_present=1$' "$backup/STATE"; then
    ROLLBACK_SOURCE_PLUGIN_IDENTITY="$(path_identity "$backup/plugin")" || return 1
  fi
  if grep -q '^skill_present=1$' "$backup/STATE"; then
    ROLLBACK_SOURCE_SKILL_IDENTITY="$(path_identity "$backup/skill")" || return 1
  fi
}

rollback_source_identities_match() {
  local backup="$1"
  regular_directory "$backup" \
    && regular_file "$backup/STATE" \
    && regular_file "$backup/MANIFEST.sha256" \
    && regular_file "$backup/openclaw.json" \
    && [[ "$(path_identity "$backup" 2>/dev/null || true)" == "$ROLLBACK_SOURCE_ROOT_IDENTITY" ]] \
    && [[ "$(path_identity "$backup/STATE" 2>/dev/null || true)" == "$ROLLBACK_SOURCE_STATE_IDENTITY" ]] \
    && [[ "$(path_identity "$backup/MANIFEST.sha256" 2>/dev/null || true)" == "$ROLLBACK_SOURCE_MANIFEST_IDENTITY" ]] \
    && [[ "$(path_identity "$backup/openclaw.json" 2>/dev/null || true)" == "$ROLLBACK_SOURCE_CONFIG_IDENTITY" ]] \
    || return 1
  if [[ -n "$ROLLBACK_SOURCE_PLUGIN_IDENTITY" ]]; then
    regular_directory "$backup/plugin" \
      && [[ "$(path_identity "$backup/plugin" 2>/dev/null || true)" == "$ROLLBACK_SOURCE_PLUGIN_IDENTITY" ]] \
      || return 1
  else
    [[ ! -e "$backup/plugin" && ! -L "$backup/plugin" ]] || return 1
  fi
  if [[ -n "$ROLLBACK_SOURCE_SKILL_IDENTITY" ]]; then
    regular_directory "$backup/skill" \
      && [[ "$(path_identity "$backup/skill" 2>/dev/null || true)" == "$ROLLBACK_SOURCE_SKILL_IDENTITY" ]] \
      || return 1
  else
    [[ ! -e "$backup/skill" && ! -L "$backup/skill" ]] || return 1
  fi
}

claim_rollback_source() {
  local original="$1" claim_root claim_name
  claim_root="$(mktemp -d "$BACKUP_ROOT/.rollback-source-claim.XXXXXX")" || return 1
  chmod 700 "$claim_root" || { rmdir "$claim_root" 2>/dev/null || true; return 1; }
  claim_name="$(basename "$original")"
  ROLLBACK_SOURCE_ORIGINAL="$original"
  ROLLBACK_SOURCE_CLAIM_ROOT="$claim_root"
  ROLLBACK_SOURCE_CLAIM="$claim_root/$claim_name"
  if ! mv "$original" "$ROLLBACK_SOURCE_CLAIM"; then
    ROLLBACK_SOURCE_CLAIM=""
    ROLLBACK_SOURCE_ORIGINAL=""
    rmdir "$ROLLBACK_SOURCE_CLAIM_ROOT" 2>/dev/null || true
    ROLLBACK_SOURCE_CLAIM_ROOT=""
    return 1
  fi
  ROLLBACK_BACKUP="$ROLLBACK_SOURCE_CLAIM"
  rollback_source_identities_match "$ROLLBACK_SOURCE_CLAIM" || return 1
  verify_backup "$ROLLBACK_SOURCE_CLAIM" "$ROLLBACK_SOURCE_CLAIM_ROOT" || return 1
}

release_rollback_source_claim() {
  [[ -n "$ROLLBACK_SOURCE_CLAIM" ]] || return 0
  if [[ -e "$ROLLBACK_SOURCE_ORIGINAL" || -L "$ROLLBACK_SOURCE_ORIGINAL" ]]; then
    printf 'Rollback backup path was recreated while its verified source was claimed; preserving the claim: %s\n' \
      "$ROLLBACK_SOURCE_CLAIM" >&2
    return 1
  fi
  mv "$ROLLBACK_SOURCE_CLAIM" "$ROLLBACK_SOURCE_ORIGINAL" || return 1
  ROLLBACK_BACKUP="$ROLLBACK_SOURCE_ORIGINAL"
  ROLLBACK_SOURCE_CLAIM=""
  rmdir "$ROLLBACK_SOURCE_CLAIM_ROOT" || return 1
  ROLLBACK_SOURCE_CLAIM_ROOT=""
  return 0
}

discard_safety_backup() {
  if [[ -n "$SAFETY_BACKUP" && "$(dirname "$SAFETY_BACKUP")" == "$BACKUP_ROOT" ]]; then
    rm -rf -- "$SAFETY_BACKUP"
    rmdir "$BACKUP_ROOT" 2>/dev/null || true
  fi
  SAFETY_BACKUP=""
}

create_backup() {
  if [[ "$TEST_FAILPOINT" == "backup-root-ancestor-swap" ]]; then
    wait_for_test_barrier backup-root-ready backup-root-continue 'backup root ancestor replacement'
  fi
  secure_prepare_backup_root || return 1
  local backup physical_backup
  backup="$(mktemp -d "$BACKUP_ROOT/$(date '+%Y%m%d-%H%M%S').XXXXXX")" || return 1
  secure_prepare_backup_root || return 1
  regular_directory "$backup" || return 1
  physical_backup="$(cd "$backup" && pwd -P)" || return 1
  case "$physical_backup/" in
    "$BACKUP_ROOT/"*) ;;
    *) printf 'Backup directory changed physical location before profile copy.\n' >&2; return 1 ;;
  esac
  chmod 700 "$backup" || { rm -rf -- "$backup"; return 1; }
  if ! {
    printf 'version=1\nprofile=%s\nstate_dir=%s\nworkspace=%s\nagent=%s\n' "$PROFILE" "$STATE_DIR" "$WORKSPACE" "$AGENT_ID"
    if [[ -d "$INSTALLED_PLUGIN" ]]; then printf 'plugin_present=1\n'; else printf 'plugin_present=0\n'; fi
    if [[ -d "$INSTALLED_SKILL" ]]; then printf 'skill_present=1\n'; else printf 'skill_present=0\n'; fi
    printf 'config_present=1\n'
  } > "$backup/STATE"; then
    rm -rf -- "$backup"
    return 1
  fi
  chmod 600 "$backup/STATE" || { rm -rf -- "$backup"; return 1; }
  install -m 600 "$PROFILE_CONFIG" "$backup/openclaw.json" \
    || { rm -rf -- "$backup"; return 1; }
  local status
  if [[ -d "$INSTALLED_PLUGIN" ]]; then
    copy_tree_preserve "$INSTALLED_PLUGIN" "$backup/plugin" || {
      status=$?
      rm -rf -- "$backup"
      return "$status"
    }
  fi
  if [[ -d "$INSTALLED_SKILL" ]]; then
    copy_tree_preserve "$INSTALLED_SKILL" "$backup/skill" || {
      status=$?
      rm -rf -- "$backup"
      return "$status"
    }
  fi
  if ! cmp -s "$PROFILE_CONFIG" "$backup/openclaw.json" \
    || { [[ -d "$INSTALLED_PLUGIN" ]] && ! trees_equal "$INSTALLED_PLUGIN" "$backup/plugin"; } \
    || { [[ -d "$INSTALLED_SKILL" ]] && ! trees_equal "$INSTALLED_SKILL" "$backup/skill"; } \
    || ! write_backup_manifest "$backup" \
    || ! verify_backup "$backup"; then
    rm -rf -- "$backup"
    return 1
  fi
  printf '%s' "$backup"
}

restore_verified_config_after_drift() {
  local restore_temp="$STATE_DIR/.openclaw.json.restore.$$"
  if [[ -e "$PROFILE_CONFIG" || -L "$PROFILE_CONFIG" ]]; then
    return 1
  fi
  rm -f -- "$restore_temp"
  install -m 600 "$SAFETY_BACKUP/openclaw.json" "$restore_temp" || return 1
  if ! ln "$restore_temp" "$PROFILE_CONFIG"; then
    rm -f -- "$restore_temp"
    return 1
  fi
  rm -f -- "$restore_temp" || return 1
  CONFIG_OLD_MOVED=0
}

retain_previous_config_inode() {
  CONFIG_RETIRED_ROOT="$(mktemp -d "$STATE_DIR/.openclaw.json.retired.XXXXXX")" || return 1
  chmod 700 "$CONFIG_RETIRED_ROOT" || {
    rmdir "$CONFIG_RETIRED_ROOT" 2>/dev/null || true
    CONFIG_RETIRED_ROOT=""
    return 1
  }
  CONFIG_RETIRED_ARTIFACT="$CONFIG_RETIRED_ROOT/openclaw.json"
  if node - "$CONFIG_PREVIOUS" "$CONFIG_RETIRED_ARTIFACT" \
    "$CONFIG_PREVIOUS_IDENTITY" "$TEST_FAILPOINT" <<'NODE'
const { constants } = require('node:fs')
const { lstat, open, rename } = require('node:fs/promises')

const [source, destination, expectedIdentity, failpoint] = process.argv.slice(2)
const uid = process.getuid === undefined ? null : BigInt(process.getuid())
const identity = value => `${value.dev}:${value.ino}`
const requireBoundFile = (pathStat, fdStat) => {
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error('retained_config_type_invalid')
  if (uid !== null && (pathStat.uid !== uid || fdStat.uid !== uid)) {
    throw new Error('retained_config_owner_invalid')
  }
  if (identity(pathStat) !== expectedIdentity || identity(fdStat) !== expectedIdentity) {
    throw new Error('retained_config_identity_invalid')
  }
}
;(async () => {
  let handle
  try {
    const sourceBefore = await lstat(source, { bigint: true })
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    const fdBefore = await handle.stat({ bigint: true })
    requireBoundFile(sourceBefore, fdBefore)

    await rename(source, destination)
    const [destinationAfter, fdAfter] = await Promise.all([
      lstat(destination, { bigint: true }),
      handle.stat({ bigint: true }),
    ])
    requireBoundFile(destinationAfter, fdAfter)
    await handle.chmod(0o600)
    if (failpoint === 'config-retain-postmove-mode-drift') {
      await handle.chmod(0o640)
    }
    const [destinationFinal, fdFinal] = await Promise.all([
      lstat(destination, { bigint: true }),
      handle.stat({ bigint: true }),
    ])
    requireBoundFile(destinationFinal, fdFinal)
    if ((Number(destinationFinal.mode) & 0o777) !== 0o600
      || (Number(fdFinal.mode) & 0o777) !== 0o600) {
      throw new Error('retained_config_mode_invalid')
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
})().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'retained_config_validation_failed'}\n`)
  process.exitCode = 1
})
NODE
  then
    CONFIG_PREVIOUS="$CONFIG_RETIRED_ARTIFACT"
    return 0
  fi

  CONFIG_PREVIOUS_VERIFIED=0
  if [[ ! -e "$CONFIG_PREVIOUS" && ! -L "$CONFIG_PREVIOUS" \
    && -f "$CONFIG_RETIRED_ARTIFACT" && ! -L "$CONFIG_RETIRED_ARTIFACT" \
    && "$(path_identity "$CONFIG_RETIRED_ARTIFACT" 2>/dev/null || true)" == "$CONFIG_PREVIOUS_IDENTITY" ]]; then
    CONFIG_PREVIOUS="$CONFIG_RETIRED_ARTIFACT"
  else
    CONFIG_PREVIOUS_VERIFIED=0
  fi
  return 1
}

TREE_QUARANTINE_ROOT=""
TREE_QUARANTINE_ARTIFACT=""

quarantine_activated_tree() {
  local target="$1" parent="$2" prefix="$3" desired="$4" expected_identity="$5"
  local move_status=0
  TREE_QUARANTINE_ROOT=""
  TREE_QUARANTINE_ARTIFACT=""

  if [[ ! -e "$target" && ! -L "$target" ]]; then
    return 0
  fi
  TREE_QUARANTINE_ROOT="$(mktemp -d "$parent/$prefix.drift.XXXXXX")" || return 1
  chmod 700 "$TREE_QUARANTINE_ROOT" || {
    rmdir "$TREE_QUARANTINE_ROOT" 2>/dev/null || true
    TREE_QUARANTINE_ROOT=""
    return 1
  }
  TREE_QUARANTINE_ARTIFACT="$TREE_QUARANTINE_ROOT/payload"
  mv "$target" "$TREE_QUARANTINE_ARTIFACT" || move_status=$?
  if { [[ "$move_status" == 0 ]] \
      || { [[ ! -e "$target" && ! -L "$target" ]] \
        && [[ -e "$TREE_QUARANTINE_ARTIFACT" || -L "$TREE_QUARANTINE_ARTIFACT" ]]; }; } \
    && [[ ! -e "$target" && ! -L "$target" ]]; then
    if regular_directory "$TREE_QUARANTINE_ARTIFACT" \
      && [[ "$(path_identity "$TREE_QUARANTINE_ARTIFACT" 2>/dev/null || true)" == "$expected_identity" ]] \
      && trees_equal "$desired" "$TREE_QUARANTINE_ARTIFACT"; then
      rm -rf -- "$TREE_QUARANTINE_ROOT" || return 1
      TREE_QUARANTINE_ROOT=""
      TREE_QUARANTINE_ARTIFACT=""
    fi
    return 0
  fi
  [[ "$move_status" != 0 ]] || move_status=1
  return "$move_status"
}

restore_original_tree_from_backup() {
  local state_key="$1" backup_member="$2" target="$3"
  verify_backup "$SAFETY_BACKUP" || return 1
  if grep -q "^${state_key}=1$" "$SAFETY_BACKUP/STATE"; then
    [[ ! -e "$target" && ! -L "$target" ]] || return 1
    copy_tree_preserve "$SAFETY_BACKUP/$backup_member" "$target" || return 1
    verify_backup "$SAFETY_BACKUP" || return 1
    trees_equal "$SAFETY_BACKUP/$backup_member" "$target" || return 1
  else
    [[ ! -e "$target" && ! -L "$target" ]] || return 1
  fi
}

discard_verified_previous_tree() {
  local previous="$1" parent="$2" prefix="$3" verified_backup="$4" expected_identity="$5"
  local discard_root discard_artifact move_status=0
  [[ -n "$previous" && -n "$expected_identity" ]] || return 0
  discard_root="$(mktemp -d "$parent/$prefix.rollback-discard.XXXXXX")" || return 0
  chmod 700 "$discard_root" || {
    rmdir "$discard_root" 2>/dev/null || true
    return 0
  }
  discard_artifact="$discard_root/payload"
  mv "$previous" "$discard_artifact" || move_status=$?
  if { [[ "$move_status" == 0 ]] \
      || { [[ ! -e "$previous" && ! -L "$previous" ]] \
        && regular_directory "$discard_artifact"; }; } \
    && [[ ! -e "$previous" && ! -L "$previous" ]] \
    && regular_directory "$discard_artifact" \
    && [[ "$(path_identity "$discard_artifact" 2>/dev/null || true)" == "$expected_identity" ]] \
    && trees_equal "$verified_backup" "$discard_artifact"; then
    rm -rf -- "$discard_root" || true
  fi
  rmdir "$discard_root" 2>/dev/null || true
}

restore_failed_commit() {
  local status=0 skill_restore_required=0 plugin_restore_required=0
  if [[ "$SKILL_NEW_ACTIVATED" == 1 || "$SKILL_OLD_MOVED" == 1 ]]; then
    skill_restore_required=1
  fi
  if [[ "$PLUGIN_NEW_ACTIVATED" == 1 || "$PLUGIN_OLD_MOVED" == 1 ]]; then
    plugin_restore_required=1
  fi
  if [[ "$CONFIG_NEW_ACTIVATED" == 1 ]]; then
    if [[ ! -e "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]]; then
      CONFIG_NEW_ACTIVATED=0
    else
      CONFIG_DRIFT_ROOT="$(mktemp -d "$STATE_DIR/.openclaw.json.drift.XXXXXX")" || status=1
      CONFIG_DRIFT_ARTIFACT="$CONFIG_DRIFT_ROOT/openclaw.json"
      if [[ "$status" != 0 ]]; then
        status=1
      else
        local quarantine_status=0
        mv "$PROFILE_CONFIG" "$CONFIG_DRIFT_ARTIFACT" || quarantine_status=$?
        if [[ "$quarantine_status" == 0 ]] \
          || { [[ ! -e "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" ]] \
            && [[ -e "$CONFIG_DRIFT_ARTIFACT" || -L "$CONFIG_DRIFT_ARTIFACT" ]]; }; then
          CONFIG_NEW_ACTIVATED=0
          if regular_file "$CONFIG_DRIFT_ARTIFACT" \
            && [[ -n "$CONFIG_NEW_IDENTITY" ]] \
            && [[ "$(path_identity "$CONFIG_DRIFT_ARTIFACT" 2>/dev/null || true)" == "$CONFIG_NEW_IDENTITY" ]] \
            && cmp -s "$DESIRED_CONFIG" "$CONFIG_DRIFT_ARTIFACT"; then
            if rm -rf -- "$CONFIG_DRIFT_ROOT"; then
              CONFIG_DRIFT_ROOT=""
              CONFIG_DRIFT_ARTIFACT=""
            else
              status=1
            fi
          fi
        else
          status=1
        fi
      fi
    fi
  fi
  if [[ "$CONFIG_OLD_MOVED" == 1 && "$CONFIG_NEW_ACTIVATED" == 0 ]]; then
    if [[ -e "$PROFILE_CONFIG" || -L "$PROFILE_CONFIG" ]]; then
      status=1
    elif [[ "$CONFIG_PREVIOUS_VERIFIED" == 1 ]]; then
      local restore_status=0
      ln "$CONFIG_PREVIOUS" "$PROFILE_CONFIG" || restore_status=$?
      if [[ "$restore_status" == 0 ]]; then
        if rm -f -- "$CONFIG_PREVIOUS"; then
          CONFIG_OLD_MOVED=0
        else
          status=1
        fi
      else
        status=1
      fi
    elif verify_backup "$SAFETY_BACKUP" \
      && restore_verified_config_after_drift; then
      :
    else
      status=1
    fi
  fi
  if [[ "$skill_restore_required" == 1 ]]; then
    if quarantine_activated_tree \
      "$INSTALLED_SKILL" "$WORKSPACE/skills" ".aiworker-director-brain" \
      "$DESIRED_SKILL" "$SKILL_NEW_IDENTITY"; then
      SKILL_DRIFT_ROOT="$TREE_QUARANTINE_ROOT"
      SKILL_DRIFT_ARTIFACT="$TREE_QUARANTINE_ARTIFACT"
      SKILL_NEW_ACTIVATED=0
    else
      SKILL_DRIFT_ROOT="$TREE_QUARANTINE_ROOT"
      SKILL_DRIFT_ARTIFACT="$TREE_QUARANTINE_ARTIFACT"
      status=1
    fi
  fi
  if [[ "$skill_restore_required" == 1 && "$SKILL_NEW_ACTIVATED" == 0 ]]; then
    if restore_original_tree_from_backup skill_present skill "$INSTALLED_SKILL"; then
      SKILL_OLD_MOVED=0
      if [[ "$SKILL_PREVIOUS_VERIFIED" == 1 ]]; then
        discard_verified_previous_tree \
          "$SKILL_PREVIOUS" "$WORKSPACE/skills" ".aiworker-director-brain" \
          "$SAFETY_BACKUP/skill" "$SKILL_PREVIOUS_IDENTITY"
      fi
    else
      status=1
    fi
  fi
  if [[ "$plugin_restore_required" == 1 ]]; then
    if quarantine_activated_tree \
      "$INSTALLED_PLUGIN" "$STATE_DIR/extensions" ".aiworker-director-brain" \
      "$DESIRED_PLUGIN" "$PLUGIN_NEW_IDENTITY"; then
      PLUGIN_DRIFT_ROOT="$TREE_QUARANTINE_ROOT"
      PLUGIN_DRIFT_ARTIFACT="$TREE_QUARANTINE_ARTIFACT"
      PLUGIN_NEW_ACTIVATED=0
    else
      PLUGIN_DRIFT_ROOT="$TREE_QUARANTINE_ROOT"
      PLUGIN_DRIFT_ARTIFACT="$TREE_QUARANTINE_ARTIFACT"
      status=1
    fi
  fi
  if [[ "$plugin_restore_required" == 1 && "$PLUGIN_NEW_ACTIVATED" == 0 ]]; then
    if restore_original_tree_from_backup plugin_present plugin "$INSTALLED_PLUGIN"; then
      PLUGIN_OLD_MOVED=0
      if [[ "$PLUGIN_PREVIOUS_VERIFIED" == 1 ]]; then
        discard_verified_previous_tree \
          "$PLUGIN_PREVIOUS" "$STATE_DIR/extensions" ".aiworker-director-brain" \
          "$SAFETY_BACKUP/plugin" "$PLUGIN_PREVIOUS_IDENTITY"
      fi
    else
      status=1
    fi
  fi
  [[ "$SKILLS_CREATED" != 1 ]] || rmdir "$WORKSPACE/skills" 2>/dev/null || true
  [[ "$EXTENSIONS_CREATED" != 1 ]] || rmdir "$STATE_DIR/extensions" 2>/dev/null || true
  [[ -z "$CONFIG_RETIRED_ROOT" ]] || rmdir "$CONFIG_RETIRED_ROOT" 2>/dev/null || true
  [[ -z "$PLUGIN_RETIRED_ROOT" ]] || rmdir "$PLUGIN_RETIRED_ROOT" 2>/dev/null || true
  [[ -z "$SKILL_RETIRED_ROOT" ]] || rmdir "$SKILL_RETIRED_ROOT" 2>/dev/null || true
  return "$status"
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$ROLLBACK_SOURCE_CLAIM" ]] && ! release_rollback_source_claim; then
    printf 'ROLLBACK SOURCE RELEASE FAILED: inspect the preserved private claim.\n' >&2
    status=70
  fi
  if [[ "$COMMIT_STARTED" == 1 && "$COMMIT_COMPLETE" != 1 ]]; then
    if ! restore_failed_commit; then
      printf 'ROLLBACK FAILED: inspect the explicit backup before retrying.\n' >&2
      status=70
    fi
  fi
  [[ -z "$PLUGIN_NEXT" || ! -e "$PLUGIN_NEXT" ]] || rm -rf -- "$PLUGIN_NEXT"
  [[ -z "$SKILL_NEXT" || ! -e "$SKILL_NEXT" ]] || rm -rf -- "$SKILL_NEXT"
  [[ -z "$CONFIG_NEXT" || ! -e "$CONFIG_NEXT" ]] || rm -f -- "$CONFIG_NEXT"
  [[ -z "$WORK_ROOT" || ! -d "$WORK_ROOT" ]] || rm -rf -- "$WORK_ROOT"
  if [[ "$LOCK_OWNED" == 1 && -n "$LOCK_DIR" ]]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
  if [[ "$DEPLOYMENT_LOCK_OWNED" == 1 ]]; then
    if ! release_shared_deployment_lock; then status=70; fi
  fi
  exit "$status"
}

WORK_ROOT="$(mktemp -d /tmp/aiworker-director-brain-installer.XXXXXX)"
chmod 700 "$WORK_ROOT"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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
    printf 'Shared director-brain replacement requires paused intake, zero active tasks, and zero pending director outbox rows.\n' >&2
    return 1
  }
}

defer_commit_signals() {
  trap 'DEFERRED_SIGNAL_STATUS=129' HUP
  trap 'DEFERRED_SIGNAL_STATUS=130' INT
  trap 'DEFERRED_SIGNAL_STATUS=143' TERM
}

exit_on_deferred_signal() {
  if [[ "$DEFERRED_SIGNAL_STATUS" != 0 ]]; then
    exit "$DEFERRED_SIGNAL_STATUS"
  fi
}

resume_immediate_signals() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  exit_on_deferred_signal
}

DESIRED_PLUGIN="$WORK_ROOT/plugin"
DESIRED_SKILL="$WORK_ROOT/skill"
DESIRED_CONFIG="$WORK_ROOT/openclaw.json"
DESIRED_PLUGIN_PRESENT=1
DESIRED_SKILL_PRESENT=1
PREFLIGHT_CONFIG_SHA256="$(path_sha256 "$PROFILE_CONFIG")"

if [[ "$MODE" == "rollback" ]]; then
  BACKUP_ROOT="$(dirname "$ROLLBACK_BACKUP")"
  regular_directory "$BACKUP_ROOT" || { printf 'Rollback backup root is invalid.\n' >&2; exit 1; }
  BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd -P)"
  ROLLBACK_BACKUP="$BACKUP_ROOT/$(basename "$ROLLBACK_BACKUP")"
  validate_effective_backup_root 'Rollback backup root' "$BACKUP_ROOT" || exit 1
  regular_directory "$ROLLBACK_BACKUP" || { printf 'Rollback backup is invalid.\n' >&2; exit 1; }
  ROLLBACK_BACKUP="$(cd "$ROLLBACK_BACKUP" && pwd -P)"
  validate_effective_rollback_backup "$ROLLBACK_BACKUP" || exit 1
  verify_backup "$ROLLBACK_BACKUP" || { printf 'Rollback backup failed integrity or identity validation.\n' >&2; exit 1; }
  validate_rollback_copy_endpoints "$ROLLBACK_BACKUP" || exit 1
  verify_backup "$ROLLBACK_BACKUP" || { printf 'Rollback backup changed before restoration.\n' >&2; exit 1; }
  validate_effective_backup_root 'Rollback backup root' "$BACKUP_ROOT" || exit 1
  validate_effective_rollback_backup "$ROLLBACK_BACKUP" || exit 1
  validate_rollback_copy_endpoints "$ROLLBACK_BACKUP" || exit 1
  capture_rollback_source_identities "$ROLLBACK_BACKUP" \
    || { printf 'Rollback backup source identities could not be bound.\n' >&2; exit 1; }
  if [[ "$TEST_FAILPOINT" == "rollback-source-before-copy" ]]; then
    wait_for_test_barrier rollback-source-ready rollback-source-continue 'rollback source replacement'
  fi
  claim_rollback_source "$ROLLBACK_BACKUP" \
    || { printf 'Rollback backup changed before its private source claim.\n' >&2; exit 1; }
  rollback_source_identities_match "$ROLLBACK_BACKUP" \
    && verify_backup "$ROLLBACK_BACKUP" "$ROLLBACK_SOURCE_CLAIM_ROOT" \
    || { printf 'Rollback backup changed after its private source claim.\n' >&2; exit 1; }
  cp "$ROLLBACK_BACKUP/openclaw.json" "$DESIRED_CONFIG"
  chmod 600 "$DESIRED_CONFIG"
  if grep -q '^plugin_present=1$' "$ROLLBACK_BACKUP/STATE"; then
    copy_tree_preserve "$ROLLBACK_BACKUP/plugin" "$DESIRED_PLUGIN"
  else
    DESIRED_PLUGIN_PRESENT=0
  fi
  if grep -q '^skill_present=1$' "$ROLLBACK_BACKUP/STATE"; then
    copy_tree_preserve "$ROLLBACK_BACKUP/skill" "$DESIRED_SKILL"
  else
    DESIRED_SKILL_PRESENT=0
  fi
  if ! rollback_source_identities_match "$ROLLBACK_BACKUP" \
    || ! verify_backup "$ROLLBACK_BACKUP" "$ROLLBACK_SOURCE_CLAIM_ROOT" \
    || ! cmp -s "$ROLLBACK_BACKUP/openclaw.json" "$DESIRED_CONFIG" \
    || { [[ "$DESIRED_PLUGIN_PRESENT" == 1 ]] \
      && ! trees_equal "$ROLLBACK_BACKUP/plugin" "$DESIRED_PLUGIN"; } \
    || { [[ "$DESIRED_SKILL_PRESENT" == 1 ]] \
      && ! trees_equal "$ROLLBACK_BACKUP/skill" "$DESIRED_SKILL"; }; then
    printf 'Rollback backup or copied desired state changed during the bound copy.\n' >&2
    exit 1
  fi
  release_rollback_source_claim \
    || { printf 'Rollback backup source claim could not be restored.\n' >&2; exit 1; }
else
  build_source_payload "$DESIRED_PLUGIN" "$DESIRED_SKILL"
  render_config "$PROFILE_CONFIG" "$DESIRED_CONFIG"
  validate_config "$DESIRED_CONFIG"
fi
validate_agent_workspace "$DESIRED_CONFIG"

compare_desired_state() {
  same_plugin=0
  same_skill=0
  same_config=0
  if [[ "$DESIRED_PLUGIN_PRESENT" == 1 ]]; then trees_equal "$DESIRED_PLUGIN" "$INSTALLED_PLUGIN" && same_plugin=1; else [[ ! -e "$INSTALLED_PLUGIN" ]] && same_plugin=1; fi
  if [[ "$DESIRED_SKILL_PRESENT" == 1 ]]; then trees_equal "$DESIRED_SKILL" "$INSTALLED_SKILL" && same_skill=1; else [[ ! -e "$INSTALLED_SKILL" ]] && same_skill=1; fi
  cmp -s "$DESIRED_CONFIG" "$PROFILE_CONFIG" && same_config=1
  return 0
}

compare_desired_state

if [[ "$MODE" == "dry-run" ]]; then
  printf 'Director-brain installation dry-run passed for explicit profile %s (agent %s).\n' "$PROFILE" "$AGENT_ID"
  printf 'Would change: plugin=%s skill=%s config=%s. No profile, plugin, skill, credential, gateway, queue, n8n, media, database, scheduler, or editing state changed.\n' \
    "$((1 - same_plugin))" "$((1 - same_skill))" "$((1 - same_config))"
  exit 0
fi

if [[ -n "$TEST_SYNC_DIR" ]]; then
  install -m 600 /dev/null "$TEST_SYNC_DIR/prelock-ready"
  test_sync_released=0
  for _ in {1..200}; do
    if [[ -f "$TEST_SYNC_DIR/prelock-continue" ]]; then
      test_sync_released=1
      break
    fi
    sleep 0.05
  done
  if [[ "$test_sync_released" != 1 ]]; then
    printf 'Timed out waiting for installer test synchronization.\n' >&2
    exit 1
  fi
fi

acquire_shared_deployment_lock
LOCK_DIR="$STATE_DIR/.aiworker-director-brain-install.lock"
if ! mkdir -m 700 "$LOCK_DIR" 2>/dev/null; then
  printf 'Another director-brain installation is already in progress.\n' >&2
  exit 1
fi
LOCK_OWNED=1

regular_file "$PROFILE_CONFIG" || {
  printf 'OpenClaw profile config changed type before the locked install.\n' >&2
  exit 1
}
LOCKED_CONFIG_IDENTITY="$(path_identity "$PROFILE_CONFIG")" || exit 1
LOCKED_CONFIG_SHA256="$(path_sha256 "$PROFILE_CONFIG")"
if ! regular_file "$PROFILE_CONFIG" \
  || [[ "$(path_identity "$PROFILE_CONFIG")" != "$LOCKED_CONFIG_IDENTITY" ]] \
  || [[ "$LOCKED_CONFIG_SHA256" != "$PREFLIGHT_CONFIG_SHA256" ]]; then
  printf 'OpenClaw profile config changed between preflight and the locked install; refusing to overwrite concurrent changes.\n' >&2
  exit 1
fi

if [[ "$MODE" != "rollback" ]]; then
  validate_agent_workspace "$PROFILE_CONFIG"
  render_config "$PROFILE_CONFIG" "$DESIRED_CONFIG"
  validate_config "$DESIRED_CONFIG"
  validate_agent_workspace "$DESIRED_CONFIG"
fi
compare_desired_state

if [[ "$same_plugin" == 1 && "$same_skill" == 1 && "$same_config" == 1 ]]; then
  printf 'Director-brain installation for profile %s is already current; no backup or write was created.\n' "$PROFILE"
  exit 0
fi

SAFETY_BACKUP="$(create_backup)"
if [[ "$(path_sha256 "$SAFETY_BACKUP/openclaw.json")" != "$LOCKED_CONFIG_SHA256" \
  || "$(path_sha256 "$PROFILE_CONFIG")" != "$LOCKED_CONFIG_SHA256" ]]; then
  discard_safety_backup
  printf 'OpenClaw profile config changed while creating the rollback point; refusing to continue.\n' >&2
  exit 1
fi
printf 'Verified rollback point: %s\n' "$SAFETY_BACKUP"
printf 'SECURITY: this verified backup contains the full profile and may contain credentials; keep state and backup roots outside Git and never commit, archive, or upload them.\n'

if [[ ! -d "$STATE_DIR/extensions" ]]; then mkdir -m 700 "$STATE_DIR/extensions"; EXTENSIONS_CREATED=1; fi
if [[ ! -d "$WORKSPACE/skills" ]]; then mkdir -m 700 "$WORKSPACE/skills"; SKILLS_CREATED=1; fi
regular_directory "$STATE_DIR/extensions" && regular_directory "$WORKSPACE/skills" || {
  printf 'Extensions and skills roots must be regular directories.\n' >&2
  exit 1
}

if [[ "$DESIRED_PLUGIN_PRESENT" == 1 ]]; then
  PLUGIN_NEXT="$(mktemp -d "$STATE_DIR/extensions/.aiworker-director-brain.next.XXXXXX")"
  rmdir "$PLUGIN_NEXT"
  if [[ "$MODE" == "rollback" ]]; then
    copy_tree_preserve "$DESIRED_PLUGIN" "$PLUGIN_NEXT"
  else
    copy_tree_exact "$DESIRED_PLUGIN" "$PLUGIN_NEXT"
  fi
fi
if [[ "$DESIRED_SKILL_PRESENT" == 1 ]]; then
  SKILL_NEXT="$(mktemp -d "$WORKSPACE/skills/.aiworker-director-brain.next.XXXXXX")"
  rmdir "$SKILL_NEXT"
  if [[ "$MODE" == "rollback" ]]; then
    copy_tree_preserve "$DESIRED_SKILL" "$SKILL_NEXT"
  else
    copy_tree_exact "$DESIRED_SKILL" "$SKILL_NEXT"
  fi
fi
CONFIG_NEXT="$(mktemp "$STATE_DIR/.openclaw.json.next.XXXXXX")"
install -m 600 "$DESIRED_CONFIG" "$CONFIG_NEXT"

if [[ "$(path_sha256 "$PROFILE_CONFIG")" != "$LOCKED_CONFIG_SHA256" ]]; then
  discard_safety_backup
  printf 'OpenClaw profile config changed before the transactional install; refusing to continue.\n' >&2
  exit 1
fi

verify_shared_install_gate
COMMIT_STARTED=1
defer_commit_signals
if [[ -d "$INSTALLED_PLUGIN" ]]; then
  PLUGIN_PREVIOUS="$STATE_DIR/extensions/.aiworker-director-brain.previous.$$"
  [[ ! -e "$PLUGIN_PREVIOUS" && ! -L "$PLUGIN_PREVIOUS" ]] || { printf 'Plugin rollback path already exists.\n' >&2; exit 1; }
  [[ "$TEST_FAILPOINT" != "plugin-old-move-failed" ]] || { printf 'Injected failure before the old plugin move.\n' >&2; exit 99; }
  plugin_old_identity="$(path_identity "$INSTALLED_PLUGIN")"
  move_status=0
  mv "$INSTALLED_PLUGIN" "$PLUGIN_PREVIOUS" || move_status=$?
  [[ "$TEST_FAILPOINT" != "signal-after-plugin-old-move" ]] || kill -TERM "$$"
  [[ "$TEST_FAILPOINT" != "plugin-old-move-reported-failed" ]] || move_status=99
  if [[ ! -e "$INSTALLED_PLUGIN" && ! -L "$INSTALLED_PLUGIN" ]] \
    && regular_directory "$PLUGIN_PREVIOUS" \
    && [[ "$(path_identity "$PLUGIN_PREVIOUS")" == "$plugin_old_identity" ]] \
    && trees_equal "$PLUGIN_PREVIOUS" "$SAFETY_BACKUP/plugin"; then
    PLUGIN_OLD_MOVED=1
    PLUGIN_PREVIOUS_IDENTITY="$plugin_old_identity"
    PLUGIN_PREVIOUS_VERIFIED=1
  else
    [[ "$move_status" != 0 ]] || move_status=1
  fi
  exit_on_deferred_signal
  [[ "$move_status" == 0 ]] || exit "$move_status"
fi
if [[ "$DESIRED_PLUGIN_PRESENT" == 1 ]]; then
  [[ "$TEST_FAILPOINT" != "plugin-new-move-failed" ]] || { printf 'Injected failure before the new plugin move.\n' >&2; exit 99; }
  plugin_next_identity="$(path_identity "$PLUGIN_NEXT")"
  move_status=0
  mv "$PLUGIN_NEXT" "$INSTALLED_PLUGIN" || move_status=$?
  [[ "$TEST_FAILPOINT" != "signal-after-plugin-new-move" ]] || kill -TERM "$$"
  [[ "$TEST_FAILPOINT" != "plugin-new-move-reported-failed" ]] || move_status=99
  if [[ ! -e "$PLUGIN_NEXT" && ! -L "$PLUGIN_NEXT" ]] \
    && regular_directory "$INSTALLED_PLUGIN" \
    && [[ "$(path_identity "$INSTALLED_PLUGIN")" == "$plugin_next_identity" ]] \
    && trees_equal "$DESIRED_PLUGIN" "$INSTALLED_PLUGIN"; then
    PLUGIN_NEW_ACTIVATED=1
    PLUGIN_NEW_IDENTITY="$plugin_next_identity"
    PLUGIN_NEXT=""
  else
    [[ "$move_status" != 0 ]] || move_status=1
  fi
  exit_on_deferred_signal
  [[ "$move_status" == 0 ]] || exit "$move_status"
fi
if [[ "$TEST_FAILPOINT" == "plugin-active-replacement" ]]; then
  wait_for_test_barrier plugin-active-ready plugin-active-continue 'active plugin replacement'
  printf 'Injected failure after the active plugin replacement barrier.\n' >&2
  exit 99
fi
[[ "$TEST_FAILPOINT" != "after-plugin" ]] || { printf 'Injected failure after plugin swap.\n' >&2; exit 99; }

if [[ -d "$INSTALLED_SKILL" ]]; then
  SKILL_PREVIOUS="$WORKSPACE/skills/.aiworker-director-brain.previous.$$"
  [[ ! -e "$SKILL_PREVIOUS" && ! -L "$SKILL_PREVIOUS" ]] || { printf 'Skill rollback path already exists.\n' >&2; exit 1; }
  [[ "$TEST_FAILPOINT" != "skill-old-move-failed" ]] || { printf 'Injected failure before the old Skill move.\n' >&2; exit 99; }
  skill_old_identity="$(path_identity "$INSTALLED_SKILL")"
  move_status=0
  mv "$INSTALLED_SKILL" "$SKILL_PREVIOUS" || move_status=$?
  [[ "$TEST_FAILPOINT" != "signal-after-skill-old-move" ]] || kill -TERM "$$"
  [[ "$TEST_FAILPOINT" != "skill-old-move-reported-failed" ]] || move_status=99
  if [[ ! -e "$INSTALLED_SKILL" && ! -L "$INSTALLED_SKILL" ]] \
    && regular_directory "$SKILL_PREVIOUS" \
    && [[ "$(path_identity "$SKILL_PREVIOUS")" == "$skill_old_identity" ]] \
    && trees_equal "$SKILL_PREVIOUS" "$SAFETY_BACKUP/skill"; then
    SKILL_OLD_MOVED=1
    SKILL_PREVIOUS_IDENTITY="$skill_old_identity"
    SKILL_PREVIOUS_VERIFIED=1
  else
    [[ "$move_status" != 0 ]] || move_status=1
  fi
  exit_on_deferred_signal
  [[ "$move_status" == 0 ]] || exit "$move_status"
fi
if [[ "$DESIRED_SKILL_PRESENT" == 1 ]]; then
  [[ "$TEST_FAILPOINT" != "skill-new-move-failed" ]] || { printf 'Injected failure before the new Skill move.\n' >&2; exit 99; }
  skill_next_identity="$(path_identity "$SKILL_NEXT")"
  move_status=0
  mv "$SKILL_NEXT" "$INSTALLED_SKILL" || move_status=$?
  [[ "$TEST_FAILPOINT" != "signal-after-skill-new-move" ]] || kill -TERM "$$"
  [[ "$TEST_FAILPOINT" != "skill-new-move-reported-failed" ]] || move_status=99
  if [[ ! -e "$SKILL_NEXT" && ! -L "$SKILL_NEXT" ]] \
    && regular_directory "$INSTALLED_SKILL" \
    && [[ "$(path_identity "$INSTALLED_SKILL")" == "$skill_next_identity" ]] \
    && trees_equal "$DESIRED_SKILL" "$INSTALLED_SKILL"; then
    SKILL_NEW_ACTIVATED=1
    SKILL_NEW_IDENTITY="$skill_next_identity"
    SKILL_NEXT=""
  else
    [[ "$move_status" != 0 ]] || move_status=1
  fi
  exit_on_deferred_signal
  [[ "$move_status" == 0 ]] || exit "$move_status"
fi
if [[ "$TEST_FAILPOINT" == "skill-active-replacement" ]]; then
  wait_for_test_barrier skill-active-ready skill-active-continue 'active Skill replacement'
  printf 'Injected failure after the active Skill replacement barrier.\n' >&2
  exit 99
fi
[[ "$TEST_FAILPOINT" != "after-skill" ]] || { printf 'Injected failure after skill swap.\n' >&2; exit 99; }

if [[ "$(path_sha256 "$PROFILE_CONFIG")" != "$LOCKED_CONFIG_SHA256" ]]; then
  printf 'OpenClaw profile config changed before config swap; refusing to overwrite concurrent changes.\n' >&2
  exit 1
fi

CONFIG_PREVIOUS="$STATE_DIR/.openclaw.json.previous.$$"
[[ ! -e "$CONFIG_PREVIOUS" && ! -L "$CONFIG_PREVIOUS" ]] || { printf 'Config rollback path already exists.\n' >&2; exit 1; }
[[ "$TEST_FAILPOINT" != "config-old-move-failed" ]] || { printf 'Injected failure before the old config move.\n' >&2; exit 99; }
move_status=0
mv "$PROFILE_CONFIG" "$CONFIG_PREVIOUS" || move_status=$?
[[ "$TEST_FAILPOINT" != "signal-after-config-old-move" ]] || kill -TERM "$$"
[[ "$TEST_FAILPOINT" != "config-old-move-reported-failed" ]] || move_status=99
if [[ "$move_status" == 0 ]] \
  || { [[ ! -e "$PROFILE_CONFIG" && -f "$CONFIG_PREVIOUS" && ! -L "$CONFIG_PREVIOUS" ]] \
    && [[ "$(path_sha256 "$CONFIG_PREVIOUS")" == "$LOCKED_CONFIG_SHA256" ]]; }; then
  CONFIG_OLD_MOVED=1
fi
if [[ "$TEST_FAILPOINT" == "config-previous-drift" && "$CONFIG_OLD_MOVED" == 1 ]]; then
  printf '\n' >> "$CONFIG_PREVIOUS"
fi
if [[ "$CONFIG_OLD_MOVED" == 1 \
  && -f "$CONFIG_PREVIOUS" && ! -L "$CONFIG_PREVIOUS" \
  && "$(path_identity "$CONFIG_PREVIOUS")" == "$LOCKED_CONFIG_IDENTITY" \
  && "$(path_sha256 "$CONFIG_PREVIOUS")" == "$LOCKED_CONFIG_SHA256" ]]; then
  CONFIG_PREVIOUS_VERIFIED=1
  CONFIG_PREVIOUS_IDENTITY="$LOCKED_CONFIG_IDENTITY"
else
  printf 'OpenClaw profile config changed after the old config move; restoring the verified rollback copy.\n' >&2
  restore_verified_config_after_drift || true
  exit 1
fi
exit_on_deferred_signal
[[ "$move_status" == 0 ]] || exit "$move_status"
if [[ -e "$PROFILE_CONFIG" || -L "$PROFILE_CONFIG" ]]; then
  printf 'OpenClaw profile config was recreated concurrently; preserving it and the verified previous config.\n' >&2
  exit 1
fi
if [[ "$TEST_FAILPOINT" == "config-concurrent-before-activation" ]]; then
  printf '{"concurrent_writer":true}\n' > "$PROFILE_CONFIG"
fi
[[ "$TEST_FAILPOINT" != "config-new-move-failed" ]] || { printf 'Injected failure before the new config move.\n' >&2; exit 99; }
move_status=0
config_next_identity="$(path_identity "$CONFIG_NEXT")" || exit 1
ln "$CONFIG_NEXT" "$PROFILE_CONFIG" || move_status=$?
[[ "$TEST_FAILPOINT" != "signal-after-config-new-move" ]] || kill -TERM "$$"
[[ "$TEST_FAILPOINT" != "config-new-move-reported-failed" ]] || move_status=99
if [[ -f "$CONFIG_NEXT" && -f "$PROFILE_CONFIG" && ! -L "$PROFILE_CONFIG" \
  && "$CONFIG_NEXT" -ef "$PROFILE_CONFIG" \
  && "$(path_identity "$PROFILE_CONFIG")" == "$config_next_identity" ]]; then
  CONFIG_NEW_ACTIVATED=1
  CONFIG_NEW_IDENTITY="$config_next_identity"
else
  [[ "$move_status" != 0 ]] || move_status=1
fi
exit_on_deferred_signal
[[ "$move_status" == 0 ]] || exit "$move_status"
rm -f -- "$CONFIG_NEXT"
CONFIG_NEXT=""
if [[ "$TEST_FAILPOINT" == "config-active-drift" ]]; then
  printf '{"concurrent_writer":true}\n' > "$PROFILE_CONFIG"
  printf 'Injected concurrent config rewrite after activation.\n' >&2
  exit 99
fi
if [[ "$TEST_FAILPOINT" == "config-active-replacement" ]]; then
  wait_for_test_barrier config-active-ready config-active-continue 'active config replacement'
  printf 'Injected failure after the active config replacement barrier.\n' >&2
  exit 99
fi
[[ "$TEST_FAILPOINT" != "after-config" ]] || { printf 'Injected failure after config swap.\n' >&2; exit 99; }

if [[ "$TEST_FAILPOINT" == "config-previous-open-fd" ]]; then
  install -m 600 /dev/null "$TEST_SYNC_DIR/config-previous-ready"
  test_sync_released=0
  for _ in {1..200}; do
    if [[ -f "$TEST_SYNC_DIR/config-previous-continue" ]]; then
      test_sync_released=1
      break
    fi
    sleep 0.05
  done
  if [[ "$test_sync_released" != 1 ]]; then
    printf 'Timed out waiting for previous config inode test synchronization.\n' >&2
    exit 1
  fi
fi

if [[ "$DESIRED_PLUGIN_PRESENT" == 1 ]]; then trees_equal "$DESIRED_PLUGIN" "$INSTALLED_PLUGIN"; else [[ ! -e "$INSTALLED_PLUGIN" ]]; fi
if [[ "$DESIRED_SKILL_PRESENT" == 1 ]]; then trees_equal "$DESIRED_SKILL" "$INSTALLED_SKILL"; else [[ ! -e "$INSTALLED_SKILL" ]]; fi
  cmp -s "$DESIRED_CONFIG" "$PROFILE_CONFIG"
  validate_agent_workspace "$PROFILE_CONFIG"
  if [[ "$MODE" != "rollback" ]]; then validate_config "$PROFILE_CONFIG"; fi
  if [[ "$TEST_FAILPOINT" == "config-final-check-barrier" ]]; then
    wait_for_test_barrier config-final-ready config-final-continue 'final active config replacement'
  fi
  if ! verify_activated_config_identity; then
    printf 'OpenClaw profile config identity changed during final validation; quarantining it and restoring the verified rollback copy.\n' >&2
    exit 1
  fi
  exit_on_deferred_signal
if [[ ! -f "$CONFIG_PREVIOUS" || -L "$CONFIG_PREVIOUS" ]]; then
  CONFIG_PREVIOUS_VERIFIED=0
  printf 'OpenClaw previous profile config changed type before finalization; restoring the verified rollback copy and preserving the unexpected object.\n' >&2
  exit 1
fi
if [[ "$(path_sha256 "$CONFIG_PREVIOUS")" != "$LOCKED_CONFIG_SHA256" ]]; then
  printf 'OpenClaw previous profile config changed through a retained file descriptor; restoring and preserving the concurrent update.\n' >&2
  exit 1
fi
if [[ "$TEST_FAILPOINT" == "config-previous-postcheck-open-fd" ]]; then
  install -m 600 /dev/null "$TEST_SYNC_DIR/config-previous-postcheck-ready"
  test_sync_released=0
  for _ in {1..200}; do
    if [[ -f "$TEST_SYNC_DIR/config-previous-postcheck-continue" ]]; then
      test_sync_released=1
      break
    fi
    sleep 0.05
  done
  if [[ "$test_sync_released" != 1 ]]; then
    printf 'Timed out waiting for post-check config inode test synchronization.\n' >&2
    exit 1
  fi
fi
if [[ "$TEST_FAILPOINT" == "config-retain-path-replace" ]]; then
  install -m 600 /dev/null "$TEST_SYNC_DIR/config-retain-ready"
  test_sync_released=0
  for _ in {1..200}; do
    if [[ -f "$TEST_SYNC_DIR/config-retain-continue" ]]; then
      test_sync_released=1
      break
    fi
    sleep 0.05
  done
  if [[ "$test_sync_released" != 1 ]]; then
    printf 'Timed out waiting for config retention path test synchronization.\n' >&2
    exit 1
  fi
fi
if ! retain_previous_config_inode; then
  printf 'Unable to retain the previous profile config inode for concurrent-writer recovery.\n' >&2
  exit 1
fi
exit_on_deferred_signal

if [[ -n "$PLUGIN_PREVIOUS" ]]; then
  tree_retain_status=0
  retain_previous_tree \
    "$PLUGIN_PREVIOUS" \
    "$STATE_DIR/extensions" \
    ".aiworker-director-brain" \
    "$SAFETY_BACKUP/plugin" \
    "plugin-retain-move-failed" \
    "plugin-retain-postcheck-failed" || tree_retain_status=$?
  PLUGIN_RETIRED_ROOT="$TREE_RETAINED_ROOT"
  PLUGIN_RETIRED_ARTIFACT="$TREE_RETAINED_ARTIFACT"
  if [[ "$TREE_RETAINED_SOURCE_MOVED" == 1 ]]; then
    PLUGIN_PREVIOUS="$PLUGIN_RETIRED_ARTIFACT"
    PLUGIN_PREVIOUS_VERIFIED="$TREE_RETAINED_VERIFIED"
  fi
  [[ "$tree_retain_status" == 0 ]] || {
    printf 'Unable to retain the previous plugin tree during finalization.\n' >&2
    exit "$tree_retain_status"
  }
fi
[[ "$TEST_FAILPOINT" != "signal-during-finalization" ]] || kill -TERM "$$"
exit_on_deferred_signal

if [[ -n "$SKILL_PREVIOUS" ]]; then
  tree_retain_status=0
  retain_previous_tree \
    "$SKILL_PREVIOUS" \
    "$WORKSPACE/skills" \
    ".aiworker-director-brain" \
    "$SAFETY_BACKUP/skill" \
    "" \
    "skill-retain-postcheck-failed" || tree_retain_status=$?
  SKILL_RETIRED_ROOT="$TREE_RETAINED_ROOT"
  SKILL_RETIRED_ARTIFACT="$TREE_RETAINED_ARTIFACT"
  if [[ "$TREE_RETAINED_SOURCE_MOVED" == 1 ]]; then
    SKILL_PREVIOUS="$SKILL_RETIRED_ARTIFACT"
    SKILL_PREVIOUS_VERIFIED="$TREE_RETAINED_VERIFIED"
  fi
  [[ "$tree_retain_status" == 0 ]] || {
    printf 'Unable to retain the previous Skill tree during finalization.\n' >&2
    exit "$tree_retain_status"
  }
  fi
  exit_on_deferred_signal

  if ! verify_activated_config_identity; then
    printf 'OpenClaw profile config identity changed before commit completion; quarantining it and restoring the verified rollback copy.\n' >&2
    exit 1
  fi

  COMMIT_COMPLETE=1
resume_immediate_signals
PLUGIN_PREVIOUS=""
SKILL_PREVIOUS=""
CONFIG_PREVIOUS=""

printf 'Retained previous config inode for concurrent-writer recovery: %s\n' "$CONFIG_RETIRED_ARTIFACT"
[[ -z "$PLUGIN_RETIRED_ARTIFACT" ]] \
  || printf 'Retained previous plugin tree for finalization recovery: %s\n' "$PLUGIN_RETIRED_ARTIFACT"
[[ -z "$SKILL_RETIRED_ARTIFACT" ]] \
  || printf 'Retained previous Skill tree for finalization recovery: %s\n' "$SKILL_RETIRED_ARTIFACT"
printf 'Cleanup policy: remove retired artifacts only after confirming every process that opened pre-install state has closed it and the new installation is healthy.\n'
printf 'SECURITY: the retired config artifact also contains the full prior profile and is governed by the same no-Git/no-archive/no-upload rule.\n'

if [[ "$MODE" == "rollback" ]]; then
  printf 'Rolled back director-brain installation for explicit profile %s. Gateway was not restarted.\n' "$PROFILE"
else
  printf 'Installed director-brain plugin, private shared runtime, and Skill for explicit profile %s (agent %s).\n' "$PROFILE" "$AGENT_ID"
  printf 'Gateway was not restarted. Activate only through a separately controlled restart and runtime catalog check.\n'
fi
printf 'No credential was added to the installed plugin payload; profile credentials remain present in the private rollback artifacts described above. No queue, n8n, media, database, scheduler, remote host, or editing capability was changed.\n'
