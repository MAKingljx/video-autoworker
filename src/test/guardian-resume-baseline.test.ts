import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const load = () => import(pathToFileURL(resolve('scripts/verify-guardian-resume-baseline.mjs')).href)
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-resume-baseline-')))
  roots.push(root); chmodSync(root, 0o700)
  const videoBatchRoot = join(root, 'batches'); mkdirSync(videoBatchRoot, { mode: 0o700 })
  const missionControlDbPath = join(root, 'mission.db'), n8nDbPath = join(root, 'n8n.db')
  const mission = new Database(missionControlDbPath)
  mission.exec(`CREATE TABLE n8n_intake_controls(control_id INTEGER,accepting INTEGER,revision INTEGER);
    INSERT INTO n8n_intake_controls VALUES(1,0,9);
    CREATE TABLE n8n_task_runs(id INTEGER,task_id TEXT,source TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE n8n_director_evidence_outbox(status TEXT);`)
  mission.close()
  const n8n = new Database(n8nDbPath)
  n8n.exec('CREATE TABLE execution_entity(id INTEGER,status TEXT,"stoppedAt" INTEGER);'); n8n.close()
  chmodSync(missionControlDbPath, 0o600); chmodSync(n8nDbPath, 0o600)
  const markerPath = join(videoBatchRoot, '.worker-launch.lock')
  const token = 'a'.repeat(64), createdAt = new Date().toISOString()
  const marker = JSON.stringify({ schema: 'video-autoworker-worker-launch-guardian/v2', pid: process.pid, token, createdAt })
  writeFileSync(markerPath, marker, { mode: 0o600 })
  const stat = statSync(markerPath, { bigint: true })
  writeFileSync(`${markerPath}.owner`, JSON.stringify({ schema: 'video-autoworker-worker-launch-guardian-owner/v1',
    pid: process.pid, createdAt, marker: { path: markerPath, dev: String(stat.dev), ino: String(stat.ino),
      createdAt, sourceSha256: digest(marker), tokenSha256: digest(token) } }), { mode: 0o600 })
  const taskPath = join(videoBatchRoot, `${'b'.repeat(64)}.json`)
  writeFileSync(taskPath, JSON.stringify({ schemaVersion: 2, status: 'queued', batchId: 'original',
    items: [{ taskId: 'original', status: 'queued', sourcePath: '/original/media.mp4', idempotencyKey: 'original-key' }] }), { mode: 0o600 })
  const preparedReceipt = join(root, 'prepared.json')
  writeFileSync(preparedReceipt, JSON.stringify({ schema: 'video-autoworker-legacy-media-orphan-runtime-receipt/v1',
    holdGuardian: true, runtimeBefore: { batchRoot: videoBatchRoot }, launchGuardian: { path: markerPath } }), { mode: 0o400 })
  const inputs = { output: join(root, 'baseline.json'), preparedReceipt, missionControlDbPath, n8nDbPath,
    deploymentRunDir: join(root, 'blue-green'), videoBatchRoot,
    expectedSourceCommit: '1'.repeat(40), expectedReleaseId: `${'1'.repeat(40)}-runtime`,
    expectedActiveReleaseId: `${'2'.repeat(40)}-runtime`, expectedManagerCommit: '3'.repeat(40) }
  const runtime = { runDirectory: inputs.deploymentRunDir, videoBatchRoot,
    activeApplication: { releaseId: inputs.expectedActiveReleaseId },
    installedManager: { manager: { sourceCommit: inputs.expectedManagerCommit }, installation: { sha256: '4'.repeat(64) } } }
  const dependencies = { captureInstalledComponents: () => ({ sourceCommit: inputs.expectedSourceCommit }),
    sharedGateDependencies: { verifyRollingRuntimeBinding: () => runtime },
    verifyRollingRuntimeBinding: () => runtime }
  return { root, inputs, runtime, dependencies, taskPath,
    request: { report: inputs.output, preparedReceipt } }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('current-component guardian resume baseline', () => {
  it('binds independent component versions and verifies unchanged held business files during successor startup', async () => {
    const f = fixture(), api = await load()
    expect(api.createGuardianResumeBaseline(f.inputs, f.dependencies).ok).toBe(true)
    expect(statSync(f.inputs.output).mode & 0o777).toBe(0o400)
    expect(api.verifyGuardianResumeBaseline(f.request, f.dependencies).ok).toBe(true)
    writeFileSync(join(f.inputs.videoBatchRoot, '.global-video-worker.lock'), 'successor control', { mode: 0o600 })
    expect(api.verifyGuardianResumeSuccessor(f.request, f.dependencies).ok).toBe(true)
    expect(() => api.createGuardianResumeBaseline(f.inputs, f.dependencies)).toThrow()
  })
  it.each(['sourcePath', 'idempotencyKey'])('rejects %s drift even when task identity and queued status are unchanged', async field => {
    const f = fixture(), api = await load()
    api.createGuardianResumeBaseline(f.inputs, f.dependencies)
    const task = JSON.parse(readFileSync(f.taskPath, 'utf8')); task.items[0][field] = 'changed'
    writeFileSync(f.taskPath, JSON.stringify(task))
    expect(() => api.verifyGuardianResumeBaseline(f.request, f.dependencies)).toThrow(/snapshot_changed/u)
    expect(() => api.verifyGuardianResumeSuccessor(f.request, f.dependencies)).toThrow(/business file changed/u)
  })
  it('rejects a new business file and a changed runtime before authorization', async () => {
    const f = fixture(), api = await load()
    api.createGuardianResumeBaseline(f.inputs, f.dependencies)
    f.runtime.activeApplication.releaseId = `${'5'.repeat(40)}-runtime`
    expect(() => api.verifyGuardianResumeSuccessor(f.request, f.dependencies)).toThrow(/runtime binding changed/u)
    f.runtime.activeApplication.releaseId = f.inputs.expectedActiveReleaseId
    writeFileSync(join(f.inputs.videoBatchRoot, `${'e'.repeat(64)}.json`), '{}', { mode: 0o600 })
    expect(() => api.verifyGuardianResumeSuccessor(f.request, f.dependencies)).toThrow(/business members changed/u)
  })
})
