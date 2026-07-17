#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FALLBACK_APP_DIR="$HOME/Documents/Phoenix/video-autoworker"
if [[ -f "$SOURCE_APP_DIR/package.json" ]]; then
  APP_DIR="$SOURCE_APP_DIR"
elif [[ -f "$FALLBACK_APP_DIR/package.json" ]]; then
  APP_DIR="$FALLBACK_APP_DIR"
else
  APP_DIR=""
fi
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/ai-worker/bin/openclaw}"
PORT=3017
QWEN_PORT=18091
USER_ID="$(id -u)"
FAILED=0

find_pnpm() {
  for candidate in \
    "${PNPM_BIN:-}" \
    "$HOME/ai-worker/bin/pnpm" \
    "$HOME/.local/node-v22/bin/pnpm" \
    "$HOME/.local/bin/pnpm" \
    "/opt/homebrew/bin/pnpm" \
    "/usr/local/bin/pnpm"
  do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  command -v pnpm 2>/dev/null || true
}

PNPM_BIN="$(find_pnpm)"

report() {
  printf '%s\n' "$1"
}

mark_failed() {
  FAILED=$((FAILED + 1))
  report "$1"
}

wait_until() {
  local timeout_seconds="$1"
  shift
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if "$@"; then
      return 0
    fi
    sleep 2
  done

  "$@"
}

qwen_ready() {
  curl --fail --silent --show-error --max-time 8 "http://127.0.0.1:${QWEN_PORT}/v1/models" >/dev/null 2>&1
}

profile_ready() {
  local profile="$1"
  local status
  status="$("$OPENCLAW_BIN" --profile "$profile" gateway status --deep 2>/dev/null || true)"
  grep -q 'Runtime: running' <<<"$status" && grep -q 'Connectivity probe: ok' <<<"$status"
}

platform_ready() {
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${PORT}/api/openclaw/profiles" >/dev/null 2>&1
}

port_is_taken() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

kickstart() {
  /bin/launchctl kickstart -k "gui/${USER_ID}/$1" >/dev/null 2>&1
}

ensure_qwen() {
  if qwen_ready; then
    report '千问模型：已运行，跳过'
    return
  fi

  if ! kickstart 'ai.aiworker.qwen36-server'; then
    mark_failed '千问模型：启动命令失败'
    return
  fi

  if wait_until 120 qwen_ready; then
    report '千问模型：已启动并通过探活'
  else
    mark_failed '千问模型：启动超时，请检查 LaunchAgent 日志'
  fi
}

ensure_profile() {
  local profile="$1"
  local label="$2"
  local port="$3"
  local launch_agent="$4"

  if profile_ready "$profile"; then
    report "${label}：Gateway :${port} 已运行，跳过"
    return
  fi

  if ! kickstart "$launch_agent"; then
    mark_failed "${label}：启动命令失败"
    return
  fi

  if wait_until 45 profile_ready "$profile"; then
    report "${label}：Gateway :${port} 已启动并通过探活"
  else
    mark_failed "${label}：Gateway :${port} 启动超时，请检查 LaunchAgent 日志"
  fi
}

ensure_platform() {
  if platform_ready; then
    report "可视化平台：:${PORT} 已运行，跳过"
    return
  fi

  if port_is_taken "$PORT"; then
    mark_failed "可视化平台：:${PORT} 已被非控制台服务占用"
    return
  fi

  if [[ -z "$PNPM_BIN" || ! -x "$PNPM_BIN" ]]; then
    mark_failed '可视化平台：未找到 pnpm，无法启动'
    return
  fi

  if [[ -z "$APP_DIR" ]]; then
    mark_failed '可视化平台：未找到 video-autoworker 部署目录'
    return
  fi

  mkdir -p "$APP_DIR/.runtime"
  nohup env \
    PATH="$(dirname "$PNPM_BIN"):$PATH" \
    MC_HOSTNAME=127.0.0.1 \
    MC_OPENCLAW_PROFILE_TARGET=local \
    "$PNPM_BIN" --dir "$APP_DIR" openclaw:profiles:server \
    >"$APP_DIR/.runtime/server.log" 2>&1 < /dev/null &

  if wait_until 90 platform_ready; then
    report "可视化平台：:${PORT} 已启动"
  else
    mark_failed "可视化平台：:${PORT} 启动超时，请查看 .runtime/server.log"
  fi
}

if [[ ! -x "$OPENCLAW_BIN" ]]; then
  report "OpenClaw 可执行文件不存在：$OPENCLAW_BIN"
  exit 127
fi

report 'AI-worker 正在检查服务状态...'
ensure_qwen
ensure_profile 'gpt-main' 'GPT 主入口' 18789 'ai.openclaw.gpt-main'
ensure_profile 'qwen-current' '千问当前入口' 18889 'ai.openclaw.qwen-current'
ensure_profile 'qwen-weixin-new' '千问微信新入口' 18989 'ai.openclaw.qwen-weixin-new'
ensure_platform

if (( FAILED > 0 )); then
  report "启动完成，但有 ${FAILED} 项需要处理。"
  exit 1
fi

report '全部服务已就绪。'
