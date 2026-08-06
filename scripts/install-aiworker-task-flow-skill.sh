#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPOSITORY_ROOT/openclaw-skills/aiworker-task-flow"
WORKSPACE_ROOT="${AIWORKER_QWEN_WORKSPACE:-$HOME/AI-worker-second-original-workspace}"
TARGET_DIR="$WORKSPACE_ROOT/skills/aiworker-task-flow"
BACKUP_ROOT="${AIWORKER_SKILL_BACKUP_ROOT:-$HOME/ai-worker/backups/aiworker-task-flow-skill}"

if [[ ! -f "$SOURCE_DIR/SKILL.md" || ! -f "$SOURCE_DIR/WORKSPACE_VIDEO_RULES.md" || ! -f "$SOURCE_DIR/scripts/submit-task.mjs" ]]; then
  printf 'Task-flow skill source is incomplete: %s\n' "$SOURCE_DIR" >&2
  exit 1
fi
if [[ ! -d "$WORKSPACE_ROOT" ]]; then
  printf 'Qwen workspace does not exist: %s\n' "$WORKSPACE_ROOT" >&2
  exit 1
fi

backup_dir=""
if [[ -e "$TARGET_DIR" ]]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup_dir="$BACKUP_ROOT/$stamp"
  install -d -m 700 "$backup_dir"
  mv "$TARGET_DIR" "$backup_dir/aiworker-task-flow"
  printf 'Backed up existing skill: %s\n' "$backup_dir/aiworker-task-flow"
fi

workspace_agents="$WORKSPACE_ROOT/AGENTS.md"
if [[ -f "$workspace_agents" ]]; then
  if [[ -z "$backup_dir" ]]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    backup_dir="$BACKUP_ROOT/$stamp"
    install -d -m 700 "$backup_dir"
  fi
  install -m 600 "$workspace_agents" "$backup_dir/AGENTS.md"
fi

staging_dir="$WORKSPACE_ROOT/skills/.aiworker-task-flow.staging.$$"
mkdir -p "$staging_dir/scripts"
install -m 600 "$SOURCE_DIR/SKILL.md" "$staging_dir/SKILL.md"
install -m 700 "$SOURCE_DIR/scripts/submit-task.mjs" "$staging_dir/scripts/submit-task.mjs"

if ! mv "$staging_dir" "$TARGET_DIR"; then
  if [[ -n "$backup_dir" && -d "$backup_dir/aiworker-task-flow" && ! -e "$TARGET_DIR" ]]; then
    mv "$backup_dir/aiworker-task-flow" "$TARGET_DIR"
  fi
  exit 1
fi

if [[ -f "$workspace_agents" ]]; then
  agents_tmp="$workspace_agents.tmp.$$"
  awk -v rules_file="$SOURCE_DIR/WORKSPACE_VIDEO_RULES.md" '
    function emit_rules(line) {
      while ((getline line < rules_file) > 0) print line
      close(rules_file)
    }
    /^## Video Learning Pipeline Rule$/ || /^## Video Analysis Task Flow Rule$/ {
      emit_rules()
      replacing = 1
      next
    }
    replacing && /^## / { replacing = 0 }
    !replacing { print }
  ' "$workspace_agents" > "$agents_tmp"
  mv "$agents_tmp" "$workspace_agents"
  chmod 600 "$workspace_agents"
fi
printf 'Installed AI-worker task-flow skill: %s\n' "$TARGET_DIR"
