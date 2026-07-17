#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$APP_DIR/scripts/aiworker-runtime-launcher.applescript"
RUNTIME_SCRIPT="$APP_DIR/scripts/start-aiworker-runtime.sh"
DEFAULT_TARGET="$HOME/Desktop/AI-worker 一键启动.app"
TARGET="${1:-$DEFAULT_TARGET}"
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

if [[ ! -x "$RUNTIME_SCRIPT" ]]; then
  printf 'Runtime launcher is missing or not executable: %s\n' "$RUNTIME_SCRIPT" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
/usr/bin/osacompile -o "$TEMP_APP" "$SOURCE"
/bin/cp "$RUNTIME_SCRIPT" "$TEMP_APP/Contents/Resources/start-aiworker-runtime.sh"
/bin/chmod +x "$TEMP_APP/Contents/Resources/start-aiworker-runtime.sh"
/usr/bin/codesign --force --deep --sign - "$TEMP_APP" >/dev/null

if [[ -e "$TARGET" ]]; then
  if [[ "$TARGET" != "$DEFAULT_TARGET" ]]; then
    printf 'Refusing to replace a custom target: %s\n' "$TARGET" >&2
    exit 1
  fi
  rm -rf "$TARGET"
fi

mv "$TEMP_APP" "$TARGET"
rmdir "$TEMP_DIR"
printf 'Launcher created: %s\n' "$TARGET"
