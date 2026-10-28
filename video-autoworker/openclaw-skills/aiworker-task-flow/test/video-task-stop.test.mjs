import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deriveMaterialIdFromFile, sourceIdentity, VideoTaskStopRequestedError,
  VideoTaskStopUnconfirmedError, copyDarwinVideoFileFromAnchor, sha256FileHandle } from '../lib/media-ingest.mjs'
import { submitStagedVideoTask, submitVideoTask } from '../lib/video-task.mjs'

const chunkBytes = 8 * 1024 * 1024, requestId = 'a'.repeat(64)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'video-task-stop-')), source = join(root, 'source.mp4'), inbox = join(root, 'inbox')
  await mkdir(inbox); await writeFile(join(inbox, 'other-task.mp4'), 'sibling-retained')
  const writer = await open(source, 'wx')
  try {
    for (const value of [1, 2, 3]) await writer.write(Buffer.alloc(chunkBytes, value))
    await writer.sync()
  } finally { await writer.close() }
  return { root, source, inbox, original: sourceIdentity(await stat(source)), journalPath: join(root, 'original-journal.json') }
}
function durableRequest(f, overrides = {}) {
  const state = { journal: null, triggers: 0, cleanups: 0, settled: 0 }
  const persist = async () => writeFile(f.journalPath, JSON.stringify(state.journal), { mode: 0o600 })
  const request = { client: { trigger: async () => { state.triggers++; return { taskId: 'stop-task', status: 'accepted' } } },
    bindingId: 2, taskId: 'stop-task', idempotencyKey: 'stop-idem', batchId: 'stop-batch', prompt: 'isolated stop',
    videoFile: f.source, inboxRoot: f.inbox, expectedSourceIdentity: f.original,
    onStagingPrepared: async recovery => { state.journal = recovery; await persist() },
    onSourceStaged: async (identity, artifact) => {
      state.journal = { ...state.journal, phase: 'source_finalized', sourceIdentity: identity, incomingIdentity: artifact.incomingIdentity }
      await persist()
    },
    onStagingCompleted: async staged => {
      state.journal = { ...state.journal, phase: 'staged', stagedIdentity: staged.stagedIdentity,
        materialId: staged.materialId, contentSha256: staged.contentSha256 }
      await persist()
    },
    onLocalCleanupStarted: async () => { state.cleanups++ }, onMediaSettled: async () => { state.settled++ }, ...overrides }
  return { state, request }
}
async function preserved(f, state) {
  assert.deepEqual(sourceIdentity(await stat(f.source)), f.original)
  assert.equal(await readFile(join(f.inbox, 'other-task.mp4'), 'utf8'), 'sibling-retained')
  assert.equal(state.cleanups, 0); assert.equal(state.settled, 0)
}

test('already stopped producer creates no staging files and makes no trigger', async () => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId)
  try {
    const { state, request } = durableRequest(f, { control: { async assertActive() { throw reason } } })
    await assert.rejects(submitVideoTask(request), error => error === reason)
    assert.deepEqual(await readdir(f.inbox), ['other-task.mp4']); assert.equal(state.triggers, 0)
    await preserved(f, state)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('owned file hashing checks a real read descriptor at each 8 MiB boundary', async () => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId), handle = await open(f.source, 'r')
  const read = handle.read.bind(handle)
  let bytes = 0
  handle.read = async (...args) => { const result = await read(...args); bytes += result.bytesRead; return result }
  try {
    await assert.rejects(sha256FileHandle(handle, { control: { async assertActive() { if (bytes >= chunkBytes) throw reason } } }), error => error === reason)
    assert.equal(bytes, chunkBytes)
  } finally { await handle.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('stop after journaling the empty destination closes both real descriptors before surfacing requested stop', async t => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId), probe = await open(f.source, 'r')
  const prototype = Object.getPrototypeOf(probe), originalStat = prototype.stat, descriptors = new Set()
  await probe.close()
  t.mock.method(prototype, 'stat', async function (...args) { descriptors.add(this.fd); return originalStat.apply(this, args) })
  try {
    const { state, request } = durableRequest(f), prepared = request.onStagingPrepared
    let stopped = false
    request.onStagingPrepared = async recovery => { await prepared(recovery); stopped = true }
    request.control = { async assertActive() { if (stopped) throw reason } }
    await assert.rejects(submitVideoTask(request), error => error === reason)
    assert.equal(descriptors.size, 2)
    for (const descriptor of descriptors) assert.throws(() => fstatSync(descriptor), error => error.code === 'EBADF')
    assert.equal((await stat(join(f.inbox, state.journal.incomingName))).size, 0)
    assert.equal(state.triggers, 0); await preserved(f, state)
  } finally { t.mock.restoreAll(); await rm(f.root, { recursive: true, force: true }) }
})

test('clone control checks before and after the single owned clone and preserves a completed clone on stop', async () => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId), destination = join(f.inbox, 'clone.mp4')
  let stopped = true, copies = 0
  const options = { control: { async assertActive() { if (stopped) throw reason } },
    async copyFileImpl(source, target) { copies++; await copyFile(source, target); stopped = true } }
  try {
    await assert.rejects(copyDarwinVideoFileFromAnchor(f.source, destination, options), error => error === reason)
    assert.equal(copies, 0)
    stopped = false
    await assert.rejects(copyDarwinVideoFileFromAnchor(f.source, destination, options), error => error === reason)
    assert.equal(copies, 1); assert.equal((await stat(destination)).size, f.original.size)
    assert.deepEqual(sourceIdentity(await stat(f.source)), f.original)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const mode of ['stop', 'lease-drift']) test(`copy ${mode} preserves its synced partial journal and never triggers or cleans up`, async () => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId)
  try {
    const { state, request } = durableRequest(f)
    request.control = { async assertActive() {
      if (!state.journal) return
      const details = await stat(join(f.inbox, state.journal.incomingName))
      if (details.size >= chunkBytes) throw mode === 'stop' ? reason : new Error('owned_worker_lease_changed')
    } }
    await assert.rejects(submitVideoTask(request), error => mode === 'stop' ? error === reason : error instanceof VideoTaskStopUnconfirmedError)
    const journal = JSON.parse(await readFile(f.journalPath, 'utf8')), incoming = join(f.inbox, journal.incomingName)
    assert.equal(journal.phase, 'prepared'); assert.equal((await stat(incoming)).size, chunkBytes)
    assert.equal((await stat(incoming)).ino, journal.incomingIdentity.ino)
    assert.equal(state.triggers, 0); await preserved(f, state)
    // A fresh process can safely reopen the original journal and bounded inode
    // after the attempt has closed its writer. It performs no recovery cleanup.
    const result = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import{readFile,stat}from'node:fs/promises';import{join}from'node:path';const j=JSON.parse(await readFile(process.argv[1],'utf8'));const s=await stat(join(process.argv[2],j.incomingName));if(s.ino!==j.incomingIdentity.ino)throw Error('identity');console.log(JSON.stringify({bytes:s.size,phase:j.phase}))",
      f.journalPath, f.inbox], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(result), { bytes: chunkBytes, phase: 'prepared' })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal((await stat(incoming)).size, chunkBytes)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('hash stop keeps the full incoming file and source and does not publish or submit a staged video', async () => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId)
  try {
    const { state, request } = durableRequest(f)
    let hashChecks = 0
    request.control = { async assertActive() {
      if (state.journal?.phase === 'source_finalized' && ++hashChecks === 4) throw reason
    } }
    await assert.rejects(submitVideoTask(request), error => error === reason)
    const incoming = join(f.inbox, state.journal.incomingName)
    assert.equal((await stat(incoming)).size, f.original.size)
    assert.equal(await deriveMaterialIdFromFile(incoming), await deriveMaterialIdFromFile(f.source))
    assert.deepEqual((await readdir(f.inbox)).sort(), [state.journal.incomingName, 'other-task.mp4'].sort())
    assert.equal(state.triggers, 0); await preserved(f, state)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a controlled durable IO failure leaves cleanup to the original owner instead of racing a late stop', async () => {
  const f = await fixture()
  try {
    const { state, request } = durableRequest(f, { control: { async assertActive() {} } })
    const finalized = request.onSourceStaged
    request.onSourceStaged = async (...args) => { await finalized(...args); throw new Error('isolated owner persistence failure') }
    await assert.rejects(submitVideoTask(request), /isolated owner persistence failure/u)
    assert.equal((await stat(join(f.inbox, state.journal.incomingName))).size, f.original.size)
    assert.equal(state.triggers, 0); await preserved(f, state)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a controlled rejected submission keeps its staged handoff for the original owner', async () => {
  const f = await fixture()
  try {
    const { state, request } = durableRequest(f, { control: { async assertActive() {} } })
    request.client = { async trigger() { state.triggers++; throw Object.assign(new Error('isolated rejection'), { status: 400 }) },
      async getRun() { return null } }
    await assert.rejects(submitVideoTask(request), /isolated rejection/u)
    assert.equal(state.journal.phase, 'staged')
    assert.equal((await stat(join(f.inbox, state.journal.videoKey))).size, f.original.size)
    assert.equal(state.triggers, 1); await preserved(f, state)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const mode of ['before-trigger', 'after-trigger']) test(`${mode} stop preserves the original staged handoff without retry or cleanup`, async () => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId)
  try {
    const { state, request } = durableRequest(f)
    let stopped = false
    request.control = { async assertActive() { if (stopped) throw reason } }
    const completed = request.onStagingCompleted
    request.onStagingCompleted = async staged => { await completed(staged); if (mode === 'before-trigger') stopped = true }
    request.client.trigger = async () => { state.triggers++; stopped = true; return { taskId: 'stop-task', status: 'accepted' } }
    await assert.rejects(submitVideoTask(request), error => error === reason)
    assert.equal(state.journal.phase, 'staged')
    const stagedPath = join(f.inbox, state.journal.videoKey)
    assert.equal((await stat(stagedPath)).size, f.original.size)
    assert.equal(await deriveMaterialIdFromFile(stagedPath), await deriveMaterialIdFromFile(f.source))
    assert.equal(state.triggers, mode === 'before-trigger' ? 0 : 1)
    await preserved(f, state)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a resumed staged handoff stops during bounded verification without triggering or deleting it', async () => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId)
  try {
    const videoKey = '00000000-0000-4000-8000-000000000010.mp4', stagedPath = join(f.inbox, videoKey)
    const bytes = await readFile(f.source); await writeFile(stagedPath, bytes)
    const staged = { sourcePath: f.source, sourceBytes: f.original.size, videoKey, materialId: 'MATERIAL-existing',
      stagedPath, inbox: f.inbox, stagedIdentity: sourceIdentity(await stat(stagedPath)),
      contentSha256: createHash('sha256').update(bytes).digest('hex'), ownershipToken: '00000000-0000-4000-8000-000000000010',
      taskId: 'stop-task', idempotencyKey: 'stop-idem', batchId: 'stop-batch' }
    let checks = 0, triggers = 0
    await assert.rejects(submitStagedVideoTask({ bindingId: 2, taskId: 'stop-task', idempotencyKey: 'stop-idem', batchId: 'stop-batch',
      prompt: 'isolated', control: { async assertActive() { if (++checks === 3) throw reason } },
      client: { async trigger() { triggers++; return {} } },
    }, staged), error => error === reason)
    assert.equal(triggers, 0); assert.deepEqual(await readFile(stagedPath), bytes)
    assert.deepEqual(sourceIdentity(await stat(f.source)), f.original)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('an admitted source identity mismatch remains fail closed with no trigger or staged artifacts', async () => {
  const f = await fixture()
  try {
    const { state, request } = durableRequest(f, { expectedSourceIdentity: { ...f.original, ino: f.original.ino + 1 },
      control: { async assertActive() {} } })
    await assert.rejects(submitVideoTask(request), /视频源文件在收件期间发生变化/u)
    assert.equal(state.triggers, 0); assert.deepEqual(await readdir(f.inbox), ['other-task.mp4'])
    await preserved(f, state)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a failed owned-writer sync is unconfirmed and never becomes a positive stop or destructive cleanup', async t => {
  const f = await fixture(), reason = new VideoTaskStopRequestedError(requestId)
  const probe = await open(f.source, 'r'), prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync
  await probe.close()
  let ownedInode = null, failSync = true
  t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).ino === ownedInode && failSync) { failSync = false; throw Object.assign(new Error('isolated sync failure'), { code: 'EIO' }) }
    return originalSync.call(this)
  })
  try {
    const { state, request } = durableRequest(f)
    const prepared = request.onStagingPrepared
    request.onStagingPrepared = async recovery => { ownedInode = recovery.incomingIdentity.ino; await prepared(recovery) }
    request.control = { async assertActive() {
      if (state.journal && (await stat(join(f.inbox, state.journal.incomingName))).size >= chunkBytes) throw reason
    } }
    await assert.rejects(submitVideoTask(request), error => error instanceof VideoTaskStopUnconfirmedError
      && error.code === 'N8N_VIDEO_STAGING_STOP_UNCONFIRMED' && error.stopRequestId === requestId)
    assert.equal((await stat(join(f.inbox, state.journal.incomingName))).size, chunkBytes)
    assert.equal(state.triggers, 0); await preserved(f, state)
  } finally { t.mock.restoreAll(); await rm(f.root, { recursive: true, force: true }) }
})
