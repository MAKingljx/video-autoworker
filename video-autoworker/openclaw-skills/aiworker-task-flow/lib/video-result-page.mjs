export const MAX_RESULT_PAGE_BYTES = 24 * 1024
export const MAX_RESULT_OFFSET = 16 * 1024 * 1024
export const MAX_RESULT_TOTAL_BYTES = 16 * 1024 * 1024

function normalizedReportText(value) {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
  return text || null
}

export function parseResultOffset(value) {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error('报告分页偏移无效')
  }
  const offset = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_RESULT_OFFSET) {
    throw new Error('报告分页偏移超出范围')
  }
  return offset
}

export function selectFinalVideoReport(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  for (const source of ['summary', 'combinedText']) {
    const text = normalizedReportText(output[source])
    if (text) return { source, text }
  }
  return null
}

// Slice only between complete UTF-8 code points. The returned nextOffset is
// therefore safe to send back unchanged to the next controlled CLI invocation.
export function paginateVideoReport(text, offset = 0, pageBytes = MAX_RESULT_PAGE_BYTES) {
  const safeOffset = parseResultOffset(offset)
  if (typeof text !== 'string' || !text) throw new Error('正式学习报告为空')
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 1 || pageBytes > MAX_RESULT_PAGE_BYTES) {
    throw new Error('报告分页大小无效')
  }
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes > MAX_RESULT_TOTAL_BYTES) throw new Error('正式学习报告超过可读取范围')
  if (safeOffset > totalBytes) throw new Error('报告分页偏移超出报告范围')

  let byteOffset = 0
  let start = 0
  let end = text.length
  let pageByteLength = 0
  let started = safeOffset === 0

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)
    const char = String.fromCodePoint(codePoint)
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (!started) {
      if (byteOffset === safeOffset) {
        start = index
        started = true
      } else if (byteOffset + charBytes > safeOffset) {
        throw new Error('报告分页偏移不是有效边界')
      }
    }
    if (started) {
      if (pageByteLength + charBytes > pageBytes) {
        end = index
        break
      }
      pageByteLength += charBytes
    }
    byteOffset += charBytes
    index += char.length
  }

  if (!started && byteOffset === safeOffset) {
    start = text.length
    end = text.length
  }
  const page = text.slice(start, end)
  const nextOffset = safeOffset + Buffer.byteLength(page, 'utf8')
  return {
    text: page,
    offset: safeOffset,
    nextOffset: nextOffset < totalBytes ? nextOffset : null,
    totalBytes,
  }
}
