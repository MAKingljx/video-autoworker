#!/bin/sh
set -eu

# OpenClaw 2026.9.2 SecretRef wrapper.
# Usage: openclaw-keychain-secretref.sh <account-ref> <service-ref> <keychain-path>
# stdout is reserved for the secret returned directly to OpenClaw by security(1).

LC_ALL=C
export LC_ALL

fail() {
  printf '%s\n' 'Invalid OpenClaw Keychain SecretRef arguments.' >&2
  exit 64
}

safe_reference() {
  [ -n "$1" ] || return 1
  case "$1" in
    -*|*[![:print:]]*) return 1 ;;
  esac
  return 0
}

[ "$#" -eq 3 ] || fail
[ -n "${HOME:-}" ] || fail

safe_reference "$1" || fail
safe_reference "$2" || fail

case "$3" in
  *[![:print:]]*) fail ;;
esac

[ "$3" = "$HOME/Library/Keychains/login.keychain-db" ] || fail

exec /usr/bin/security find-generic-password -a "$1" -s "$2" -w "$3"
