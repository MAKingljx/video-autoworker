#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$APP_DIR/scripts/aiworker-runtime-launcher.applescript"
TARGET="${1:-$HOME/Desktop/AI-worker 一键启动.app}"
TEMP_DIR="$(mktemp -d)"
TEMP_APP="$TEMP_DIR/AI-worker 一键启动.app"

if [[ ! -x /usr/bin/osacompile ]]; then
  printf 'osacompile is required to build the macOS launcher.\n' >&2
  exit 127
fi

if [[ ! -f "$SOURCE" ]]; then
  printf 'Launcher source is missing: %s\n' "$SOURCE" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
/usr/bin/osacompile -o "$TEMP_APP" "$SOURCE"

if [[ -e "$TARGET" ]]; then
  backup="${TARGET}.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$backup"
  printf 'Existing launcher backed up to: %s\n' "$backup"
fi

mv "$TEMP_APP" "$TARGET"
rmdir "$TEMP_DIR"
printf 'Launcher created: %s\n' "$TARGET"
