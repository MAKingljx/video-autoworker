#!/usr/bin/env bash
set -euo pipefail
umask 077

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_DIR="$REPOSITORY_ROOT/openclaw-skills/aiworker-task-flow"
RENDERER="$REPOSITORY_ROOT/scripts/lib/render-managed-markdown-section.mjs"
SHARED_INSTALL_GATE="$REPOSITORY_ROOT/scripts/verify-shared-runtime-install-gate.mjs"
SHARED_DEPLOYMENT_LOCK_HELPER="$REPOSITORY_ROOT/scripts/lib/shared-deployment-lock.sh"
WORKSPACE_ROOT="${AIWORKER_QWEN_WORKSPACE:-$HOME/AI-worker-second-original-workspace}"
BACKUP_ROOT="${AIWORKER_SKILL_BACKUP_ROOT:-$HOME/ai-worker/backups/aiworker-task-flow-skill}"
DEPLOYMENT_RUN_DIR="${AIWORKER_BG_RUN_DIR:-$REPOSITORY_ROOT/.run/blue-green}"
DEPLOYMENT_LOCK_DIR="$DEPLOYMENT_RUN_DIR/.deployment.lock"
MISSION_CONTROL_DB_PATH="${AIWORKER_BG_LIVE_DB_PATH:-}"
N8N_DB_PATH="${AIWORKER_BG_N8N_DB_PATH:-}"
LEGACY_PREINSTALL_ATTEMPT_DIR="${AIWORKER_BG_LEGACY_PREINSTALL_ATTEMPT_DIR:-}"
ISOLATED_TEST_ROOT="${AIWORKER_INSTALLER_ISOLATED_TEST_ROOT:-}"
CANONICAL_VIDEO_BATCH_ROOT="$HOME/ai-worker/state/video-autoworker/video-batches"
VIDEO_BATCH_ROOT="$CANONICAL_VIDEO_BATCH_ROOT"
if [[ "${NODE_ENV:-}" == test && -n "$ISOLATED_TEST_ROOT" \
  && -n "${AIWORKER_VIDEO_BATCH_DIR:-}" ]]; then
  VIDEO_BATCH_ROOT="$AIWORKER_VIDEO_BATCH_DIR"
elif [[ -n "${AIWORKER_VIDEO_BATCH_DIR:-}" \
  && "$AIWORKER_VIDEO_BATCH_DIR" != "$CANONICAL_VIDEO_BATCH_ROOT" ]]; then
  printf 'Production video batch root is fixed at %s; custom overrides are test-only.\n' \
    "$CANONICAL_VIDEO_BATCH_ROOT" >&2
  exit 2
fi
MUTATION_AUTHORIZATION=""
SHARED_GATE_MODE=""
MODE=""
ROLLBACK_BACKUP=""
ROLLBACK_SOURCE_ORIGINAL=""
ROLLBACK_SOURCE_CLAIM=""
ROLLBACK_SOURCE_CLAIM_ROOT=""
RESULT_OUTPUT=""
RESERVATION_SHA256=""
ROLLBACK_NOOP=0

[[ -f "$SHARED_DEPLOYMENT_LOCK_HELPER" && ! -L "$SHARED_DEPLOYMENT_LOCK_HELPER" ]] || {
  printf 'Shared deployment lock helper is unavailable.\n' >&2
  exit 1
}
# shellcheck source=scripts/lib/shared-deployment-lock.sh
. "$SHARED_DEPLOYMENT_LOCK_HELPER"

usage() {
  printf 'Usage: %s (--dry-run|--apply) [--result-output <absolute-path>] | --rollback (--backup <absolute-path>|--noop) [--result-output <absolute-path>]\n' "$0"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply|--rollback|--probe-current-manifest)
      [[ -z "$MODE" ]] || { usage >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --backup)
      [[ -z "$ROLLBACK_BACKUP" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      ROLLBACK_BACKUP="$2"
      shift 2
      ;;
    --result-output)
      [[ -z "$RESULT_OUTPUT" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      RESULT_OUTPUT="$2"
      shift 2
      ;;
    --reservation-sha256)
      [[ -z "$RESERVATION_SHA256" && "$#" -ge 2 ]] || { usage >&2; exit 2; }
      RESERVATION_SHA256="$2"
      shift 2
      ;;
    --noop)
      [[ "$ROLLBACK_NOOP" == 0 ]] || { usage >&2; exit 2; }
      ROLLBACK_NOOP=1
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" ]] || { usage >&2; exit 2; }
[[ "$MODE" == "rollback" || -z "$ROLLBACK_BACKUP" ]] || { usage >&2; exit 2; }
[[ "$MODE" != "rollback" || "$ROLLBACK_NOOP" == 1 || "$ROLLBACK_BACKUP" == /* ]] || { usage >&2; exit 2; }
[[ "$ROLLBACK_NOOP" == 0 || ( "$MODE" == rollback && -z "$ROLLBACK_BACKUP" ) ]] || { usage >&2; exit 2; }
[[ -z "$RESULT_OUTPUT" || "$RESULT_OUTPUT" == /* ]] || { usage >&2; exit 2; }
[[ "$MODE" != "dry-run" || -z "$RESULT_OUTPUT" ]] || { usage >&2; exit 2; }
if [[ "$MODE" == "probe-current-manifest" \
  && ( -z "$RESULT_OUTPUT" || ! "$RESERVATION_SHA256" =~ ^[a-f0-9]{64}$ ) ]]; then
  usage >&2
  exit 2
fi
[[ "$MODE" == "probe-current-manifest" || -z "$RESERVATION_SHA256" ]] || { usage >&2; exit 2; }
if [[ "$MODE" != "dry-run" && "$MODE" != "probe-current-manifest" && -n "$LEGACY_PREINSTALL_ATTEMPT_DIR" \
  && -z "$RESULT_OUTPUT" ]]; then
  printf 'Legacy preinstall task-flow mutations require an immutable raw result output path.\n' >&2
  exit 2
fi
if [[ -n "$RESULT_OUTPUT" && ( -e "$RESULT_OUTPUT" || -L "$RESULT_OUTPUT" ) ]]; then
  printf 'Result output already exists; refusing to overwrite it: %s\n' "$RESULT_OUTPUT" >&2
  exit 1
fi

case "$WORKSPACE_ROOT" in
  /*) ;;
  *)
    printf 'Qwen workspace must be an absolute path.\n' >&2
    exit 1
    ;;
esac
case "$BACKUP_ROOT" in
  /*) ;;
  *)
    printf 'Task-flow backup root must be an absolute path.\n' >&2
    exit 1
    ;;
esac

if [[ ! -d "$WORKSPACE_ROOT" || -L "$WORKSPACE_ROOT" ]]; then
  printf 'Qwen workspace must be an existing regular directory: %s\n' "$WORKSPACE_ROOT" >&2
  exit 1
fi
WORKSPACE_ROOT="$(cd "$WORKSPACE_ROOT" && pwd -P)"

SKILLS_ROOT="$WORKSPACE_ROOT/skills"
TARGET_DIR="$SKILLS_ROOT/aiworker-task-flow"
WORKSPACE_AGENTS="$WORKSPACE_ROOT/AGENTS.md"
WORKSPACE_MEMORY="$WORKSPACE_ROOT/MEMORY.md"
LOCK_DIR="$WORKSPACE_ROOT/.aiworker-task-flow-install.lock"
if [[ -n "$RESULT_OUTPUT" ]]; then
  case "$RESULT_OUTPUT" in
    "$TARGET_DIR"|"$TARGET_DIR"/*|"$WORKSPACE_AGENTS"|"$WORKSPACE_MEMORY")
      printf 'Result output must be outside managed task-flow objects.\n' >&2
      exit 1
      ;;
  esac
fi

required_skill_files=(
  "$SOURCE_DIR/SKILL.md"
  "$SOURCE_DIR/WORKSPACE_VIDEO_RULES.md"
  "$SOURCE_DIR/WORKSPACE_VIDEO_MEMORY.md"
  "$SOURCE_DIR/scripts/submit-task.mjs"
  "$SOURCE_DIR/scripts/run-video-batch.mjs"
  "$SOURCE_DIR/lib/platform-client.mjs"
  "$SOURCE_DIR/lib/task-status-authority.mjs"
  "$SOURCE_DIR/lib/media-policy.mjs"
  "$SOURCE_DIR/lib/media-ingest.mjs"
  "$SOURCE_DIR/lib/video-task.mjs"
  "$SOURCE_DIR/lib/video-batch-state.mjs"
  "$SOURCE_DIR/lib/video-result-page.mjs"
  "$RENDERER"
  "$SHARED_INSTALL_GATE"
  "$SHARED_DEPLOYMENT_LOCK_HELPER"
)
for required_skill_file in "${required_skill_files[@]}"; do
  if [[ ! -f "$required_skill_file" || -L "$required_skill_file" ]]; then
    printf 'Task-flow skill source is incomplete: %s\n' "$required_skill_file" >&2
    exit 1
  fi
done
if [[ ! -d "$SOURCE_DIR/scripts" || ! -d "$SOURCE_DIR/lib" ]]; then
  printf 'Task-flow skill source is incomplete: %s\n' "$SOURCE_DIR" >&2
  exit 1
fi

NODE_BIN="${AIWORKER_NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  printf 'Node.js executable is required to render workspace sections.\n' >&2
  exit 1
fi
SHASUM_BIN="$(command -v shasum || true)"
if [[ -z "$SHASUM_BIN" || ! -x "$SHASUM_BIN" ]]; then
  printf 'shasum is required to verify task-flow installation state.\n' >&2
  exit 1
fi
WORKSPACE_IDENTITY="$(printf '%s' "$WORKSPACE_ROOT" | "$SHASUM_BIN" -a 256)"
WORKSPACE_IDENTITY="${WORKSPACE_IDENTITY%% *}"
GIT_BIN="$(command -v git || true)"
if [[ -z "$GIT_BIN" || ! -x "$GIT_BIN" ]]; then
  printf 'Git is required to bind the task-flow payload to one source commit.\n' >&2
  exit 1
fi

run_repository_git() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
    -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM \
    "$GIT_BIN" -C "$REPOSITORY_ROOT" "$@"
}

assert_canonical_clean_source_repository() {
  local top_level current_commit status_output source_path relative
  top_level="$(run_repository_git rev-parse --show-toplevel)" || return 1
  [[ "$(cd "$top_level" && pwd -P)" == "$REPOSITORY_ROOT" ]] || return 1
  current_commit="$(run_repository_git rev-parse --verify 'HEAD^{commit}')" || return 1
  [[ "$current_commit" == "$EXPECTED_SOURCE_COMMIT" ]] || return 1
  run_repository_git diff-index --quiet HEAD -- || return 1
  status_output="$(run_repository_git status --porcelain=v1 --untracked-files=all)" || return 1
  [[ -z "$status_output" ]] || return 1
  while IFS= read -r source_path; do
    relative="${source_path#"$REPOSITORY_ROOT"/}"
    [[ "$relative" != "$source_path" ]] \
      && run_repository_git ls-files --error-unmatch -- "$relative" >/dev/null 2>&1 \
      || return 1
  done < <(find "$SOURCE_DIR" -type f -print; printf '%s\n' "$RENDERER")
}

resolve_private_backup_plan() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
let target = path.resolve(process.argv[2])

// macOS exposes /var and /tmp as fixed system aliases. Normalize only those
// platform-owned aliases; every project-controlled ancestor remains subject to
// lstat/no-symlink validation below.
for (const alias of ['/var', '/tmp']) {
  if (process.platform !== 'darwin'
    || (target !== alias && !target.startsWith(`${alias}/`))) continue
  const value = fs.lstatSync(alias)
  const physical = fs.realpathSync.native(alias)
  if (!value.isSymbolicLink() || !physical.startsWith('/private/')) {
    throw new Error(`unexpected_system_alias:${alias}`)
  }
  target = `${physical}${target.slice(alias.length)}`
}

const parsed = path.parse(target)
let current = parsed.root
for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, component)
  let value
  try {
    value = fs.lstatSync(current)
  } catch (error) {
    if (error?.code === 'ENOENT') break
    throw error
  }
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw new Error(`backup_ancestor_unsafe:${current}`)
  }
}
const finalValue = fs.lstatSync(target, { throwIfNoEntry: false })
if (finalValue && (finalValue.isSymbolicLink() || !finalValue.isDirectory()
  || finalValue.uid !== process.getuid() || (finalValue.mode & 0o077) !== 0)) {
  throw new Error('backup_root_not_owner_private')
}
process.stdout.write(target)
NODE
}

paths_overlap() {
  local left="$1" right="$2"
  [[ "$left" == "$right" || "$left/" == "$right/"* || "$right/" == "$left/"* ]]
}

reject_git_worktree_path() {
  local pathname="$1" existing="$1" cursor marker probe_output probe_status=0
  while [[ ! -d "$existing" ]]; do
    [[ "$existing" != / ]] || break
    existing="${existing%/*}"
    [[ -n "$existing" ]] || existing=/
  done
  cursor="$existing"
  while :; do
    marker="$cursor/.git"
    if [[ -e "$marker" || -L "$marker" ]]; then
      printf 'Task-flow backup root must be outside every Git worktree: %s\n' "$pathname" >&2
      return 1
    fi
    [[ "$cursor" != / ]] || break
    cursor="${cursor%/*}"
    [[ -n "$cursor" ]] || cursor=/
  done
  probe_output="$(env -i PATH="$(dirname "$GIT_BIN"):/usr/bin:/bin" \
    LC_ALL=C LANG=C HOME=/var/empty XDG_CONFIG_HOME=/var/empty \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    "$GIT_BIN" -C "$existing" rev-parse --is-inside-work-tree \
      --is-inside-git-dir 2>&1)" || probe_status=$?
  if [[ "$probe_status" == 0 ]]; then
    printf 'Task-flow backup root must be outside every Git worktree: %s\n' "$pathname" >&2
    return 1
  fi
  if [[ "$probe_output" != "fatal: not a git repository"* ]]; then
    printf 'Unable to verify task-flow backup Git boundary: %s\n' "$probe_output" >&2
    return 1
  fi
}

secure_prepare_task_flow_backup_root() {
  "$NODE_BIN" - "$BACKUP_ROOT" <<'NODE'
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
    fs.mkdirSync(current, { mode: 0o700 })
    value = fs.lstatSync(current)
  }
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw new Error(`backup_ancestor_unsafe:${current}`)
  }
}
const handle = fs.openSync(target,
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
try {
  const value = fs.fstatSync(handle)
  if (!value.isDirectory() || value.uid !== process.getuid()) {
    throw new Error('backup_root_owner_invalid')
  }
  fs.fchmodSync(handle, 0o700)
  fs.fsyncSync(handle)
} finally {
  fs.closeSync(handle)
}
NODE
  [[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" \
    && "$(path_mode "$BACKUP_ROOT")" == 700 ]] || return 1
}

BACKUP_ROOT="$(resolve_private_backup_plan "$BACKUP_ROOT")" || {
  printf 'Task-flow backup root has a symlink, non-directory, or non-private owner boundary.\n' >&2
  exit 1
}
if paths_overlap "$BACKUP_ROOT" "$WORKSPACE_ROOT"; then
  printf 'Task-flow backup root must be outside the workspace tree.\n' >&2
  exit 1
fi
reject_git_worktree_path "$BACKUP_ROOT" || exit 1

EXPECTED_SOURCE_COMMIT="$(env \
  -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
  "$GIT_BIN" -C "$REPOSITORY_ROOT" rev-parse --verify 'HEAD^{commit}')" || {
  printf 'Could not resolve the task-flow source commit.\n' >&2
  exit 1
}
[[ "$EXPECTED_SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || {
  printf 'Task-flow source commit must be one full lowercase Git commit.\n' >&2
  exit 1
}
EXPECTED_RELEASE_ID="$EXPECTED_SOURCE_COMMIT-runtime"
if [[ "$MODE" == dry-run \
  && ( "${NODE_ENV:-}" != test || -z "$ISOLATED_TEST_ROOT" ) ]]; then
  assert_canonical_clean_source_repository || {
    printf 'Task-flow production payload must come from the canonical clean HEAD worktree.\n' >&2
    exit 1
  }
fi

if [[ -L "$SKILLS_ROOT" || ( -e "$SKILLS_ROOT" && ! -d "$SKILLS_ROOT" ) ]]; then
  printf 'Workspace skills path must be a regular directory: %s\n' "$SKILLS_ROOT" >&2
  exit 1
fi
if [[ -L "$TARGET_DIR" || ( -e "$TARGET_DIR" && ! -d "$TARGET_DIR" ) ]]; then
  printf 'Installed task-flow skill must be a regular directory: %s\n' "$TARGET_DIR" >&2
  exit 1
fi
for workspace_file in "$WORKSPACE_AGENTS" "$WORKSPACE_MEMORY"; do
  if [[ -L "$workspace_file" || ( -e "$workspace_file" && ! -f "$workspace_file" ) ]]; then
    printf 'Workspace control file must be a regular file: %s\n' "$workspace_file" >&2
    exit 1
  fi
done
if [[ -L "$BACKUP_ROOT" || ( -e "$BACKUP_ROOT" && ! -d "$BACKUP_ROOT" ) ]]; then
  printf 'Task-flow backup root must be a regular directory: %s\n' "$BACKUP_ROOT" >&2
  exit 1
fi
case "$BACKUP_ROOT/" in
  "$TARGET_DIR/"*)
    printf 'Task-flow backup root must not be inside the installed skill.\n' >&2
    exit 1
    ;;
esac

TEST_FAILPOINT="${AIWORKER_TASK_FLOW_INSTALL_TEST_FAILPOINT:-}"
TEST_SYNC_DIR="${AIWORKER_TASK_FLOW_INSTALL_TEST_SYNC_DIR:-}"
if [[ -n "$TEST_FAILPOINT$TEST_SYNC_DIR" \
  && "${AIWORKER_TASK_FLOW_INSTALL_TESTING:-0}" != "1" ]]; then
  printf 'Installer failure injection is available only in an explicit test environment.\n' >&2
  exit 1
fi
case "$TEST_FAILPOINT" in
  ""|after-skill-original|after-skill|after-agents-original|after-agents|after-memory-original|after-memory|sigkill-after-skill-original) ;;
  *)
    printf 'Unknown installer test failpoint: %s\n' "$TEST_FAILPOINT" >&2
    exit 1
    ;;
esac
if [[ -n "$TEST_SYNC_DIR" && ( ! -d "$TEST_SYNC_DIR" || -L "$TEST_SYNC_DIR" ) ]]; then
  printf 'Task-flow installer test synchronization directory is unsafe.\n' >&2
  exit 1
fi

maybe_fail() {
  if [[ "$TEST_FAILPOINT" == "$1" ]]; then
    printf 'Injected task-flow installer failure at %s.\n' "$1" >&2
    return 97
  fi
}

wait_for_sigkill_test() {
  [[ "$TEST_FAILPOINT" == sigkill-after-skill-original && -n "$TEST_SYNC_DIR" ]] || return 0
  install -m 600 /dev/null "$TEST_SYNC_DIR/sigkill-ready"
  for _ in {1..1000}; do sleep 0.01; done
  printf 'Timed out waiting for SIGKILL test driver.\n' >&2
  return 97
}

LOCK_OWNED=0
DEPLOYMENT_LOCK_OWNED=0
SKILLS_ROOT_CREATED=0
TRANSACTION_DIR=""
TRANSACTION_COMPLETE=0
COMMIT_STARTED=0
PRESERVE_TRANSACTION=0
LOCAL_LOCK_FENCE=""
LOCAL_OWNER_START=""
JOURNAL_WRITTEN=0

path_mode() {
  stat -f '%Lp' "$1"
}

path_sha256() {
  local digest
  digest="$("$SHASUM_BIN" -a 256 "$1")"
  printf '%s' "${digest%% *}"
}

write_tree_manifest() {
  local tree_root="$1"
  local manifest_path="$2"
  local excluded_relative_path="${3:-}"

  if ! "$NODE_BIN" - "$tree_root" "$excluded_relative_path" > "$manifest_path" <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')

const [rootPath, excludedPath] = process.argv.slice(2)
const root = Buffer.from(rootPath)
const excluded = excludedPath === '' ? null : Buffer.from(excludedPath)
const slash = Buffer.from('/')
const dotSlash = Buffer.from('./')

const mode = stat => Number(stat.mode & 0o7777n).toString(8)
const sameSnapshot = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
const verifyPath = (pathname, expected) => {
  const actual = fs.lstatSync(pathname, { bigint: true })
  if (!sameSnapshot(actual, expected)) throw new Error('Manifest path changed while reading')
  return actual
}
const write = value => {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  let offset = 0
  while (offset < buffer.length) {
    const written = fs.writeSync(1, buffer, offset, buffer.length - offset)
    if (written === 0) throw new Error('Could not complete manifest output')
    offset += written
  }
}
const sha256 = value => createHash('sha256').update(value).digest('hex')

const hashFile = (pathname, expected) => {
  const noFollow = fs.constants.O_NOFOLLOW
  if (noFollow === undefined) throw new Error('O_NOFOLLOW is required for manifest hashing')
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | noFollow)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || !sameSnapshot(before, expected)) {
      throw new Error('Manifest file changed before hashing')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = fs.fstatSync(fd, { bigint: true })
    if (!sameSnapshot(after, expected)) {
      throw new Error('Manifest file changed while hashing')
    }
    verifyPath(pathname, expected)
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

let rootStat
try {
  rootStat = fs.lstatSync(root, { bigint: true })
} catch {
  write('absent\n')
  process.exit(0)
}
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  write('absent\n')
  process.exit(0)
}

const entries = []
const pending = [{ pathname: root, relative: Buffer.alloc(0), stat: rootStat }]
while (pending.length > 0) {
  const directory = pending.pop()
  verifyPath(directory.pathname, directory.stat)
  for (const name of fs.readdirSync(directory.pathname, { encoding: 'buffer' })) {
    if (name.includes(0x0a)) throw new Error('Manifest paths must not contain newlines')
    const pathname = Buffer.concat([directory.pathname, slash, name])
    const bareRelative = directory.relative.length === 0
      ? name
      : Buffer.concat([directory.relative, slash, name])
    const relative = Buffer.concat([dotSlash, bareRelative])
    const stat = fs.lstatSync(pathname, { bigint: true })
    entries.push({ pathname, relative, stat })
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      pending.push({ pathname, relative: bareRelative, stat })
    }
  }
}
entries.sort((left, right) => Buffer.compare(left.relative, right.relative))

verifyPath(root, rootStat)
write(`.\tdirectory\t${mode(rootStat)}\t-\n`)
for (const entry of entries) {
  if (excluded !== null && entry.relative.equals(excluded)) continue
  verifyPath(entry.pathname, entry.stat)
  write(entry.relative)
  if (entry.stat.isSymbolicLink()) {
    let target = fs.readlinkSync(entry.pathname, { encoding: 'buffer' })
    while (target.length > 0 && target[target.length - 1] === 0x0a) {
      target = target.subarray(0, target.length - 1)
    }
    const verified = fs.lstatSync(entry.pathname, { bigint: true })
    if (!verified.isSymbolicLink() || !sameSnapshot(entry.stat, verified)) {
      throw new Error('Manifest symlink changed while reading')
    }
    write(`\tsymlink\t${mode(entry.stat)}\t${sha256(target)}\n`)
  } else if (entry.stat.isDirectory()) {
    write(`\tdirectory\t${mode(entry.stat)}\t-\n`)
  } else if (entry.stat.isFile()) {
    const escapedDigest = entry.relative.includes(0x5c) ? '\\' : ''
    write(`\tfile\t${mode(entry.stat)}\t${escapedDigest}${hashFile(entry.pathname, entry.stat)}\n`)
  } else {
    write(`\tother\t${mode(entry.stat)}\t-\n`)
  }
}
verifyPath(root, rootStat)
for (const entry of entries) {
  if (entry.stat.isDirectory()) verifyPath(entry.pathname, entry.stat)
}
NODE
  then
    rm -f -- "$manifest_path"
    return 1
  fi
  if ! chmod 600 "$manifest_path"; then
    rm -f -- "$manifest_path"
    return 1
  fi
}

is_task_flow_backup_family_name() {
  [[ "$1" =~ ^[[:digit:]]{8}-[[:digit:]]{6}\.[[:alnum:]]{6}$ ]]
}

task_flow_backup_has_recoverable_shape() {
  local candidate="$1"
  local state_path="$candidate/STATE"
  local line state_version skill_present agents_present memory_present
  local -a state_lines=()

  if [[ ! -f "$state_path" || -L "$state_path" || ! -r "$state_path" ]]; then
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    state_lines+=("$line")
  done < "$state_path"
  state_version="${state_lines[0]#version=}"
  case "${state_lines[0]:-}" in
    version=1)
      [[ "${#state_lines[@]}" == "4" ]] || return 1
      skill_present="${state_lines[1]#skill_present=}"
      agents_present="${state_lines[2]#agents_present=}"
      memory_present="${state_lines[3]#memory_present=}"
      [[ "${state_lines[1]}" == "skill_present=$skill_present" \
        && "${state_lines[2]}" == "agents_present=$agents_present" \
        && "${state_lines[3]}" == "memory_present=$memory_present" ]] || return 1
      ;;
    version=2)
      [[ "${#state_lines[@]}" == "7" \
        && "${state_lines[1]}" =~ ^workspace_sha256=[a-f0-9]{64}$ \
        && "${state_lines[2]}" =~ ^source_commit=[a-f0-9]{40}$ \
        && "${state_lines[3]}" == "release_id=${state_lines[2]#source_commit=}-runtime" ]] || return 1
      skill_present="${state_lines[4]#skill_present=}"
      agents_present="${state_lines[5]#agents_present=}"
      memory_present="${state_lines[6]#memory_present=}"
      [[ "${state_lines[4]}" == "skill_present=$skill_present" \
        && "${state_lines[5]}" == "agents_present=$agents_present" \
        && "${state_lines[6]}" == "memory_present=$memory_present" ]] || return 1
      for line in APPLIED.skill.manifest APPLIED.AGENTS.manifest APPLIED.MEMORY.manifest; do
        [[ -f "$candidate/$line" && ! -L "$candidate/$line" ]] || return 1
      done
      ;;
    *) return 1 ;;
  esac
  while IFS= read -r line; do
    case "${line##*/}:$state_version" in
      STATE:*|MANIFEST.sha256:*|aiworker-task-flow:*|aiworker-task-flow.absent:* \
        |AGENTS.md:*|AGENTS.md.absent:*|MEMORY.md:*|MEMORY.md.absent:* \
        |APPLIED.skill.manifest:2|APPLIED.AGENTS.manifest:2|APPLIED.MEMORY.manifest:2) ;;
      *) return 1 ;;
    esac
  done < <(find "$candidate" -mindepth 1 -maxdepth 1 -print)
  case "$skill_present:$agents_present:$memory_present" in
    [01]:[01]:[01]) ;;
    *) return 1 ;;
  esac

  if [[ "$skill_present" == "1" ]]; then
    [[ -d "$candidate/aiworker-task-flow" && ! -L "$candidate/aiworker-task-flow" ]] || return 1
    [[ ! -e "$candidate/aiworker-task-flow.absent" && ! -L "$candidate/aiworker-task-flow.absent" ]] || return 1
  else
    [[ -f "$candidate/aiworker-task-flow.absent" \
      && ! -L "$candidate/aiworker-task-flow.absent" \
      && ! -s "$candidate/aiworker-task-flow.absent" ]] || return 1
    [[ ! -e "$candidate/aiworker-task-flow" && ! -L "$candidate/aiworker-task-flow" ]] || return 1
  fi
  if [[ "$agents_present" == "1" ]]; then
    [[ -f "$candidate/AGENTS.md" && ! -L "$candidate/AGENTS.md" ]] || return 1
    [[ ! -e "$candidate/AGENTS.md.absent" && ! -L "$candidate/AGENTS.md.absent" ]] || return 1
  else
    [[ -f "$candidate/AGENTS.md.absent" \
      && ! -L "$candidate/AGENTS.md.absent" \
      && ! -s "$candidate/AGENTS.md.absent" ]] || return 1
    [[ ! -e "$candidate/AGENTS.md" && ! -L "$candidate/AGENTS.md" ]] || return 1
  fi
  if [[ "$memory_present" == "1" ]]; then
    [[ -f "$candidate/MEMORY.md" && ! -L "$candidate/MEMORY.md" ]] || return 1
    [[ ! -e "$candidate/MEMORY.md.absent" && ! -L "$candidate/MEMORY.md.absent" ]] || return 1
  else
    [[ -f "$candidate/MEMORY.md.absent" \
      && ! -L "$candidate/MEMORY.md.absent" \
      && ! -s "$candidate/MEMORY.md.absent" ]] || return 1
    [[ ! -e "$candidate/MEMORY.md" && ! -L "$candidate/MEMORY.md" ]] || return 1
  fi
}

task_flow_backup_is_verified() {
  local candidate="$1"
  local scan_index="$2"
  local expected_parent="${3:-$BACKUP_ROOT}"
  local candidate_name candidate_manifest candidate_symlinks actual_manifest

  candidate_name="${candidate##*/}"
  if ! is_task_flow_backup_family_name "$candidate_name"; then
    return 1
  fi
  if [[ ! -d "$candidate" || -L "$candidate" ]]; then
    return 1
  fi
  [[ "${candidate%/*}" == "$expected_parent" ]] || return 1
  candidate_manifest="$candidate/MANIFEST.sha256"
  if [[ ! -f "$candidate_manifest" || -L "$candidate_manifest" ]]; then
    return 1
  fi
  [[ "$(path_mode "$candidate")" == "700" \
    && "$(path_mode "$candidate/STATE")" == "600" \
    && "$(path_mode "$candidate_manifest")" == "600" ]] || return 1
  if ! candidate_symlinks="$(find -P "$candidate" -type l -print 2>/dev/null)"; then
    return 1
  fi
  if [[ -n "$candidate_symlinks" ]]; then
    return 1
  fi
  while IFS= read -r line; do
    [[ "$line" != *$'\t'* && "$line" != *$'\n'* ]] || return 1
  done < <(find "$candidate" -mindepth 1 -print)
  if ! task_flow_backup_has_recoverable_shape "$candidate"; then
    return 1
  fi
  if [[ "$(sed -n '1p' "$candidate/STATE")" == "version=2" ]]; then
    for candidate_manifest in \
      "$candidate/APPLIED.skill.manifest" \
      "$candidate/APPLIED.AGENTS.manifest" \
      "$candidate/APPLIED.MEMORY.manifest"; do
      [[ "$(path_mode "$candidate_manifest")" == "600" ]] || return 1
    done
    candidate_manifest="$candidate/MANIFEST.sha256"
  fi

  actual_manifest="$TRANSACTION_DIR/verified-backup-manifest.$scan_index"
  rm -f -- "$actual_manifest"
  if ! write_tree_manifest "$candidate" "$actual_manifest" './MANIFEST.sha256' \
    || ! cmp -s "$actual_manifest" "$candidate_manifest"; then
    rm -f -- "$actual_manifest"
    return 1
  fi
  rm -f -- "$actual_manifest"
}

task_flow_backup_matches_workspace() {
  local candidate="$1"
  [[ "$(sed -n '1p' "$candidate/STATE")" == "version=2" \
    && "$(sed -n '2p' "$candidate/STATE")" == "workspace_sha256=$WORKSPACE_IDENTITY" ]]
}

claim_rollback_backup() {
  local original="$1" claim_name claim_path
  ROLLBACK_SOURCE_CLAIM_ROOT="$(mktemp -d "$BACKUP_ROOT/.rollback-source-claim.XXXXXX")" || return 1
  chmod 700 "$ROLLBACK_SOURCE_CLAIM_ROOT" || {
    rmdir "$ROLLBACK_SOURCE_CLAIM_ROOT" 2>/dev/null || true
    ROLLBACK_SOURCE_CLAIM_ROOT=""
    return 1
  }
  claim_name="${original##*/}"
  claim_path="$ROLLBACK_SOURCE_CLAIM_ROOT/$claim_name"
  if ! mv "$original" "$claim_path"; then
    rmdir "$ROLLBACK_SOURCE_CLAIM_ROOT" 2>/dev/null || true
    ROLLBACK_SOURCE_CLAIM_ROOT=""
    return 1
  fi
  ROLLBACK_SOURCE_ORIGINAL="$original"
  ROLLBACK_SOURCE_CLAIM="$claim_path"
  ROLLBACK_BACKUP="$ROLLBACK_SOURCE_CLAIM"
  task_flow_backup_is_verified "$ROLLBACK_BACKUP" 900001 "$ROLLBACK_SOURCE_CLAIM_ROOT" \
    && task_flow_backup_matches_workspace "$ROLLBACK_BACKUP"
}

release_rollback_backup_claim() {
  [[ -n "$ROLLBACK_SOURCE_CLAIM" ]] || return 0
  [[ ! -e "$ROLLBACK_SOURCE_ORIGINAL" && ! -L "$ROLLBACK_SOURCE_ORIGINAL" ]] || return 1
  mv "$ROLLBACK_SOURCE_CLAIM" "$ROLLBACK_SOURCE_ORIGINAL" || return 1
  ROLLBACK_BACKUP="$ROLLBACK_SOURCE_ORIGINAL"
  ROLLBACK_SOURCE_CLAIM=""
  rmdir "$ROLLBACK_SOURCE_CLAIM_ROOT" || return 1
  ROLLBACK_SOURCE_CLAIM_ROOT=""
}

list_verified_task_flow_backups() {
  local candidate scan_index=0
  local LC_ALL=C

  if [[ ! -d "$BACKUP_ROOT" ]]; then
    return
  fi

  for candidate in "$BACKUP_ROOT"/*; do
    if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
      continue
    fi
    scan_index=$((scan_index + 1))
    if task_flow_backup_is_verified "$candidate" "$scan_index"; then
      printf '%s\n' "$candidate"
    fi
  done
}

prune_verified_task_flow_backups() {
  local candidate candidate_name selected="" scan_index=100000
  local -a verified_backups=()

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && verified_backups+=("$candidate")
  done < <(list_verified_task_flow_backups)
  if [[ "${#verified_backups[@]}" -le 2 ]]; then
    return
  fi
  if [[ "${#verified_backups[@]}" -ne 3 ]]; then
    printf 'Verified task-flow backup count must grow from at most two to at most three.\n' >&2
    return 1
  fi
  if [[ ! " ${verified_backups[*]} " =~ " $BACKUP_DIR " ]]; then
    printf 'The new task-flow backup is not part of the verified backup set.\n' >&2
    return 1
  fi

  for candidate in "${verified_backups[@]}"; do
    if [[ "$candidate" != "$BACKUP_DIR" ]]; then
      selected="$candidate"
      break
    fi
  done
  if [[ -z "$selected" || "${selected%/*}" != "$BACKUP_ROOT" ]]; then
    printf 'Could not select a safe old task-flow backup for retention cleanup.\n' >&2
    return 1
  fi
  candidate_name="${selected##*/}"
  if ! is_task_flow_backup_family_name "$candidate_name" \
    || ! task_flow_backup_is_verified "$selected" "$scan_index"; then
    printf 'Old task-flow backup changed before retention cleanup.\n' >&2
    return 1
  fi
  rm -rf -- "$selected"

  verified_backups=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && verified_backups+=("$candidate")
  done < <(list_verified_task_flow_backups)
  if [[ "${#verified_backups[@]}" -ne 2 \
    || ! " ${verified_backups[*]} " =~ " $BACKUP_DIR " ]]; then
    printf 'Task-flow backup retention did not converge to two verified versions.\n' >&2
    return 1
  fi
}

count_verified_task_flow_backups() {
  local candidate verified_count=0
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && verified_count=$((verified_count + 1))
  done < <(list_verified_task_flow_backups)

  printf '%s\n' "$verified_count"
}

write_file_manifest() {
  local file_path="$1"
  local manifest_path="$2"
  if [[ -f "$file_path" && ! -L "$file_path" ]]; then
    printf 'file\t%s\t%s\n' "$(path_mode "$file_path")" "$(path_sha256 "$file_path")" > "$manifest_path"
  elif [[ ! -e "$file_path" && ! -L "$file_path" ]]; then
    printf 'absent\n' > "$manifest_path"
  else
    printf 'other\n' > "$manifest_path"
  fi
  chmod 600 "$manifest_path"
}

target_state_manifest_sha256() {
  local label="$1" skill_manifest="$2" agents_manifest="$3" memory_manifest="$4"
  local combined_manifest="$TRANSACTION_DIR/$label-target-state.manifest"
  {
    printf 'skill\t%s\n' "$(path_sha256 "$skill_manifest")"
    printf 'agents\t%s\n' "$(path_sha256 "$agents_manifest")"
    printf 'memory\t%s\n' "$(path_sha256 "$memory_manifest")"
  } > "$combined_manifest"
  chmod 600 "$combined_manifest"
  path_sha256 "$combined_manifest"
}

reservation_target_state_sha256() {
  "$NODE_BIN" - "$TARGET_DIR" "$WORKSPACE_AGENTS" "$WORKSPACE_MEMORY" <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [skillRoot, agentsPath, memoryPath] = process.argv.slice(2)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const mode = stat => stat.mode & 0o7777
const tree = root => {
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (rootStat === undefined) return { state: 'absent' }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) process.exit(1)
  const entries = [['.', 'directory', mode(rootStat), null]]
  const visit = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const pathname = path.join(directory, name)
      const childRelative = relative ? `${relative}/${name}` : name
      const stat = fs.lstatSync(pathname)
      if (stat.isSymbolicLink()) {
        entries.push([childRelative, 'symlink', mode(stat), sha256(fs.readlinkSync(pathname))])
      } else if (stat.isDirectory()) {
        entries.push([childRelative, 'directory', mode(stat), null]); visit(pathname, childRelative)
      } else if (stat.isFile()) {
        entries.push([childRelative, 'file', mode(stat), sha256(fs.readFileSync(pathname))])
      } else entries.push([childRelative, 'other', mode(stat), null])
    }
  }
  visit(root, '')
  return { state: 'present', entries }
}
const file = pathname => {
  const stat = fs.lstatSync(pathname, { throwIfNoEntry: false })
  if (stat === undefined) return { state: 'absent' }
  if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1)
  return { state: 'present', mode: mode(stat), sha256: sha256(fs.readFileSync(pathname)) }
}
process.stdout.write(sha256(JSON.stringify({
  skill: tree(skillRoot), agents: file(agentsPath), memory: file(memoryPath),
})))
NODE
}

if [[ "$MODE" == "probe-current-manifest" ]]; then
  probe_digest="$(reservation_target_state_sha256)" || exit 1
  "$NODE_BIN" - "$RESULT_OUTPUT" "$REPOSITORY_ROOT/scripts/install-aiworker-task-flow-skill.sh" \
    "$EXPECTED_SOURCE_COMMIT" "$EXPECTED_RELEASE_ID" "$RESERVATION_SHA256" "$probe_digest" <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const [output, verifierPath, sourceCommit, targetReleaseId, reservationSha256,
  targetStateSha256] = process.argv.slice(2)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const stat = fs.lstatSync(verifierPath, { bigint: true })
const value = {
  schema: 'video-autoworker-component-target-probe/v1', component: 'task-flow', sourceCommit,
  targetReleaseId, reservationSha256, targetStateSha256,
  observedAt: Math.floor(Date.now() / 1000),
  verifier: { path: verifierPath, dev: stat.dev.toString(), ino: stat.ino.toString(),
    size: Number(stat.size), sha256: sha256(fs.readFileSync(verifierPath)) },
}
const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
NODE
  exit 0
fi

write_install_result() {
  local operation="$1" status="$2" before_digest="$3" after_digest="$4"
  local backup_path="$5" backup_manifest_digest="$6"
  [[ -n "$RESULT_OUTPUT" ]] || return 0
  "$NODE_BIN" - "$RESULT_OUTPUT" "$operation" "$status" "$EXPECTED_SOURCE_COMMIT" \
    "$EXPECTED_RELEASE_ID" "$before_digest" "$after_digest" "$backup_path" \
    "$backup_manifest_digest" <<'NODE'
const fs = require('node:fs')
const [outputPath, operation, status, sourceCommit, targetReleaseId,
  beforeManifestSha256, afterManifestSha256, backupPath,
  backupManifestSha256] = process.argv.slice(2)
const sha256 = /^[a-f0-9]{64}$/u
if (!['apply', 'rollback'].includes(operation)
  || !['applied', 'noop', 'restored'].includes(status)
  || !/^[a-f0-9]{40}$/u.test(sourceCommit)
  || targetReleaseId !== `${sourceCommit}-runtime`
  || !sha256.test(beforeManifestSha256) || !sha256.test(afterManifestSha256)
  || ((backupPath === '') !== (backupManifestSha256 === ''))
  || (backupManifestSha256 !== '' && !sha256.test(backupManifestSha256))) {
  throw new Error('invalid installer result evidence')
}
const value = {
  schema: 'video-autoworker-installer-result/v1',
  component: 'task-flow',
  operation,
  status,
  sourceCommit,
  targetReleaseId,
  beforeManifestSha256,
  afterManifestSha256,
  backup: backupPath === '' ? null : { path: backupPath, manifestSha256: backupManifestSha256 },
  requiresFreshRestart: false,
  completedAt: Math.floor(Date.now() / 1000),
}
const handle = fs.openSync(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try {
  fs.fchmodSync(handle, 0o600)
  fs.writeFileSync(handle, `${JSON.stringify(value)}\n`, { encoding: 'utf8' })
  fs.fsyncSync(handle)
} finally {
  fs.closeSync(handle)
}
NODE
}

tree_matches_manifest() {
  local tree_root="$1"
  local expected_manifest="$2"
  local actual_manifest="$TRANSACTION_DIR/rollback-tree-manifest.$$.txt"
  rm -f -- "$actual_manifest"
  if ! write_tree_manifest "$tree_root" "$actual_manifest"; then
    return 1
  fi
  cmp -s "$actual_manifest" "$expected_manifest"
}

file_matches_expected() {
  local file_path="$1"
  local expected_path="$2"
  [[ -f "$file_path" && ! -L "$file_path" ]] \
    && [[ "$(path_mode "$file_path")" == "$(path_mode "$expected_path")" ]] \
    && cmp -s "$file_path" "$expected_path"
}

process_start_token() {
  /bin/ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

create_local_lock_claim() {
  LOCAL_OWNER_START="$(process_start_token "$$")"
  [[ -n "$LOCAL_OWNER_START" ]] || return 1
  LOCAL_LOCK_FENCE="$($NODE_BIN -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))")"
  "$NODE_BIN" - "$LOCK_DIR" "$$" "$LOCAL_OWNER_START" "$LOCAL_LOCK_FENCE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [lockPath, pidSource, start, fence] = process.argv.slice(2)
const parent = path.dirname(lockPath)
const stage = `${lockPath}.claim.${fence}`
fs.mkdirSync(stage, { mode: 0o700 })
try {
  const owner = {
    schema: 'video-autoworker-installer-owner/v1',
    component: 'task-flow', pid: Number(pidSource), start, fence,
  }
  const ownerPath = path.join(stage, 'owner.json')
  const fd = fs.openSync(ownerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  const stageFd = fs.openSync(stage, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(stageFd) } finally { fs.closeSync(stageFd) }
  try { fs.renameSync(stage, lockPath) } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') process.exit(42)
    throw error
  }
  const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
NODE
}

read_local_lock_owner() {
  "$NODE_BIN" - "$LOCK_DIR/owner.json" <<'NODE'
const fs = require('node:fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (value?.schema !== 'video-autoworker-installer-owner/v1'
  || value?.component !== 'task-flow'
  || !Number.isSafeInteger(value?.pid) || value.pid < 1
  || typeof value?.start !== 'string' || /[\r\n\t]/u.test(value.start)
  || !/^[a-f0-9]{32}$/u.test(value?.fence || '')) process.exit(1)
process.stdout.write(`${value.pid}\t${value.start}\t${value.fence}\n`)
NODE
}

write_transaction_journal() {
  local operation="$1" backup="$2" backup_digest="$3"
  local backup_identity
  backup_identity="$(stat -f '%d:%i' "$backup")" || return 1
  "$NODE_BIN" - "$LOCK_DIR/journal.json" "$operation" "$LOCAL_LOCK_FENCE" \
    "$TRANSACTION_DIR" "$BEFORE_MANIFEST_SHA256" "$backup" "$backup_identity" \
    "$backup_digest" "$SKILL_PRESENT" "$AGENTS_PRESENT" "$MEMORY_PRESENT" \
    "$RESULT_OUTPUT" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [output, operation, fence, transactionDir, beforeManifestSha256,
  backupPath, backupIdentity, backupManifestSha256, skillPresent,
  agentsPresent, memoryPresent, resultOutput] = process.argv.slice(2)
const value = {
  schema: 'video-autoworker-installer-journal/v1', component: 'task-flow',
  operation, fence, phase: 'prepared', transactionDir, beforeManifestSha256,
  backup: { path: backupPath, identity: backupIdentity, manifestSha256: backupManifestSha256 },
  beforeEndpoint: {
    skillPresent: Number(skillPresent), agentsPresent: Number(agentsPresent),
    memoryPresent: Number(memoryPresent),
  },
  resultOutput: resultOutput || null,
}
if (!['apply', 'rollback'].includes(operation) || !/^[a-f0-9]{32}$/u.test(fence)
  || !/^[a-f0-9]{64}$/u.test(beforeManifestSha256)
  || !/^\d+:\d+$/u.test(backupIdentity)
  || !/^[a-f0-9]{64}$/u.test(backupManifestSha256)
  || ![skillPresent, agentsPresent, memoryPresent].every(item => ['0', '1'].includes(item))) {
  throw new Error('journal_binding_invalid')
}
const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) }
finally { fs.closeSync(fd) }
const parentFd = fs.openSync(path.dirname(output), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
NODE
  JOURNAL_WRITTEN=1
}

journal_field() {
  "$NODE_BIN" - "$LOCK_DIR/journal.json" "$1" <<'NODE'
const fs = require('node:fs')
const [pathname, field] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(pathname, 'utf8'))
const fields = {
  phase: value.phase, fence: value.fence, transactionDir: value.transactionDir,
  before: value.beforeManifestSha256, backupPath: value.backup?.path,
  backupIdentity: value.backup?.identity, backupDigest: value.backup?.manifestSha256,
  skillPresent: value.beforeEndpoint?.skillPresent,
  agentsPresent: value.beforeEndpoint?.agentsPresent,
  memoryPresent: value.beforeEndpoint?.memoryPresent,
}
if (value?.schema !== 'video-autoworker-installer-journal/v1'
  || value?.component !== 'task-flow' || !(field in fields)) process.exit(1)
const result = fields[field]
if (typeof result === 'string' && /[\r\n]/u.test(result)) process.exit(1)
process.stdout.write(String(result))
NODE
}

mark_transaction_journal_complete() {
  local after_digest="$1"
  "$NODE_BIN" - "$LOCK_DIR/journal.json" "$LOCAL_LOCK_FENCE" "$after_digest" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [pathname, fence, afterManifestSha256] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(pathname, 'utf8'))
if (value?.fence !== fence || value?.phase !== 'prepared'
  || !/^[a-f0-9]{64}$/u.test(afterManifestSha256)) throw new Error('journal_fence_invalid')
value.phase = 'complete'
value.afterManifestSha256 = afterManifestSha256
const temporary = `${pathname}.complete.${fence}`
const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) }
finally { fs.closeSync(fd) }
fs.renameSync(temporary, pathname)
const parentFd = fs.openSync(path.dirname(pathname), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
NODE
}

remove_local_lock() {
  rm -f -- "$LOCK_DIR/journal.json" "$LOCK_DIR/owner.json"
  rmdir "$LOCK_DIR"
}

recover_stale_local_lock() {
  local owner_line owner_pid owner_start owner_fence actual_start
  [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || return 1
  owner_line="$(read_local_lock_owner)" || {
    printf 'Existing task-flow installer lock has no valid recoverable owner record.\n' >&2
    return 1
  }
  IFS=$'\t' read -r owner_pid owner_start owner_fence <<< "$owner_line"
  actual_start="$(process_start_token "$owner_pid")"
  if [[ -n "$actual_start" && "$actual_start" == "$owner_start" ]]; then
    printf 'Another task-flow installation already holds the workspace lock: %s\n' "$LOCK_DIR" >&2
    return 1
  fi
  if [[ ! -f "$LOCK_DIR/journal.json" ]]; then
    rm -f -- "$LOCK_DIR/owner.json"
    rmdir "$LOCK_DIR"
    return 0
  fi
  [[ "$(journal_field fence)" == "$owner_fence" ]] || return 1
  local stale_transaction stale_phase stale_backup stale_backup_identity stale_backup_digest
  stale_transaction="$(journal_field transactionDir)" || return 1
  stale_phase="$(journal_field phase)" || return 1
  stale_backup="$(journal_field backupPath)" || return 1
  stale_backup_identity="$(journal_field backupIdentity)" || return 1
  stale_backup_digest="$(journal_field backupDigest)" || return 1
  case "$stale_transaction" in "$WORKSPACE_ROOT"/.aiworker-task-flow.txn.*) ;; *) return 1 ;; esac
  [[ -d "$stale_transaction" && ! -L "$stale_transaction" ]] || return 1
  TRANSACTION_DIR="$stale_transaction"
  if [[ "$stale_phase" == complete ]]; then
    rm -rf -- "$TRANSACTION_DIR"
    TRANSACTION_DIR=""
    remove_local_lock
    return 0
  fi
  [[ "$stale_phase" == prepared \
    && "$(stat -f '%d:%i' "$stale_backup")" == "$stale_backup_identity" \
    && "$(path_sha256 "$stale_backup/MANIFEST.sha256")" == "$stale_backup_digest" ]] \
    || return 1
  task_flow_backup_is_verified "$stale_backup" 990001 || return 1
  SKILL_PRESENT="$(journal_field skillPresent)" || return 1
  AGENTS_PRESENT="$(journal_field agentsPresent)" || return 1
  MEMORY_PRESENT="$(journal_field memoryPresent)" || return 1
  EXPECTED_SKILL="$TRANSACTION_DIR/expected/aiworker-task-flow"
  EXPECTED_AGENTS="$TRANSACTION_DIR/expected/AGENTS.md"
  EXPECTED_MEMORY="$TRANSACTION_DIR/expected/MEMORY.md"
  EXPECTED_SKILL_MANIFEST="$TRANSACTION_DIR/expected-skill.manifest"
  COMMIT_STARTED=1
  rollback_transaction || return 1
  COMMIT_STARTED=0
  local recovered_skill="$TRANSACTION_DIR/recovered-skill.manifest"
  local recovered_agents="$TRANSACTION_DIR/recovered-agents.manifest"
  local recovered_memory="$TRANSACTION_DIR/recovered-memory.manifest"
  write_tree_manifest "$TARGET_DIR" "$recovered_skill"
  write_file_manifest "$WORKSPACE_AGENTS" "$recovered_agents"
  write_file_manifest "$WORKSPACE_MEMORY" "$recovered_memory"
  [[ "$(target_state_manifest_sha256 recovered "$recovered_skill" "$recovered_agents" "$recovered_memory")" \
    == "$(journal_field before)" ]] || return 1
  rm -rf -- "$TRANSACTION_DIR"
  TRANSACTION_DIR=""
  remove_local_lock
}

rollback_transaction() {
  local rollback_failed=0

  if [[ -f "$TRANSACTION_DIR/originals/MEMORY.md" ]]; then
    if [[ -e "$WORKSPACE_MEMORY" || -L "$WORKSPACE_MEMORY" ]]; then
      if file_matches_expected "$WORKSPACE_MEMORY" "$EXPECTED_MEMORY"; then
        rm -f -- "$WORKSPACE_MEMORY" || rollback_failed=1
      else
        rollback_failed=1
      fi
    fi
    if [[ ! -e "$WORKSPACE_MEMORY" && ! -L "$WORKSPACE_MEMORY" ]]; then
      mv "$TRANSACTION_DIR/originals/MEMORY.md" "$WORKSPACE_MEMORY" || rollback_failed=1
    fi
  elif [[ "$MEMORY_PRESENT" == "0" && ( -e "$WORKSPACE_MEMORY" || -L "$WORKSPACE_MEMORY" ) ]]; then
    if file_matches_expected "$WORKSPACE_MEMORY" "$EXPECTED_MEMORY"; then
      rm -f -- "$WORKSPACE_MEMORY" || rollback_failed=1
    else
      rollback_failed=1
    fi
  fi

  if [[ -f "$TRANSACTION_DIR/originals/AGENTS.md" ]]; then
    if [[ -e "$WORKSPACE_AGENTS" || -L "$WORKSPACE_AGENTS" ]]; then
      if file_matches_expected "$WORKSPACE_AGENTS" "$EXPECTED_AGENTS"; then
        rm -f -- "$WORKSPACE_AGENTS" || rollback_failed=1
      else
        rollback_failed=1
      fi
    fi
    if [[ ! -e "$WORKSPACE_AGENTS" && ! -L "$WORKSPACE_AGENTS" ]]; then
      mv "$TRANSACTION_DIR/originals/AGENTS.md" "$WORKSPACE_AGENTS" || rollback_failed=1
    fi
  elif [[ "$AGENTS_PRESENT" == "0" && ( -e "$WORKSPACE_AGENTS" || -L "$WORKSPACE_AGENTS" ) ]]; then
    if file_matches_expected "$WORKSPACE_AGENTS" "$EXPECTED_AGENTS"; then
      rm -f -- "$WORKSPACE_AGENTS" || rollback_failed=1
    else
      rollback_failed=1
    fi
  fi

  if [[ -d "$TRANSACTION_DIR/originals/aiworker-task-flow" ]]; then
    if [[ -e "$TARGET_DIR" || -L "$TARGET_DIR" ]]; then
      if [[ "$TARGET_DIR" != "$SKILLS_ROOT/aiworker-task-flow" ]] \
        || ! tree_matches_manifest "$TARGET_DIR" "$EXPECTED_SKILL_MANIFEST"; then
        rollback_failed=1
      else
        rm -rf -- "$TARGET_DIR" || rollback_failed=1
      fi
    fi
    if [[ ! -e "$TARGET_DIR" && ! -L "$TARGET_DIR" ]]; then
      mv "$TRANSACTION_DIR/originals/aiworker-task-flow" "$TARGET_DIR" || rollback_failed=1
    fi
  elif [[ "$SKILL_PRESENT" == "0" && ( -e "$TARGET_DIR" || -L "$TARGET_DIR" ) ]]; then
    if [[ "$TARGET_DIR" != "$SKILLS_ROOT/aiworker-task-flow" ]] \
      || ! tree_matches_manifest "$TARGET_DIR" "$EXPECTED_SKILL_MANIFEST"; then
      rollback_failed=1
    else
      rm -rf -- "$TARGET_DIR" || rollback_failed=1
    fi
  fi

  if [[ "$rollback_failed" != "0" ]]; then
    printf 'Task-flow install rollback failed; transaction evidence retained: %s\n' "$TRANSACTION_DIR" >&2
    return 1
  fi
  printf 'Rolled back task-flow skill and workspace control files.\n' >&2
}

cleanup() {
  local exit_code=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM
  set +e

  if [[ -n "$ROLLBACK_SOURCE_CLAIM" ]]; then
    if ! release_rollback_backup_claim; then
      printf 'Rollback backup claim could not be restored; private evidence retained.\n' >&2
      exit_code=1
      PRESERVE_TRANSACTION=1
    fi
  fi

  if [[ "$COMMIT_STARTED" == "1" && "$TRANSACTION_COMPLETE" != "1" ]]; then
    if ! rollback_transaction; then
      exit_code=1
      PRESERVE_TRANSACTION=1
    fi
  fi

  if [[ -n "$TRANSACTION_DIR" && "$PRESERVE_TRANSACTION" != "1" ]]; then
    case "$TRANSACTION_DIR" in
      "$WORKSPACE_ROOT"/.aiworker-task-flow.txn.*|/tmp/aiworker-task-flow.dry-run.*|/private/tmp/aiworker-task-flow.dry-run.*)
        rm -rf -- "$TRANSACTION_DIR" || cleanup_failed=1
        ;;
      *)
        printf 'Refusing to clean unexpected transaction path: %s\n' "$TRANSACTION_DIR" >&2
        cleanup_failed=1
        ;;
    esac
  fi

  if [[ "$SKILLS_ROOT_CREATED" == "1" ]]; then
    rmdir "$SKILLS_ROOT" 2>/dev/null || true
  fi

  if [[ "$LOCK_OWNED" == "1" ]]; then
    remove_local_lock || cleanup_failed=1
    LOCK_OWNED=0
  fi
  if [[ "$DEPLOYMENT_LOCK_OWNED" == "1" ]]; then
    release_shared_deployment_lock || cleanup_failed=1
  fi
  if [[ "$cleanup_failed" != "0" && "$exit_code" == "0" ]]; then
    exit_code=1
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

verify_shared_install_gate() {
  local gate_operation="install" gate_output gate_mode
  [[ "$MODE" != "rollback" ]] || gate_operation="rollback"
  local -a gate_arguments=(
    --mission-control-db-path "$MISSION_CONTROL_DB_PATH"
    --n8n-db-path "$N8N_DB_PATH"
    --video-batch-root "$VIDEO_BATCH_ROOT"
    --expected-source-commit "$EXPECTED_SOURCE_COMMIT"
    --expected-release-id "$EXPECTED_RELEASE_ID"
    --operation "$gate_operation"
    --component "task-flow"
    --target-state-sha256 "$RESERVATION_TARGET_STATE_SHA256"
  )
  if [[ "$MUTATION_AUTHORIZATION" == production ]]; then
    gate_arguments+=(--deployment-run-dir "$DEPLOYMENT_RUN_DIR")
  fi
  if [[ -n "$LEGACY_PREINSTALL_ATTEMPT_DIR" ]]; then
    gate_arguments+=(--legacy-preinstall-attempt-dir "$LEGACY_PREINSTALL_ATTEMPT_DIR")
    gate_arguments+=(--raw-result-output "$RESULT_OUTPUT")
  fi
  gate_output="$("$NODE_BIN" "$SHARED_INSTALL_GATE" "${gate_arguments[@]}")" || {
    printf 'Shared task-flow replacement requires paused intake, zero active tasks, and zero pending director outbox rows.\n' >&2
    return 1
  }
  if [[ "$MUTATION_AUTHORIZATION" == production ]]; then
    gate_mode="$(printf '%s' "$gate_output" | "$NODE_BIN" -e '
      const fs = require("node:fs")
      const value = JSON.parse(fs.readFileSync(0, "utf8"))
      if (value?.mode === "legacy-preinstall" && value?.reservation?.path) {
        process.stdout.write("legacy-preinstall")
      } else if (value?.mode === "rolling") {
        process.stdout.write("rolling")
      } else process.exit(1)
    ')" || {
      printf 'Task-flow mutations require a recognized shared install gate authorization.\n' >&2
      return 1
    }
    SHARED_GATE_MODE="$gate_mode"
    if [[ "$gate_mode" == legacy-preinstall ]]; then
      [[ -n "$LEGACY_PREINSTALL_ATTEMPT_DIR" ]] || {
        printf 'Task-flow legacy mutations require a reserved preinstall attempt.\n' >&2
        return 1
      }
    else
      [[ -z "$LEGACY_PREINSTALL_ATTEMPT_DIR" ]] || {
        printf 'Task-flow rolling mutations cannot carry a legacy preinstall attempt.\n' >&2
        return 1
      }
    fi
  fi
}

authorize_mutating_invocation() {
  [[ "$MODE" == "dry-run" ]] && return 0
  if [[ -z "$ISOLATED_TEST_ROOT" || "${NODE_ENV:-}" != test ]]; then
    MUTATION_AUTHORIZATION=production
    return 0
  fi
  "$NODE_BIN" - "$ISOLATED_TEST_ROOT" "$WORKSPACE_ROOT" "$BACKUP_ROOT" \
    "$DEPLOYMENT_RUN_DIR" "$MISSION_CONTROL_DB_PATH" "$N8N_DB_PATH" \
    "$VIDEO_BATCH_ROOT" "$RESULT_OUTPUT" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const [rootInput, ...candidates] = process.argv.slice(2)
const root = path.resolve(rootInput)
const temporaryRoot = fs.realpathSync.native(os.tmpdir())
const value = fs.lstatSync(root)
if (rootInput !== root || fs.realpathSync.native(root) !== root || value.isSymbolicLink()
  || !value.isDirectory() || value.uid !== process.getuid() || (value.mode & 0o077) !== 0
  || (root !== temporaryRoot && !root.startsWith(`${temporaryRoot}${path.sep}`))) {
  throw new Error('isolated_test_root_unsafe')
}
for (const input of candidates.filter(Boolean)) {
  let candidate = path.resolve(input)
  if (input !== candidate) throw new Error('isolated_test_path_not_normalized')
  for (const alias of ['/var', '/tmp']) {
    if (process.platform !== 'darwin'
      || (candidate !== alias && !candidate.startsWith(`${alias}${path.sep}`))) continue
    candidate = `${fs.realpathSync.native(alias)}${candidate.slice(alias.length)}`
  }
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('isolated_test_path_outside_root')
  }
  let cursor = candidate
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new Error('isolated_test_path_unresolvable')
    cursor = parent
  }
  while (cursor !== root) {
    const entry = fs.lstatSync(cursor)
    if (entry.isSymbolicLink()) throw new Error('isolated_test_path_symlink')
    cursor = path.dirname(cursor)
  }
}
NODE
  MUTATION_AUTHORIZATION=isolated-test
}

if [[ "$MODE" == "rollback" && "$ROLLBACK_NOOP" == 0 ]]; then
  if [[ ! -d "$BACKUP_ROOT" || -L "$BACKUP_ROOT" ]]; then
    printf 'Rollback backup root is invalid.\n' >&2
    exit 1
  fi
  BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd -P)"
  if [[ ! -d "$ROLLBACK_BACKUP" || -L "$ROLLBACK_BACKUP" ]]; then
    printf 'Rollback backup is invalid.\n' >&2
    exit 1
  fi
  ROLLBACK_BACKUP="$(cd "$ROLLBACK_BACKUP" && pwd -P)"
  if [[ "${ROLLBACK_BACKUP%/*}" != "$BACKUP_ROOT" ]]; then
    printf 'Rollback backup must be one direct member of the configured backup family.\n' >&2
    exit 1
  fi
fi

if [[ "$MODE" != "dry-run" ]]; then
  authorize_mutating_invocation
  RESERVATION_TARGET_STATE_SHA256="$(reservation_target_state_sha256)" || {
    printf 'Could not capture the pre-reservation task-flow target state.\n' >&2
    exit 1
  }
  # The shared gate owns the centralized component reservation. It must run
  # before local locks, transaction directories, backup-family members, result
  # files, or managed roots are created.
  verify_shared_install_gate
  acquire_shared_deployment_lock
  [[ "$(reservation_target_state_sha256)" == "$RESERVATION_TARGET_STATE_SHA256" ]] || {
    printf 'Task-flow target changed between reservation and the locked mutation.\n' >&2
    exit 1
  }
  if [[ "$SHARED_GATE_MODE" == rolling ]]; then
    verify_shared_install_gate
  fi
  if [[ "$MUTATION_AUTHORIZATION" == production && "$MODE" != rollback ]]; then
    assert_canonical_clean_source_repository || {
      printf 'Task-flow production payload must come from the canonical clean HEAD worktree.\n' >&2
      exit 1
    }
  fi
  if [[ -e "$LOCK_DIR" || -L "$LOCK_DIR" ]]; then
    recover_stale_local_lock || exit 1
    # Recovery restores the last fenced transaction before this invocation can
    # create a new local claim. Bind the new attempt to that restored state and
    # have the shared gate re-authorize it instead of comparing against the
    # interrupted, partial target captured on entry.
    RESERVATION_TARGET_STATE_SHA256="$(reservation_target_state_sha256)" || {
      printf 'Could not capture the recovered task-flow target state.\n' >&2
      exit 1
    }
    verify_shared_install_gate
  fi
  create_local_lock_claim || {
    printf 'Another task-flow installation already holds the workspace lock: %s\n' "$LOCK_DIR" >&2
    exit 1
  }
  LOCK_OWNED=1
  [[ "$(reservation_target_state_sha256)" == "$RESERVATION_TARGET_STATE_SHA256" ]] || {
    printf 'Task-flow target changed before the locally locked mutation.\n' >&2
    exit 1
  }
  TRANSACTION_DIR="$(mktemp -d "$WORKSPACE_ROOT/.aiworker-task-flow.txn.XXXXXX")"
else
  TRANSACTION_DIR="$(mktemp -d /tmp/aiworker-task-flow.dry-run.XXXXXX)"
  TRANSACTION_DIR="$(cd "$TRANSACTION_DIR" && pwd -P)"
fi
chmod 700 "$TRANSACTION_DIR"
install -d -m 700 \
  "$TRANSACTION_DIR/expected/aiworker-task-flow/scripts" \
  "$TRANSACTION_DIR/expected/aiworker-task-flow/lib" \
  "$TRANSACTION_DIR/commit" \
  "$TRANSACTION_DIR/originals"

EXPECTED_SKILL="$TRANSACTION_DIR/expected/aiworker-task-flow"
EXPECTED_AGENTS="$TRANSACTION_DIR/expected/AGENTS.md"
EXPECTED_MEMORY="$TRANSACTION_DIR/expected/MEMORY.md"
EMPTY_INPUT="$TRANSACTION_DIR/empty.md"
: > "$EMPTY_INPUT"
chmod 600 "$EMPTY_INPUT"

if [[ "$MODE" == rollback && "$ROLLBACK_NOOP" == 1 ]]; then
  current_skill_manifest="$TRANSACTION_DIR/noop-current-skill.manifest"
  current_agents_manifest="$TRANSACTION_DIR/noop-current-agents.manifest"
  current_memory_manifest="$TRANSACTION_DIR/noop-current-memory.manifest"
  write_tree_manifest "$TARGET_DIR" "$current_skill_manifest"
  write_file_manifest "$WORKSPACE_AGENTS" "$current_agents_manifest"
  write_file_manifest "$WORKSPACE_MEMORY" "$current_memory_manifest"
  noop_digest="$(target_state_manifest_sha256 rollback-noop \
    "$current_skill_manifest" "$current_agents_manifest" "$current_memory_manifest")"
  write_install_result rollback restored "$noop_digest" "$noop_digest" "" ""
  TRANSACTION_COMPLETE=1
  printf 'Task-flow no-op compensation recorded without changing managed state.\n'
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  if ! task_flow_backup_is_verified "$ROLLBACK_BACKUP" 900000 \
    || ! task_flow_backup_matches_workspace "$ROLLBACK_BACKUP"; then
    printf 'Rollback backup failed family, manifest, STATE, or workspace identity validation.\n' >&2
    exit 1
  fi
  claim_rollback_backup "$ROLLBACK_BACKUP" || {
    printf 'Rollback backup changed before its private source claim.\n' >&2
    exit 1
  }

  ROLLBACK_SKILL_PRESENT=0
  ROLLBACK_AGENTS_PRESENT=0
  ROLLBACK_MEMORY_PRESENT=0
  if grep -Fqx 'skill_present=1' "$ROLLBACK_BACKUP/STATE"; then ROLLBACK_SKILL_PRESENT=1; fi
  if grep -Fqx 'agents_present=1' "$ROLLBACK_BACKUP/STATE"; then ROLLBACK_AGENTS_PRESENT=1; fi
  if grep -Fqx 'memory_present=1' "$ROLLBACK_BACKUP/STATE"; then ROLLBACK_MEMORY_PRESENT=1; fi

  rm -rf -- "$EXPECTED_SKILL"
  if [[ "$ROLLBACK_SKILL_PRESENT" == "1" ]]; then
    cp -pR "$ROLLBACK_BACKUP/aiworker-task-flow" "$EXPECTED_SKILL"
  fi
  if [[ "$ROLLBACK_AGENTS_PRESENT" == "1" ]]; then
    cp -p "$ROLLBACK_BACKUP/AGENTS.md" "$EXPECTED_AGENTS"
  fi
  if [[ "$ROLLBACK_MEMORY_PRESENT" == "1" ]]; then
    cp -p "$ROLLBACK_BACKUP/MEMORY.md" "$EXPECTED_MEMORY"
  fi

  EXPECTED_SKILL_MANIFEST="$TRANSACTION_DIR/expected-skill.manifest"
  CURRENT_SKILL_MANIFEST="$TRANSACTION_DIR/current-skill.manifest"
  EXPECTED_AGENTS_MANIFEST="$TRANSACTION_DIR/expected-agents.manifest"
  CURRENT_AGENTS_MANIFEST="$TRANSACTION_DIR/current-agents.manifest"
  EXPECTED_MEMORY_MANIFEST="$TRANSACTION_DIR/expected-memory.manifest"
  CURRENT_MEMORY_MANIFEST="$TRANSACTION_DIR/current-memory.manifest"
  BACKUP_DESIRED_SKILL_MANIFEST="$TRANSACTION_DIR/backup-desired-skill.manifest"
  BACKUP_DESIRED_AGENTS_MANIFEST="$TRANSACTION_DIR/backup-desired-agents.manifest"
  BACKUP_DESIRED_MEMORY_MANIFEST="$TRANSACTION_DIR/backup-desired-memory.manifest"
  ROLLBACK_APPLIED_SKILL_MANIFEST="$TRANSACTION_DIR/rollback-applied-skill.manifest"
  ROLLBACK_APPLIED_AGENTS_MANIFEST="$TRANSACTION_DIR/rollback-applied-agents.manifest"
  ROLLBACK_APPLIED_MEMORY_MANIFEST="$TRANSACTION_DIR/rollback-applied-memory.manifest"
  write_tree_manifest "$EXPECTED_SKILL" "$EXPECTED_SKILL_MANIFEST"
  write_file_manifest "$EXPECTED_AGENTS" "$EXPECTED_AGENTS_MANIFEST"
  write_file_manifest "$EXPECTED_MEMORY" "$EXPECTED_MEMORY_MANIFEST"
  write_tree_manifest "$ROLLBACK_BACKUP/aiworker-task-flow" "$BACKUP_DESIRED_SKILL_MANIFEST"
  write_file_manifest "$ROLLBACK_BACKUP/AGENTS.md" "$BACKUP_DESIRED_AGENTS_MANIFEST"
  write_file_manifest "$ROLLBACK_BACKUP/MEMORY.md" "$BACKUP_DESIRED_MEMORY_MANIFEST"
  cp -p "$ROLLBACK_BACKUP/APPLIED.skill.manifest" "$ROLLBACK_APPLIED_SKILL_MANIFEST"
  cp -p "$ROLLBACK_BACKUP/APPLIED.AGENTS.manifest" "$ROLLBACK_APPLIED_AGENTS_MANIFEST"
  cp -p "$ROLLBACK_BACKUP/APPLIED.MEMORY.manifest" "$ROLLBACK_APPLIED_MEMORY_MANIFEST"
  if ! task_flow_backup_is_verified "$ROLLBACK_BACKUP" 900002 "$ROLLBACK_SOURCE_CLAIM_ROOT" \
    || ! task_flow_backup_matches_workspace "$ROLLBACK_BACKUP" \
    || ! cmp -s "$EXPECTED_SKILL_MANIFEST" "$BACKUP_DESIRED_SKILL_MANIFEST" \
    || ! cmp -s "$EXPECTED_AGENTS_MANIFEST" "$BACKUP_DESIRED_AGENTS_MANIFEST" \
    || ! cmp -s "$EXPECTED_MEMORY_MANIFEST" "$BACKUP_DESIRED_MEMORY_MANIFEST" \
    || ! cmp -s "$ROLLBACK_BACKUP/APPLIED.skill.manifest" "$ROLLBACK_APPLIED_SKILL_MANIFEST" \
    || ! cmp -s "$ROLLBACK_BACKUP/APPLIED.AGENTS.manifest" "$ROLLBACK_APPLIED_AGENTS_MANIFEST" \
    || ! cmp -s "$ROLLBACK_BACKUP/APPLIED.MEMORY.manifest" "$ROLLBACK_APPLIED_MEMORY_MANIFEST"; then
    printf 'Rollback backup or copied desired state changed during the bound copy.\n' >&2
    exit 1
  fi
  release_rollback_backup_claim || {
    printf 'Rollback backup source claim could not be restored.\n' >&2
    exit 1
  }

  write_tree_manifest "$TARGET_DIR" "$CURRENT_SKILL_MANIFEST"
  write_file_manifest "$WORKSPACE_AGENTS" "$CURRENT_AGENTS_MANIFEST"
  write_file_manifest "$WORKSPACE_MEMORY" "$CURRENT_MEMORY_MANIFEST"
  BEFORE_MANIFEST_SHA256="$(target_state_manifest_sha256 before \
    "$CURRENT_SKILL_MANIFEST" "$CURRENT_AGENTS_MANIFEST" "$CURRENT_MEMORY_MANIFEST")"
  ROLLBACK_ALREADY_RESTORED=0
  if cmp -s "$CURRENT_SKILL_MANIFEST" "$EXPECTED_SKILL_MANIFEST" \
    && cmp -s "$CURRENT_AGENTS_MANIFEST" "$EXPECTED_AGENTS_MANIFEST" \
    && cmp -s "$CURRENT_MEMORY_MANIFEST" "$EXPECTED_MEMORY_MANIFEST"; then
    ROLLBACK_ALREADY_RESTORED=1
  elif cmp -s "$CURRENT_SKILL_MANIFEST" "$ROLLBACK_APPLIED_SKILL_MANIFEST" \
    && cmp -s "$CURRENT_AGENTS_MANIFEST" "$ROLLBACK_APPLIED_AGENTS_MANIFEST" \
    && cmp -s "$CURRENT_MEMORY_MANIFEST" "$ROLLBACK_APPLIED_MEMORY_MANIFEST"; then
    :
  else
    printf 'Rollback refused because the managed task-flow state drifted from both backup endpoints.\n' >&2
    exit 1
  fi

  if [[ "$ROLLBACK_ALREADY_RESTORED" == "1" ]]; then
    task_flow_backup_is_verified "$ROLLBACK_BACKUP" 900003 || {
      printf 'Rollback backup changed before result finalization.\n' >&2
      exit 1
    }
    ROLLBACK_BACKUP_MANIFEST_SHA256="$(path_sha256 "$ROLLBACK_BACKUP/MANIFEST.sha256")"
    write_install_result rollback restored "$BEFORE_MANIFEST_SHA256" \
      "$BEFORE_MANIFEST_SHA256" "$ROLLBACK_BACKUP" "$ROLLBACK_BACKUP_MANIFEST_SHA256"
    if [[ "$ROLLBACK_SKILL_PRESENT" == "0" ]]; then rmdir "$SKILLS_ROOT" 2>/dev/null || true; fi
    TRANSACTION_COMPLETE=1
    printf 'TASK_FLOW_INSTALL_RESULT mode=rollback status=already-restored backup=%s\n' "$ROLLBACK_BACKUP"
    exit 0
  fi

  SKILL_PRESENT=0
  AGENTS_PRESENT=0
  MEMORY_PRESENT=0
  if [[ -d "$TARGET_DIR" ]]; then SKILL_PRESENT=1; fi
  if [[ -f "$WORKSPACE_AGENTS" ]]; then AGENTS_PRESENT=1; fi
  if [[ -f "$WORKSPACE_MEMORY" ]]; then MEMORY_PRESENT=1; fi
  if [[ "$ROLLBACK_SKILL_PRESENT" == "1" ]]; then
    cp -pR "$EXPECTED_SKILL" "$TRANSACTION_DIR/commit/aiworker-task-flow"
  fi
  if [[ "$ROLLBACK_AGENTS_PRESENT" == "1" ]]; then
    cp -p "$EXPECTED_AGENTS" "$TRANSACTION_DIR/commit/AGENTS.md"
  fi
  if [[ "$ROLLBACK_MEMORY_PRESENT" == "1" ]]; then
    cp -p "$EXPECTED_MEMORY" "$TRANSACTION_DIR/commit/MEMORY.md"
  fi

  ROLLBACK_BACKUP_MANIFEST_SHA256="$(path_sha256 "$ROLLBACK_BACKUP/MANIFEST.sha256")"
  write_transaction_journal rollback "$ROLLBACK_BACKUP" "$ROLLBACK_BACKUP_MANIFEST_SHA256"
  COMMIT_STARTED=1
  if [[ "$SKILL_PRESENT" == "1" ]]; then mv "$TARGET_DIR" "$TRANSACTION_DIR/originals/aiworker-task-flow"; fi
  wait_for_sigkill_test
  maybe_fail after-skill-original
  if [[ "$ROLLBACK_SKILL_PRESENT" == "1" ]]; then mv "$TRANSACTION_DIR/commit/aiworker-task-flow" "$TARGET_DIR"; fi
  maybe_fail after-skill
  if [[ "$AGENTS_PRESENT" == "1" ]]; then mv "$WORKSPACE_AGENTS" "$TRANSACTION_DIR/originals/AGENTS.md"; fi
  maybe_fail after-agents-original
  if [[ "$ROLLBACK_AGENTS_PRESENT" == "1" ]]; then mv "$TRANSACTION_DIR/commit/AGENTS.md" "$WORKSPACE_AGENTS"; fi
  maybe_fail after-agents
  if [[ "$MEMORY_PRESENT" == "1" ]]; then mv "$WORKSPACE_MEMORY" "$TRANSACTION_DIR/originals/MEMORY.md"; fi
  maybe_fail after-memory-original
  if [[ "$ROLLBACK_MEMORY_PRESENT" == "1" ]]; then mv "$TRANSACTION_DIR/commit/MEMORY.md" "$WORKSPACE_MEMORY"; fi
  maybe_fail after-memory

  POST_SKILL_MANIFEST="$TRANSACTION_DIR/post-skill.manifest"
  POST_AGENTS_MANIFEST="$TRANSACTION_DIR/post-agents.manifest"
  POST_MEMORY_MANIFEST="$TRANSACTION_DIR/post-memory.manifest"
  write_tree_manifest "$TARGET_DIR" "$POST_SKILL_MANIFEST"
  write_file_manifest "$WORKSPACE_AGENTS" "$POST_AGENTS_MANIFEST"
  write_file_manifest "$WORKSPACE_MEMORY" "$POST_MEMORY_MANIFEST"
  if ! cmp -s "$POST_SKILL_MANIFEST" "$EXPECTED_SKILL_MANIFEST" \
    || ! cmp -s "$POST_AGENTS_MANIFEST" "$EXPECTED_AGENTS_MANIFEST" \
    || ! cmp -s "$POST_MEMORY_MANIFEST" "$EXPECTED_MEMORY_MANIFEST"; then
    printf 'Task-flow rollback verification failed.\n' >&2
    exit 1
  fi
  AFTER_MANIFEST_SHA256="$(target_state_manifest_sha256 after \
    "$POST_SKILL_MANIFEST" "$POST_AGENTS_MANIFEST" "$POST_MEMORY_MANIFEST")"
  task_flow_backup_is_verified "$ROLLBACK_BACKUP" 900004 || {
    printf 'Rollback backup changed before result finalization.\n' >&2
    exit 1
  }
  ROLLBACK_BACKUP_MANIFEST_SHA256="$(path_sha256 "$ROLLBACK_BACKUP/MANIFEST.sha256")"
  write_install_result rollback restored "$BEFORE_MANIFEST_SHA256" \
    "$AFTER_MANIFEST_SHA256" "$ROLLBACK_BACKUP" "$ROLLBACK_BACKUP_MANIFEST_SHA256"
  mark_transaction_journal_complete "$AFTER_MANIFEST_SHA256"
  if [[ "$ROLLBACK_SKILL_PRESENT" == "0" ]]; then rmdir "$SKILLS_ROOT" 2>/dev/null || true; fi
  TRANSACTION_COMPLETE=1
  printf 'TASK_FLOW_INSTALL_RESULT mode=rollback status=restored backup=%s\n' "$ROLLBACK_BACKUP"
  printf 'Restored task-flow skill and workspace control files from the verified backup.\n'
  exit 0
fi

install -m 600 "$SOURCE_DIR/SKILL.md" "$EXPECTED_SKILL/SKILL.md"
for skill_script in "$SOURCE_DIR"/scripts/*.mjs; do
  install -m 700 "$skill_script" "$EXPECTED_SKILL/scripts/$(basename "$skill_script")"
done
for skill_module in "$SOURCE_DIR"/lib/*.mjs; do
  install -m 600 "$skill_module" "$EXPECTED_SKILL/lib/$(basename "$skill_module")"
done

AGENTS_INPUT="$EMPTY_INPUT"
if [[ -f "$WORKSPACE_AGENTS" ]]; then AGENTS_INPUT="$WORKSPACE_AGENTS"; fi
"$NODE_BIN" "$RENDERER" \
  --input "$AGENTS_INPUT" \
  --template "$SOURCE_DIR/WORKSPACE_VIDEO_RULES.md" \
  --section-id video-rules \
  --legacy-heading '## Video Learning Pipeline Rule' \
  --legacy-heading '## Video Analysis Task Flow Rule' \
  > "$EXPECTED_AGENTS"
chmod 600 "$EXPECTED_AGENTS"

MEMORY_INPUT="$EMPTY_INPUT"
if [[ -f "$WORKSPACE_MEMORY" ]]; then MEMORY_INPUT="$WORKSPACE_MEMORY"; fi
"$NODE_BIN" "$RENDERER" \
  --input "$MEMORY_INPUT" \
  --template "$SOURCE_DIR/WORKSPACE_VIDEO_MEMORY.md" \
  --section-id video-memory \
  --legacy-heading '## Current AI-worker Video Analysis Memory' \
  > "$EXPECTED_MEMORY"
chmod 600 "$EXPECTED_MEMORY"

EXPECTED_SKILL_MANIFEST="$TRANSACTION_DIR/expected-skill.manifest"
CURRENT_SKILL_MANIFEST="$TRANSACTION_DIR/current-skill.manifest"
EXPECTED_AGENTS_MANIFEST="$TRANSACTION_DIR/expected-agents.manifest"
CURRENT_AGENTS_MANIFEST="$TRANSACTION_DIR/current-agents.manifest"
EXPECTED_MEMORY_MANIFEST="$TRANSACTION_DIR/expected-memory.manifest"
CURRENT_MEMORY_MANIFEST="$TRANSACTION_DIR/current-memory.manifest"
write_tree_manifest "$EXPECTED_SKILL" "$EXPECTED_SKILL_MANIFEST"
write_tree_manifest "$TARGET_DIR" "$CURRENT_SKILL_MANIFEST"
write_file_manifest "$EXPECTED_AGENTS" "$EXPECTED_AGENTS_MANIFEST"
write_file_manifest "$WORKSPACE_AGENTS" "$CURRENT_AGENTS_MANIFEST"
write_file_manifest "$EXPECTED_MEMORY" "$EXPECTED_MEMORY_MANIFEST"
write_file_manifest "$WORKSPACE_MEMORY" "$CURRENT_MEMORY_MANIFEST"
BEFORE_MANIFEST_SHA256="$(target_state_manifest_sha256 before \
  "$CURRENT_SKILL_MANIFEST" "$CURRENT_AGENTS_MANIFEST" "$CURRENT_MEMORY_MANIFEST")"

SKILL_MATCHES=0
AGENTS_MATCHES=0
MEMORY_MATCHES=0
if cmp -s "$CURRENT_SKILL_MANIFEST" "$EXPECTED_SKILL_MANIFEST"; then
  SKILL_MATCHES=1
fi
if cmp -s "$CURRENT_AGENTS_MANIFEST" "$EXPECTED_AGENTS_MANIFEST"; then
  AGENTS_MATCHES=1
fi
if cmp -s "$CURRENT_MEMORY_MANIFEST" "$EXPECTED_MEMORY_MANIFEST"; then
  MEMORY_MATCHES=1
fi

if [[ "$MODE" == "dry-run" ]]; then
  TRANSACTION_COMPLETE=1
  printf 'AI-worker task-flow installation dry-run passed: target=%s skill_matches=%s agents_matches=%s memory_matches=%s\n' \
    "$TARGET_DIR" "$SKILL_MATCHES" "$AGENTS_MATCHES" "$MEMORY_MATCHES"
  printf 'No skill, workspace control file, backup, queue state, n8n, or Gateway was changed.\n'
  exit 0
fi

if [[ "$SKILL_MATCHES" == "1" && "$AGENTS_MATCHES" == "1" && "$MEMORY_MATCHES" == "1" ]]; then
  write_install_result apply noop "$BEFORE_MANIFEST_SHA256" "$BEFORE_MANIFEST_SHA256" "" ""
  TRANSACTION_COMPLETE=1
  printf 'AI-worker task-flow skill and workspace sections are already current: %s\n' "$TARGET_DIR"
  exit 0
fi

VERIFIED_BACKUP_COUNT="$(count_verified_task_flow_backups)"
if [[ "$VERIFIED_BACKUP_COUNT" -gt 2 ]]; then
  printf 'More than two verified task-flow backups already exist; refusing to expand the inconsistent set.\n' >&2
  exit 1
fi

if [[ ! -e "$SKILLS_ROOT" ]]; then
  install -d -m 700 "$SKILLS_ROOT"
  SKILLS_ROOT_CREATED=1
fi

secure_prepare_task_flow_backup_root || {
  printf 'Task-flow backup root changed or could not be created privately.\n' >&2
  exit 1
}
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S).XXXXXX")"
chmod 700 "$BACKUP_DIR"

SKILL_PRESENT=0
AGENTS_PRESENT=0
MEMORY_PRESENT=0
if [[ -d "$TARGET_DIR" ]]; then
  SKILL_PRESENT=1
  cp -pR "$TARGET_DIR" "$BACKUP_DIR/aiworker-task-flow"
else
  : > "$BACKUP_DIR/aiworker-task-flow.absent"
fi
if [[ -f "$WORKSPACE_AGENTS" ]]; then
  AGENTS_PRESENT=1
  cp -p "$WORKSPACE_AGENTS" "$BACKUP_DIR/AGENTS.md"
else
  : > "$BACKUP_DIR/AGENTS.md.absent"
fi
if [[ -f "$WORKSPACE_MEMORY" ]]; then
  MEMORY_PRESENT=1
  cp -p "$WORKSPACE_MEMORY" "$BACKUP_DIR/MEMORY.md"
else
  : > "$BACKUP_DIR/MEMORY.md.absent"
fi

BACKUP_SKILL_MANIFEST="$TRANSACTION_DIR/backup-skill.manifest"
BACKUP_AGENTS_MANIFEST="$TRANSACTION_DIR/backup-agents.manifest"
BACKUP_MEMORY_MANIFEST="$TRANSACTION_DIR/backup-memory.manifest"
write_tree_manifest "$BACKUP_DIR/aiworker-task-flow" "$BACKUP_SKILL_MANIFEST"
write_file_manifest "$BACKUP_DIR/AGENTS.md" "$BACKUP_AGENTS_MANIFEST"
write_file_manifest "$BACKUP_DIR/MEMORY.md" "$BACKUP_MEMORY_MANIFEST"
if ! cmp -s "$BACKUP_SKILL_MANIFEST" "$CURRENT_SKILL_MANIFEST" \
  || ! cmp -s "$BACKUP_AGENTS_MANIFEST" "$CURRENT_AGENTS_MANIFEST" \
  || ! cmp -s "$BACKUP_MEMORY_MANIFEST" "$CURRENT_MEMORY_MANIFEST"; then
  printf 'Task-flow backup does not match the pre-install state.\n' >&2
  exit 1
fi

cp -p "$EXPECTED_SKILL_MANIFEST" "$BACKUP_DIR/APPLIED.skill.manifest"
cp -p "$EXPECTED_AGENTS_MANIFEST" "$BACKUP_DIR/APPLIED.AGENTS.manifest"
cp -p "$EXPECTED_MEMORY_MANIFEST" "$BACKUP_DIR/APPLIED.MEMORY.manifest"
printf 'version=2\nworkspace_sha256=%s\nsource_commit=%s\nrelease_id=%s\nskill_present=%s\nagents_present=%s\nmemory_present=%s\n' \
  "$WORKSPACE_IDENTITY" "$EXPECTED_SOURCE_COMMIT" "$EXPECTED_RELEASE_ID" \
  "$SKILL_PRESENT" "$AGENTS_PRESENT" "$MEMORY_PRESENT" > "$BACKUP_DIR/STATE"
chmod 600 "$BACKUP_DIR/STATE"
for absent_marker in "$BACKUP_DIR"/*.absent; do
  if [[ -f "$absent_marker" ]]; then chmod 600 "$absent_marker"; fi
done

BACKUP_MANIFEST_SOURCE="$TRANSACTION_DIR/backup-manifest.source"
BACKUP_MANIFEST_VERIFY="$TRANSACTION_DIR/backup-manifest.verify"
write_tree_manifest "$BACKUP_DIR" "$BACKUP_MANIFEST_SOURCE" './MANIFEST.sha256'
install -m 600 "$BACKUP_MANIFEST_SOURCE" "$BACKUP_DIR/MANIFEST.sha256"
write_tree_manifest "$BACKUP_DIR" "$BACKUP_MANIFEST_VERIFY" './MANIFEST.sha256'
if ! cmp -s "$BACKUP_MANIFEST_SOURCE" "$BACKUP_MANIFEST_VERIFY"; then
  printf 'Task-flow backup manifest self-verification failed.\n' >&2
  exit 1
fi

cp -pR "$EXPECTED_SKILL" "$TRANSACTION_DIR/commit/aiworker-task-flow"
cp -p "$EXPECTED_AGENTS" "$TRANSACTION_DIR/commit/AGENTS.md"
cp -p "$EXPECTED_MEMORY" "$TRANSACTION_DIR/commit/MEMORY.md"

BACKUP_MANIFEST_SHA256="$(path_sha256 "$BACKUP_DIR/MANIFEST.sha256")"
write_transaction_journal apply "$BACKUP_DIR" "$BACKUP_MANIFEST_SHA256"
COMMIT_STARTED=1
if [[ "$SKILL_PRESENT" == "1" ]]; then
  mv "$TARGET_DIR" "$TRANSACTION_DIR/originals/aiworker-task-flow"
fi
wait_for_sigkill_test
maybe_fail after-skill-original
mv "$TRANSACTION_DIR/commit/aiworker-task-flow" "$TARGET_DIR"
maybe_fail after-skill

if [[ "$AGENTS_PRESENT" == "1" ]]; then
  mv "$WORKSPACE_AGENTS" "$TRANSACTION_DIR/originals/AGENTS.md"
fi
maybe_fail after-agents-original
mv "$TRANSACTION_DIR/commit/AGENTS.md" "$WORKSPACE_AGENTS"
maybe_fail after-agents

if [[ "$MEMORY_PRESENT" == "1" ]]; then
  mv "$WORKSPACE_MEMORY" "$TRANSACTION_DIR/originals/MEMORY.md"
fi
maybe_fail after-memory-original
mv "$TRANSACTION_DIR/commit/MEMORY.md" "$WORKSPACE_MEMORY"
maybe_fail after-memory

POST_SKILL_MANIFEST="$TRANSACTION_DIR/post-skill.manifest"
POST_AGENTS_MANIFEST="$TRANSACTION_DIR/post-agents.manifest"
POST_MEMORY_MANIFEST="$TRANSACTION_DIR/post-memory.manifest"
write_tree_manifest "$TARGET_DIR" "$POST_SKILL_MANIFEST"
write_file_manifest "$WORKSPACE_AGENTS" "$POST_AGENTS_MANIFEST"
write_file_manifest "$WORKSPACE_MEMORY" "$POST_MEMORY_MANIFEST"
if ! cmp -s "$POST_SKILL_MANIFEST" "$EXPECTED_SKILL_MANIFEST" \
  || ! cmp -s "$POST_AGENTS_MANIFEST" "$EXPECTED_AGENTS_MANIFEST" \
  || ! cmp -s "$POST_MEMORY_MANIFEST" "$EXPECTED_MEMORY_MANIFEST"; then
  printf 'Task-flow installation verification failed.\n' >&2
  exit 1
fi
if [[ "$(grep -Fxc '<!-- aiworker-task-flow:video-rules:start -->' "$WORKSPACE_AGENTS")" != "1" \
  || "$(grep -Fxc '<!-- aiworker-task-flow:video-rules:end -->' "$WORKSPACE_AGENTS")" != "1" \
  || "$(grep -Fxc '<!-- aiworker-task-flow:video-memory:start -->' "$WORKSPACE_MEMORY")" != "1" \
  || "$(grep -Fxc '<!-- aiworker-task-flow:video-memory:end -->' "$WORKSPACE_MEMORY")" != "1" ]]; then
  printf 'Task-flow managed-section verification failed.\n' >&2
  exit 1
fi

prune_verified_task_flow_backups

AFTER_MANIFEST_SHA256="$(target_state_manifest_sha256 after \
  "$POST_SKILL_MANIFEST" "$POST_AGENTS_MANIFEST" "$POST_MEMORY_MANIFEST")"
task_flow_backup_is_verified "$BACKUP_DIR" 100001 || {
  printf 'Verified task-flow backup changed before result finalization.\n' >&2
  exit 1
}
write_install_result apply applied "$BEFORE_MANIFEST_SHA256" "$AFTER_MANIFEST_SHA256" \
  "$BACKUP_DIR" "$BACKUP_MANIFEST_SHA256"
mark_transaction_journal_complete "$AFTER_MANIFEST_SHA256"
TRANSACTION_COMPLETE=1
printf 'TASK_FLOW_INSTALL_RESULT mode=apply status=installed backup=%s\n' "$BACKUP_DIR"
printf 'Backed up task-flow installation state: %s\n' "$BACKUP_DIR"
printf 'Installed AI-worker task-flow skill and workspace sections: %s\n' "$TARGET_DIR"
