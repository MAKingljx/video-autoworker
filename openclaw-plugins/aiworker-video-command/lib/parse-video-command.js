import { extname, isAbsolute } from 'node:path'

const COMMAND_PREFIX = '分析视频 '
const MAX_COMMAND_LENGTH = 4_096
const SUPPORTED_EXTENSIONS = new Set(['.m4v', '.mkv', '.mov', '.mp4', '.webm'])
const NEGATIVE_PHRASES = ['不要开始', '不要执行', '不要提交', '暂不执行', '只分析', '先告诉我方法']

function unwrapMatchingQuotes(value) {
  const first = value[0]
  const last = value[value.length - 1]
  const startsWithQuote = first === '"' || first === "'"
  const endsWithQuote = last === '"' || last === "'"

  if (!startsWithQuote && !endsWithQuote) return { ok: true, value }
  if (!startsWithQuote || first !== last || value.length < 3) return { ok: false }
  return { ok: true, value: value.slice(1, -1) }
}

export function parseVideoCommand(content) {
  if (typeof content !== 'string' || !content.startsWith(COMMAND_PREFIX)) {
    return { kind: 'unmatched' }
  }
  if (
    content.length > MAX_COMMAND_LENGTH
    || content !== content.trim()
    || content.includes('\n')
    || content.includes('\r')
    || content.includes('\0')
    || NEGATIVE_PHRASES.some(phrase => content.includes(phrase))
  ) {
    return { kind: 'invalid' }
  }

  const rawPath = content.slice(COMMAND_PREFIX.length)
  if (!rawPath || rawPath.startsWith(' ')) return { kind: 'invalid' }

  const unwrapped = unwrapMatchingQuotes(rawPath)
  if (!unwrapped.ok || !unwrapped.value || !isAbsolute(unwrapped.value)) {
    return { kind: 'invalid' }
  }
  if (!SUPPORTED_EXTENSIONS.has(extname(unwrapped.value).toLowerCase())) {
    return { kind: 'invalid' }
  }

  return { kind: 'match', videoPath: unwrapped.value }
}
