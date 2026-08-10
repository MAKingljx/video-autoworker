import { extname, isAbsolute, normalize } from 'node:path'

export const MAX_VIDEO_REQUEST_LENGTH = 4_096
export const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze(['.m4v', '.mkv', '.mov', '.mp4', '.webm'])

const SUPPORTED_EXTENSION_SET = new Set(SUPPORTED_VIDEO_EXTENSIONS)
const QUOTE_PAIRS = new Map([
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
])
const CLOSING_QUOTES = new Set(QUOTE_PAIRS.values())

export const VIDEO_EXTENSION_OCCURRENCE = /\.(?:3gp|avi|flv|m4v|mkv|mov|mp4|mpeg|mpg|ts|webm|wmv)(?![\p{L}\p{N}_])/giu

export function unwrapVideoPath(value) {
  if (typeof value !== 'string' || !value) return { ok: false }
  const expectedClosing = QUOTE_PAIRS.get(value[0])
  const closingQuote = CLOSING_QUOTES.has(value.at(-1))
  if (!expectedClosing && !closingQuote) return { ok: true, quoted: false, value }
  if (!expectedClosing || value.at(-1) !== expectedClosing || value.length < 3) {
    return { ok: false }
  }
  return { ok: true, quoted: true, value: value.slice(1, -1) }
}

export function validateVideoPath(value, { quoted = false } = {}) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > MAX_VIDEO_REQUEST_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return { ok: false, reason: 'invalid_message_shape' }
  }
  if (!isAbsolute(value)) return { ok: false, reason: 'relative_path_not_allowed' }
  if (value.startsWith('//') || normalize(value) !== value) {
    return { ok: false, reason: 'noncanonical_path' }
  }
  if (!SUPPORTED_EXTENSION_SET.has(extname(value).toLowerCase())) {
    return { ok: false, reason: 'unsupported_video_path' }
  }
  if (!quoted && /\s/u.test(value)) {
    return { ok: false, reason: 'unquoted_space_path' }
  }
  return { ok: true, videoPath: value }
}

export function countVideoExtensionTokens(value) {
  if (typeof value !== 'string') return 0
  return [...value.matchAll(VIDEO_EXTENSION_OCCURRENCE)].length
}
