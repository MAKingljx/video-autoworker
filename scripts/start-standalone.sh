#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STANDALONE_ROOT="$PROJECT_ROOT/.next/standalone"
SOURCE_STATIC_DIR="$PROJECT_ROOT/.next/static"
SOURCE_PUBLIC_DIR="$PROJECT_ROOT/public"

find_standalone_server() {
  if [[ -f "$STANDALONE_ROOT/server.js" ]]; then
    printf '%s\n' "$STANDALONE_ROOT/server.js"
    return 0
  fi

  if [[ ! -d "$STANDALONE_ROOT" ]]; then
    return 0
  fi

  find "$STANDALONE_ROOT" \
    -path '*/node_modules/*' -prune -o \
    -type f -name server.js -print -quit 2>/dev/null
}

STANDALONE_SERVER="$(find_standalone_server)"

if [[ -z "$STANDALONE_SERVER" || ! -f "$STANDALONE_SERVER" ]]; then
  echo "error: standalone server missing under $STANDALONE_ROOT" >&2
  echo "run 'pnpm build' first" >&2
  exit 1
fi

STANDALONE_DIR="$(cd "$(dirname "$STANDALONE_SERVER")" && pwd)"
STANDALONE_NEXT_DIR="$STANDALONE_DIR/.next"
STANDALONE_STATIC_DIR="$STANDALONE_NEXT_DIR/static"
STANDALONE_PUBLIC_DIR="$STANDALONE_DIR/public"

mkdir -p "$STANDALONE_NEXT_DIR"

if [[ -d "$SOURCE_STATIC_DIR" ]]; then
  rm -rf "$STANDALONE_STATIC_DIR"
  cp -R "$SOURCE_STATIC_DIR" "$STANDALONE_STATIC_DIR"
fi

if [[ -d "$SOURCE_PUBLIC_DIR" ]]; then
  rm -rf "$STANDALONE_PUBLIC_DIR"
  cp -R "$SOURCE_PUBLIC_DIR" "$STANDALONE_PUBLIC_DIR"
fi

cd "$STANDALONE_DIR"
# Next.js standalone server reads HOSTNAME to decide bind address.
# Bash auto-populates HOSTNAME with the machine name, so prefer MC_HOSTNAME
# and otherwise fall back to 0.0.0.0 for standalone deployments.
machine_hostname="$(hostname 2>/dev/null || true)"
if [[ -n "${MC_HOSTNAME:-}" ]]; then
  export HOSTNAME="$MC_HOSTNAME"
elif [[ -z "${HOSTNAME:-}" || "$HOSTNAME" == "$machine_hostname" ]]; then
  export HOSTNAME="0.0.0.0"
fi
exec "${NODE_BIN:-node}" server.js
