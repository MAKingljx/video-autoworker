#!/bin/sh
# One-recovery adapter for an immutable bootstrap script's empty-port query.
# Every other invocation keeps the operating system tool's original behavior.
set -u

if [ ! -f /usr/sbin/lsof ] || [ ! -x /usr/sbin/lsof ] || [ -L /usr/sbin/lsof ]; then
  printf '%s\n' 'Native lsof is unavailable or unsafe.' >&2
  exit 70
fi
if [ "$#" -ne 2 ] || [ "$1" != '-tiTCP:3017' ] || [ "$2" != '-sTCP:LISTEN' ]; then
  exec /usr/sbin/lsof "$@"
fi

umask 077
work=$(/usr/bin/mktemp -d /private/tmp/aiworker-lsof-compat.XXXXXX) || exit 70
cleanup() {
  case "$work" in
    /private/tmp/aiworker-lsof-compat.*) /bin/rm -rf -- "$work" ;;
    *) exit 70 ;;
  esac
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/sbin/lsof "$@" > "$work/stdout" 2> "$work/stderr"
status=$?
# Exit 1 with two empty streams means that this valid query found no listener.
# PID output, diagnostic output and every other error remain unchanged.
if [ "$status" -eq 1 ] && [ ! -s "$work/stdout" ] && [ ! -s "$work/stderr" ]; then
  exit 0
fi
/bin/cat "$work/stdout"
/bin/cat "$work/stderr" >&2
exit "$status"
