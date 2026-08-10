import { extname, isAbsolute, normalize } from 'node:path'

const MAX_REQUEST_LENGTH = 4_096
const SUPPORTED_EXTENSIONS = new Set(['.m4v', '.mkv', '.mov', '.mp4', '.webm'])
const EXACT_COMMAND_SHAPE = /^分析视频(?:\s|$)/u
const VIDEO_WORD = /(?:视频|影片|录像|video)/iu
const ACTION_WORD = /(?:分析|解析|处理|识别|总结)/u
const VIDEO_PATH_HINT = /\/[^\r\n\0]{0,4096}\.(?:m4v|mkv|mov|mp4|webm)(?![\p{L}\p{N}_])/iu
const AFFIRMATIVE_REQUEST = /(?:(?:帮我|请(?:你)?|请帮我|麻烦(?:你)?|麻烦帮我|能不能(?:帮我)?|可以(?:帮我)?|现在|马上|立即|给我)?\s*(?:分析|解析|处理|识别|总结)(?:一下|下)?\s*(?:(?:这个|该|这段|以下)?\s*(?:视频|影片|录像|video))?|(?:视频|影片|录像|video).*?(?:分析|解析|处理|识别|总结))/iu
const EXPLANATION_WORDS = /(?:怎么|如何|方法|方案|流程|架构|原理|什么技能|哪(?:个|些)模型|分工|先告诉|先说|先给|只告诉|只说|只给)/u
const DELEGATED_CAPABILITY_REQUEST = /(?:能不能|可以)(?:请)?(?:帮我|替我)\s*(?:分析|解析|处理|识别|总结)/u
const CAPABILITY_QUESTION = /(?:是否(?:可以)?|能否|可否|支不支持|(?:你|这个视频|该视频)?(?:能不能|可以|能).*?(?:吗|么|[?？]))/u
const NEGATIVE_WORDS = /(?:不要|别|不用|无需|暂不|先不|先别|取消|停止|只分析|仅分析)/u
const CONDITIONAL_WORDS = /(?:如果|假如|要是|等[^\s，。；;]{0,24}再|先[^\s，。；;]{0,24}再)/u
const EXAMPLE_WORDS = /(?:比如|例如|示例|假设|引用|演示)/u
const URL_PATTERN = /(?:https?|file):\/\//iu
const RELATIVE_PATH_PATTERN = /(?:^|\s)(?:\.\.?\/|~\/)[^\s]+/u
const VIDEO_EXTENSION_OCCURRENCE = /\.(?:3gp|avi|flv|m4v|mkv|mov|mp4|mpeg|mpg|ts|webm|wmv)(?![\p{L}\p{N}_])/giu

function maskRange(chars, start, end) {
  for (let index = start; index < end; index += 1) chars[index] = ' '
}

function extractPathCandidates(value) {
  const spans = []
  const quoted = /"(\/[^"\r\n]*?)"|'(\/[^'\r\n]*?)'|`(\/[^`\r\n]*?)`|“(\/[^”\r\n]*?)”|‘(\/[^’\r\n]*?)’/gu
  for (const match of value.matchAll(quoted)) {
    const path = match.slice(1).find(candidate => candidate !== undefined)
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      path,
      quoted: true,
    })
  }

  const masked = value.split('')
  for (const span of spans) maskRange(masked, span.start, span.end)
  const hasUnmatchedQuote = /["'`“”‘’]/u.test(masked.join(''))
  const unquoted = /\/[^\s"'`“”‘’，。！？；、,!?;]+/gu
  const remainder = masked.join('')
  for (const match of remainder.matchAll(unquoted)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      path: match[0],
      quoted: false,
    })
  }

  spans.sort((left, right) => left.start - right.start)
  const intentChars = value.split('')
  for (const span of spans) maskRange(intentChars, span.start, span.end)
  return { spans, intentText: intentChars.join(''), hasUnmatchedQuote }
}

function supportedVideoPath(value) {
  return (
    value.length > 1
    && value.length <= MAX_REQUEST_LENGTH
    && isAbsolute(value)
    && !value.startsWith('//')
    && !value.includes('\0')
    && SUPPORTED_EXTENSIONS.has(extname(value).toLowerCase())
  )
}

export function parseNaturalVideoRequest(value) {
  if (typeof value !== 'string' || value.length === 0) return { kind: 'unmatched' }
  const looksVideoShaped = ACTION_WORD.test(value)
    && (VIDEO_WORD.test(value) || VIDEO_PATH_HINT.test(value))
  if (
    value.length > MAX_REQUEST_LENGTH
    || value !== value.trim()
    || /[\r\n\0]/u.test(value)
  ) {
    return looksVideoShaped
      ? { kind: 'blocked', reason: 'invalid_message_shape' }
      : { kind: 'unmatched' }
  }

  const { spans, intentText, hasUnmatchedQuote } = extractPathCandidates(value)
  const supported = spans.filter(candidate => supportedVideoPath(candidate.path))
  const videoExtensionCount = [...value.matchAll(VIDEO_EXTENSION_OCCURRENCE)].length
  const hasVideoIntent = ACTION_WORD.test(intentText)
    && (VIDEO_WORD.test(intentText) || supported.length > 0)

  if (!hasVideoIntent) return { kind: 'unmatched' }
  if (EXACT_COMMAND_SHAPE.test(value)) {
    return { kind: 'blocked', reason: 'exact_command_reserved' }
  }
  if (URL_PATTERN.test(value)) return { kind: 'blocked', reason: 'url_not_allowed' }
  if (EXAMPLE_WORDS.test(intentText)) return { kind: 'blocked', reason: 'example_only' }
  if (hasUnmatchedQuote) return { kind: 'blocked', reason: 'invalid_message_shape' }
  if (EXPLANATION_WORDS.test(intentText)) return { kind: 'blocked', reason: 'explanation_only' }
  if (
    CAPABILITY_QUESTION.test(intentText)
    && !DELEGATED_CAPABILITY_REQUEST.test(intentText)
  ) {
    return { kind: 'blocked', reason: 'capability_question' }
  }
  if (NEGATIVE_WORDS.test(intentText)) return { kind: 'blocked', reason: 'negative_intent' }
  if (CONDITIONAL_WORDS.test(intentText)) return { kind: 'blocked', reason: 'conditional_intent' }
  if (!AFFIRMATIVE_REQUEST.test(intentText)) {
    return { kind: 'blocked', reason: 'execution_not_explicit' }
  }
  if (RELATIVE_PATH_PATTERN.test(value)) {
    return { kind: 'blocked', reason: 'relative_path_not_allowed' }
  }
  if (spans.length === 0) return { kind: 'blocked', reason: 'missing_absolute_path' }
  if (spans.length !== 1 || videoExtensionCount > 1) {
    return { kind: 'blocked', reason: 'multiple_paths' }
  }
  if (supported.length !== 1) return { kind: 'blocked', reason: 'unsupported_video_path' }

  const candidate = supported[0]
  if (normalize(candidate.path) !== candidate.path) {
    return { kind: 'blocked', reason: 'noncanonical_path' }
  }
  if (!candidate.quoted && /\s/u.test(candidate.path)) {
    return { kind: 'blocked', reason: 'unquoted_space_path' }
  }
  return { kind: 'match', videoPath: normalize(candidate.path) }
}

export const naturalVideoRequestContract = Object.freeze({
  maxRequestLength: MAX_REQUEST_LENGTH,
  supportedExtensions: [...SUPPORTED_EXTENSIONS],
})
