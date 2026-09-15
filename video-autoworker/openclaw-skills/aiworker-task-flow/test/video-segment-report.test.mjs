import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  compatibleVideoReport, exportVideoSegmentReport, MAX_SEGMENT_BYTES,
  renderVideoReportDocx, renderVideoReportMarkdown, selectVideoSegmentReport, segmentDirectory, singleSegment,
} from '../lib/video-segment-report.mjs'

const execute = promisify(execFile)
const metadata = { taskId: `video-command-${'a'.repeat(64)}`, name: '项目片段 & <最新>.mp4' }
const rows = Array.from({ length: 200 }, (_, i) => ({ index: i + 1, startTime: `${i}:00`, endTime: `${i + 1}:00`, summary: `独立摘要${i + 1}：项目更新证据。${'甲😀'.repeat(120)}` }))
const report = selectVideoSegmentReport({ segmentSummaries: [...rows].reverse(), summary: '不要使用全片汇总' })
async function withRoot(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'segment-report-')))
  try { return await callback(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('200 saved segments have bounded previews and precise single selection without model work', () => {
  const page = segmentDirectory(report, 10, 20)
  assert.equal(page.totalSegments, 200)
  assert.equal(page.items.length, 20)
  assert.equal(page.items[0].index, 11)
  assert.equal(page.nextSegmentOffset, 30)
  assert.ok(page.items.every(row => [...row.preview].length === 160 && !Object.hasOwn(row, 'summary')))
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 24 * 1024)
  assert.equal(singleSegment(report, 199).segment.summary, rows[198].summary)
  assert.equal(segmentDirectory(report, 200).nextSegmentOffset, null)
  assert.throws(() => segmentDirectory(report, 201), /超出范围/u)
  assert.throws(() => segmentDirectory(report, 0, 21), /超出范围/u)
  assert.throws(() => singleSegment(report, 0), /超出范围/u)
  assert.throws(() => singleSegment(report, 201), /未找到/u)
})

test('single summary truncation preserves complete UTF8 and explicitly marks remaining content', () => {
  const long = selectVideoSegmentReport({ segmentSummaries: [{ index: 1, summary: '😀中'.repeat(5000) }] })
  const result = singleSegment(long, 1).segment
  assert.equal(result.truncated, true)
  assert.equal(result.totalBytes, 35000)
  assert.ok(Buffer.byteLength(result.summary) <= MAX_SEGMENT_BYTES)
  assert.equal(Buffer.from(result.summary).toString('utf8'), result.summary)
  assert.ok(!result.summary.includes('�'))
})

test('historical chapters and timeline retain their evidence meaning; full summary is never a segment', () => {
  const chapters = selectVideoSegmentReport({ chapters: [{ index: 1, startTime: '00:00', endTime: '05:00', summary: '历史章节' }], summary: '历史全片' })
  assert.equal(chapters.source, 'legacy_chapter')
  assert.equal(chapters.segments[0].summary, '历史章节')
  const timeline = selectVideoSegmentReport({ timeline: [{ index: 1, timeRange: '00:00-01:00', transcript: '语音证据', visualAnalysis: '画面证据' }], summary: '历史全片' })
  assert.equal(timeline.source, 'legacy_timeline')
  assert.match(timeline.segments[0].summary, /未生成融合摘要/u)
  assert.match(timeline.segments[0].summary, /语音证据/u)
  const legacy = selectVideoSegmentReport({ summary: '仅有全片报告' })
  assert.equal(legacy.source, 'legacy_report')
  assert.equal(segmentDirectory(legacy).totalSegments, 0)
  assert.throws(() => singleSegment(legacy, 1), /历史全片报告/u)
  assert.equal(compatibleVideoReport(legacy, metadata).text, '仅有全片报告')
  assert.match(compatibleVideoReport(chapters, metadata).text, /历史章节 1/u)
  assert.throws(() => selectVideoSegmentReport({ segmentSummaries: [{ index: 1, summary: 'a' }, { index: 1, summary: 'b' }] }), /重复/u)
})

test('programmatic export contains all 200 summaries in order and idempotently validates bytes', async () => withRoot(async root => {
  const artifact = await exportVideoSegmentReport(report, { ...metadata, format: 'markdown' }, { root })
  const body = await readFile(artifact.path, 'utf8')
  let previous = -1
  for (const row of rows) {
    const position = body.indexOf(row.summary)
    assert.ok(position > previous)
    previous = position
  }
  assert.equal(artifact.totalSegments, 200)
  assert.equal(artifact.sha256, createHash('sha256').update(body).digest('hex'))
  assert.deepEqual(await exportVideoSegmentReport(report, { ...metadata, format: 'markdown' }, { root }), artifact)
  assert.ok(Buffer.byteLength(JSON.stringify(artifact)) < 1500)
  const other = await exportVideoSegmentReport(report, { ...metadata, taskId: `video-command-${'b'.repeat(64)}`, format: 'markdown' }, { root })
  assert.notEqual(dirname(other.path), dirname(artifact.path))
  await writeFile(artifact.path, 'corrupt', { mode: 0o600 })
  await assert.rejects(exportVideoSegmentReport(report, { ...metadata, format: 'markdown' }, { root }), /校验失败/u)
}))

test('DOCX is a valid OOXML ZIP with correct escapes and black headings; all fragments survive', async () => withRoot(async root => {
  const artifact = await exportVideoSegmentReport(report, metadata, { root })
  const { stdout } = await execute('python3', ['-c', `import sys,zipfile,xml.etree.ElementTree as E,json
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for n in z.namelist(): E.fromstring(z.read(n))
 doc=E.fromstring(z.read('word/document.xml'))
 texts=[t.text or '' for t in doc.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')]
 print(json.dumps(texts,ensure_ascii=False))`, artifact.path], { maxBuffer: 2 * 1024 * 1024 })
  const paragraphs = JSON.parse(stdout)
  assert.equal(paragraphs[0], metadata.name)
  for (const row of rows) assert.ok(paragraphs.includes(row.summary))
  const bytes = await readFile(artifact.path)
  assert.ok(bytes.includes(Buffer.from('w:val="000000"')))
  assert.ok(bytes.includes(Buffer.from('w:val="Title"')))
  assert.deepEqual(renderVideoReportDocx(report, metadata), bytes)
}))

test('exports reject traversal, symlink directories and symlink content-addressed destinations', async () => withRoot(async root => {
  await assert.rejects(exportVideoSegmentReport(report, { ...metadata, taskId: '../other' }, { root }), /身份无效/u)
  await assert.rejects(exportVideoSegmentReport(report, metadata, { root: root + '/../other' }), /根目录无效/u)
  const real = join(root, 'real'), alias = join(root, 'alias')
  await mkdir(real, { mode: 0o700 }); await symlink(real, alias)
  await assert.rejects(exportVideoSegmentReport(report, metadata, { root: alias }), /符号链接/u)
  const taskDir = join(root, createHash('sha256').update(metadata.taskId).digest('hex'))
  await symlink(real, taskDir)
  await assert.rejects(exportVideoSegmentReport(report, metadata, { root }), /符号链接/u)
  await rm(taskDir)
  const artifact = await exportVideoSegmentReport(report, metadata, { root })
  await rm(artifact.path)
  const target = join(real, 'target.docx'); await writeFile(target, 'untouched', { mode: 0o600 })
  await symlink(target, artifact.path)
  await assert.rejects(exportVideoSegmentReport(report, metadata, { root }))
  assert.equal(await readFile(target, 'utf8'), 'untouched')
}))


test('exports show human content only and stored Markdown headings never change DOCX outline', async () => withRoot(async root => {
  const content = selectVideoSegmentReport({ segmentSummaries: [{ index: 1, timeRange: '00:00-01:00', summary: '# 观察标题\n## 摘要中的子标题\n用户能够看到中文原始证据。' }] })
  const markdown = renderVideoReportMarkdown(content, metadata)
  assert.ok(!markdown.includes(metadata.taskId))
  assert.ok(!markdown.includes('segment_summary'))
  assert.match(markdown, /片段数量：1/u)
  assert.ok(markdown.includes('\\# 观察标题'))
  const artifact = await exportVideoSegmentReport(content, metadata, { root })
  const { stdout } = await execute('python3', ['-c', `import sys,zipfile,xml.etree.ElementTree as E,json
with zipfile.ZipFile(sys.argv[1]) as z:
 doc=E.fromstring(z.read('word/document.xml'))
 ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 print(json.dumps([{'style':p.find('w:pPr/w:pStyle',ns).get('{'+ns['w']+'}val'),'text':''.join(t.text or '' for t in p.findall('.//w:t',ns))} for p in doc.findall('.//w:p',ns)],ensure_ascii=False))`, artifact.path])
  const paragraphs = JSON.parse(stdout)
  assert.equal(paragraphs.filter(p => p.style === 'Heading1').length, 1)
  assert.equal(paragraphs.find(p => p.text === '# 观察标题').style, 'Normal')
  assert.equal(paragraphs.find(p => p.text === '## 摘要中的子标题').style, 'Normal')
  assert.ok(!paragraphs.some(p => p.text.includes(metadata.taskId) || p.text.includes('segment_summary')))
}))
