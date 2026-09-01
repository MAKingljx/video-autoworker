// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  projectOfflineQueue,
  scanOfflineDurableBatchStates,
} from '../../scripts/legacy-bootstrap-controller.mjs'

const controller = resolve(process.cwd(), 'scripts/legacy-bootstrap-controller.mjs')
const transitionAnchor = resolve(process.cwd(), 'scripts/n8n-workflow-transition-anchor.mjs')
const roots: string[] = []
const BASE_NOW = 1_800_000_000
const SOURCE_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, 'n8n-recovery-package'), 0o700) } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalize(record[key])]))
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function identity(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

function reference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  const source = readFileSync(pathname)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    sha256: hash(source),
  }
}

function fullReference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & BigInt(0o7777)).toString(8),
    nlink: Number(entry.nlink),
    sha256: hash(readFileSync(pathname)),
  }
}

function fullDirectoryReference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & BigInt(0o7777)).toString(8),
  }
}

function writePrivate(pathname: string, value: unknown): string {
  const source = `${JSON.stringify(value)}\n`
  writeFileSync(pathname, source, { mode: 0o600 })
  chmodSync(pathname, 0o600)
  return source
}

type Fixture = ReturnType<typeof fixture>

function fixture(options: { guardExpiresAt?: number, observedAt?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-bootstrap-controller.')))
  roots.push(root)
  chmodSync(root, 0o700)
  const attempt = join(root, 'attempt')
  const evidenceDirectory = join(root, 'evidence')
  const proofDirectory = join(root, 'proof')
  const databaseDirectory = join(root, 'databases')
  const routerRunDirectory = join(root, 'run')
  const releaseId = `${SOURCE_COMMIT}-runtime`
  const releaseRoot = join(root, 'releases', releaseId, 'standalone')
  for (const directory of [
    attempt, evidenceDirectory, proofDirectory, databaseDirectory, releaseRoot, routerRunDirectory,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const manifestPath = join(releaseRoot, 'release-manifest.json')
  const manifestSource = '{"schema":"test-release/v1"}\n'
  writeFileSync(manifestPath, manifestSource, { mode: 0o600 })
  chmodSync(manifestPath, 0o600)
  const mission = join(databaseDirectory, 'mission-control.db')
  const n8n = join(databaseDirectory, 'database.sqlite')
  const missionBackup = join(proofDirectory, 'mission-control.backup.db')
  const n8nBackup = join(proofDirectory, 'n8n.backup.sqlite')
  writeFileSync(mission, 'mission-database', { mode: 0o600 })
  writeFileSync(n8n, 'n8n-database', { mode: 0o600 })
  writeFileSync(missionBackup, 'mission-backup', { mode: 0o600 })
  writeFileSync(n8nBackup, 'n8n-backup', { mode: 0o600 })
  for (const pathname of [mission, n8n, missionBackup, n8nBackup]) chmodSync(pathname, 0o600)

  const syntheticIdentity = (name: string, number: number) => ({
    path: join(root, name), dev: '16777234', ino: String(number),
  })
  const legacy = {
    pid: 1200,
    ppid: 1100,
    uid: process.getuid!(),
    startTime: 'Sun Jan 15 08:00:00 2027',
    argvSha256: 'a'.repeat(64),
    executable: syntheticIdentity('legacy-node', 201),
    cwd: syntheticIdentity('legacy-cwd', 202),
    database: identity(mission),
    releaseId: 'legacy-runtime',
    routerPort: 3017,
  }
  const n8nProcess = {
    pid: 1300,
    ppid: 1250,
    uid: process.getuid!(),
    startTime: 'Sun Jan 15 08:00:00 2027',
    argvSha256: 'b'.repeat(64),
    executable: syntheticIdentity('n8n-node', 203),
    cwd: syntheticIdentity('n8n-cwd', 204),
    database: identity(n8n),
    launchPid: 1250,
    port: 5678,
  }
  const frozen = {
    schema: 'video-autoworker-legacy-freeze-guard/v1',
    pid: 1400,
    uid: process.getuid!(),
    startedAt: 'Sun Jan 15 08:00:01 2027',
    argvSha256: 'c'.repeat(64),
    scriptSha256: 'd'.repeat(64),
    guardNonceSha256: 'e'.repeat(64),
    legacyBindingSha256: hash(canonicalJson({
      pid: legacy.pid,
      uid: legacy.uid,
      startedAt: legacy.startTime,
      argvSha256: legacy.argvSha256,
      database: legacy.database,
      port: legacy.routerPort,
    })),
    mode: 'dual',
    issuedAt: BASE_NOW,
    expiresAt: options.guardExpiresAt ?? BASE_NOW + 300,
    database: legacy.database,
    n8nDatabase: n8nProcess.database,
    socket: syntheticIdentity('guard.sock', 205),
    ready: true,
  }
  const target = {
    slot: 'blue',
    releaseId,
    releaseRoot,
    manifestSha256: hash(manifestSource),
  }
  const snapshot = {
    legacy,
    n8n: n8nProcess,
    counts: { mediaNodes: 0, n8nActiveExecutions: 0, queueWaiting: 0, queueRunning: 0 },
    queueDigestSha256: 'f'.repeat(64),
    supervisor: { disabled: true, loaded: false, lockAbsent: true, workerPids: [] },
    frozen,
  }
  const proofPath = join(proofDirectory, 'rollback-proof.json')
  const proof = {
    schema: 'video-autoworker-legacy-bootstrap-rollback-proof/v2',
    generatorSha256: '1'.repeat(64),
    createdAt: BASE_NOW - 10,
    host: 'isolated-test-host',
    uid: process.getuid!(),
    target: { slot: target.slot, releaseId, manifestSha256: target.manifestSha256 },
    sources: { mission: legacy.database, n8n: n8nProcess.database },
    backups: {
      mission: { path: missionBackup, sha256: hash(readFileSync(missionBackup)) },
      n8n: { path: n8nBackup, sha256: hash(readFileSync(n8nBackup)) },
    },
    queueDigestSha256: snapshot.queueDigestSha256,
    guardSha256: hash(canonicalJson(frozen)),
    runtimeIdentitySha256: hash(canonicalJson(snapshot)),
  }
  const proofSource = writePrivate(proofPath, proof)
  const proofEntry = identity(proofPath)
  const evidencePath = join(evidenceDirectory, 'freeze.json')
  const evidence = {
    schema: 'video-autoworker-legacy-freeze-evidence/v3',
    observedAt: options.observedAt ?? BASE_NOW,
    generatorSha256: '2'.repeat(64),
    frozen,
    rollback: { ...proofEntry, sha256: hash(proofSource) },
    target,
    legacy,
    n8n: n8nProcess,
    counts: snapshot.counts,
    queueDigestSha256: snapshot.queueDigestSha256,
    supervisor: snapshot.supervisor,
  }
  writePrivate(evidencePath, evidence)
  const recoveryPackage = join(root, 'n8n-recovery-package')
  mkdirSync(recoveryPackage, { mode: 0o700 })
  const recoveryWorkflows = [
    {
      id: 'aiworker-task-intake-v1', active: true, file: 'aiworker-task-intake-v1.json',
      fileSha256: '3'.repeat(64), semanticSha256: '4'.repeat(64),
    },
    {
      id: 'aiworker-video-analysis-v1', active: true, file: 'aiworker-video-analysis-v1.json',
      fileSha256: '5'.repeat(64), semanticSha256: '6'.repeat(64),
    },
  ]
  const recoveryCombinedSha256 = hash(recoveryWorkflows.map(workflow => [
    workflow.id, workflow.active ? 'active' : 'inactive', workflow.fileSha256,
    workflow.semanticSha256,
  ].join(':')).join('\n'))
  const recoveryManifest = {
    schema: 'video-autoworker-n8n-managed-workflow-backup/v1',
    createdAt: BASE_NOW - 10,
    combinedSha256: recoveryCombinedSha256,
    source: {
      databaseFileName: 'database.sqlite',
      databaseIdentity: { bytes: 1, dev: '0x1', ino: '1', mtimeNs: '1' },
      n8nVersion: '2.31.6',
      quickCheck: 'ok',
      sourceCommit: SOURCE_COMMIT,
    },
    workflows: recoveryWorkflows,
  }
  writeFileSync(join(recoveryPackage, 'manifest.json'), `${JSON.stringify(recoveryManifest)}\n`, { mode: 0o400 })
  chmodSync(join(recoveryPackage, 'manifest.json'), 0o400)
  chmodSync(recoveryPackage, 0o500)

  const transitionDirectory = join(root, 'workflow-transition')
  const transitionJournal = join(transitionDirectory, 'journal')
  mkdirSync(transitionJournal, { recursive: true, mode: 0o700 })
  chmodSync(transitionDirectory, 0o700)
  chmodSync(transitionJournal, 0o700)
  const workflowReportPath = join(transitionDirectory, 'live-report.json')
  const runtimeIdentitySha256 = '7'.repeat(64)
  const transitionWorkflows = [
    {
      id: 'aiworker-task-intake-v1', sourceVersionId: 'source-intake-v1',
      sourceSha256: '8'.repeat(64), publishedVersionId: 'published-intake-v1', sha256: '9'.repeat(64),
    },
    {
      id: 'aiworker-video-analysis-v1', sourceVersionId: 'source-video-v1',
      sourceSha256: 'a'.repeat(64), publishedVersionId: 'published-video-v1', sha256: 'b'.repeat(64),
    },
  ]
  const workflowDigest = hash([
    SOURCE_COMMIT,
    runtimeIdentitySha256,
    ...transitionWorkflows.map(item => [
      item.id, item.sourceVersionId, item.sourceSha256, item.publishedVersionId, item.sha256,
    ].join(':')),
  ].join('\n'))
  writeFileSync(workflowReportPath, `${JSON.stringify({
    schema: 'video-autoworker-n8n-workflow-compatibility/v2',
    protocol: 'slot-v1-execution-owner-v1',
    sourceCommit: SOURCE_COMMIT,
    databasePath: n8n,
    runtimeIdentitySha256,
    workflows: transitionWorkflows,
    combinedSha256: workflowDigest,
  })}\n`, { mode: 0o400 })
  chmodSync(workflowReportPath, 0o400)
  const transitionIntent = join(transitionDirectory, 'upgrade-intent.json')
  writeFileSync(transitionIntent, `${JSON.stringify({
    rollback: {
      directory: { ...identity(recoveryPackage), path: recoveryPackage },
      manifest: reference(join(recoveryPackage, 'manifest.json')),
      sourceCommit: recoveryManifest.source.sourceCommit,
      n8nVersion: recoveryManifest.source.n8nVersion,
      combinedSha256: recoveryCombinedSha256,
      workflows: recoveryWorkflows,
    },
  })}\n`, { mode: 0o400 })
  chmodSync(transitionIntent, 0o400)
  const transitionConfirmation = join(transitionDirectory, 'current-confirmation.json')
  writeFileSync(transitionConfirmation, '{"confirmed":true}\n', { mode: 0o400 })
  chmodSync(transitionConfirmation, 0o400)
  const transitionAttestation = join(transitionDirectory, 'transition-attestation.json')
  writeFileSync(transitionAttestation, `${JSON.stringify({
    producer: { path: transitionAnchor, sha256: hash(readFileSync(transitionAnchor)) },
    deployed: {
      report: reference(workflowReportPath),
      combinedSha256: workflowDigest,
    },
  })}\n`, { mode: 0o400 })
  chmodSync(transitionAttestation, 0o400)
  const transitionClaim = join(transitionDirectory, 'bootstrap-claim.json')
  const bootstrapAttemptId = '11111111-1111-4111-8111-111111111111'
  writeFileSync(transitionClaim, `${JSON.stringify({
    schema: 'video-autoworker-n8n-workflow-transition-bootstrap-claim/v1',
    upgradeId: '22222222-2222-4222-8222-222222222222',
    uid: process.getuid!(),
    claimedAt: BASE_NOW,
    transition: {
      attestation: fullReference(transitionAttestation),
      committedJournalHeadSha256: 'c'.repeat(64),
      liveCombinedSha256: workflowDigest,
    },
    bootstrap: {
      attemptId: bootstrapAttemptId,
      request: {
        preparePath: join(attempt, 'prepare.receipt.json'),
        database: { ...identity(n8n), size: statSync(n8n).size },
        target: { slot: target.slot, releaseId, releaseRoot, manifestSha256: target.manifestSha256 },
      },
    },
  })}\n`, { mode: 0o400 })
  chmodSync(transitionClaim, 0o400)
  const runtimeRelease = join(root, 'n8n', 'releases', SOURCE_COMMIT)
  const n8nModule = join(runtimeRelease, 'ops/n8n/node_modules/n8n')
  mkdirSync(n8nModule, { recursive: true, mode: 0o700 })
  writeFileSync(join(runtimeRelease, 'SOURCE_COMMIT'), `${SOURCE_COMMIT}\n`, { mode: 0o600 })
  writeFileSync(join(runtimeRelease, 'SOURCE_MANIFEST'),
    `source_commit=${SOURCE_COMMIT}\nn8n_version=2.31.6\n`, { mode: 0o600 })
  writeFileSync(join(n8nModule, 'package.json'), '{"version":"2.31.6"}\n', { mode: 0o600 })
  const livePath = join(root, 'live-snapshot.json')
  writePrivate(livePath, snapshot)
  const verifierCountPath = join(root, 'verifier-count')
  writeFileSync(verifierCountPath, '0', { mode: 0o600 })
  const verifierPath = join(root, 'test-live-verifier.mjs')
  writeFileSync(verifierPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const snapshot = JSON.parse(readFileSync(${JSON.stringify(livePath)}, 'utf8'))
const countPath = ${JSON.stringify(verifierCountPath)}
writeFileSync(countPath, String(Number(readFileSync(countPath, 'utf8')) + 1), { mode: 0o600 })
if (JSON.stringify(snapshot) !== JSON.stringify(${JSON.stringify(snapshot)})) process.exit(2)
const evidence = readFileSync(3)
process.stdout.write(createHash('sha256').update(evidence).digest('hex') + '\\n')
`, { mode: 0o700 })
  chmodSync(verifierPath, 0o700)
  const resumeSnapshotPath = join(root, 'resume-snapshot.json')
  writePrivate(resumeSnapshotPath, {
    observedAt: BASE_NOW + 500,
    n8nPid: 2300,
    runtimeRelease: identity(runtimeRelease),
    workflow: {
      protocol: 'slot-v1-execution-owner-v1',
      sourceCommit: SOURCE_COMMIT,
      runtimeIdentitySha256: 'a'.repeat(64),
      combinedSha256: 'b'.repeat(64),
    },
    previousQueueDigestSha256: snapshot.queueDigestSha256,
    queueDigestSha256: 'c'.repeat(64),
    counts: { mediaNodes: 0, n8nActiveExecutions: 0, queueWaiting: 0, queueRunning: 0 },
  })
  return {
    root,
    attempt,
    evidencePath,
    proofPath,
    releaseRoot,
    manifestPath,
    mission,
    n8n,
    releaseId,
    routerRunDirectory,
    routerStatePath: join(routerRunDirectory, 'router-state.json'),
    livePath,
    verifierPath,
    verifierCountPath,
    recoveryPackage,
    runtimeRelease,
    resumeSnapshotPath,
    transitionIntent,
    transitionConfirmation,
    transitionJournal,
    transitionAttestation,
    transitionClaim,
    workflowReportPath,
    workflowDigest,
  }
}

function environment(now = BASE_NOW): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    AIWORKER_TEST_LEGACY_BOOTSTRAP: '1',
    AIWORKER_TEST_LEGACY_BOOTSTRAP_NOW: String(now),
  }
}

function run(
  args: string[],
  now = BASE_NOW,
  extraEnvironment: Record<string, string | undefined> = {},
) {
  return spawnSync(process.execPath, [controller, ...args], {
    cwd: process.cwd(),
    env: { ...environment(now), ...extraEnvironment },
    encoding: 'utf8',
  })
}

function prepare(entry: Fixture) {
  return run([
    'prepare',
    '--attempt-dir', entry.attempt,
    '--evidence', entry.evidencePath,
    '--proof', entry.proofPath,
    '--source-commit', SOURCE_COMMIT,
    '--router-run-dir', entry.routerRunDirectory,
    '--router-state', entry.routerStatePath,
    '--router-port', '3017',
    '--mission-db', entry.mission,
    '--n8n-db', entry.n8n,
    '--transition-intent', entry.transitionIntent,
    '--transition-confirmation', entry.transitionConfirmation,
    '--transition-journal', entry.transitionJournal,
    '--transition-attestation', entry.transitionAttestation,
    '--transition-claim', entry.transitionClaim,
  ], BASE_NOW, {
    AIWORKER_TEST_LEGACY_BOOTSTRAP_VERIFIER: entry.verifierPath,
    AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim,
  })
}

function confirm(entry: Fixture) {
  return run(['current-confirm', '--prepare', join(entry.attempt, 'prepare.receipt.json')], BASE_NOW, {
    AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim,
  })
}

function apply(entry: Fixture, now = BASE_NOW) {
  return run([
    'apply',
    '--prepare', join(entry.attempt, 'prepare.receipt.json'),
    '--confirm', join(entry.attempt, 'current-confirm.receipt.json'),
    '--token', join(entry.attempt, 'current-confirm.token.json'),
  ], now, { AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim })
}

function deriveRestore(entry: Fixture, now = BASE_NOW) {
  return run([
    'derive-n8n-restore-confirmation',
    '--prepare', join(entry.attempt, 'prepare.receipt.json'),
    '--confirm', join(entry.attempt, 'current-confirm.receipt.json'),
    '--shutdown', join(entry.attempt, 'shutdown-requested.receipt.json'),
    '--package', entry.recoveryPackage,
    '--runtime-release', entry.runtimeRelease,
    '--database', entry.n8n,
  ], now, { AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim })
}

function createPendingV4(entry: Fixture) {
  const prepareReceipt = JSON.parse(readFileSync(join(entry.attempt, 'prepare.receipt.json'), 'utf8'))
  const evidence = JSON.parse(readFileSync(entry.evidencePath, 'utf8'))
  const pathname = join(entry.root, 'bootstrap.pending.json')
  const value = {
    schema: 'video-autoworker-blue-green-bootstrap-pending/v4',
    attemptId: prepareReceipt.attemptId,
    authorization: {
      prepare: reference(join(entry.attempt, 'prepare.receipt.json')),
      confirm: reference(join(entry.attempt, 'current-confirm.receipt.json')),
      shutdown: reference(join(entry.attempt, 'shutdown-requested.receipt.json')),
    },
    createdAt: BASE_NOW,
    evidence: reference(entry.evidencePath),
    proof: reference(entry.proofPath),
    transition: prepareReceipt.transition,
    bootstrapClaim: prepareReceipt.transition.claim,
    databases: prepareReceipt.databases,
    router: prepareReceipt.routing,
    slot: prepareReceipt.target.slot,
    releaseId: prepareReceipt.target.releaseId,
    releaseRoot: prepareReceipt.target.releaseRoot,
    manifestSha256: prepareReceipt.target.manifest.sha256,
    baselineSourceCommit: prepareReceipt.sourceCommit,
    evidenceObservedAt: evidence.observedAt,
    legacyPid: evidence.legacy.pid,
    legacyCwd: evidence.legacy.cwd.path,
    legacyReleaseId: evidence.legacy.releaseId,
    n8n: {
      pid: evidence.n8n.pid,
      dbPath: evidence.n8n.database.path,
      workflowProtocol: 'slot-v1-execution-owner-v1',
      workflowSourceCommit: prepareReceipt.sourceCommit,
      workflowDigest: entry.workflowDigest,
      workflowReport: reference(entry.workflowReportPath),
    },
  }
  writeFileSync(pathname, `${JSON.stringify(value)}\n`, { mode: 0o400 })
  chmodSync(pathname, 0o400)
  return pathname
}

function disasterAttempt(entry: Fixture, attemptId = '123e4567-e89b-42d3-a456-426614174000') {
  const parent = join(entry.attempt, 'disaster-recovery-attempts')
  if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 })
  const pathname = join(parent, attemptId)
  mkdirSync(pathname, { mode: 0o700 })
  return pathname
}

function deriveDisaster(entry: Fixture, pending: string, recoveryAttempt: string, now: number) {
  return run([
    'derive-n8n-disaster-recovery-confirmation',
    '--prepare', join(entry.attempt, 'prepare.receipt.json'),
    '--confirm', join(entry.attempt, 'current-confirm.receipt.json'),
    '--shutdown', join(entry.attempt, 'shutdown-requested.receipt.json'),
    '--pending', pending,
    '--proof', entry.proofPath,
    '--package', entry.recoveryPackage,
    '--runtime-release', entry.runtimeRelease,
    '--database', entry.n8n,
    '--recovery-attempt-dir', recoveryAttempt,
  ], now, {
    AIWORKER_TEST_LEGACY_BOOTSTRAP_DISASTER_STOPPED: '1',
    AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim,
  })
}

function deriveResume(entry: Fixture, pending: string, recoveryAttempt: string, now: number) {
  return run([
    'derive-bootstrap-resume',
    '--prepare', join(entry.attempt, 'prepare.receipt.json'),
    '--confirm', join(entry.attempt, 'current-confirm.receipt.json'),
    '--shutdown', join(entry.attempt, 'shutdown-requested.receipt.json'),
    '--pending', pending,
    '--runtime-release', entry.runtimeRelease,
    '--n8n-pid', '2300',
    '--recovery-attempt-dir', recoveryAttempt,
  ], now, {
    AIWORKER_TEST_LEGACY_BOOTSTRAP_RESUME: '1',
    AIWORKER_TEST_LEGACY_BOOTSTRAP_RESUME_SNAPSHOT: entry.resumeSnapshotPath,
    AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim,
  })
}

function verifyResume(entry: Fixture, recoveryAttempt: string, command: 'verify' | 'consume', now: number) {
  return run([
    `${command}-bootstrap-resume`,
    '--receipt', join(recoveryAttempt, 'resume.receipt.json'),
    '--token', join(recoveryAttempt, 'resume.token.json'),
  ], now, {
    AIWORKER_TEST_LEGACY_BOOTSTRAP_RESUME: '1',
    AIWORKER_TEST_LEGACY_BOOTSTRAP_RESUME_SNAPSHOT: entry.resumeSnapshotPath,
    AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim,
  })
}

function mutateLive(entry: Fixture, mutate: (value: any) => void) {
  const value = JSON.parse(readFileSync(entry.livePath, 'utf8'))
  mutate(value)
  writePrivate(entry.livePath, value)
}

describe('legacy bootstrap confirmation controller', () => {
  it('requires a completely empty bootstrap attempt before prepare', () => {
    const entry = fixture()
    writeFileSync(join(entry.attempt, 'transition-rollback-authorization.receipt.json'), '{}\n', {
      mode: 0o400,
    })
    const refused = prepare(entry)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('attempt directory must be empty')
    expect(existsSync(join(entry.attempt, 'prepare.receipt.json'))).toBe(false)
  })

  it('creates a private immutable prepare/confirm/shutdown receipt chain without service actions', () => {
    const entry = fixture()
    const prepared = prepare(entry)
    expect(prepared.status, prepared.stderr).toBe(0)
    const preparePath = join(entry.attempt, 'prepare.receipt.json')
    expect(lstatSync(preparePath).mode & 0o777).toBe(0o400)
    expect(lstatSync(preparePath).nlink).toBe(1)

    const confirmed = confirm(entry)
    expect(confirmed.status, confirmed.stderr).toBe(0)
    const confirmPath = join(entry.attempt, 'current-confirm.receipt.json')
    const tokenPath = join(entry.attempt, 'current-confirm.token.json')
    const confirmation = JSON.parse(readFileSync(confirmPath, 'utf8'))
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'))
    expect(confirmation).not.toHaveProperty('capability')
    expect(confirmation.tokenSha256).toBe(hash(token.capability))
    expect(token.capability).toMatch(/^[a-f0-9]{64}$/u)
    expect(lstatSync(confirmPath).mode & 0o777).toBe(0o400)
    expect(lstatSync(tokenPath).mode & 0o777).toBe(0o600)

    const applied = apply(entry)
    expect(applied.status, applied.stderr).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: 'apply',
      phase: 'SHUTDOWN_REQUESTED',
      serviceActionsPerformed: false,
    })
    expect(existsSync(tokenPath)).toBe(false)
    const shutdownPath = join(entry.attempt, 'shutdown-requested.receipt.json')
    expect(lstatSync(shutdownPath).mode & 0o777).toBe(0o400)
    expect(lstatSync(shutdownPath).nlink).toBe(1)

    const status = run(['status', '--attempt-dir', entry.attempt], BASE_NOW, {
      AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM: entry.transitionClaim,
    })
    expect(status.status, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({
      phase: 'SHUTDOWN_REQUESTED',
      expired: false,
      tokenPresent: false,
      bindings: {
        sourceCommit: SOURCE_COMMIT,
        databases: {
          mission: identity(entry.mission),
          n8n: identity(entry.n8n),
        },
      },
    })
    expect(readFileSync(entry.verifierCountPath, 'utf8')).toBe('2')
  })

  it('refuses replay and a capability rebound to another target', () => {
    const replay = fixture()
    expect(prepare(replay).status).toBe(0)
    expect(confirm(replay).status).toBe(0)
    expect(apply(replay).status).toBe(0)
    const repeated = apply(replay)
    expect(repeated.status).not.toBe(0)
    expect(repeated.stderr).toContain('capability replay refused')

    const wrongTarget = fixture()
    expect(prepare(wrongTarget).status).toBe(0)
    expect(confirm(wrongTarget).status).toBe(0)
    const tokenPath = join(wrongTarget.attempt, 'current-confirm.token.json')
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'))
    token.targetSha256 = '9'.repeat(64)
    writePrivate(tokenPath, token)
    const refused = apply(wrongTarget)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('bound to another target')
    expect(existsSync(join(wrongTarget.attempt, 'shutdown-requested.receipt.json'))).toBe(false)
  })

  it('rejects incomplete or drifted native transition full references', () => {
    for (const mutate of [
      (claim: Record<string, unknown>) => { delete claim.ctimeNs },
      (claim: Record<string, unknown>) => { claim.mode = '600' },
      (claim: Record<string, unknown>) => { claim.nlink = 2 },
      (claim: Record<string, unknown>) => {
        claim.mtimeNs = String(BigInt(String(claim.mtimeNs)) + BigInt(1))
      },
    ]) {
      const entry = fixture()
      expect(prepare(entry).status).toBe(0)
      const pathname = join(entry.attempt, 'prepare.receipt.json')
      const receipt = JSON.parse(readFileSync(pathname, 'utf8'))
      mutate(receipt.transition.claim)
      chmodSync(pathname, 0o600)
      writeFileSync(pathname, `${JSON.stringify(receipt)}\n`)
      chmodSync(pathname, 0o400)
      const result = confirm(entry)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('full reference')
    }
  })

  it('uses the earliest guard/prepare/120-second expiry and rejects stale capability use', () => {
    const entry = fixture({ guardExpiresAt: BASE_NOW + 300 })
    expect(prepare(entry).status).toBe(0)
    expect(confirm(entry).status).toBe(0)
    const confirmation = JSON.parse(readFileSync(
      join(entry.attempt, 'current-confirm.receipt.json'),
      'utf8',
    ))
    expect(confirmation.expiresAt).toBe(BASE_NOW + 120)
    const expired = apply(entry, BASE_NOW + 121)
    expect(expired.status).not.toBe(0)
    expect(expired.stderr).toMatch(/expired/u)
    expect(existsSync(join(entry.attempt, 'shutdown-requested.receipt.json'))).toBe(false)
  })

  it('caps confirmation at the five-minute evidence freshness deadline', () => {
    const entry = fixture({ observedAt: BASE_NOW - 250, guardExpiresAt: BASE_NOW + 300 })
    expect(prepare(entry).status).toBe(0)
    const prepared = JSON.parse(readFileSync(join(entry.attempt, 'prepare.receipt.json'), 'utf8'))
    expect(prepared.evidenceExpiresAt).toBe(BASE_NOW + 50)
    expect(confirm(entry).status).toBe(0)
    const confirmation = JSON.parse(readFileSync(
      join(entry.attempt, 'current-confirm.receipt.json'), 'utf8',
    ))
    expect(confirmation.expiresAt).toBe(BASE_NOW + 50)
    const refused = apply(entry, BASE_NOW + 51)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toMatch(/expired/u)
  })

  it('detects proof/evidence/target and database inode replacement after confirmation', () => {
    for (const selector of ['evidence', 'manifest', 'mission'] as const) {
      const entry = fixture()
      expect(prepare(entry).status).toBe(0)
      expect(confirm(entry).status).toBe(0)
      const pathname = selector === 'evidence'
        ? entry.evidencePath
        : selector === 'manifest' ? entry.manifestPath : entry.mission
      const replacement = `${pathname}.replacement`
      writeFileSync(replacement, readFileSync(pathname), { mode: 0o600 })
      chmodSync(replacement, 0o600)
      renameSync(replacement, pathname)
      const result = apply(entry)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/(identity changed|target identity changed|database identities changed)/u)
      expect(existsSync(join(entry.attempt, 'shutdown-requested.receipt.json'))).toBe(false)
    }
  })

  it('re-samples current state at confirmation and apply and refuses runtime or guard drift', () => {
    const beforeConfirm = fixture()
    expect(prepare(beforeConfirm).status).toBe(0)
    mutateLive(beforeConfirm, value => { value.counts.n8nActiveExecutions = 1 })
    const busy = confirm(beforeConfirm)
    expect(busy.status).not.toBe(0)
    expect(busy.stderr).toContain('live verifier failed')

    const beforeApply = fixture()
    expect(prepare(beforeApply).status).toBe(0)
    expect(confirm(beforeApply).status).toBe(0)
    mutateLive(beforeApply, value => { value.legacy.pid += 1 })
    const changedPid = apply(beforeApply)
    expect(changedPid.status).not.toBe(0)
    expect(changedPid.stderr).toContain('live verifier failed')
    expect(existsSync(join(beforeApply.attempt, 'shutdown-requested.receipt.json'))).toBe(false)
    expect(readFileSync(beforeApply.verifierCountPath, 'utf8')).toBe('2')

    for (const mutate of [
      (value: any) => { value.frozen.ready = false },
      (value: any) => { value.frozen.guardNonceSha256 = '7'.repeat(64) },
      (value: any) => { value.frozen.expiresAt -= 1 },
      (value: any) => { value.legacy.database.ino = String(Number(value.legacy.database.ino) + 1) },
    ]) {
      const entry = fixture()
      expect(prepare(entry).status).toBe(0)
      mutateLive(entry, mutate)
      const refused = confirm(entry)
      expect(refused.status).not.toBe(0)
      expect(existsSync(join(entry.attempt, 'current-confirm.receipt.json'))).toBe(false)
    }
  })

  it('rejects an unsafe verifier and malformed verifier output', () => {
    const linked = fixture()
    const originalVerifier = linked.verifierPath
    const alias = `${originalVerifier}.alias`
    renameSync(originalVerifier, alias)
    symlinkSync(alias, originalVerifier)
    const linkedResult = prepare(linked)
    expect(linkedResult.status).not.toBe(0)
    expect(linkedResult.stderr).toContain('symlink')

    const writable = fixture()
    chmodSync(writable.verifierPath, 0o722)
    const writableResult = prepare(writable)
    expect(writableResult.status).not.toBe(0)
    expect(writableResult.stderr).toContain('mode is unsafe')

    const oversized = fixture()
    writeFileSync(oversized.verifierPath, Buffer.alloc(1024 * 1024 + 1, 0x20), { mode: 0o700 })
    const oversizedResult = prepare(oversized)
    expect(oversizedResult.status).not.toBe(0)
    expect(oversizedResult.stderr).toContain('too large')

    const duplicate = fixture()
    writeFileSync(duplicate.verifierPath, `#!/usr/bin/env node
process.stdout.write('{"sha":"one","sha":"two"}')
`, { mode: 0o700 })
    chmodSync(duplicate.verifierPath, 0o700)
    expect(prepare(duplicate).status).toBe(0)
    const duplicateResult = confirm(duplicate)
    expect(duplicateResult.status).not.toBe(0)
    expect(duplicateResult.stderr).toContain('live verifier failed')
  })

  it('derives one immutable n8n restore v2 receipt only from the consumed shutdown chain', () => {
    const entry = fixture()
    expect(prepare(entry).status).toBe(0)
    expect(confirm(entry).status).toBe(0)
    const beforeShutdown = deriveRestore(entry)
    expect(beforeShutdown.status).not.toBe(0)
    expect(apply(entry).status).toBe(0)
    const derived = deriveRestore(entry)
    expect(derived.status, derived.stderr).toBe(0)
    const pathname = join(entry.attempt, 'n8n-restore-confirmation.receipt.json')
    const receipt = JSON.parse(readFileSync(pathname, 'utf8'))
    expect(lstatSync(pathname).mode & 0o777).toBe(0o400)
    expect(receipt).toMatchObject({
      schema: 'video-autoworker-n8n-managed-workflow-restore-confirmation/v2',
      action: 'restore-managed-n8n-workflows',
      expiresAt: BASE_NOW + 120,
      target: {
        sourceCommit: SOURCE_COMMIT,
        n8nVersion: '2.31.6',
        runtimeRelease: entry.runtimeRelease,
      },
      authorization: {
        kind: 'legacy-bootstrap-shutdown-requested/v1',
      },
    })
    expect(receipt.authorization.prepare.path).toBe(join(entry.attempt, 'prepare.receipt.json'))
    expect(receipt.authorization.confirm.path).toBe(join(entry.attempt, 'current-confirm.receipt.json'))
    expect(receipt.authorization.shutdown.path).toBe(join(entry.attempt, 'shutdown-requested.receipt.json'))
    const replay = deriveRestore(entry)
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('already exists')

    const boundary = fixture()
    expect(prepare(boundary).status).toBe(0)
    expect(confirm(boundary).status).toBe(0)
    expect(apply(boundary).status).toBe(0)
    const zeroLifetime = deriveRestore(boundary, BASE_NOW + 120)
    expect(zeroLifetime.status).not.toBe(0)
    expect(zeroLifetime.stderr).toContain('expired before n8n restore authorization')
  })

  it('derives a fresh restore-only disaster claim after the original guard and confirmation expired', () => {
    const entry = fixture()
    expect(prepare(entry).status).toBe(0)
    expect(confirm(entry).status).toBe(0)
    expect(apply(entry).status).toBe(0)
    const pending = createPendingV4(entry)
    const recoveryAttempt = disasterAttempt(entry)
    const result = deriveDisaster(entry, pending, recoveryAttempt, BASE_NOW + 500)
    expect(result.status, result.stderr).toBe(0)
    const pathname = join(recoveryAttempt, 'n8n-disaster-recovery-confirmation.receipt.json')
    const receipt = JSON.parse(readFileSync(pathname, 'utf8'))
    expect(lstatSync(pathname).mode & 0o777).toBe(0o400)
    expect(receipt).toMatchObject({
      schema: 'video-autoworker-n8n-managed-workflow-disaster-recovery-confirmation/v1',
      scope: 'n8n-managed-workflow-restore-only',
      issuedAt: BASE_NOW + 500,
      expiresAt: BASE_NOW + 620,
      authorization: {
        attemptId: JSON.parse(readFileSync(join(entry.attempt, 'prepare.receipt.json'), 'utf8')).attemptId,
        originalConfirmationExpiresAt: BASE_NOW + 120,
      },
      journal: {
        schema: 'video-autoworker-n8n-disaster-recovery-journal/v1',
        directory: recoveryAttempt,
      },
    })
    expect(receipt.expiresAt).toBe(receipt.issuedAt + 120)
    expect(receipt.authorization.pending).toEqual(reference(pending))
  })

  it('derives, verifies, and consumes one fresh resume capability after TTL/guard loss', () => {
    const entry = fixture()
    expect(prepare(entry).status).toBe(0)
    expect(confirm(entry).status).toBe(0)
    expect(apply(entry).status).toBe(0)
    const pending = createPendingV4(entry)
    const recoveryAttempt = disasterAttempt(entry)
    const derived = deriveResume(entry, pending, recoveryAttempt, BASE_NOW + 86_401)
    expect(derived.status, derived.stderr).toBe(0)
    expect(lstatSync(join(recoveryAttempt, 'resume.receipt.json')).mode & 0o777).toBe(0o400)
    expect(lstatSync(join(recoveryAttempt, 'resume.token.json')).mode & 0o777).toBe(0o600)
    expect(verifyResume(entry, recoveryAttempt, 'verify', BASE_NOW + 86_520).status).toBe(0)
    const consumed = verifyResume(entry, recoveryAttempt, 'consume', BASE_NOW + 86_520)
    expect(consumed.status, consumed.stderr).toBe(0)
    expect(existsSync(join(recoveryAttempt, 'resume.token.json'))).toBe(false)
    expect(lstatSync(join(recoveryAttempt, 'resume.consumed.json')).mode & 0o777).toBe(0o400)
    expect(verifyResume(entry, recoveryAttempt, 'consume', BASE_NOW + 86_520).status).not.toBe(0)

    const expiredEntry = fixture()
    expect(prepare(expiredEntry).status).toBe(0)
    expect(confirm(expiredEntry).status).toBe(0)
    expect(apply(expiredEntry).status).toBe(0)
    const expiredAttempt = disasterAttempt(expiredEntry)
    expect(deriveResume(
      expiredEntry, createPendingV4(expiredEntry), expiredAttempt, BASE_NOW + 500,
    ).status).toBe(0)
    const expired = verifyResume(expiredEntry, expiredAttempt, 'verify', BASE_NOW + 620)
    expect(expired.status).not.toBe(0)
    expect(expired.stderr).toContain('capability expired')
  })

  it('resumes the selected recovery branch after claim, artifact, TTL, and consumed-token crash windows', () => {
    const claimOnly = fixture()
    expect(prepare(claimOnly).status).toBe(0)
    expect(confirm(claimOnly).status).toBe(0)
    expect(apply(claimOnly).status).toBe(0)
    const claimOnlyPending = createPendingV4(claimOnly)
    const claimOnlyAttempt = disasterAttempt(claimOnly)
    const bootstrapAttemptId = JSON.parse(readFileSync(
      join(claimOnly.attempt, 'prepare.receipt.json'), 'utf8',
    )).attemptId
    writeFileSync(join(claimOnly.attempt, 'recovery-branch.claim.json'), `${JSON.stringify({
      schema: 'video-autoworker-legacy-bootstrap-recovery-branch/v2',
      attemptId: bootstrapAttemptId,
      branch: 'resume',
      claimedAt: BASE_NOW + 500,
      uid: process.getuid?.() ?? 0,
    })}\n`, { mode: 0o400 })
    chmodSync(join(claimOnly.attempt, 'recovery-branch.claim.json'), 0o400)
    expect(deriveResume(
      claimOnly, claimOnlyPending, claimOnlyAttempt, BASE_NOW + 500,
    ).status).toBe(0)

    const tokenOnly = fixture()
    expect(prepare(tokenOnly).status).toBe(0)
    expect(confirm(tokenOnly).status).toBe(0)
    expect(apply(tokenOnly).status).toBe(0)
    const tokenOnlyPending = createPendingV4(tokenOnly)
    const tokenOnlyAttempt = disasterAttempt(tokenOnly)
    expect(deriveResume(tokenOnly, tokenOnlyPending, tokenOnlyAttempt, BASE_NOW + 500).status).toBe(0)
    const originalReceipt = readFileSync(join(tokenOnlyAttempt, 'resume.receipt.json'), 'utf8')
    rmSync(join(tokenOnlyAttempt, 'resume.receipt.json'))
    const reconstructed = deriveResume(
      tokenOnly, tokenOnlyPending, tokenOnlyAttempt, BASE_NOW + 510,
    )
    expect(reconstructed.status, reconstructed.stderr).toBe(0)
    expect(readFileSync(join(tokenOnlyAttempt, 'resume.receipt.json'), 'utf8')).toBe(originalReceipt)

    const consumed = fixture()
    expect(prepare(consumed).status).toBe(0)
    expect(confirm(consumed).status).toBe(0)
    expect(apply(consumed).status).toBe(0)
    const consumedPending = createPendingV4(consumed)
    const firstAttempt = disasterAttempt(consumed)
    expect(deriveResume(consumed, consumedPending, firstAttempt, BASE_NOW + 500).status).toBe(0)
    expect(verifyResume(consumed, firstAttempt, 'consume', BASE_NOW + 510).status).toBe(0)
    const repeated = deriveResume(consumed, consumedPending, firstAttempt, BASE_NOW + 515)
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(JSON.parse(repeated.stdout)).toMatchObject({ alreadyConsumed: true, tokenFile: null })
    const nextAttempt = disasterAttempt(consumed, '223e4567-e89b-42d3-a456-426614174000')
    const renewed = deriveResume(consumed, consumedPending, nextAttempt, BASE_NOW + 700)
    expect(renewed.status, renewed.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(nextAttempt, 'resume.token.json'), 'utf8'))).toMatchObject({
      issuedAt: BASE_NOW + 700,
      expiresAt: BASE_NOW + 820,
    })

    const restore = fixture()
    expect(prepare(restore).status).toBe(0)
    expect(confirm(restore).status).toBe(0)
    expect(apply(restore).status).toBe(0)
    const restorePending = createPendingV4(restore)
    const restoreAttempt = disasterAttempt(restore)
    const restoreAttemptId = JSON.parse(readFileSync(
      join(restore.attempt, 'prepare.receipt.json'), 'utf8',
    )).attemptId
    writeFileSync(join(restore.attempt, 'recovery-branch.claim.json'), `${JSON.stringify({
      schema: 'video-autoworker-legacy-bootstrap-recovery-branch/v2',
      attemptId: restoreAttemptId,
      branch: 'restore',
      claimedAt: BASE_NOW + 500,
      uid: process.getuid?.() ?? 0,
    })}\n`, { mode: 0o400 })
    chmodSync(join(restore.attempt, 'recovery-branch.claim.json'), 0o400)
    expect(deriveDisaster(
      restore, restorePending, restoreAttempt, BASE_NOW + 500,
    ).status).toBe(0)
    expect(deriveDisaster(
      restore, restorePending, restoreAttempt, BASE_NOW + 510,
    ).status).toBe(0)
  })

  it('makes disaster restore and managed resume mutually exclusive for one bootstrap attempt', () => {
    const resumeFirst = fixture()
    expect(prepare(resumeFirst).status).toBe(0)
    expect(confirm(resumeFirst).status).toBe(0)
    expect(apply(resumeFirst).status).toBe(0)
    const resumePending = createPendingV4(resumeFirst)
    expect(deriveResume(
      resumeFirst,
      resumePending,
      disasterAttempt(resumeFirst),
      BASE_NOW + 500,
    ).status).toBe(0)
    const blockedRestore = deriveDisaster(
      resumeFirst,
      resumePending,
      disasterAttempt(resumeFirst, '223e4567-e89b-42d3-a456-426614174000'),
      BASE_NOW + 500,
    )
    expect(blockedRestore.status).not.toBe(0)
    expect(blockedRestore.stderr).toContain('other restore/resume branch')

    const restoreFirst = fixture()
    expect(prepare(restoreFirst).status).toBe(0)
    expect(confirm(restoreFirst).status).toBe(0)
    expect(apply(restoreFirst).status).toBe(0)
    const restorePending = createPendingV4(restoreFirst)
    expect(deriveDisaster(
      restoreFirst,
      restorePending,
      disasterAttempt(restoreFirst),
      BASE_NOW + 500,
    ).status).toBe(0)
    const blockedResume = deriveResume(
      restoreFirst,
      restorePending,
      disasterAttempt(restoreFirst, '323e4567-e89b-42d3-a456-426614174000'),
      BASE_NOW + 500,
    )
    expect(blockedResume.status).not.toBe(0)
    expect(blockedResume.stderr).toContain('other restore/resume branch')
  })

  it('refuses resume when a zero-work snapshot changes or the database identity drifts', () => {
    for (const field of ['mediaNodes', 'n8nActiveExecutions', 'queueWaiting', 'queueRunning']) {
      const active = fixture()
      expect(prepare(active).status).toBe(0)
      expect(confirm(active).status).toBe(0)
      expect(apply(active).status).toBe(0)
      const activeAttempt = disasterAttempt(active)
      const activeSnapshot = JSON.parse(readFileSync(active.resumeSnapshotPath, 'utf8'))
      activeSnapshot.counts[field] = 1
      writePrivate(active.resumeSnapshotPath, activeSnapshot)
      expect(deriveResume(
        active, createPendingV4(active), activeAttempt, BASE_NOW + 500,
      ).status, field).not.toBe(0)
    }

    const drift = fixture()
    expect(prepare(drift).status).toBe(0)
    expect(confirm(drift).status).toBe(0)
    expect(apply(drift).status).toBe(0)
    const pending = createPendingV4(drift)
    const replacement = `${drift.n8n}.replacement`
    writeFileSync(replacement, readFileSync(drift.n8n), { mode: 0o600 })
    renameSync(replacement, drift.n8n)
    expect(deriveResume(drift, pending, disasterAttempt(drift), BASE_NOW + 500).status).not.toBe(0)
  })

  it('keeps stale non-durable accepted work as attention while durable or fresh work blocks resume', () => {
    const now = BASE_NOW + 500
    const staleOnly = projectOfflineQueue([
      { taskId: 'stale-openclaw', status: 'accepted', updatedAt: now - 24 * 60 * 60 },
    ], [], now)
    expect(staleOnly).toMatchObject({ waiting: 0, running: 0 })
    expect(staleOnly.values[0]).toMatchObject({ origin: 'attention-stale' })

    const fresh = projectOfflineQueue([
      { taskId: 'fresh-openclaw', status: 'accepted', updatedAt: now - 60 },
    ], [], now)
    expect(fresh.waiting).toBe(1)

    const durable = projectOfflineQueue([
      { taskId: 'durable-old', status: 'accepted', updatedAt: now - 48 * 60 * 60 },
    ], [{ taskId: 'durable-old', status: 'accepted', origin: 'durable' }], now)
    expect(durable.waiting).toBe(1)

    const allDurableWaitStates = projectOfflineQueue([], [
      { taskId: 'waiting', status: 'waiting', origin: 'durable' },
      { taskId: 'recovering', status: 'recovering', origin: 'durable' },
      { taskId: 'paused', status: 'paused', origin: 'durable' },
    ], now)
    expect(allDurableWaitStates.waiting).toBe(3)
  })

  it('fails closed on damaged, unknown, or over-limit durable batch state instead of projecting zero', () => {
    const makeRoot = () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-bootstrap-batches.')))
      roots.push(root)
      chmodSync(root, 0o700)
      return root
    }
    const stateName = (index: number) => `${hash(`state-${index}`)}.json`
    const writeState = (root: string, index: number, state: unknown) => {
      const pathname = join(root, stateName(index))
      writeFileSync(pathname, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      chmodSync(pathname, 0o600)
    }

    const valid = makeRoot()
    writeState(valid, 0, {
      schemaVersion: 2,
      batchId: 'durable-batch',
      status: 'recovering',
      items: [
        { taskId: 'durable-waiting', status: 'waiting' },
        { taskId: 'durable-paused', status: 'paused' },
        { taskId: 'durable-running', status: 'running' },
      ],
    })
    const projection = projectOfflineQueue([], scanOfflineDurableBatchStates(valid), BASE_NOW)
    expect(projection).toMatchObject({ waiting: 2, running: 1 })

    const corrupt = makeRoot()
    writeFileSync(join(corrupt, stateName(0)), '{broken', { mode: 0o600 })
    expect(() => scanOfflineDurableBatchStates(corrupt)).toThrow(/video batch state/u)

    const unknown = makeRoot()
    writeFileSync(join(unknown, 'untracked.json'), '{}\n', { mode: 0o600 })
    expect(() => scanOfflineDurableBatchStates(unknown)).toThrow(/unrecognized artifact/u)

    const tooManyItems = makeRoot()
    writeState(tooManyItems, 0, {
      schemaVersion: 2,
      batchId: 'oversized-batch',
      status: 'queued',
      items: Array.from({ length: 20_001 }, (_, index) => ({
        taskId: `oversized:${index}`,
        status: 'queued',
      })),
    })
    expect(() => scanOfflineDurableBatchStates(tooManyItems)).toThrow(/items exceed/u)

    const tooManyFiles = makeRoot()
    for (let index = 0; index < 2_001; index += 1) {
      writeFileSync(join(tooManyFiles, stateName(index)), '{}\n', { mode: 0o600 })
    }
    expect(() => scanOfflineDurableBatchStates(tooManyFiles)).toThrow(/state count exceeds/u)

    const orphanBackup = makeRoot()
    writeFileSync(join(orphanBackup, `${stateName(0)}.bak`), '{}\n', { mode: 0o600 })
    expect(() => scanOfflineDurableBatchStates(orphanBackup)).toThrow(/no authoritative primary/u)
  })

  it('refuses disaster authorization on pending, database, or recovery-attempt ABA drift', () => {
    const setup = () => {
      const entry = fixture()
      expect(prepare(entry).status).toBe(0)
      expect(confirm(entry).status).toBe(0)
      expect(apply(entry).status).toBe(0)
      return { entry, pending: createPendingV4(entry), recoveryAttempt: disasterAttempt(entry) }
    }

    const pendingDrift = setup()
    const pendingValue = JSON.parse(readFileSync(pendingDrift.pending, 'utf8'))
    pendingValue.n8n.workflowProtocol = 'legacy-v1'
    chmodSync(pendingDrift.pending, 0o600)
    writeFileSync(pendingDrift.pending, `${JSON.stringify(pendingValue)}\n`)
    chmodSync(pendingDrift.pending, 0o400)
    expect(deriveDisaster(
      pendingDrift.entry, pendingDrift.pending, pendingDrift.recoveryAttempt, BASE_NOW + 500,
    ).status).not.toBe(0)

    const databaseAba = setup()
    const replacement = `${databaseAba.entry.n8n}.replacement`
    writeFileSync(replacement, readFileSync(databaseAba.entry.n8n), { mode: 0o600 })
    renameSync(replacement, databaseAba.entry.n8n)
    expect(deriveDisaster(
      databaseAba.entry, databaseAba.pending, databaseAba.recoveryAttempt, BASE_NOW + 500,
    ).status).not.toBe(0)

    const reportTamper = setup()
    const reportPath = reportTamper.entry.workflowReportPath
    chmodSync(reportPath, 0o600)
    writeFileSync(reportPath, `${readFileSync(reportPath, 'utf8')}\n`)
    chmodSync(reportPath, 0o400)
    const tampered = deriveDisaster(
      reportTamper.entry, reportTamper.pending, reportTamper.recoveryAttempt, BASE_NOW + 500,
    )
    expect(tampered.status).not.toBe(0)
    expect(tampered.stderr).toMatch(/workflow compatibility report (identity|reference)/u)

    const wrongReport = setup()
    const wrongPendingValue = JSON.parse(readFileSync(wrongReport.pending, 'utf8'))
    const wrongReportPath = join(wrongReport.entry.attempt, 'wrong-workflow-report.json')
    const wrongReportValue = JSON.parse(readFileSync(
      wrongReport.entry.workflowReportPath, 'utf8',
    ))
    wrongReportValue.databasePath = join(wrongReport.entry.root, 'other.sqlite')
    writeFileSync(wrongReportPath, `${JSON.stringify(wrongReportValue)}\n`, { mode: 0o400 })
    chmodSync(wrongReportPath, 0o400)
    wrongPendingValue.n8n.workflowReport = reference(wrongReportPath)
    chmodSync(wrongReport.pending, 0o600)
    writeFileSync(wrongReport.pending, `${JSON.stringify(wrongPendingValue)}\n`)
    chmodSync(wrongReport.pending, 0o400)
    const rejectedReport = deriveDisaster(
      wrongReport.entry, wrongReport.pending, wrongReport.recoveryAttempt, BASE_NOW + 500,
    )
    expect(rejectedReport.status).not.toBe(0)
    expect(rejectedReport.stderr).toContain('workflow compatibility report binding is invalid')

    const nonempty = setup()
    writeFileSync(join(nonempty.recoveryAttempt, 'manual.json'), '{}', { mode: 0o600 })
    const refused = deriveDisaster(nonempty.entry, nonempty.pending, nonempty.recoveryAttempt, BASE_NOW + 500)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('unknown artifact')
  })

  it('rejects duplicate JSON keys, unsafe links, oversized artifacts, and non-private directories', () => {
    const duplicate = fixture()
    const original = readFileSync(duplicate.proofPath, 'utf8').trim()
    writeFileSync(duplicate.proofPath,
      `{"schema":"duplicate",${original.slice(1)}\n`, { mode: 0o600 })
    const duplicateResult = prepare(duplicate)
    expect(duplicateResult.status).not.toBe(0)
    expect(duplicateResult.stderr).toContain('duplicate JSON key')

    const linked = fixture()
    linkSync(linked.evidencePath, `${linked.evidencePath}.alias`)
    const linkResult = prepare(linked)
    expect(linkResult.status).not.toBe(0)
    expect(linkResult.stderr).toContain('link count is unsafe')

    const oversized = fixture()
    writeFileSync(oversized.evidencePath, Buffer.alloc(1024 * 1024 + 1, 0x20), { mode: 0o600 })
    const sizeResult = prepare(oversized)
    expect(sizeResult.status).not.toBe(0)
    expect(sizeResult.stderr).toContain('too large')

    const publicDirectory = fixture()
    chmodSync(publicDirectory.attempt, 0o755)
    const modeResult = prepare(publicDirectory)
    expect(modeResult.status).not.toBe(0)
    expect(modeResult.stderr).toContain('mode is unsafe')
  })
})
