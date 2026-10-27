import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildVideoLearningResult } from '../lib/video-learning-result.mjs'
import { singleVideoStatePath } from '../lib/video-batch-state.mjs'

const execute = promisify(execFile)
const script = new URL('../scripts/submit-task.mjs', import.meta.url).pathname
const taskId = `video-command-${'a'.repeat(64)}`
const segments = Array.from({ length: 200 }, (_, index) => ({ index: index + 1, sourceName: '项目第一集.mp4', timeRange: `${index}:00-${index + 1}:00`, summary: `片段${index + 1}独立摘要` }))
async function fixture(callback, resultOutput = { segmentSummaries: segments, summary: '不应重新生成全片报告' }, status = 'succeeded') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'result-cli-')))
  const calls = []
  const server = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ runs: [{ taskId, status, output: resultOutput }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const run = async args => {
    const { stdout } = await execute(process.execPath, ['--import', 'data:text/javascript,import os from "node:os";import{syncBuiltinESMExports}from "node:module";os.homedir=()=>process.env.AIWORKER_TEST_EXPORT_HOME;syncBuiltinESMExports()', script, '--base-url', `http://127.0.0.1:${server.address().port}`, ...args], { env: { ...process.env, AIWORKER_TEST_EXPORT_HOME: root, AIWORKER_VIDEO_BATCH_DIR: join(root, 'batches') } })
    return JSON.parse(stdout)
  }
  try { return await callback({ run, calls, root }) }
  finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
}

test('CLI directory, exact segment and exports use one authoritative GET with bounded payloads', async () => fixture(async ({ run, calls, root }) => {
  const directory = await run(['--result', taskId, '--result-view', 'segments'])
  assert.equal(directory.kind, 'segments'); assert.equal(directory.name, '项目第一集.mp4')
  assert.equal(directory.totalSegments, 200); assert.equal(directory.items.length, 10)
  const item = await run(['--result', taskId, '--result-view', 'segment', '--segment-index', '199'])
  assert.equal(item.segment.summary, '片段199独立摘要')
  const artifact = await run(['--result', taskId, '--result-view', 'export', '--export-format', 'markdown'])
  assert.equal(artifact.kind, 'artifact'); assert.equal(artifact.artifact.totalSegments, 200)
  assert.ok(artifact.artifact.path.startsWith(join(root, 'ai-worker/state/video-autoworker/exports') + '/'))
  assert.match(await readFile(artifact.artifact.path, 'utf8'), /片段200独立摘要/u)
  assert.ok(!JSON.stringify(artifact).includes('片段199独立摘要'))
  const compatible = await run(['--result', taskId, '--result-offset', '0'])
  assert.equal(compatible.kind, 'report'); assert.equal(compatible.report.source, 'segment_summary')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.method === 'GET' && call.url.startsWith('/api/n8n/runs?taskId=')))
}))

test('CLI rejects incompatible pagination before network and does not merge ambiguous same-name tasks', async () => fixture(async ({ run, calls, root }) => {
  await assert.rejects(run(['--result', taskId, '--result-view', 'segment', '--segment-index', '1', '--result-offset', '0']), /不支持/u)
  await assert.rejects(run(['--result', taskId, '--result-view', 'segments', '--segment-limit', '200']), /超出范围/u)
  await assert.rejects(run(['--result', taskId, '--result-view', 'segment']), /缺少参数/u)
  assert.equal(calls.length, 0)
  for (const id of [taskId, `video-command-${'b'.repeat(64)}`]) {
    const path = singleVideoStatePath(id, join(root, 'batches'))
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: 'single', status: 'succeeded', updatedAt: '2026-09-15T00:00:00Z', items: [{ taskId: id, name: '项目第一集.mp4', status: 'succeeded', error: null }] }), { mode: 0o600 })
  }
  const ambiguous = await run(['--result', '项目第一集', '--result-view', 'export'])
  assert.equal(ambiguous.kind, 'matches'); assert.equal(ambiguous.total, 2)
  assert.equal(calls.length, 0)
}))

test('CLI partial result and export preserve failure gaps and explicitly describe partial completion', async () => {
  const learningResult = buildVideoLearningResult(3, [{ index: 2, timeRange: '00:00:05-00:00:10',
    stage: 'summary', errorCode: 'N8N_MEDIA_MODEL_OUTPUT_INVALID' }])
  await fixture(async ({ run }) => {
    const directory = await run(['--result', taskId, '--result-view', 'segments'])
    assert.equal(directory.status, 'succeeded')
    assert.equal(directory.displayStatus, '部分完成')
    assert.equal(directory.displayState, 'partial')
    assert.deepEqual(directory.items.map(item => item.index), [1, 3])
    const failed = await run(['--result', taskId, '--result-view', 'segment', '--segment-index', '2'])
    assert.equal(failed.segment, null)
    assert.equal(failed.failedSegments[0].index, 2)
    const exported = await run(['--result', taskId, '--result-view', 'export', '--export-format', 'markdown'])
    assert.match(await readFile(exported.artifact.path, 'utf8'), /部分完成：2 \/ 3 段/u)
    const brief = await run(['--status-brief', taskId])
    assert.equal(brief.displayState, 'partial')
    assert.deepEqual(brief.output.learningResult, learningResult)
  }, { learningResult, segmentSummaries: [{ ...segments[0], index: 1 }, { ...segments[2], index: 3 }] })
})

test('repair in progress can read a validated saved partial snapshot without dispatching work', async () => {
  const learningResult = buildVideoLearningResult(3, [{ index: 2, timeRange: '00:00:05-00:00:10',
    stage: 'summary', errorCode: 'N8N_MEDIA_MODEL_OUTPUT_INVALID' }])
  await fixture(async ({ run, calls }) => {
    const directory = await run(['--result', taskId, '--result-view', 'segments'])
    assert.equal(directory.status, 'running')
    assert.equal(directory.displayState, 'running')
    assert.equal(directory.savedPartialSnapshot, true)
    assert.match(directory.learningSummary, /^补学中，以下为已保存结果/u)
    assert.deepEqual(directory.items.map(item => item.index), [1, 3])
    const selected = await run(['--result', taskId, '--result-view', 'segment', '--segment-index', '3'])
    assert.equal(selected.segment.summary, segments[2].summary)
    assert.ok(calls.every(call => call.method === 'GET'))
  }, { learningResult, segmentSummaries: [segments[0], segments[2]] }, 'running')
  await fixture(async ({ run }) => {
    const result = await run(['--result', taskId, '--result-view', 'segments'])
    assert.equal(result.savedPartialSnapshot, undefined)
    assert.deepEqual(result.items, [])
  }, { segmentSummaries: [segments[0]] }, 'running')
})
