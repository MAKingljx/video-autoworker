#!/usr/bin/env bash
set -euo pipefail
umask 077

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPOSITORY_ROOT/openclaw-skills/aiworker-task-flow"
RENDERER="$REPOSITORY_ROOT/scripts/lib/render-managed-markdown-section.mjs"
WORKSPACE_ROOT="${AIWORKER_QWEN_WORKSPACE:-$HOME/AI-worker-second-original-workspace}"
BACKUP_ROOT="${AIWORKER_SKILL_BACKUP_ROOT:-$HOME/ai-worker/backups/aiworker-task-flow-skill}"
MODE=""

usage() {
  printf 'Usage: %s (--dry-run|--apply)\n' "$0"
}

if [[ "$#" -ne 1 ]]; then
  usage >&2
  exit 2
fi
case "$1" in
  --dry-run) MODE="dry-run" ;;
  --apply) MODE="apply" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

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

required_skill_files=(
  "$SOURCE_DIR/SKILL.md"
  "$SOURCE_DIR/WORKSPACE_VIDEO_RULES.md"
  "$SOURCE_DIR/WORKSPACE_VIDEO_MEMORY.md"
  "$SOURCE_DIR/scripts/submit-task.mjs"
  "$SOURCE_DIR/scripts/run-video-batch.mjs"
  "$SOURCE_DIR/lib/platform-client.mjs"
  "$SOURCE_DIR/lib/media-ingest.mjs"
  "$SOURCE_DIR/lib/video-task.mjs"
  "$SOURCE_DIR/lib/video-batch-state.mjs"
  "$RENDERER"
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
if [[ -n "$TEST_FAILPOINT" && "${AIWORKER_TASK_FLOW_INSTALL_TESTING:-0}" != "1" ]]; then
  printf 'Installer failure injection is available only in an explicit test environment.\n' >&2
  exit 1
fi
case "$TEST_FAILPOINT" in
  ""|after-skill-original|after-skill|after-agents-original|after-agents|after-memory-original|after-memory) ;;
  *)
    printf 'Unknown installer test failpoint: %s\n' "$TEST_FAILPOINT" >&2
    exit 1
    ;;
esac

LOCK_OWNED=0
SKILLS_ROOT_CREATED=0
TRANSACTION_DIR=""
TRANSACTION_COMPLETE=0
COMMIT_STARTED=0
PRESERVE_TRANSACTION=0

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

  if [[ ! -d "$tree_root" || -L "$tree_root" ]]; then
    printf 'absent\n' > "$manifest_path"
    chmod 600 "$manifest_path"
    return
  fi

  if ! (
    cd "$tree_root"
    printf '.\tdirectory\t%s\t-\n' "$(path_mode .)"
    while IFS= read -r relative_path; do
      if [[ -n "$excluded_relative_path" && "$relative_path" == "$excluded_relative_path" ]]; then
        continue
      fi
      if [[ -L "$relative_path" ]]; then
        local_link_target="$(readlink "$relative_path")"
        local_link_digest="$(printf '%s' "$local_link_target" | "$SHASUM_BIN" -a 256)"
        printf '%s\tsymlink\t%s\t%s\n' \
          "$relative_path" "$(path_mode "$relative_path")" "${local_link_digest%% *}"
      elif [[ -d "$relative_path" ]]; then
        printf '%s\tdirectory\t%s\t-\n' "$relative_path" "$(path_mode "$relative_path")"
      elif [[ -f "$relative_path" ]]; then
        printf '%s\tfile\t%s\t%s\n' \
          "$relative_path" "$(path_mode "$relative_path")" "$(path_sha256 "$relative_path")"
      else
        printf '%s\tother\t%s\t-\n' "$relative_path" "$(path_mode "$relative_path")"
      fi
    done < <(LC_ALL=C find . -mindepth 1 -print | LC_ALL=C sort)
  ) > "$manifest_path"; then
    rm -f -- "$manifest_path"
    return 1
  fi
  chmod 600 "$manifest_path"
}

is_task_flow_backup_family_name() {
  [[ "$1" =~ ^[[:digit:]]{8}-[[:digit:]]{6}\.[[:alnum:]]{6}$ ]]
}

task_flow_backup_has_recoverable_shape() {
  local candidate="$1"
  local state_path="$candidate/STATE"
  local line skill_present agents_present memory_present
  local -a state_lines=()

  if [[ ! -f "$state_path" || -L "$state_path" || ! -r "$state_path" ]]; then
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    state_lines+=("$line")
  done < "$state_path"
  if [[ "${#state_lines[@]}" != "4" || "${state_lines[0]}" != "version=1" ]]; then
    return 1
  fi
  skill_present="${state_lines[1]#skill_present=}"
  agents_present="${state_lines[2]#agents_present=}"
  memory_present="${state_lines[3]#memory_present=}"
  if [[ "${state_lines[1]}" != "skill_present=$skill_present" \
    || "${state_lines[2]}" != "agents_present=$agents_present" \
    || "${state_lines[3]}" != "memory_present=$memory_present" ]]; then
    return 1
  fi
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
  local candidate_name candidate_manifest candidate_symlinks actual_manifest

  candidate_name="${candidate##*/}"
  if ! is_task_flow_backup_family_name "$candidate_name"; then
    return 1
  fi
  if [[ ! -d "$candidate" || -L "$candidate" ]]; then
    return 1
  fi
  candidate_manifest="$candidate/MANIFEST.sha256"
  if [[ ! -f "$candidate_manifest" || -L "$candidate_manifest" ]]; then
    return 1
  fi
  if ! candidate_symlinks="$(find -P "$candidate" -type l -print 2>/dev/null)"; then
    return 1
  fi
  if [[ -n "$candidate_symlinks" ]]; then
    return 1
  fi
  if ! task_flow_backup_has_recoverable_shape "$candidate"; then
    return 1
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
    rm -f -- "$LOCK_DIR/pid" || cleanup_failed=1
    rmdir "$LOCK_DIR" || cleanup_failed=1
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

if [[ "$MODE" == "apply" ]]; then
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    printf 'Another task-flow installation already holds the workspace lock: %s\n' "$LOCK_DIR" >&2
    exit 1
  fi
  LOCK_OWNED=1
  chmod 700 "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  chmod 600 "$LOCK_DIR/pid"
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

install -d -m 700 "$BACKUP_ROOT"
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

printf 'version=1\nskill_present=%s\nagents_present=%s\nmemory_present=%s\n' \
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

maybe_fail() {
  if [[ "$TEST_FAILPOINT" == "$1" ]]; then
    printf 'Injected task-flow installer failure at %s.\n' "$1" >&2
    return 97
  fi
}

COMMIT_STARTED=1
if [[ "$SKILL_PRESENT" == "1" ]]; then
  mv "$TARGET_DIR" "$TRANSACTION_DIR/originals/aiworker-task-flow"
fi
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

TRANSACTION_COMPLETE=1
printf 'Backed up task-flow installation state: %s\n' "$BACKUP_DIR"
printf 'Installed AI-worker task-flow skill and workspace sections: %s\n' "$TARGET_DIR"
