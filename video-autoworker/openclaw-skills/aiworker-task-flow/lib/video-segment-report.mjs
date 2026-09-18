import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, parse, resolve } from 'node:path'
import { MAX_RESULT_TOTAL_BYTES, selectFinalVideoReport } from './video-result-page.mjs'

export const MAX_SEGMENT_BYTES = 12 * 1024
const MAX_SEGMENTS = 10_000
const SUMMARY_COMPLETENESS = new Set(['complete', 'incomplete', 'unknown'])
const sha256 = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim() : ''
const label = value => [...text(String(value ?? '')).replace(/\s+/gu, ' ')].slice(0, 180).join('')

export function parseSegmentInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback
    throw new Error(`${name} 缺少参数值`)
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(String(value))) throw new Error(`${name} 必须是整数`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${name} 超出范围`)
  return number
}

export function truncateUtf8(value, maxBytes) {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

// One adapter owns historical and current report semantics for reads and exports.
// Historical chapters remain chapters; timeline observations are never relabelled as fusion summaries.
export function selectVideoSegmentReport(output) {
  const record = output && typeof output === 'object' && !Array.isArray(output) ? output : {}
  let source = 'none'
  let rows = []
  if (Array.isArray(record.segmentSummaries) && record.segmentSummaries.length) {
    source = 'segment_summary'
    rows = record.segmentSummaries
  } else if (Array.isArray(record.chapters) && record.chapters.length) {
    source = 'legacy_chapter'
    rows = record.chapters
  } else if (Array.isArray(record.timeline) && record.timeline.length) {
    source = 'legacy_timeline'
    rows = record.timeline
  }
  if (rows.length > MAX_SEGMENTS) throw new Error('片段数量超过可读取范围')
  const seen = new Set()
  const segments = rows.map((row, offset) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('片段记录无效')
    const index = Number(row.index ?? offset + 1)
    if (!Number.isSafeInteger(index) || index < 1 || seen.has(index)) throw new Error('片段编号无效或重复')
    seen.add(index)
    const timeRange = truncateUtf8(label(row.timeRange || [row.startTime, row.endTime].filter(value => value !== undefined).join('-')), 128)
    const summary = source === 'legacy_timeline'
      ? ['历史音画观察（未生成融合摘要）', `语音：${text(row.transcript) || '无可用转写'}`, `画面：${text(row.visualAnalysis) || '无可用画面分析'}`].join('\n')
      : text(row.summary)
    if (!summary) throw new Error(`片段 ${index} 摘要为空`)
    const completeness = SUMMARY_COMPLETENESS.has(row.completeness)
      ? row.completeness
      : source === 'segment_summary'
        ? 'complete'
        : source === 'legacy_timeline'
          ? 'incomplete'
          : 'unknown'
    return {
      index, startTime: truncateUtf8(label(row.startTime || timeRange.split('-')[0]), 128),
      endTime: truncateUtf8(label(row.endTime || timeRange.split('-')[1]), 128), timeRange, source, summary, completeness,
      ...(typeof row.inputSha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.inputSha256) ? { inputSha256: row.inputSha256 } : {}),
    }
  }).sort((a, b) => a.index - b.index)
  const legacyReport = segments.length ? null : selectFinalVideoReport(record)
  if (segments.reduce((sum, row) => sum + Buffer.byteLength(row.summary), 0) > MAX_RESULT_TOTAL_BYTES) throw new Error('片段摘要超过可读取范围')
  return { source: segments.length ? source : legacyReport ? 'legacy_report' : 'none', segments, legacyReport }
}

export function segmentDirectory(report, offset = 0, limit = 10) {
  const segmentOffset = parseSegmentInteger(offset, '--segment-offset', 0, 0, MAX_SEGMENTS)
  const segmentLimit = parseSegmentInteger(limit, '--segment-limit', 10, 1, 20)
  if (segmentOffset > report.segments.length) throw new Error('片段偏移超出范围')
  const items = report.segments.slice(segmentOffset, segmentOffset + segmentLimit).map(({ summary, inputSha256: _digest, ...row }) => ({
    ...row, preview: [...summary.replace(/\s+/gu, ' ')].slice(0, 160).join(''),
  }))
  return { source: report.source, totalSegments: report.segments.length, segmentOffset, segmentLimit,
    nextSegmentOffset: segmentOffset + items.length < report.segments.length ? segmentOffset + items.length : null, items }
}

export function singleSegment(report, index) {
  const selected = parseSegmentInteger(index, '--segment-index', null, 1, Number.MAX_SAFE_INTEGER)
  const row = report.segments.find(segment => segment.index === selected)
  if (!row) throw new Error('未找到指定片段；历史全片报告不能作为独立片段读取')
  const totalBytes = Buffer.byteLength(row.summary)
  return { source: report.source, totalSegments: report.segments.length,
    segment: { ...row, summary: truncateUtf8(row.summary, MAX_SEGMENT_BYTES), totalBytes, truncated: totalBytes > MAX_SEGMENT_BYTES } }
}

function videoReportParagraphs(report, { name }) {
  if (!report.segments.length && !report.legacyReport) throw new Error('没有已保存的学习报告可导出')
  const title = label(name) || '视频学习报告'
  const paragraphs = [{ style: 'Title', text: title }]
  if (report.segments.length) {
    paragraphs.push({ style: 'Normal', text: `${report.source === 'legacy_chapter' ? '章节' : '片段'}数量：${report.segments.length}` })
    if (report.source === 'legacy_chapter') paragraphs.push({ style: 'Normal', text: '以下内容为已保存的历史章节摘要。' })
    if (report.source === 'legacy_timeline') paragraphs.push({ style: 'Normal', text: '以下内容为已保存的历史音画观察，尚未生成独立融合摘要。' })
    for (const row of report.segments) {
      paragraphs.push({ style: 'Heading1', text: `${report.source === 'legacy_chapter' ? '历史章节' : '片段'} ${row.index} · ${row.timeRange || '时间未登记'}` })
      // Stored body text never controls document styles or outline hierarchy.
      for (const line of row.summary.split('\n')) paragraphs.push({ style: 'Normal', text: line })
    }
  } else {
    paragraphs.push({ style: 'Heading1', text: '历史全片报告（未保存独立片段摘要）' })
    for (const line of report.legacyReport.text.split('\n')) paragraphs.push({ style: 'Normal', text: line })
  }
  return paragraphs
}

export function renderVideoReportMarkdown(report, metadata) {
  const document = videoReportParagraphs(report, metadata).map(paragraph => {
    if (paragraph.style === 'Title') return `# ${paragraph.text}`
    if (paragraph.style === 'Heading1') return `## ${paragraph.text}`
    return paragraph.text.replace(/^( {0,3})(#{1,6})(?=\s|$)/u, '$1\\$2')
  }).join('\n\n') + '\n'
  if (Buffer.byteLength(document) > MAX_RESULT_TOTAL_BYTES) throw new Error('导出报告超过可读取范围')
  return document
}

export function compatibleVideoReport(report, metadata) {
  return report.segments.length ? { source: report.source, text: renderVideoReportMarkdown(report, metadata) } : report.legacyReport
}

const xml = value => value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uFFFE\uFFFF]/gu, '\uFFFD').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;')
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

// OOXML uses an ordinary ZIP container. Stored entries avoid native dependencies
// on the controlled production node, and fixed metadata makes exports reproducible.
function zipStored(entries) {
  const local = [], directory = []
  let offset = 0
  for (const [path, content] of entries) {
    const name = Buffer.from(path), data = Buffer.from(content), crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    local.push(header, name, data); directory.push(central, name)
    offset += header.length + name.length + data.length
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, central, end])
}

export function renderVideoReportDocx(report, metadata) {
  const paragraphs = videoReportParagraphs(report, metadata).map(({ style, text: value }) => {
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`
  }).join('')
  return zipStored([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Songti SC"/><w:color w:val="000000"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`],
  ])
}

export function defaultVideoExportRoot() { return join(homedir(), 'ai-worker/state/video-autoworker/exports') }

async function assertDirectoryChain(root, create = false) {
  let current = parse(root).root
  for (const part of root.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part)
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('导出目录不能包含符号链接')
  }
  const info = await lstat(root)
  if ((info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('导出目录权限不安全')
}

async function readVerifiedArtifact(path, expected) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('导出文件权限不安全')
    if (info.size !== expected.length) throw new Error('导出文件大小校验失败')
    const actual = await handle.readFile()
    if (sha256(actual) !== sha256(expected)) throw new Error('导出文件摘要校验失败')
  } finally { await handle.close() }
}

export async function exportVideoSegmentReport(report, { taskId, name, format = 'docx' }, { root = defaultVideoExportRoot() } = {}) {
  if (!['docx', 'markdown'].includes(format)) throw new Error('--export-format 只能是 docx 或 markdown')
  if (typeof taskId !== 'string' || !taskId || taskId.length > 240 || /[\/\\\u0000-\u001f]/u.test(taskId)) throw new Error('导出任务身份无效')
  if (!root || resolve(root) !== root || root.split('/').includes('..')) throw new Error('导出根目录无效')
  const document = renderVideoReportMarkdown(report, { taskId, name })
  const data = format === 'docx' ? renderVideoReportDocx(report, { name }) : Buffer.from(document)
  if (data.length > 64 * 1024 * 1024) throw new Error('导出文件超过 64 MiB 范围')
  const digest = sha256(data), extension = format === 'docx' ? 'docx' : 'md'
  await assertDirectoryChain(root, true)
  const taskRoot = join(root, sha256(taskId))
  await assertDirectoryChain(taskRoot, true)
  const path = join(taskRoot, `${digest}.${extension}`)
  const temporary = join(taskRoot, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(data); await handle.sync(); await handle.close()
    await assertDirectoryChain(taskRoot)
    // Atomic no-clobber publication. Existing content-addressed exports are read
    // back and verified rather than replaced, including on concurrent exports.
    await link(temporary, path).catch(error => { if (error.code !== 'EEXIST') throw error })
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  await assertDirectoryChain(taskRoot)
  await readVerifiedArtifact(path, data)
  return { format, fileName: `${label(basename(name || '视频学习报告')).replace(/[\/\\]/gu, '_')}.${extension}`,
    path, mimeType: format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown',
    bytes: data.length, sha256: digest, totalSegments: report.segments.length, source: report.source }
}
