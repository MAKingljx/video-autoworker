import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createVideoCoverSubmissionAttemptStore } from '../lib/video-cover-submission-attempt-store.js'
import { imageSessionScope } from '../lib/image-profile-binding.js'

const operationId = 'a'.repeat(32)
const frameRef = 'b'.repeat(32)
const jobId = 'c'.repeat(32)
const firstPlan = {
  schema: 'aiworker-protected-cover/v1', eraseRegions: [],
  textLayers: [{ text: '老大的火车体验又升级了', role: 'title',
    box: { x: 20, y: 24, width: 1320, height: 320 }, style: 'large cinematic title' }],
}
const revisedPlan = {
  schema: 'aiworker-protected-cover/v1', eraseRegions: [],
  textLayers: [{ text: '老大的火车体验又升级了', role: 'title',
    box: { x: 20, y: 24, width: 1660, height: 480 }, style: 'large cinematic title' }],
}

function makeBinding(stateDir) {
  return { profile: 'qwen-current', targetAgentId: 'second-original', stateDir }
}

function request(binding, sessionKey = 'agent:second-original:cover-store-test', changes = {}) {
  return {
    operationId,
    frameRef,
    imageScope: imageSessionScope({ agentId: 'second-original', sessionKey }, binding),
    sessionKey,
    protected: firstPlan,
    ...changes,
  }
}

async function fixture(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'aiworker-cover-attempt-'))
  const binding = makeBinding(stateDir)
  let stamp = 1_795_000_000_000
  const create = () => createVideoCoverSubmissionAttemptStore({ stateDir, binding, now: () => ++stamp })
  const store = create()
  try {
    await store.start({ stateDir })
    await run({ stateDir, binding, store, create })
  } finally {
    await store.stop()
    await rm(stateDir, { recursive: true, force: true })
  }
}

test('records a private normalized first attempt without retaining the raw session key', async () => {
  await fixture(async ({ stateDir, binding, store }) => {
    const answer = await store.beginOrResume(request(binding))
    assert.equal(answer.action, 'new_submission')
    assert.equal(answer.status, 'unconfirmed')
    assert.equal(answer.revisionCount, 0)
    assert.deepEqual(answer.protected, firstPlan)

    const root = join(stateDir, 'aiworker-image-command')
    const path = join(root, 'video-cover-submission-attempts.json')
    const content = await readFile(path, 'utf8')
    assert.doesNotMatch(content, /agent:second-original:cover-store-test/u)
    assert.match(content, /"sessionKeySha256":"[a-f0-9]{64}"/u)
    assert.equal((await stat(root)).mode & 0o077, 0)
    assert.equal((await stat(path)).mode & 0o077, 0)
  })
})

test('an unconfirmed retry restores the original plan rather than accepting a changed layout', async () => {
  await fixture(async ({ binding, store }) => {
    await store.beginOrResume(request(binding))
    const retry = await store.beginOrResume(request(binding, undefined, { protected: revisedPlan }))
    assert.equal(retry.action, 'retry_unconfirmed')
    assert.equal(retry.status, 'unconfirmed')
    assert.deepEqual(retry.protected, firstPlan)
  })
})

test('a confirmed attempt survives restart and never opens another submit path for its frame', async () => {
  await fixture(async ({ stateDir, binding, store, create }) => {
    const input = request(binding)
    await store.beginOrResume(input)
    const accepted = await store.markSubmitted({ ...input, jobId })
    assert.equal(accepted.action, 'submitted')
    assert.equal(accepted.jobId, jobId)

    await store.stop()
    const restarted = create()
    await restarted.start({ stateDir })
    const recovered = await restarted.beginOrResume({ ...input, protected: revisedPlan })
    assert.equal(recovered.action, 'existing_submission')
    assert.equal(recovered.status, 'submitted')
    assert.equal(recovered.jobId, jobId)
    assert.deepEqual(recovered.protected, firstPlan)
    await restarted.stop()
  })
})

test('only an explicit no-job layout rejection permits one changed revision', async () => {
  await fixture(async ({ binding, store }) => {
    const input = request(binding)
    await store.beginOrResume(input)
    const rejected = await store.markRejected({ ...input, errorCode: 'protected_title_box_too_small' })
    assert.equal(rejected.action, 'rejected')
    assert.equal(rejected.status, 'rejected')

    const same = await store.beginOrResume(input)
    assert.equal(same.action, 'rejected_same_plan')
    const revision = await store.beginOrResume({ ...input, protected: revisedPlan })
    assert.equal(revision.action, 'revision_submission')
    assert.equal(revision.revisionCount, 1)
    assert.deepEqual(revision.protected, revisedPlan)

    await store.markRejected({ ...input, errorCode: 'VIDEO_COVER_TITLE_BOX_TOO_SMALL' })
    const exhausted = await store.beginOrResume({ ...input, protected: firstPlan })
    assert.equal(exhausted.action, 'revision_limit')
    assert.equal(exhausted.revisionCount, 1)
  })
})

test('cross-session, unknown and non-revisable updates fail closed', async () => {
  await fixture(async ({ binding, store }) => {
    const input = request(binding)
    await store.beginOrResume(input)
    const otherSession = 'agent:second-original:another-session'
    const otherScope = imageSessionScope({ agentId: 'second-original', sessionKey: otherSession }, binding)
    await assert.rejects(
      store.markSubmitted({ ...input, sessionKey: otherSession, jobId }),
      /video_cover_submission_attempt_identity_invalid/u,
    )
    await assert.rejects(
      store.markSubmitted({ ...input, imageScope: otherScope, sessionKey: otherSession, jobId }),
      /video_cover_submission_attempt_unknown_attempt/u,
    )
    await assert.rejects(
      store.markRejected({ ...input, errorCode: 'IMAGE_SERVICE_UNAVAILABLE' }),
      /video_cover_submission_attempt_rejection_not_revisable/u,
    )
    const stillUnconfirmed = await store.beginOrResume(input)
    assert.equal(stillUnconfirmed.action, 'retry_unconfirmed')
  })
})

test('a damaged ledger and capacity overflow are rejected before ownership can be restored', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aiworker-cover-attempt-damaged-'))
  const binding = makeBinding(stateDir)
  const root = join(stateDir, 'aiworker-image-command')
  const path = join(root, 'video-cover-submission-attempts.json')
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(path, '{"schema":"wrong","attempts":[]}', { mode: 0o600 })
    const damaged = createVideoCoverSubmissionAttemptStore({ stateDir, binding })
    await assert.rejects(damaged.start({ stateDir }), /video_cover_submission_attempt_store_invalid/u)

    await rm(path)
    const small = createVideoCoverSubmissionAttemptStore({ stateDir, binding, maxAttempts: 1 })
    await small.start({ stateDir })
    await small.beginOrResume(request(binding))
    await assert.rejects(
      small.beginOrResume(request(binding, undefined, { operationId: 'd'.repeat(32) })),
      /video_cover_submission_attempt_store_limit/u,
    )
    await small.stop()
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
