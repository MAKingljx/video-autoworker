import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import Database from 'better-sqlite3'
import { discoverDeploymentEnvironment, parseDeploymentEnvironment } from './lib/deployment-discovery.mjs'
import { observeRuntime, publicRuntimeReceiptStatus, readCurrentRuntimeReceipt,
  runtimeDigest, writeCurrentRuntimeReceipt } from './lib/runtime-receipt.mjs'
import { applyRuntimeRetention, planRuntimeRetention } from './lib/runtime-retention.mjs'
import { releaseComponentSummary } from './release-impact-deploy.mjs'

let root, runDir, releasesDir, databasePath, platformPath, references
const commit = 'a'.repeat(40), releaseId = `${commit}-runtime`
const sha = 'b'.repeat(64)
const directory = pathname => { mkdirSync(pathname, { recursive: true, mode: 0o700 }); chmodSync(pathname, 0o700); return pathname }
const write = (pathname, value) => { directory(pathname.slice(0, pathname.lastIndexOf('/'))); writeFileSync(pathname,
  typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); chmodSync(pathname, 0o600) }
const inspectProcess = () => ({ status: 'aligned', process: { pid: process.pid, alive: true, authoritativeDatabaseOpen: true } })
const json = pathname => JSON.parse(readFileSync(pathname, 'utf8'))

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-receipt-test-')))
  runDir = directory(join(root, 'run')); releasesDir = directory(join(root, 'releases'))
  databasePath = join(root, 'mission.db'); const db = new Database(databasePath)
  db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO schema_migrations VALUES (?)').run('059_director_evidence_projection_receipts'); db.close()
  chmodSync(databasePath, 0o600)
  platformPath = join(root, '.config/video-autoworker/platform.env')
  write(platformPath, `MISSION_CONTROL_DB_PATH=${databasePath}\nMC_AUTH_MODE=openclaw-loopback\nMC_OPENCLAW_TENANT_ID=1\nMC_OPENCLAW_WORKSPACE_ID=1\n`)
  const releaseRoot = directory(join(releasesDir, releaseId, 'standalone'))
  write(join(releaseRoot, 'server.js'), 'server')
  const manifest = { schemaVersion: 2, artifactContent: { digest: sha },
    files: [{ path: 'server.js', bytes: 6 }], directories: [], symlinks: [] }
  write(join(releaseRoot, 'release-manifest.json'), manifest)
  write(join(releaseRoot, 'release-provenance.json'), { gitCommit: commit })
  write(join(releaseRoot, 'package.json'), { version: '2.0.1' })
  write(join(runDir, 'router-state.json'), { schema: 'video-autoworker-standalone-router/v1',
    generation: 7, active: 'blue', previous: null, slots: { blue: { releaseId }, green: { releaseId: 'unbound-green' } } })
  write(join(runDir, 'slots/blue.json'), { releaseId, releaseRoot,
    manifestSha256: runtimeDigest(readFileSync(join(releaseRoot, 'release-manifest.json'))) })
  references = [{ name: 'platform', kind: 'file', path: platformPath }]
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function receipt() {
  const observation = await observeRuntime({ runDir, databasePath, references, inspectProcess })
  return writeCurrentRuntimeReceipt({ runDir, databasePath, observation, components: { control: { sourceCommit: commit } },
    evidence: { acceptance: 'verified', settlement: 'verified', operationsRoot: directory(join(root, 'operations')) } })
}

test('one receipt stores actual 059 and an explicitly absent optional editing schema', async () => {
  const before = readFileSync(databasePath)
  const value = await receipt()
  assert.equal(value.database.latestMigration, '059_director_evidence_projection_receipts')
  assert.equal(value.database.videoEditingMigrationPresent, false)
  assert.deepEqual(readFileSync(databasePath), before)
  const status = await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess })
  assert.equal(status.currentState, 'ready')
  assert.equal(lstatSync(join(runDir, 'current-runtime.json')).mode & 0o777, 0o600)
  assert.equal(JSON.stringify(publicRuntimeReceiptStatus(status)).includes(root), false)
})

test('reads report absence without creating a receipt', async () => {
  assert.equal((await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess })).currentState, 'uninitialized')
  assert.equal(existsSync(join(runDir, 'current-runtime.json')), false)
})

for (const missing of ['manifest', 'slot', 'platform']) {
  test(`an existing receipt with a missing ${missing} reports drift, not uninitialized`, async () => {
    await receipt()
    const pathname = missing === 'manifest' ? join(releasesDir, releaseId, 'standalone/release-manifest.json')
      : missing === 'slot' ? join(runDir, 'slots/blue.json') : platformPath
    rmSync(pathname)
    const status = await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess })
    assert.equal(status.currentState, 'drift')
    assert.equal(status.errorCode, 'runtime_receipt_unverifiable')
    assert.equal(existsSync(join(runDir, 'current-runtime.json')), true)
  })
}

test('a missing worker reference does not erase the existence of a release receipt', async () => {
  await receipt()
  const pathname = join(runDir, 'current-runtime.json'), value = json(pathname)
  value.components.worker = { stateDir: join(root, 'missing-worker'), manifestPath: join(root, 'missing-worker/manifest.json') }
  write(pathname, value)
  const status = await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess,
    readWorker: async () => { throw Object.assign(new Error('missing worker'), { code: 'ENOENT' }) } })
  assert.equal(status.currentState, 'drift')
})

test('route, artifact file, schema and component changes report drift without changing the receipt', async () => {
  await receipt(); const original = readFileSync(join(runDir, 'current-runtime.json'))
  write(join(releasesDir, releaseId, 'standalone/server.js'), 'changed-server')
  assert.equal((await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess })).currentState, 'drift')
  assert.deepEqual(readFileSync(join(runDir, 'current-runtime.json')), original)
  write(platformPath, `MISSION_CONTROL_DB_PATH=${databasePath}\nMC_AUTH_MODE=changed\n`)
  assert.equal((await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess })).currentState, 'drift')
})

test('actual process identity failures never become healthy receipt status', async () => {
  await receipt()
  assert.equal((await readCurrentRuntimeReceipt({ runDir, databasePath,
    inspectProcess: () => ({ status: 'drifted' }) })).currentState, 'drift')
})

test('schema changes are measured from readonly SQLite and cause receipt drift', async () => {
  await receipt()
  const db = new Database(databasePath)
  db.prepare('INSERT INTO schema_migrations VALUES (?)').run('060_video_edit_task_receipts')
  db.exec('CREATE TABLE video_edit_task_receipts (id INTEGER PRIMARY KEY)'); db.close()
  const observation = await observeRuntime({ runDir, databasePath, references, inspectProcess })
  assert.equal(observation.database.videoEditingMigrationPresent, true)
  assert.equal(observation.database.latestMigration, '060_video_edit_task_receipts')
  assert.equal((await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess })).currentState, 'drift')
})

test('receipt writer rejects missing acceptance, stale CAS and changed route', async () => {
  const observation = await observeRuntime({ runDir, databasePath, references, inspectProcess })
  assert.throws(() => writeCurrentRuntimeReceipt({ runDir, databasePath, observation, evidence: {} }), /acceptance_required/u)
  await receipt()
  assert.throws(() => writeCurrentRuntimeReceipt({ runDir, databasePath, observation, components: {},
    expectedReceiptSha256: sha, evidence: { acceptance: 'verified', settlement: 'verified' } }), /cas_failed/u)
  const router = json(join(runDir, 'router-state.json')); router.generation++
  write(join(runDir, 'router-state.json'), router)
  assert.throws(() => writeCurrentRuntimeReceipt({ runDir, databasePath, observation, components: {},
    evidence: { acceptance: 'verified', settlement: 'verified' } }), /route_changed/u)
})

test('symlink receipts are rejected without following them', async () => {
  symlinkSync(platformPath, join(runDir, 'current-runtime.json'))
  assert.equal((await readCurrentRuntimeReceipt({ runDir, databasePath, inspectProcess })).currentState, 'drift')
})

test('deployment environment parser does not evaluate shell or disclose credentials', () => {
  assert.deepEqual(parseDeploymentEnvironment('TOKEN=secret\nMC_AUTH_MODE="openclaw-loopback"\n'), { MC_AUTH_MODE: 'openclaw-loopback' })
  assert.throws(() => parseDeploymentEnvironment('MISSION_CONTROL_DB_PATH=$(anything)\n'), /expression_rejected/u)
  assert.throws(() => parseDeploymentEnvironment('MC_AUTH_MODE=a\nMC_AUTH_MODE=b\n'), /duplicate/u)
})

test('a shared receipt implementation change updates both Web and controller components', () => {
  const before = new Map([['scripts/lib/runtime-receipt.mjs', 'before']])
  const after = new Map([['scripts/lib/runtime-receipt.mjs', 'after']])
  const summary = releaseComponentSummary(before, after)
  assert.equal(summary.app.changed, true); assert.equal(summary.control.changed, true)
  assert.equal(summary.taskFlow.changed, false)
})

function installation() {
  write(join(runDir, 'supervisor/installation.json'), { schema: 'video-autoworker-blue-green-launchd/v2',
    projectRoot: join(root, 'source/video-autoworker'), runDir, releasesDir, launchAgentsDir: join(root, 'agents'),
    nodeBin: process.execPath, services: { router: { port: 3017 }, blue: { port: 3317 }, green: { port: 3417 } } })
  const artifact = directory(join(root, 'worker-artifact'))
  write(join(artifact, 'worker-manifest.json'), { schema: 'video-autoworker-scheduler-artifact/v1', contentSha256: sha })
  return { env: { AIWORKER_BG_RUN_DIR: runDir }, home: root,
    workerArguments: ['node', 'worker', '--artifact', artifact, '--state-dir', directory(join(root, 'worker-state'))],
    readWorker: async () => ({ worker: { contentSha256: sha } }) }
}

test('discovery selects actual Worker LaunchAgent instead of a stale implicit platform pointer', async () => {
  const options = installation()
  write(platformPath, readFileSync(platformPath, 'utf8') + 'AIWORKER_SCHEDULER_MANIFEST=/stale/manifest.json\n')
  const result = await discoverDeploymentEnvironment(options)
  assert.equal(result.currentState, 'ready')
  assert.equal(result.environment.AIWORKER_SCHEDULER_MANIFEST, join(root, 'worker-artifact/worker-manifest.json'))
  assert.equal(result.environment.AIWORKER_BG_LIVE_DB_PATH, databasePath)
})

test('explicit paths are preserved and a mismatching explicit Worker produces one report', async () => {
  const options = installation(); options.env.AIWORKER_SCHEDULER_MANIFEST = '/missing/explicit/manifest.json'
  options.env.AIWORKER_BG_ROUTER_PORT = '3999'
  const result = await discoverDeploymentEnvironment(options)
  assert.equal(result.currentState, 'blocked')
  assert.equal(result.environment.AIWORKER_SCHEDULER_MANIFEST, '/missing/explicit/manifest.json')
  assert.equal(result.environment.AIWORKER_BG_ROUTER_PORT, '3999')
  assert.equal(result.missing.filter(item => item.field === 'workerManifest').length, 1)
})

test('missing discovery fields are aggregated without inventing installation bindings', async () => {
  const result = await discoverDeploymentEnvironment({ home: join(root, 'absent'), env: {},
    workerArguments: [], readWorker: async () => ({}) })
  assert.equal(result.currentState, 'blocked')
  assert.equal(result.environment.AIWORKER_BG_RUN_DIR, undefined)
  assert.ok(result.missing.length > 3)
})

const fakeAudit = async path => ({ ok: true, artifactContent: { digest: sha },
  verificationBundle: { treeMetadata: { sha256: runtimeDigest(readFileSync(join(path, 'server.js'))) } } })
const fakeSnapshotVerification = async (path, bundle) => {
  assert.equal(runtimeDigest(readFileSync(join(path, 'server.js'))), bundle.treeMetadata.sha256)
}
async function oldRelease(char, date, current) {
  const id = `${char.repeat(40)}-runtime`, pathname = directory(join(releasesDir, id))
  const standalone = directory(join(pathname, 'standalone'))
  write(join(standalone, 'server.js'), 'server')
  write(join(standalone, 'release-manifest.json'), { files: [{ path: 'server.js', bytes: 6 }] })
  const evidence = { ...current.evidence, recoveryVerified: true }; delete evidence.sha256
  write(join(pathname, 'recovery-receipt.json'), { ...current, sourceCommit: char.repeat(40), releaseId: id,
    verifiedAt: date, artifact: { ...current.artifact, manifestSha256: runtimeDigest(readFileSync(join(standalone, 'release-manifest.json'))) },
    evidence: { ...evidence, sha256: runtimeDigest(evidence) } })
  return pathname
}
const planOptions = () => ({ runDir, releasesDir, readProcesses: () => [], auditArtifact: fakeAudit })

test('retention retains current and two verified history objects and protects unknown/source/reference objects', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current)
  await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const oldest = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const referenced = await oldRelease('e', '2026-10-04T00:00:00Z', current)
  directory(join(releasesDir, 'unknown')); directory(join(releasesDir, `${'f'.repeat(40)}-runtime`, '.git'))
  const plan = await planRuntimeRetention({ ...planOptions(), referencedPaths: [join(referenced, 'standalone/server.js')] })
  assert.equal(plan.keep.length, 2); assert.equal(plan.remove.length, 1); assert.equal(plan.remove[0].path, oldest)
  assert.ok(plan.protectedObjects.some(item => item.reason === 'runtime_reference'))
  assert.ok(plan.protectedObjects.some(item => item.reason === 'current_or_previous'))
  assert.equal(existsSync(oldest), true)
})

test('retention requires exact confirmation and refuses changed candidates before deleting anything', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current); await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const oldest = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const plan = await planRuntimeRetention(planOptions())
  await assert.rejects(applyRuntimeRetention(plan, 'incorrect'), /confirmation_required/u)
  write(join(oldest, 'standalone/server.js'), 'modified')
  await assert.rejects(applyRuntimeRetention(plan, plan.planSha256,
    { readProcesses: () => [], auditArtifact: fakeAudit }), /candidate_changed/u)
  assert.equal(existsSync(oldest), true)
})

test('retention protects artifacts referenced by a pending sealed release plan', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current); await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const oldest = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  write(join(root, 'operations/pending/plan.json'), { schema: 'video-autoworker-release-impact-plan/v2',
    sourceCommit: 'd'.repeat(40), planSha256: sha, actions: ['transition-app'], components: { app: { changed: true } },
    router: { target: 'green', releaseId: `${'d'.repeat(40)}-runtime` }, artifactRoot: join(oldest, 'standalone') })
  const plan = await planRuntimeRetention(planOptions())
  assert.equal(plan.remove.length, 0)
  assert.ok(plan.protectedObjects.some(item => item.path === oldest && item.reason === 'runtime_reference'))
})

test('a verified previous release counts towards two retained history objects', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current); await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const previous = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const router = json(join(runDir, 'router-state.json')); router.previous = 'green'; router.slots.green.releaseId = previous.split('/').at(-1)
  write(join(runDir, 'router-state.json'), router); await receipt()
  const plan = await planRuntimeRetention(planOptions())
  assert.equal(plan.summary.retainedVerifiedHistory, 2)
  assert.equal(plan.keep.length, 1); assert.equal(plan.remove.length, 1)
  assert.equal(plan.protectedHistory.length, 1)
  assert.ok(plan.protectedObjects.some(item => item.path === previous && item.reason === 'current_or_previous'))
})

for (const mutation of ['deleted', 'damaged']) {
  test(`a ${mutation} retained history point prevents every deletion`, async () => {
    const current = await receipt()
    const kept = await oldRelease('b', '2026-10-07T00:00:00Z', current)
    await oldRelease('c', '2026-10-06T00:00:00Z', current)
    const oldest = await oldRelease('d', '2026-10-05T00:00:00Z', current)
    const plan = await planRuntimeRetention(planOptions())
    if (mutation === 'deleted') rmSync(kept, { recursive: true })
    else write(join(kept, 'standalone/server.js'), 'damaged-history')
    await assert.rejects(applyRuntimeRetention(plan, plan.planSha256,
      { readProcesses: () => [], auditArtifact: fakeAudit, verifyArtifactSnapshot: fakeSnapshotVerification }), /recovery_changed/u)
    assert.equal(existsSync(oldest), true)
    assert.equal(existsSync(join(runDir, '.deployment.lock')), false)
  })
}

test('a damaged previous point that counted as recovery prevents deleting another valid point', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current)
  const disposable = await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const previous = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const router = json(join(runDir, 'router-state.json')); router.previous = 'green'; router.slots.green.releaseId = previous.split('/').at(-1)
  write(join(runDir, 'router-state.json'), router); await receipt()
  const plan = await planRuntimeRetention(planOptions())
  write(join(previous, 'standalone/server.js'), 'previous-point-damaged')
  await assert.rejects(applyRuntimeRetention(plan, plan.planSha256,
    { readProcesses: () => [], auditArtifact: fakeAudit, verifyArtifactSnapshot: fakeSnapshotVerification }), /recovery_changed/u)
  assert.equal(existsSync(disposable), true)
})

test('a history point changed while remove audits run fails the final evidence fence', async () => {
  const current = await receipt()
  const kept = await oldRelease('b', '2026-10-07T00:00:00Z', current)
  await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const oldest = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const plan = await planRuntimeRetention(planOptions())
  const mutatingAudit = async path => {
    const result = await fakeAudit(path)
    if (path === join(oldest, 'standalone')) write(join(kept, 'standalone/server.js'), 'changed-after-retained-audit')
    return result
  }
  await assert.rejects(applyRuntimeRetention(plan, plan.planSha256,
    { readProcesses: () => [], auditArtifact: mutatingAudit, verifyArtifactSnapshot: fakeSnapshotVerification }), /recovery_changed/u)
  assert.equal(existsSync(oldest), true)
})

test('initial retention inventory protects a cross-device member without treating it as a candidate', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current); await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const mounted = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const readEntry = pathname => {
    const value = lstatSync(pathname)
    if (pathname === join(mounted, 'standalone/server.js')) Object.defineProperty(value, 'dev', { value: value.dev + 1 })
    return value
  }
  const plan = await planRuntimeRetention({ ...planOptions(), readEntry })
  assert.equal(plan.remove.length, 0)
  assert.ok(plan.protectedObjects.some(item => item.path === mounted && item.reason === 'unverified_or_unsafe'))
})

test('cross-device deletion subtrees detected after artifact audits cause zero removals', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current); await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const first = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const second = await oldRelease('e', '2026-10-04T00:00:00Z', current)
  const plan = await planRuntimeRetention(planOptions())
  let mountChanged = false
  const auditArtifact = async path => {
    const result = await fakeAudit(path)
    if (path === join(second, 'standalone')) mountChanged = true
    return result
  }
  const readEntry = pathname => {
    const value = lstatSync(pathname)
    if (mountChanged && pathname === join(second, 'standalone/server.js')) Object.defineProperty(value, 'dev', { value: value.dev + 1 })
    return value
  }
  await assert.rejects(applyRuntimeRetention(plan, plan.planSha256, { readProcesses: () => [], auditArtifact,
    readEntry, verifyArtifactSnapshot: fakeSnapshotVerification }), /cross_device/u)
  assert.equal(existsSync(first), true); assert.equal(existsSync(second), true)
})

test('even a recomputed confirmed plan cannot delete current or previous', async () => {
  await receipt()
  const plan = await planRuntimeRetention(planOptions())
  const body = { ...plan }; delete body.planSha256
  body.remove = [{ path: join(releasesDir, releaseId), releaseId,
    identity: { dev: String(lstatSync(releasesDir).dev) } }]
  const forged = { ...body, planSha256: runtimeDigest(body) }
  await assert.rejects(applyRuntimeRetention(forged, forged.planSha256,
    { readProcesses: () => [], auditArtifact: fakeAudit }), /target_protected/u)
  assert.equal(existsSync(join(releasesDir, releaseId)), true)
})

test('confirmed retention removes only the sandbox regenerable object and releases the shared lock', async () => {
  const current = await receipt()
  await oldRelease('b', '2026-10-07T00:00:00Z', current); await oldRelease('c', '2026-10-06T00:00:00Z', current)
  const oldest = await oldRelease('d', '2026-10-05T00:00:00Z', current)
  const plan = await planRuntimeRetention(planOptions())
  const result = await applyRuntimeRetention(plan, plan.planSha256, { readProcesses: () => [], auditArtifact: fakeAudit,
    verifyArtifactSnapshot: fakeSnapshotVerification })
  assert.equal(result.currentState, 'completed'); assert.equal(existsSync(oldest), false)
  assert.equal(existsSync(join(releasesDir, releaseId)), true)
  assert.equal(existsSync(join(runDir, '.deployment.lock')), false)
})
