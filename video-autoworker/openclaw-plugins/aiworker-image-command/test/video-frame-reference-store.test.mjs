import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createVideoFrameReferenceStore } from '../lib/video-frame-reference-store.js'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4])
const sha256 = value => import('node:crypto').then(({ createHash }) => createHash('sha256').update(value).digest('hex'))
const scopeA = 'a'.repeat(64)
const scopeB = 'b'.repeat(64)
const sessionA = 'agent:second-original:frame-test-a'
const sessionB = 'agent:second-original:frame-test-b'

async function fixture(run) {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-video-frame-ref-')))
  let clock = 1_000
  const store = createVideoFrameReferenceStore({ stateDir, now: () => clock })
  const frameRef = 'c'.repeat(32)
  const candidate = {
    frameRef, segmentIndex: 3, timeRange: '00:00:10-00:00:15', frameTimeSeconds: 12.5,
    videoName: '北美火车短片.mp4', width: 1920, height: 1080, bytes: jpeg.length,
    sha256: await sha256(jpeg), mimeType: 'image/jpeg', bytesBuffer: jpeg,
  }
  try { await run({ stateDir, store, candidate, setNow: value => { clock = value } }) }
  finally { await store.stop(); await rm(stateDir, { recursive: true, force: true }) }
}

test('stores frames privately and resolves only for the issuing profile session', async () => {
  await fixture(async ({ stateDir, store, candidate }) => {
    const stored = await store.captureBatch({ imageScope: scopeA, sessionKey: sessionA, videoName: candidate.videoName, candidates: [candidate] })
    assert.equal(stored.length, 1)
    assert.equal(stored[0].frameRef, candidate.frameRef)
    assert.equal(stored[0].data, jpeg.toString('base64'))
    const resolved = await store.resolve({ frameRef: candidate.frameRef, imageScope: scopeA, sessionKey: sessionA })
    assert.deepEqual(await readFile(resolved.path), jpeg)
    assert.equal(resolved.receipt.videoName, candidate.videoName)
    const details = await stat(resolved.path)
    assert.equal(details.mode & 0o777, 0o600)
    await assert.rejects(store.resolve({ frameRef: candidate.frameRef, imageScope: scopeB, sessionKey: sessionA }),
      /video_frame_reference_scope_mismatch/u)
    await assert.rejects(store.resolve({ frameRef: candidate.frameRef, imageScope: scopeA, sessionKey: sessionB }),
      /video_frame_reference_scope_mismatch/u)
    assert.ok(resolved.path.startsWith(join(stateDir, 'media/video-frame-references') + '/'))
  })
})

test('requires the resolved video name when writing a frame receipt', async () => {
  await fixture(async ({ store, candidate }) => {
    await assert.rejects(store.captureBatch({ imageScope: scopeA, sessionKey: sessionA, candidates: [candidate] }),
      /video_frame_reference_capture_invalid/u)
  })
})

test('expires references and rejects unissued frame identifiers', async () => {
  await fixture(async ({ store, candidate, setNow }) => {
    await store.captureBatch({ imageScope: scopeA, sessionKey: sessionA, videoName: candidate.videoName, candidates: [candidate] })
    setNow(3_601_001)
    await assert.rejects(store.resolve({ frameRef: candidate.frameRef, imageScope: scopeA, sessionKey: sessionA }),
      /video_frame_reference_receipt_invalid|ENOENT/u)
    await assert.rejects(store.resolve({ frameRef: 'd'.repeat(32), imageScope: scopeA, sessionKey: sessionA }),
      /ENOENT/u)
  })
})

test('binds cover workflow state and frame references to the same scoped session', async () => {
  await fixture(async ({ store, candidate }) => {
    const workflow = await store.beginWorkflow({
      imageScope: scopeA, sessionKey: sessionA, videoName: candidate.videoName, segmentIndexes: [candidate.segmentIndex],
    })
    assert.match(workflow.operationId, /^[a-f0-9]{32}$/u)
    assert.deepEqual(await store.resolveWorkflow({
      operationId: workflow.operationId, imageScope: scopeA, sessionKey: sessionA,
    }), workflow)
    await store.captureBatch({
      imageScope: scopeA, sessionKey: sessionA, videoName: candidate.videoName,
      workflowId: workflow.operationId, candidates: [candidate],
    })
    await assert.doesNotReject(store.resolve({
      frameRef: candidate.frameRef, imageScope: scopeA, sessionKey: sessionA, workflowId: workflow.operationId,
    }))
    await assert.rejects(store.resolve({
      frameRef: candidate.frameRef, imageScope: scopeA, sessionKey: sessionA, workflowId: 'd'.repeat(32),
    }), /video_frame_reference_workflow_mismatch/u)
    await assert.rejects(store.resolveWorkflow({
      operationId: workflow.operationId, imageScope: scopeA, sessionKey: sessionB,
    }), /video_frame_reference_workflow_scope_mismatch/u)
  })
})
