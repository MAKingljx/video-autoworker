import {
  countVideoExtensionTokens,
  MAX_VIDEO_REQUEST_LENGTH,
  SUPPORTED_VIDEO_EXTENSIONS,
  validateVideoPath,
} from './video-path-policy.js'

const MAX_REQUEST_LENGTH = MAX_VIDEO_REQUEST_LENGTH
const EXACT_COMMAND_SHAPE = /^分析视频(?:\s|$)/u
const VIDEO_WORD = /(?:视频|影片|录像|video)/iu
const ACTION_WORD = /(?:分析|解析|处理|识别|总结)/u
const VIDEO_REQUEST_ACTION = /(?:执行|提交|开始|分析|解析|处理|识别|总结)/u
const VIDEO_PATH_HINT = /\/[^\r\n\0]{0,4096}\.(?:m4v|mkv|mov|mp4|webm)(?![\p{L}\p{N}_])/iu
const AFFIRMATIVE_REQUEST = /^\s*(?:(?:(?:帮我|请(?:你)?|请帮我|麻烦(?:你)?|麻烦帮我|能不能帮我|可以帮我|现在|马上|立即|给我)\s*)?(?:只|仅)\s*(?:分析|解析|处理|识别|总结)(?:一下|下)?\s*(?:(?:这个|该|这段|以下)?\s*(?:视频|影片|录像|video))?|(?:帮我|请(?:你)?|请帮我|麻烦(?:你)?|麻烦帮我|能不能帮我|可以帮我|现在|马上|立即|给我)\s*(?:分析|解析|处理|识别|总结)(?:一下|下)?\s*(?:(?:这个|该|这段|以下)?\s*(?:视频|影片|录像|video))?|(?:这个|该|这段|以下)?\s*(?:视频|影片|录像|video).*?(?:分析|解析|处理|识别|总结))/iu
const EXPLANATION_WORDS = /(?:怎么|如何|方法|方案|流程|架构|原理|什么技能|哪(?:个|些)模型|分工|先告诉|先说|先给|只告诉|只说|只给)/u
const DELEGATED_CAPABILITY_REQUEST = /^\s*(?:能不能|可以)(?:请)?(?:帮我|替我)\s*(?:分析|解析|处理|识别|总结)/u
const CAPABILITY_QUESTION = /(?:是否(?:可以)?|能否|可否|支不支持|(?:你|这个视频|该视频)?(?:能不能|可以|能).*?(?:吗|么|[?？]))/u
const EXECUTION_NEGATION = /(?:(?:不要|请勿|禁止|别|不用|无需|不需要|不必|不想|不能|不可以|暂不|先不|先别)\s*(?:(?:你|帮我|替我|再|先|现在|马上|立即|直接|继续)\s*)*(?:执行|提交|开始|分析|解析|处理|识别|总结)|(?:取消|停止)\s*(?:执行|提交|开始|分析|解析|处理|识别|总结)?|(?:并非|不是(?:让|要)|没(?:有)?让)[^，。；;]{0,24}(?:执行|提交|开始|分析|解析|处理|识别|总结))/u
const DEFERRED_EXECUTION = /(?:(?:如果|假如|要是)[^，。；;]{0,48}(?:再\s*)?(?:执行|提交|开始|分析|解析|处理|识别|总结)|(?:确认后|稍后|之后|待[^，。；;]{0,24}后|等[^，。；;]{0,24}(?:后|再))\s*(?:再\s*)?(?:执行|提交|开始|分析|解析|处理|识别|总结)|先(?:确认|给|看|讨论|考虑|问|等)[^，。；;]{0,24}再\s*(?:执行|提交|开始|分析|解析|处理|识别|总结))/u
const EXAMPLE_WORDS = /(?:比如|例如|示例|假设|引用|演示)/u
const HISTORICAL_REFERENCE = /(?:刚才|之前|上次|前面|先前|曾经|我说过)/u
const NON_MEDIA_VIDEO_TOPIC = /(?:视频号|视频会议|视频编码)/u
const ASYNC_PREFERENCE_PREFIX = /^\s*(?:(?:不要|别|不用|无需|不需要)\s*(?:等待|一直盯着|盯进度|回投|回复结果|返回结果))\s*[，,]\s*/u
const URL_PATTERN = /(?:https?|file):\/\//iu
const RELATIVE_PATH_PATTERN = /(?:\.\.?|~)\//u
const UNQUOTED_VIDEO_TAIL = /(\/[^\r\n\0"'`“”‘’]*\.(?:m4v|mkv|mov|mp4|webm))(?=[。！？!?]?$)/iu
const EXCLUSIVE_ANALYSIS_CLAUSE = /^\s*(?:(?:帮我|请(?:你)?|请帮我|麻烦(?:你)?|麻烦帮我|能不能帮我|可以帮我|现在|马上|立即|给我)\s*)?(?:只|仅)\s*(?:分析|解析|处理|识别|总结)(?:一下|下)?\s*([^，。；;！？!?]{0,80})/iu
const VISUAL_SCOPE = /(?:画面|视觉|图像|镜头)/u
const AUDIO_SCOPE = /(?:音频|声音|语音|对白|台词)/u
const COMBINED_AUDIO_VISUAL_SCOPE = /(?:音画|视听)/u
const OTHER_PARTIAL_SCOPE = /(?:字幕|文字轨|音轨)/u

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
  const unquoted = /(?:^|[\s：])(\/[^\s"'`“”‘’，。！？；、,!?;]+)/gu
  const remainder = masked.join('')
  for (const match of remainder.matchAll(unquoted)) {
    const path = match[1]
    spans.push({
      start: match.index + match[0].length - path.length,
      end: match.index + match[0].length,
      path,
      quoted: false,
    })
  }

  spans.sort((left, right) => left.start - right.start)
  const intentChars = value.split('')
  for (const span of spans) maskRange(intentChars, span.start, span.end)
  return { spans, intentText: intentChars.join(''), hasUnmatchedQuote }
}

function hasExecutionNegation(value) {
  const delegated = value.match(DELEGATED_CAPABILITY_REQUEST)?.[0]
  const remaining = delegated ? value.slice(delegated.length) : value
  return EXECUTION_NEGATION.test(remaining)
}

function hasUnsupportedPartialAnalysis(value) {
  const scope = value.match(EXCLUSIVE_ANALYSIS_CLAUSE)?.[1]
  if (!scope) return false
  const combined = COMBINED_AUDIO_VISUAL_SCOPE.test(scope)
  const visual = combined || VISUAL_SCOPE.test(scope)
  const audio = combined || AUDIO_SCOPE.test(scope)
  return OTHER_PARTIAL_SCOPE.test(scope) || visual !== audio
}

export function parseNaturalVideoRequest(value) {
  if (typeof value !== 'string' || value.length === 0) return { kind: 'unmatched' }
  const { spans, intentText, hasUnmatchedQuote } = extractPathCandidates(value)
  const candidates = spans.map(candidate => ({
    ...candidate,
    validation: validateVideoPath(candidate.path, { quoted: candidate.quoted }),
  }))
  const affirmativeIntentText = intentText.replace(ASYNC_PREFERENCE_PREFIX, '')
  const looksVideoShaped = VIDEO_REQUEST_ACTION.test(intentText)
    && (VIDEO_WORD.test(intentText) || VIDEO_PATH_HINT.test(value))

  // Do not reinterpret ordinary compound nouns as a media-analysis request.
  // A real absolute media path makes the user's object explicit and therefore
  // bypasses this lexical guard.
  if (spans.length === 0 && NON_MEDIA_VIDEO_TOPIC.test(intentText)) {
    return { kind: 'unmatched' }
  }

  // These are video-conversation requests, not execution authorization. The
  // router converts them into managed hook replies without starting the model.
  if (EXACT_COMMAND_SHAPE.test(value)) {
    return { kind: 'pass', reason: 'exact_command_reserved' }
  }
  if (looksVideoShaped && EXAMPLE_WORDS.test(intentText)) {
    return { kind: 'pass', reason: 'example_only' }
  }
  if (looksVideoShaped && DEFERRED_EXECUTION.test(intentText)) {
    return { kind: 'pass', reason: 'conditional_intent' }
  }
  if (looksVideoShaped && EXPLANATION_WORDS.test(intentText)) {
    return { kind: 'pass', reason: 'explanation_only' }
  }
  if (
    looksVideoShaped
    && CAPABILITY_QUESTION.test(intentText)
    && !DELEGATED_CAPABILITY_REQUEST.test(intentText)
  ) {
    return { kind: 'pass', reason: 'capability_question' }
  }
  if (
    looksVideoShaped
    && hasExecutionNegation(intentText)
  ) {
    return { kind: 'pass', reason: 'negative_intent' }
  }
  if (looksVideoShaped && HISTORICAL_REFERENCE.test(intentText)) {
    return { kind: 'pass', reason: 'historical_reference' }
  }
  if (looksVideoShaped && hasUnsupportedPartialAnalysis(intentText)) {
    return { kind: 'blocked', reason: 'partial_analysis_unsupported' }
  }

  if (
    value.length > MAX_REQUEST_LENGTH
    || value !== value.trim()
    || /[\r\n\0]/u.test(value)
  ) {
    return looksVideoShaped
      ? { kind: 'blocked', reason: 'invalid_message_shape' }
      : { kind: 'unmatched' }
  }

  const videoExtensionCount = countVideoExtensionTokens(value)
  const hasVideoIntent = ACTION_WORD.test(intentText)
    && (VIDEO_WORD.test(intentText) || videoExtensionCount > 0)

  if (!hasVideoIntent) return { kind: 'unmatched' }
  if (URL_PATTERN.test(value)) return { kind: 'blocked', reason: 'url_not_allowed' }
  if (hasUnmatchedQuote) return { kind: 'blocked', reason: 'invalid_message_shape' }
  if (!AFFIRMATIVE_REQUEST.test(affirmativeIntentText)) {
    return { kind: 'pass', reason: 'execution_not_explicit' }
  }
  if (RELATIVE_PATH_PATTERN.test(value)) {
    return { kind: 'blocked', reason: 'relative_path_not_allowed' }
  }
  if (spans.length === 0) return { kind: 'blocked', reason: 'missing_absolute_path' }
  if (videoExtensionCount > 1) {
    return { kind: 'blocked', reason: 'multiple_paths' }
  }
  const unquotedTail = value.match(UNQUOTED_VIDEO_TAIL)?.[1]
  if (
    !spans.some(span => span.quoted)
    && unquotedTail
    && (spans.length !== 1 || unquotedTail !== spans[0].path)
    && /\s/u.test(unquotedTail)
  ) {
    return { kind: 'blocked', reason: 'unquoted_space_path' }
  }
  if (spans.length !== 1) return { kind: 'blocked', reason: 'multiple_paths' }
  const candidate = candidates[0]
  if (!candidate.validation.ok) {
    return { kind: 'blocked', reason: candidate.validation.reason }
  }
  return { kind: 'match', videoPath: candidate.validation.videoPath }
}

export const naturalVideoRequestContract = Object.freeze({
  maxRequestLength: MAX_REQUEST_LENGTH,
  supportedExtensions: [...SUPPORTED_VIDEO_EXTENSIONS],
})
