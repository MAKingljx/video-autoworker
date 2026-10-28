// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeN8nVideoFrames, mediaTaskWorkspace, prepareN8nMedia, synthesizeN8nMediaResults, transcribeN8nMedia } from '@/lib/n8n-media-execution'
import { N8nVideoStopRequestedError, N8nChildExecutionLeaseLostError } from '@/lib/n8n-task-runs'
import type { N8nMediaExecutionControl } from '@/lib/n8n-media-control'
import { executeN8nModelRoute } from '@/lib/n8n-model-execution'

let root = ''
const controlForStop = () => {
  const controller = new AbortController(), reason = new N8nVideoStopRequestedError()
  const control: N8nMediaExecutionControl = { signal: controller.signal, assertActive: () => controller.signal.throwIfAborted(),
    commitIfActive: publish => { controller.signal.throwIfAborted(); return publish() } }
  return { controller, reason, control }
}
const perception = { summary: '已验证的片段', people: [], locations: [], actions: [], objects: [], environment: [],
  ocr: [], shotTypes: [], cameraMovement: [], composition: [], emotion: [] }
const routing = { config: { modelRouting: { nodes: { vision: { routeId: 'primary', fallbackRouteIds: ['fallback'] } } } } }
function registry(baseUrl?: string) {
  process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({ version: 1, resources: [], routes: ['primary', 'fallback'].map(id => ({
    id, label: id, location: 'local', transport: 'openai-compatible', model: id, enabled: true,
    capabilities: ['text', 'vision'], baseUrl: baseUrl || `http://127.0.0.1:${id === 'primary' ? 18094 : 18091}/v1`, maxImagesPerRequest: 1,
  })) })
}
async function metadata(taskId: string, audio = false) {
  const workspace = mediaTaskWorkspace(taskId)
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  for (const index of [1, 2]) await writeFile(join(workspace, `frame-${index}.jpg`), `frame ${index}`, { mode: 0o600 })
  if (audio) await writeFile(join(workspace, 'audio.wav'), 'retained audio', { mode: 0o600 })
  await writeFile(join(workspace, 'metadata.json'), JSON.stringify({ taskId, kind: 'prepared-video',
    durationSeconds: 10, sourceBytes: 100, sourceSha256: 'a'.repeat(64), audioAvailable: audio,
    audioSourceFile: audio ? 'audio.wav' : null, frameCount: 2, segmentCount: 2, segmentSeconds: 5,
    memoryMode: 'none', preparedAt: new Date().toISOString(), segments: [1, 2].map(index => ({
      index, startSeconds: (index - 1) * 5, durationSeconds: 5, audioFile: null, frameFiles: [`frame-${index}.jpg`],
    })),
  }), { mode: 0o600 })
  return workspace
}
async function waitReady(pathname: string) {
  for (let n = 0; n < 200; n++) { if (existsSync(pathname)) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('test-owned media command was not ready')
}
async function controlledHttpProvider(status: number) {
  let response: ServerResponse | undefined, requests = 0, started!: () => void
  const received = new Promise<void>(resolve => { started = resolve })
  const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(perception) } }] })
  const split = Math.floor(body.length / 2)
  const server = createServer((_request, outgoing) => {
    requests++; response = outgoing
    outgoing.writeHead(status, { 'Content-Type': 'application/json' })
    outgoing.write(body.slice(0, split)); started()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test provider did not bind')
  return { received, baseUrl: `http://127.0.0.1:${address.port}/v1`, count: () => requests,
    finish: () => response!.end(body.slice(split)), disconnect: () => response!.destroy(),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-stop-execution-'))
  process.env.AIWORKER_MEDIA_WORK_DIR = join(root, 'work')
  process.env.AIWORKER_MEDIA_INGEST_DIR = join(root, 'inbox')
  registry()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const key of ['AIWORKER_MEDIA_WORK_DIR', 'AIWORKER_MEDIA_INGEST_DIR', 'AIWORKER_MODEL_ROUTES_JSON', 'AIWORKER_FFMPEG_BIN']) delete process.env[key]
  await rm(root, { recursive: true, force: true })
})

describe('media stage stop propagation', () => {
  it('keeps a completed visual checkpoint and never falls back or writes failure ledgers after HTTP cancellation', async () => {
    const task = 'video-stop-vision', workspace = await metadata(task), { controller, reason, control } = controlForStop()
    let first: Buffer | null = null
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (fetcher.mock.calls.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(perception) } }] }))
      first = readFileSync(join(workspace, 'checkpoints/vision-001.json'))
      controller.abort(reason)
      throw init?.signal?.reason
    })
    await expect(analyzeN8nVideoFrames(task, routing, {}, control)).rejects.toBe(reason)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(reason.providerCancellation).toBe('provider_unconfirmed')
    expect(await readFile(join(workspace, 'checkpoints/vision-001.json'))).toEqual(first)
    expect(await readdir(join(workspace, 'checkpoints'))).toEqual(['vision-001.json'])
    await expect(analyzeN8nVideoFrames(task, routing, {}, control)).rejects.toBe(reason)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('discards a provider response that naturally completes after stop without issuing another request', async () => {
    const task = 'video-stop-late-http', workspace = await metadata(task), { controller, reason, control } = controlForStop()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort(reason)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(perception) } }] }))
    })
    await expect(analyzeN8nVideoFrames(task, routing, {}, control)).rejects.toBe(reason)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(reason.providerCancellation).toBe('confirmed')
    expect(existsSync(join(workspace, 'checkpoints/vision-001.json'))).toBe(false)
  })
  it.each(['success', 'disconnect', '504', 'lease-lost'] as const)('handles a real slow HTTP %s without publishing late work or invoking fallback', async outcome => {
    const task = `video-stop-real-http-${outcome}`, workspace = await metadata(task), provider = await controlledHttpProvider(outcome === '504' ? 504 : 200)
    registry(provider.baseUrl)
    const { controller, control } = controlForStop()
    const reason = outcome === 'lease-lost' ? new N8nChildExecutionLeaseLostError() : new N8nVideoStopRequestedError()
    let settled = false
    const running = analyzeN8nVideoFrames(task, routing, {}, control).catch(error => error).finally(() => { settled = true })
    try {
      await provider.received
      controller.abort(reason)
      await new Promise(resolve => setTimeout(resolve, 40))
      if (outcome === 'lease-lost') expect(settled).toBe(true)
      else { expect(settled).toBe(false); outcome === 'disconnect' ? provider.disconnect() : provider.finish() }
      expect(await running).toBe(reason)
      expect((reason as Error & { providerCancellation?: string }).providerCancellation).toBe(outcome === 'success' ? 'confirmed' : 'provider_unconfirmed')
      expect(provider.count()).toBe(1)
      expect(existsSync(join(workspace, 'checkpoints/vision-001.json'))).toBe(false)
      expect(existsSync(join(workspace, 'checkpoints/vision-failed-001.json'))).toBe(false)
    } finally { if (!controller.signal.aborted) controller.abort(reason); await provider.close(); await running }
  })
  it('keeps a timed-out real provider request unconfirmed after a user stop', async () => {
    const provider = await controlledHttpProvider(200), { controller, reason, control } = controlForStop()
    const running = executeN8nModelRoute({ id: 'local-timeout', label: 'local timeout', description: '', location: 'local',
      transport: 'openai-compatible', model: 'test', baseUrl: provider.baseUrl, enabled: true,
      timeoutSeconds: 0.1, thinking: 'off', capabilities: ['text'], systemPrompt: '',
    }, { nodeKey: 'executor', input: {}, sessionKey: 'unused', delivery: { mode: 'none' }, executionControl: control }).catch(error => error)
    try {
      await provider.received; controller.abort(reason)
      expect(await running).toBe(reason)
      expect(reason.providerCancellation).toBe('provider_unconfirmed')
      expect(provider.count()).toBe(1)
    } finally { if (!controller.signal.aborted) controller.abort(reason); await provider.close(); await running }
  })
  it('does not turn a cancelled segment summary into an individual retry or a failure record', async () => {
    const task = 'video-stop-finalize', workspace = await metadata(task), { controller, reason, control } = controlForStop()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { controller.abort(reason); throw reason })
    await expect(synthesizeN8nMediaResults(task, routing, {}, { timeline: [{ index: 1, timeRange: '00:00:00-00:00:05',
      transcript: '已保存语音', visualAnalysis: '已保存画面' }] }, control)).rejects.toBe(reason)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(existsSync(join(workspace, 'checkpoints/segment-summary-001.json'))).toBe(false)
  })
  it('terminates its audio command and preserves the audio source without publishing a result', async () => {
    const task = 'video-stop-audio', workspace = await metadata(task, true), marker = join(root, 'audio-ready')
    const command = join(root, 'fake-asr')
    await writeFile(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)\n`, { mode: 0o700 })
    await chmod(command, 0o700)
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({ version: 1, routes: [], resources: [{
      id: 'fake-asr', label: 'isolated audio', kind: 'speech-recognition', model: 'fake', enabled: true,
      capabilities: ['transcription'], runtime: { type: 'cli', command },
    }] })
    const { controller, reason, control } = controlForStop()
    const running = transcribeN8nMedia(task, { config: { media: { audioResourceId: 'fake-asr' } } }, control).catch(error => error)
    try { await waitReady(marker); controller.abort(reason); expect(await running).toBe(reason) }
    finally { if (!controller.signal.aborted) controller.abort(reason); await running }
    expect(reason.providerCancellation).toBe('confirmed')
    expect(await readFile(join(workspace, 'audio.wav'), 'utf8')).toBe('retained audio')
    expect(existsSync(join(workspace, 'checkpoints/audio-full.json'))).toBe(false)
  }, 10_000)
  it('stops prepare during audio extraction without falling through to uniform frame extraction', async () => {
    const inbox = process.env.AIWORKER_MEDIA_INGEST_DIR!, marker = join(root, 'ffmpeg-ready'), command = join(root, 'fake-ffmpeg')
    const key = '123e4567-e89b-42d3-a456-426614174000.mp4'
    await mkdir(inbox, { mode: 0o700 }); await writeFile(join(inbox, key), 'controlled source', { mode: 0o600 })
    await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('-vn')){fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)}else{process.stderr.write('Duration: 00:00:10.000\\nStream #0:0 Video: h264\\nStream #0:1 Audio: aac\\n');process.exitCode=1}\n`, { mode: 0o700 })
    await chmod(command, 0o700); process.env.AIWORKER_FFMPEG_BIN = command
    const { controller, reason, control } = controlForStop()
    const running = prepareN8nMedia('video-stop-prepare', { config: {} }, { videoKey: key }, control).catch(error => error)
    try { await waitReady(marker); controller.abort(reason); expect(await running).toBe(reason) }
    finally { if (!controller.signal.aborted) controller.abort(reason); await running }
    expect(reason.providerCancellation).toBe('confirmed')
    expect(await readFile(join(inbox, key), 'utf8')).toBe('controlled source')
    expect(existsSync(join(mediaTaskWorkspace('video-stop-prepare'), 'metadata.json'))).toBe(false)
  }, 10_000)
})
