#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_SCRIPT="$APP_DIR/scripts/start-aiworker-runtime.sh"
APP_EXECUTABLE="$APP_DIR/scripts/aiworker-runtime-app"
INFO_PLIST="$APP_DIR/scripts/aiworker-runtime-launcher-Info.plist"
APP_NAME="AI-worker 一键启动.app"
INSTALL_TARGET="$HOME/Applications/$APP_NAME"
DESKTOP_LINK="$HOME/Desktop/$APP_NAME"
TEMP_DIR="$(mktemp -d)"
TEMP_APP="$TEMP_DIR/$APP_NAME"

if [[ ! -x "$RUNTIME_SCRIPT" ]]; then
  printf 'Runtime launcher is missing or not executable: %s\n' "$RUNTIME_SCRIPT" >&2
  exit 1
fi

if [[ ! -x "$APP_EXECUTABLE" || ! -f "$INFO_PLIST" ]]; then
  printf 'Launcher app files are missing.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_TARGET")" "$(dirname "$DESKTOP_LINK")"
mkdir -p "$TEMP_APP/Contents/MacOS" "$TEMP_APP/Contents/Resources"
/bin/cp "$INFO_PLIST" "$TEMP_APP/Contents/Info.plist"
/bin/cp "$APP_EXECUTABLE" "$TEMP_APP/Contents/MacOS/AI-worker-runtime"
/bin/cp "$RUNTIME_SCRIPT" "$TEMP_APP/Contents/Resources/start-aiworker-runtime.sh"
/bin/chmod +x "$TEMP_APP/Contents/MacOS/AI-worker-runtime" "$TEMP_APP/Contents/Resources/start-aiworker-runtime.sh"

if [[ -e "$INSTALL_TARGET" ]]; then
  rm -rf "$INSTALL_TARGET"
fi

mv "$TEMP_APP" "$INSTALL_TARGET"
rmdir "$TEMP_DIR"
/usr/bin/xattr -cr "$INSTALL_TARGET"
/usr/bin/codesign --force --deep --sign - "$INSTALL_TARGET" >/dev/null
/usr/bin/codesign --verify --deep --strict "$INSTALL_TARGET"

if [[ -e "$DESKTOP_LINK" || -L "$DESKTOP_LINK" ]]; then
  rm -rf "$DESKTOP_LINK"
fi
ln -s "$INSTALL_TARGET" "$DESKTOP_LINK"
printf 'Launcher installed: %s\n' "$INSTALL_TARGET"
printf 'Desktop launcher: %s\n' "$DESKTOP_LINK"
