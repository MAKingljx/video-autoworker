import { parseNaturalVideoRequest } from './natural-video-request.js'
import { parseVideoCommand } from './parse-video-command.js'

const REJECTION_TEXT = Object.freeze({
  invalid_message_shape: '未提交：消息格式无效。',
  missing_absolute_path: '未提交：请提供一个绝对视频路径。',
  multiple_paths: '未提交：一次只能分析一个视频。',
  noncanonical_path: '未提交：视频路径无效。',
  partial_analysis_unsupported: '未提交：当前只支持完整音画分析。',
  relative_path_not_allowed: '未提交：请提供一个绝对视频路径。',
  unquoted_space_path: '未提交：带空格的视频路径需要使用引号。',
  unsupported_video_path: '未提交：视频路径或格式无效。',
  url_not_allowed: '未提交：只支持本机绝对视频路径。',
})

export const MANAGED_VIDEO_EXPLANATION_TEXT = '视频会由原生插件一次派发到 AI-worker，后台依次执行 prepare、Whisper 音频、本地 Qwen 画面和 finalize；当前轮不等待，结果按任务编号另查。'
const NO_SUBMIT_TEXT = '好的，本次不会提交视频任务。需要执行时，请重新发送明确请求和一个本机绝对视频路径。'
const EXPLICIT_REQUEST_TEXT = '本次没有明确执行授权，未提交视频任务。需要执行时，请明确说“帮我分析”并提供一个本机绝对视频路径。'

function conversationResponse(reason) {
  if (reason === 'explanation_only' || reason === 'capability_question') {
    return MANAGED_VIDEO_EXPLANATION_TEXT
  }
  if (reason === 'execution_not_explicit') return EXPLICIT_REQUEST_TEXT
  return NO_SUBMIT_TEXT
}

export function routeVideoRequest(content) {
  const command = parseVideoCommand(content)
  if (command.kind === 'match') {
    return { kind: 'submit', route: 'command', videoPath: command.videoPath }
  }
  if (command.kind === 'invalid') {
    return { kind: 'reject', text: '未提交：视频命令或路径无效。' }
  }

  const natural = parseNaturalVideoRequest(content)
  if (natural.kind === 'match') {
    return { kind: 'submit', route: 'natural', videoPath: natural.videoPath }
  }
  if (natural.kind === 'pass') {
    return { kind: 'respond', text: conversationResponse(natural.reason) }
  }
  if (natural.kind === 'blocked') {
    return {
      kind: 'reject',
      text: REJECTION_TEXT[natural.reason] ?? '未提交：视频请求无效。',
    }
  }
  return { kind: 'pass' }
}
