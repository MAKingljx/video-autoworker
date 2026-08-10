import {
  countVideoExtensionTokens,
  unwrapVideoPath,
  validateVideoPath,
} from './video-path-policy.js'

const COMMAND_NAME = '分析视频'
const COMMAND_PREFIX = `${COMMAND_NAME} `
const MAX_COMMAND_LENGTH = 4_096

export function parseVideoCommand(content) {
  if (typeof content !== 'string') return { kind: 'unmatched' }
  if (content === COMMAND_NAME || (/^分析视频\s/u.test(content) && !content.startsWith(COMMAND_PREFIX))) {
    return { kind: 'invalid' }
  }
  if (!content.startsWith(COMMAND_PREFIX)) {
    return { kind: 'unmatched' }
  }
  if (
    content.length > MAX_COMMAND_LENGTH
    || content !== content.trim()
    || content.includes('\n')
    || content.includes('\r')
    || content.includes('\0')
  ) {
    return { kind: 'invalid' }
  }

  const rawPath = content.slice(COMMAND_PREFIX.length)
  if (!rawPath || rawPath.startsWith(' ')) return { kind: 'invalid' }

  const unwrapped = unwrapVideoPath(rawPath)
  if (!unwrapped.ok || countVideoExtensionTokens(unwrapped.value) !== 1) {
    return { kind: 'invalid' }
  }
  const validated = validateVideoPath(unwrapped.value, { quoted: unwrapped.quoted })
  return validated.ok
    ? { kind: 'match', videoPath: validated.videoPath }
    : { kind: 'invalid' }
}
