// @vitest-environment node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const controller = resolve(process.cwd(), 'scripts/legacy-preinstall-controller.mjs')
const COMMIT = 'a'.repeat(40)
const NOW = 1_800_000_000
const roots: string[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const canonicalize = (value: any): any => Array.isArray(value) ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
    : value
const canonicalJson = (value: unknown) => JSON.stringify(canonicalize(value))

function processStartToken(pid = process.pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function identity(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

function reference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return {
    ...identity(pathname), size: Number(entry.size), sha256: digest(readFileSync(pathname)),
  }
}

function writeJson(pathname: string, value: unknown, mode = 0o600) {
  writeFileSync(pathname, `${JSON.stringify(value)}\n`, { mode })
  chmodSync(pathname, mode)
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-preinstall.')))
  roots.push(root)
  chmodSync(root, 0o700)
  const attempt = join(root, 'attempt')
  const releasesRoot = join(root, 'releases')
  const releaseId = `${COMMIT}-runtime`
  const releaseRoot = join(releasesRoot, releaseId, 'standalone')
  const transitionRoot = join(root, 'transition')
  const journal = join(transitionRoot, 'journal')
  const profileStateRoot = join(root, 'profile')
  const workspaceRoot = join(root, 'workspace')
  const videoBatchRoot = join(root, 'video-batches')
  for (const pathname of [attempt, releaseRoot, journal, profileStateRoot, workspaceRoot, videoBatchRoot]) {
    mkdirSync(pathname, { recursive: true, mode: 0o700 })
    chmodSync(pathname, 0o700)
  }
  const manifest = join(releaseRoot, 'release-manifest.json')
  writeJson(manifest, { schema: 'test-release/v1' })
  const mission = join(root, 'mission.db')
  const n8n = join(root, 'n8n.db')
  const missionBackup = join(root, 'mission.backup.db')
  const n8nBackup = join(root, 'n8n.backup.db')
  for (const pathname of [mission, n8n, missionBackup, n8nBackup]) {
    writeFileSync(pathname, pathname, { mode: 0o600 })
    chmodSync(pathname, 0o600)
  }
  const guard = {
    schema: 'video-autoworker-legacy-freeze-guard/v1',
    expiresAt: NOW + 3_600,
    guardNonceSha256: 'b'.repeat(64),
    legacyBindingSha256: 'c'.repeat(64),
  }
  const proof = join(root, 'proof.json')
  writeJson(proof, { schema: 'video-autoworker-legacy-bootstrap-rollback-proof/v2' })
  const evidence = join(root, 'evidence.json')
  writeJson(evidence, {
    schema: 'video-autoworker-legacy-freeze-evidence/v3',
    observedAt: NOW,
    frozen: guard,
    rollback: reference(proof),
    target: {
      slot: 'blue', releaseId, releaseRoot, manifestSha256: digest(readFileSync(manifest)),
    },
    legacy: { database: identity(mission) },
    n8n: { database: identity(n8n) },
    counts: { mediaNodes: 0, n8nActiveExecutions: 0, queueWaiting: 0, queueRunning: 0 },
    queueDigestSha256: 'd'.repeat(64),
    supervisor: { disabled: true, loaded: false, lockAbsent: true, workerPids: [] },
  })
  const intent = join(transitionRoot, 'upgrade-intent.json')
  const confirmation = join(transitionRoot, 'current-confirmation.json')
  const report = join(transitionRoot, 'live-report.json')
  const attestation = join(transitionRoot, 'transition-attestation.json')
  const journalHead = join(journal, '000001-COMMITTED.json')
  writeJson(intent, { schema: 'test-intent/v1' }, 0o400)
  writeJson(confirmation, { schema: 'test-confirmation/v1' }, 0o400)
  writeJson(journalHead, { state: 'COMMITTED' }, 0o400)
  const liveCombinedSha256 = 'e'.repeat(64)
  writeJson(report, { databasePath: n8n, sourceCommit: COMMIT, combinedSha256: liveCombinedSha256 }, 0o400)
  writeJson(attestation, {
    upgradeId: '11111111-1111-4111-8111-111111111111',
    n8n: { sourceCommit: COMMIT },
    targetApplicationRelease: {
      slot: 'blue', releaseId, releaseRoot: { path: releaseRoot },
      manifest: { sha256: digest(readFileSync(manifest)) },
    },
    deployed: { report: reference(report), combinedSha256: liveCombinedSha256 },
  }, 0o400)
  const evidenceVerifier = join(root, 'evidence-verifier.mjs')
  writeFileSync(evidenceVerifier, "import{readFileSync}from'node:fs';import{createHash}from'node:crypto';process.stdout.write(createHash('sha256').update(readFileSync(3)).digest('hex')+'\\n')\n", { mode: 0o700 })
  chmodSync(evidenceVerifier, 0o700)
  const transitionVerifier = join(root, 'transition-verifier.mjs')
  writeFileSync(transitionVerifier, `import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const p=${JSON.stringify(attestation)};process.stdout.write(JSON.stringify({committed:true,attestationSha256:createHash('sha256').update(readFileSync(p)).digest('hex'),liveCombinedSha256:${JSON.stringify(liveCombinedSha256)},upgradeId:'11111111-1111-4111-8111-111111111111'})+'\\n')\n`, { mode: 0o700 })
  chmodSync(transitionVerifier, 0o700)
  const readinessVerifier = join(root, 'readiness-verifier.mjs')
  writeFileSync(readinessVerifier, `process.stdout.write(JSON.stringify({schema:'video-autoworker-director-video-preflight/v1',phase:'pre-bootstrap',ok:true,commit:${JSON.stringify(COMMIT)},app:{releaseId:${JSON.stringify(releaseId)},root:${JSON.stringify(releaseRoot)},manifestSha256:${JSON.stringify(digest(readFileSync(manifest)))}},contracts:{directorWork:true,outboxClosure:true,sessionScopedRuntimeConvergence:true},payloads:{videoCommand:{root:${JSON.stringify(join(profileStateRoot, 'plugins/aiworker-video-command'))},manifestSha256:'1'.repeat(64)},taskFlow:{root:${JSON.stringify(join(workspaceRoot, 'skills/aiworker-task-flow'))},manifestSha256:'2'.repeat(64)},directorBrain:{manifestSha256:'3'.repeat(64)}},runtimeConvergence:{schema:'video-autoworker-openclaw-runtime-convergence-proof/v1'}})+'\\n')\n`, { mode: 0o700 })
  chmodSync(readinessVerifier, 0o700)
  const runtimeProof = join(root, 'runtime-proof.json')
  writeJson(runtimeProof, {
    schema: 'video-autoworker-openclaw-runtime-convergence-proof/v1',
    runtime: {
      gateway: { pid: 102 }, toolInventory: { sha256: '7'.repeat(64) },
      effectiveToolInventory: { sha256: '8'.repeat(64) },
      plugins: [{ id: 'aiworker-director-brain', treeSha256: '9'.repeat(64) }],
    },
  })
  const gatewayRestart = join(root, 'gateway-restart.json')
  writeJson(gatewayRestart, {
    schema: 'video-autoworker-legacy-preinstall-protected-pids/v1',
    phase: 'restarted', beforePid: 101, afterPid: 102,
  })
  const finalGate = join(root, 'final-gate.mjs')
  writeFileSync(finalGate, `import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';import{statSync}from'node:fs';const a=process.argv.slice(2),v=n=>a[a.indexOf(n)+1],c=x=>Array.isArray(x)?x.map(c):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,c(x[k])])):x,j=x=>JSON.stringify(c(x)),s=x=>createHash('sha256').update(x).digest('hex'),status=JSON.parse(execFileSync(process.execPath,[${JSON.stringify(controller)},'status','--attempt-dir',v('--legacy-preinstall-attempt-dir')],{encoding:'utf8',env:process.env})),id=p=>{const e=statSync(p,{bigint:true});return{path:p,dev:e.dev.toString(),ino:e.ino.toString()}},activity={mission:id(v('--mission-control-db-path')),n8n:id(v('--n8n-db-path')),activeTasks:0,activeMediaNodes:0,activeN8nExecutions:0,waiting:0,running:0,attentionStale:0,pendingOutbox:0},observedAt=Number(process.env.AIWORKER_TEST_LEGACY_PREINSTALL_NOW);const identity={phase:status.phase,installAttemptId:status.installAttemptId,revision:status.revision,prepared:status.prepared,verification:status.verification,terminal:status.terminal,finalize:status.finalize,components:status.components,bindings:status.bindings};process.stdout.write(JSON.stringify({schema:'video-autoworker-shared-runtime-final-gate/v1',mode:'legacy-preinstall',installAttemptId:status.installAttemptId,revision:status.revision,sourceCommit:v('--expected-source-commit'),targetReleaseId:v('--expected-release-id'),observedAt,statusIdentitySha256:s(j(identity)),activity:{...activity,snapshotSha256:s(j(activity))}})+'\\n')\n`, { mode: 0o700 })
  const patchedFinalGate = readFileSync(finalGate, 'utf8')
    .replace("import{statSync}", "import{readFileSync,statSync}")
    .replace("const identity=", "const self=(()=>{const p=process.argv[1],e=statSync(p,{bigint:true});return{path:p,dev:e.dev.toString(),ino:e.ino.toString(),size:Number(e.size),sha256:s(readFileSync(p))}})();const identity=")
    .replace("statusIdentitySha256:s(j(identity)),activity:", "statusIdentitySha256:s(j(identity)),finalize:status.finalize,verifier:self,activity:")
  writeFileSync(finalGate, patchedFinalGate, { mode: 0o700 })
  chmodSync(finalGate, 0o700)
  const claim = join(transitionRoot, 'bootstrap-claim.json')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AIWORKER_TEST_LEGACY_PREINSTALL: '1',
    AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(NOW),
    AIWORKER_TEST_LEGACY_PREINSTALL_EVIDENCE_VERIFIER: evidenceVerifier,
    AIWORKER_TEST_LEGACY_PREINSTALL_TRANSITION_ANCHOR: transitionVerifier,
    AIWORKER_TEST_LEGACY_PREINSTALL_READINESS_VERIFIER: readinessVerifier,
    AIWORKER_TEST_LEGACY_PREINSTALL_FINAL_GATE: finalGate,
  }
  return {
    root, attempt, releasesRoot, releaseRoot, profileStateRoot, workspaceRoot, evidence, proof,
    mission, n8n, intent, confirmation, journal, attestation, claim, runtimeProof,
    gatewayRestart, videoBatchRoot, env,
  }
}

function run(entry: ReturnType<typeof fixture>, ...args: string[]) {
  return spawnSync(process.execPath, [controller, ...args], { encoding: 'utf8', env: entry.env })
}

function prepareArguments(entry: ReturnType<typeof fixture>) {
  return [
    'prepare', '--attempt-dir', entry.attempt, '--evidence', entry.evidence,
    '--proof', entry.proof, '--source-commit', COMMIT,
    '--transition-intent', entry.intent, '--transition-confirmation', entry.confirmation,
    '--transition-journal', entry.journal, '--transition-attestation', entry.attestation,
    '--transition-claim', entry.claim,
  ]
}

function prepare(entry: ReturnType<typeof fixture>) {
  return run(entry, ...prepareArguments(entry))
}

const components = ['task-flow', 'video-command', 'director-brain'] as const

const managedInstallers = {
  'task-flow': resolve(process.cwd(), 'scripts/install-aiworker-task-flow-skill.sh'),
  'video-command': resolve(process.cwd(), 'scripts/install-aiworker-video-command-plugin.sh'),
  'director-brain': resolve(process.cwd(), 'scripts/install-aiworker-director-brain.sh'),
} as const

function reserveOnly(
  entry: ReturnType<typeof fixture>, installAttemptId: string,
  component: typeof components[number], rawResultPath: string,
  installerPid: number, installerStartToken: string, targetStateSha256 = 'f'.repeat(64),
) {
  const status = JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout)
  const identityValue = {
    phase: status.phase, installAttemptId: status.installAttemptId, revision: status.revision,
    prepared: status.prepared, verification: status.verification, terminal: status.terminal,
    finalize: status.finalize, components: status.components, bindings: status.bindings,
  }
  const activity = {
    mission: status.bindings.databases.mission, n8n: status.bindings.databases.n8n,
    activeTasks: 0, activeMediaNodes: 0, activeN8nExecutions: 0,
    waiting: 0, running: 0, attentionStale: 0, pendingOutbox: 0,
  }
  return run(entry,
    'reserve-component', '--attempt-dir', entry.attempt,
    '--install-attempt-id', installAttemptId, '--expected-revision', String(status.revision),
    '--operation', 'install', '--component', component, '--raw-result-output', rawResultPath,
    '--status-identity-sha256', digest(canonicalJson(identityValue)),
    '--target-state-sha256', targetStateSha256,
    '--installer-pid', String(installerPid), '--installer-start-token', installerStartToken,
    '--active-tasks', '0', '--active-media-nodes', '0', '--active-n8n-executions', '0',
    '--waiting', '0', '--running', '0', '--attention-stale', '0', '--pending-outbox', '0',
    '--snapshot-sha256', digest(canonicalJson(activity)))
}

function cancellationProbe(
  entry: ReturnType<typeof fixture>, component: typeof components[number],
  reservationSha256: string, targetStateSha256 = 'f'.repeat(64), observedAt = NOW,
) {
  const pathname = join(entry.root, `${component}.cancel-probe.${observedAt}.json`)
  writeJson(pathname, {
    schema: 'video-autoworker-component-target-probe/v1',
    component,
    reservationSha256,
    sourceCommit: COMMIT,
    targetReleaseId: `${COMMIT}-runtime`,
    targetStateSha256,
    observedAt,
    verifier: reference(managedInstallers[component]),
  }, 0o600)
  return pathname
}

function cancelReservation(
  entry: ReturnType<typeof fixture>, installAttemptId: string,
  component: typeof components[number], reservationSha256: string,
  probe: string, reason: 'installer-failed' | 'invalid-raw-result' | 'lease-expired',
  revision = 1,
) {
  return run(entry,
    'cancel-component', '--attempt-dir', entry.attempt,
    '--install-attempt-id', installAttemptId, '--expected-revision', String(revision),
    '--operation', 'install', '--component', component,
    '--reservation-sha256', reservationSha256, '--probe', probe, '--reason', reason)
}

async function reserveForDeadInstaller(
  entry: ReturnType<typeof fixture>, installAttemptId: string,
  component: typeof components[number], rawResultPath: string,
) {
  mkdirSync(join(entry.attempt, 'preinstall', 'orchestrator'), { recursive: true, mode: 0o700 })
  const owner = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1_000)'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  expect(owner.pid).toBeTypeOf('number')
  const ownerToken = processStartToken(owner.pid!)
  const reserved = reserveOnly(
    entry, installAttemptId, component, rawResultPath, owner.pid!, ownerToken,
  )
  expect(reserved.status, reserved.stderr).toBe(0)
  const settled = waitChild(owner)
  owner.kill('SIGTERM')
  expect((await settled).code).toBeNull()
  return JSON.parse(reserved.stdout)
}

function componentResult(
  entry: ReturnType<typeof fixture>, installAttemptId: string,
  component: typeof components[number], operation: 'install' | 'rollback', index: number,
) {
  const backup = join(entry.root, `${component}.backup`)
  if (!existsSync(backup)) mkdirSync(backup, { mode: 0o700 })
  const backupManifest = join(backup, 'MANIFEST.sha256')
  if (!existsSync(backupManifest)) writeJson(backupManifest, { component, backup: true }, 0o600)
  const before = String(index + 1).repeat(64)
  const after = String(index + 4).repeat(64)
  const artifacts = join(entry.attempt, 'preinstall', 'orchestrator')
  if (!existsSync(artifacts)) mkdirSync(artifacts, { recursive: true, mode: 0o700 })
  const result = join(artifacts, `${component}.${operation === 'install' ? 'apply' : 'rollback'}.raw.json`)
  const status = JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout)
  const identityValue = {
    phase: status.phase, installAttemptId: status.installAttemptId, revision: status.revision,
    prepared: status.prepared, verification: status.verification, terminal: status.terminal,
    finalize: status.finalize, components: status.components, bindings: status.bindings,
  }
  const activity = {
    mission: status.bindings.databases.mission, n8n: status.bindings.databases.n8n,
    activeTasks: 0, activeMediaNodes: 0, activeN8nExecutions: 0,
    waiting: 0, running: 0, attentionStale: 0, pendingOutbox: 0,
  }
  const reserved = run(entry,
    'reserve-component', '--attempt-dir', entry.attempt,
    '--install-attempt-id', installAttemptId, '--expected-revision', String(status.revision),
    '--operation', operation, '--component', component, '--raw-result-output', result,
    '--status-identity-sha256', status.reservation?.statusIdentitySha256
      ?? digest(canonicalJson(identityValue)),
    '--target-state-sha256', 'f'.repeat(64),
    '--installer-pid', String(process.pid), '--installer-start-token', processStartToken(),
    '--active-tasks', '0', '--active-media-nodes', '0', '--active-n8n-executions', '0',
    '--waiting', '0', '--running', '0', '--attention-stale', '0', '--pending-outbox', '0',
    '--snapshot-sha256', digest(canonicalJson(activity)))
  expect(reserved.status, reserved.stderr).toBe(0)
  writeJson(result, {
    schema: 'video-autoworker-installer-result/v1',
    component,
    operation: operation === 'install' ? 'apply' : 'rollback',
    status: operation === 'install' ? 'applied' : 'restored',
    sourceCommit: COMMIT,
    targetReleaseId: `${COMMIT}-runtime`,
    completedAt: NOW + index,
    beforeManifestSha256: operation === 'install' ? before : after,
    afterManifestSha256: operation === 'install' ? after : before,
    backup: { path: backup, manifestSha256: digest(readFileSync(backupManifest)) },
    requiresFreshRestart: operation === 'install' && component !== 'task-flow',
  }, 0o600)
  return result
}

function recordInstalls(entry: ReturnType<typeof fixture>, installAttemptId: string, revision = 1) {
  for (const [index, component] of components.entries()) {
    const result = componentResult(entry, installAttemptId, component, 'install', index)
    const recorded = run(entry,
      'record-component', '--attempt-dir', entry.attempt,
      '--install-attempt-id', installAttemptId, '--expected-revision', String(revision),
      '--operation', 'install', '--component', component, '--raw-result', result)
    expect(recorded.status, recorded.stderr).toBe(0)
  }
}

function freshEvidence(entry: ReturnType<typeof fixture>, observedAt: number, suffix: string) {
  const proof = join(entry.root, `proof-${suffix}.json`)
  writeJson(proof, { schema: 'video-autoworker-legacy-bootstrap-rollback-proof/v2' })
  const value = JSON.parse(readFileSync(entry.evidence, 'utf8'))
  value.observedAt = observedAt
  value.rollback = reference(proof)
  value.frozen.expiresAt = observedAt + 3_600
  const evidence = join(entry.root, `evidence-${suffix}.json`)
  writeJson(evidence, value)
  return { evidence, proof }
}

function waitChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null, stderr: string }>(resolvePromise => {
    let stderr = ''
    child.stderr?.on('data', value => { stderr += String(value) })
    child.on('exit', code => resolvePromise({ code, stderr }))
  })
}

describe('legacy preinstall controller', () => {
  it('creates one transition-scoped owner and rejects a second attempt directory', () => {
    const entry = fixture()
    const first = prepare(entry)
    expect(first.status, first.stderr).toBe(0)
    const another = join(entry.root, 'another-attempt')
    mkdirSync(another, { mode: 0o700 })
    const second = run({ ...entry, attempt: another },
      'prepare', '--attempt-dir', another, '--evidence', entry.evidence,
      '--proof', entry.proof, '--source-commit', COMMIT,
      '--transition-intent', entry.intent, '--transition-confirmation', entry.confirmation,
      '--transition-journal', entry.journal, '--transition-attestation', entry.attestation,
      '--transition-claim', entry.claim)
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain('bound to another attempt')
  })

  it('recovers owner hard-link and prepare stdout SIGKILL windows on exact retry', () => {
    const ownerCrash = fixture()
    const killedOwner = spawnSync(process.execPath, [controller, ...prepareArguments(ownerCrash)], {
      env: { ...ownerCrash.env, AIWORKER_TEST_LEGACY_PREINSTALL_FAILPOINT: 'after-link' },
      encoding: 'utf8',
    })
    expect(killedOwner.signal).toBe('SIGKILL')
    const ownerRetry = prepare(ownerCrash)
    expect(ownerRetry.status, ownerRetry.stderr).toBe(0)

    const receiptCrash = fixture()
    const killedReceipt = spawnSync(process.execPath, [controller, ...prepareArguments(receiptCrash)], {
      env: {
        ...receiptCrash.env,
        AIWORKER_TEST_LEGACY_PREINSTALL_COMMAND_FAILPOINT: 'after-prepare-publish',
      },
      encoding: 'utf8',
    })
    expect(killedReceipt.signal).toBe('SIGKILL')
    const receiptRetry = prepare(receiptCrash)
    expect(receiptRetry.status, receiptRetry.stderr).toBe(0)
    expect(JSON.parse(receiptRetry.stdout)).toMatchObject({ resumed: true, revision: 1 })
  })

  it('verifies installed payloads and closes the installer lease after handoff', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    recordInstalls(entry, prepared.installAttemptId)
    const verified = run(entry,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(verified.status, verified.stderr).toBe(0)
    const handed = run(entry,
      'handoff', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--runtime-convergence-proof', entry.runtimeProof, '--video-batch-root', entry.videoBatchRoot)
    expect(handed.status, handed.stderr).toBe(0)
    const status = run(entry, 'status', '--attempt-dir', entry.attempt)
    expect(JSON.parse(status.stdout)).toMatchObject({ phase: 'BOOTSTRAP_HANDOFF', expired: false })
    const repeatedVerify = run(entry,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(repeatedVerify.status).not.toBe(0)
  })

  it('renews a verified lease after thirty minutes with fresh evidence and re-verifies the successor', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    recordInstalls(entry, prepared.installAttemptId)
    const firstVerification = run(entry,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(firstVerification.status, firstVerification.stderr).toBe(0)
    const fresh = freshEvidence(entry, NOW + 1_800, 'thirty-minutes')
    const later = { ...entry, env: { ...entry.env, AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(NOW + 1_800) } }
    const renewed = run(later,
      'renew', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--evidence', fresh.evidence, '--proof', fresh.proof)
    expect(renewed.status, renewed.stderr).toBe(0)
    expect(JSON.parse(renewed.stdout)).toMatchObject({ revision: 2, resumed: false })
    const secondVerification = run(later,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '2',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(secondVerification.status, secondVerification.stderr).toBe(0)
  })

  it('allows exactly one of two concurrent renew CAS operations to advance the lease', async () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    recordInstalls(entry, prepared.installAttemptId)
    const fresh = freshEvidence(entry, NOW + 10, 'concurrent')
    const args = [controller,
      'renew', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--evidence', fresh.evidence, '--proof', fresh.proof]
    const children = [0, 1].map(() => spawn(process.execPath, args, {
      env: { ...entry.env, AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(NOW + 10) },
      stdio: ['ignore', 'ignore', 'pipe'],
    }))
    const results = await Promise.all(children.map(waitChild))
    expect(results.filter(result => result.code === 0)).toHaveLength(1)
    expect(results.filter(result => result.code !== 0)).toHaveLength(1)
    const status = run({ ...entry, env: { ...entry.env, AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(NOW + 10) } },
      'status', '--attempt-dir', entry.attempt)
    expect(JSON.parse(status.stdout)).toMatchObject({ phase: 'INSTALL_PREPARED', revision: 2 })
  })

  it('resumes renew, verify, and terminal commands killed after their durable publication', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    recordInstalls(entry, prepared.installAttemptId)
    const fresh = freshEvidence(entry, NOW + 10, 'command-crash')
    const later = { ...entry, env: { ...entry.env, AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(NOW + 10) } }
    const renewArgs = [
      'renew', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--evidence', fresh.evidence, '--proof', fresh.proof,
    ]
    const killedRenew = spawnSync(process.execPath, [controller, ...renewArgs], {
      env: {
        ...later.env,
        AIWORKER_TEST_LEGACY_PREINSTALL_COMMAND_FAILPOINT: 'after-renew-publish',
      },
    })
    expect(killedRenew.signal).toBe('SIGKILL')
    const renewRetry = run(later, ...renewArgs)
    expect(renewRetry.status, renewRetry.stderr).toBe(0)
    expect(JSON.parse(renewRetry.stdout)).toMatchObject({ resumed: true, revision: 2 })

    const verifyArgs = [
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '2',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart,
    ]
    const killedVerify = spawnSync(process.execPath, [controller, ...verifyArgs], {
      env: {
        ...later.env,
        AIWORKER_TEST_LEGACY_PREINSTALL_COMMAND_FAILPOINT: 'after-verify-publish',
      },
    })
    expect(killedVerify.signal).toBe('SIGKILL')
    const verifyRetry = run(later, ...verifyArgs)
    expect(verifyRetry.status, verifyRetry.stderr).toBe(0)
    expect(JSON.parse(verifyRetry.stdout)).toMatchObject({ resumed: true, revision: 2 })

    const handoffArgs = [
      'handoff', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '2',
      '--runtime-convergence-proof', later.runtimeProof,
      '--video-batch-root', later.videoBatchRoot,
    ]
    const killedHandoff = spawnSync(process.execPath, [controller, ...handoffArgs], {
      env: {
        ...later.env,
        AIWORKER_TEST_LEGACY_PREINSTALL_COMMAND_FAILPOINT: 'after-terminal-publish',
      },
    })
    expect(killedHandoff.signal).toBe('SIGKILL')
    const handoffRetry = run(later, ...handoffArgs)
    expect(handoffRetry.status, handoffRetry.stderr).toBe(0)
    expect(JSON.parse(handoffRetry.stdout)).toMatchObject({ resumed: true, revision: 2 })
  })

  it('selects one finalize branch and requires strict reverse component rollback before abandon', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    recordInstalls(entry, prepared.installAttemptId)
    const verified = run(entry,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(verified.status, verified.stderr).toBe(0)

    const wrong = componentResult(entry, prepared.installAttemptId, 'director-brain', 'rollback', 2)
    const rejected = run(entry,
      'record-component', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--operation', 'rollback', '--component', 'task-flow', '--raw-result', wrong)
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('matching active reservation')

    for (const component of [...components].reverse()) {
      const index = components.indexOf(component)
      const result = componentResult(entry, prepared.installAttemptId, component, 'rollback', index)
      const recorded = run(entry,
        'record-component', '--attempt-dir', entry.attempt,
        '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
        '--operation', 'rollback', '--component', component, '--raw-result', result)
      expect(recorded.status, recorded.stderr).toBe(0)
      const retried = run(entry,
        'record-component', '--attempt-dir', entry.attempt,
        '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
        '--operation', 'rollback', '--component', component, '--raw-result', result)
      expect(JSON.parse(retried.stdout)).toMatchObject({ resumed: true })
    }
    const handoff = run(entry,
      'handoff', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--runtime-convergence-proof', entry.runtimeProof, '--video-batch-root', entry.videoBatchRoot)
    expect(handoff.status).not.toBe(0)
    expect(handoff.stderr).toContain('finalize')
    const abandoned = run(entry,
      'abandon', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1')
    expect(abandoned.status, abandoned.stderr).toBe(0)
    expect(JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout)).toMatchObject({
      phase: 'INSTALL_ABANDONED',
      components: {
        installed: [...components],
        rolledBack: [...components].reverse(),
      },
    })
  })

  it('blocks terminal and adjacent component branches while one reservation is active', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    componentResult(entry, prepared.installAttemptId, 'task-flow', 'install', 0)
    const abandoned = run(entry,
      'abandon', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1')
    expect(abandoned.status).not.toBe(0)
    expect(abandoned.stderr).toContain('blocked by a component reservation')
    expect(JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout))
      .toMatchObject({ phase: 'INSTALL_PREPARED', reservation: { component: 'task-flow' } })
  })

  it('cancels a failed installer without advancing the component journal and can abandon', async () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    const raw = join(entry.attempt, 'preinstall', 'orchestrator', 'task-flow.failed.raw.json')
    const reserved = await reserveForDeadInstaller(
      entry, prepared.installAttemptId, 'task-flow', raw,
    )
    const probe = cancellationProbe(entry, 'task-flow', reserved.reservation.sha256)
    const cancelled = cancelReservation(
      entry, prepared.installAttemptId, 'task-flow', reserved.reservation.sha256,
      probe, 'installer-failed',
    )
    expect(cancelled.status, cancelled.stderr).toBe(0)
    expect(JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout)).toMatchObject({
      phase: 'INSTALL_PREPARED', reservation: null,
      components: { installed: [], rolledBack: [], cancelled: [{ component: 'task-flow' }] },
    })
    const abandoned = run(entry,
      'abandon', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1')
    expect(abandoned.status, abandoned.stderr).toBe(0)
  })

  it('fails closed while the exact reserved installer process is still alive', async () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    const raw = join(entry.attempt, 'preinstall', 'orchestrator', 'task-flow.live.raw.json')
    mkdirSync(join(entry.attempt, 'preinstall', 'orchestrator'), { recursive: true, mode: 0o700 })
    const owner = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1_000)'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const ownerToken = processStartToken(owner.pid!)
    const reservedResult = reserveOnly(
      entry, prepared.installAttemptId, 'task-flow', raw, owner.pid!, ownerToken,
    )
    expect(reservedResult.status, reservedResult.stderr).toBe(0)
    const reserved = JSON.parse(reservedResult.stdout)
    const probe = cancellationProbe(entry, 'task-flow', reserved.reservation.sha256)
    const blocked = cancelReservation(
      entry, prepared.installAttemptId, 'task-flow', reserved.reservation.sha256,
      probe, 'installer-failed',
    )
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('reserved installer is alive')
    const settled = waitChild(owner)
    owner.kill('SIGTERM')
    await settled
    const cancelled = cancelReservation(
      entry, prepared.installAttemptId, 'task-flow', reserved.reservation.sha256,
      probe, 'installer-failed',
    )
    expect(cancelled.status, cancelled.stderr).toBe(0)
  })

  it('anchors rollback after the latest cancellation event in the append-only journal', async () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    const installedRaw = componentResult(
      entry, prepared.installAttemptId, 'task-flow', 'install', 0,
    )
    const installed = run(entry,
      'record-component', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--operation', 'install', '--component', 'task-flow', '--raw-result', installedRaw)
    expect(installed.status, installed.stderr).toBe(0)

    const raw = join(entry.attempt, 'preinstall', 'orchestrator', 'video-command.failed.raw.json')
    const reservation = await reserveForDeadInstaller(
      entry, prepared.installAttemptId, 'video-command', raw,
    )
    const probe = cancellationProbe(entry, 'video-command', reservation.reservation.sha256)
    const cancelled = cancelReservation(
      entry, prepared.installAttemptId, 'video-command', reservation.reservation.sha256,
      probe, 'installer-failed',
    )
    expect(cancelled.status, cancelled.stderr).toBe(0)
    const cancelEvent = JSON.parse(cancelled.stdout).event

    const rollbackRaw = componentResult(
      entry, prepared.installAttemptId, 'task-flow', 'rollback', 0,
    )
    const rolledBack = run(entry,
      'record-component', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--operation', 'rollback', '--component', 'task-flow', '--raw-result', rollbackRaw)
    expect(rolledBack.status, rolledBack.stderr).toBe(0)
    const finalize = JSON.parse(readFileSync(
      join(entry.attempt, 'preinstall', 'install-finalize-claim.receipt.json'), 'utf8',
    ))
    const rollbackEvent = JSON.parse(readFileSync(JSON.parse(rolledBack.stdout).event.path, 'utf8'))
    expect(finalize.journalHead).toEqual(cancelEvent)
    expect(rollbackEvent.previous).toEqual(cancelEvent)
  })

  it('recovers cancellation after the result publication crash and binds invalid raw bytes', async () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    const raw = join(entry.attempt, 'preinstall', 'orchestrator', 'task-flow.apply.raw.json')
    const reserved = await reserveForDeadInstaller(
      entry, prepared.installAttemptId, 'task-flow', raw,
    )
    writeFileSync(raw, '{invalid-json\n', { mode: 0o600 })
    chmodSync(raw, 0o600)
    const probe = cancellationProbe(entry, 'task-flow', reserved.reservation.sha256)
    const args = [
      'cancel-component', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--operation', 'install', '--component', 'task-flow',
      '--reservation-sha256', reserved.reservation.sha256,
      '--probe', probe, '--reason', 'invalid-raw-result',
    ]
    const killed = spawnSync(process.execPath, [controller, ...args], {
      env: {
        ...entry.env,
        AIWORKER_TEST_LEGACY_PREINSTALL_COMMAND_FAILPOINT: 'after-cancellation-result-publish',
      },
    })
    expect(killed.signal, killed.stderr?.toString()).toBe('SIGKILL')
    expect(JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout))
      .toMatchObject({ reservation: { component: 'task-flow' }, components: { cancelled: [] } })
    const retried = run(entry, ...args)
    expect(retried.status, retried.stderr).toBe(0)
    const repeated = run(entry, ...args)
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(JSON.parse(repeated.stdout)).toMatchObject({ resumed: true })
    const changedProbe = cancellationProbe(
      entry, 'task-flow', reserved.reservation.sha256, 'f'.repeat(64), NOW + 1,
    )
    const changedRetry = run(entry, ...args.map(value => value === probe ? changedProbe : value))
    expect(changedRetry.status).not.toBe(0)
    expect(changedRetry.stderr).toContain('cancellation retry changed')
    const status = JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout)
    expect(status).toMatchObject({
      reservation: null,
      components: { installed: [], cancelled: [{ component: 'task-flow' }] },
    })
    const cancellationResult = JSON.parse(readFileSync(
      join(entry.attempt, 'preinstall', 'install-component-result.000001.receipt.json'), 'utf8',
    ))
    expect(cancellationResult.rawResult).toMatchObject({ sha256: digest('{invalid-json\n') })
  })

  it('rejects cancellation after target drift and rejects cancelling a valid raw result', async () => {
    const drift = fixture()
    const driftPrepared = JSON.parse(prepare(drift).stdout)
    const driftRaw = join(drift.attempt, 'preinstall', 'orchestrator', 'task-flow.apply.raw.json')
    const driftReservation = await reserveForDeadInstaller(
      drift, driftPrepared.installAttemptId, 'task-flow', driftRaw,
    )
    const driftProbe = cancellationProbe(
      drift, 'task-flow', driftReservation.reservation.sha256, 'e'.repeat(64),
    )
    const drifted = cancelReservation(
      drift, driftPrepared.installAttemptId, 'task-flow', driftReservation.reservation.sha256,
      driftProbe, 'installer-failed',
    )
    expect(drifted.status).not.toBe(0)
    expect(drifted.stderr).toContain('changed target')

    const valid = fixture()
    const validPrepared = JSON.parse(prepare(valid).stdout)
    const validRaw = join(valid.attempt, 'preinstall', 'orchestrator', 'task-flow.apply.raw.json')
    const validReservation = await reserveForDeadInstaller(
      valid, validPrepared.installAttemptId, 'task-flow', validRaw,
    )
    const backup = join(valid.root, 'valid.backup')
    mkdirSync(backup, { mode: 0o700 })
    const backupManifest = join(backup, 'MANIFEST.sha256')
    writeJson(backupManifest, { backup: true }, 0o600)
    writeJson(validRaw, {
      schema: 'video-autoworker-installer-result/v1', component: 'task-flow',
      operation: 'apply', status: 'applied', sourceCommit: COMMIT,
      targetReleaseId: `${COMMIT}-runtime`, completedAt: NOW,
      beforeManifestSha256: '1'.repeat(64), afterManifestSha256: '2'.repeat(64),
      backup: { path: backup, manifestSha256: digest(readFileSync(backupManifest)) },
      requiresFreshRestart: false,
    }, 0o600)
    const validProbe = cancellationProbe(valid, 'task-flow', validReservation.reservation.sha256)
    const rejected = cancelReservation(
      valid, validPrepared.installAttemptId, 'task-flow', validReservation.reservation.sha256,
      validProbe, 'invalid-raw-result',
    )
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('must be recorded')
  })

  it('strictly cancels an expired active reservation without renewing its lease', async () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    const raw = join(entry.attempt, 'preinstall', 'orchestrator', 'task-flow.apply.raw.json')
    const reserved = await reserveForDeadInstaller(
      entry, prepared.installAttemptId, 'task-flow', raw,
    )
    const expiredNow = NOW + 301
    const later = {
      ...entry,
      env: { ...entry.env, AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(expiredNow) },
    }
    const probe = cancellationProbe(
      later, 'task-flow', reserved.reservation.sha256, 'f'.repeat(64), expiredNow,
    )
    const cancelled = cancelReservation(
      later, prepared.installAttemptId, 'task-flow', reserved.reservation.sha256,
      probe, 'lease-expired',
    )
    expect(cancelled.status, cancelled.stderr).toBe(0)
    expect(JSON.parse(run(later, 'status', '--attempt-dir', entry.attempt).stdout)).toMatchObject({
      expired: true, revision: 1, reservation: null,
      components: { installed: [], cancelled: [{ component: 'task-flow' }] },
    })
  })

  it('rejects caller-normalized receipts and a backup manifest changed after reservation', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    const raw = componentResult(entry, prepared.installAttemptId, 'task-flow', 'install', 0)
    const forged = join(entry.attempt, 'preinstall', 'orchestrator', 'forged.result.json')
    writeJson(forged, { schema: 'video-autoworker-legacy-preinstall-component-result/v1' }, 0o400)
    const normalized = run(entry,
      'record-component', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--operation', 'install', '--component', 'task-flow', '--result', forged)
    expect(normalized.status).not.toBe(0)
    expect(normalized.stderr).toContain('arguments are invalid')
    rmSync(forged)
    const rawValue = JSON.parse(readFileSync(raw, 'utf8'))
    writeFileSync(join(rawValue.backup.path, 'MANIFEST.sha256'), 'changed\n', { mode: 0o600 })
    const changed = run(entry,
      'record-component', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--operation', 'install', '--component', 'task-flow', '--raw-result', raw)
    expect(changed.status).not.toBe(0)
    expect(changed.stderr).toContain('backup manifest changed')
  })

  it('requires a fresh lease for handoff and succeeds only after renew plus reverify', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    recordInstalls(entry, prepared.installAttemptId)
    const verified = run(entry,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(verified.status, verified.stderr).toBe(0)
    const laterNow = NOW + 300
    const later = {
      ...entry,
      env: { ...entry.env, AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(laterNow) },
    }
    const expired = run(later,
      'handoff', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--runtime-convergence-proof', entry.runtimeProof, '--video-batch-root', entry.videoBatchRoot)
    expect(expired.status).not.toBe(0)
    expect(expired.stderr).toContain('lease expired')
    const fresh = freshEvidence(entry, laterNow, 'handoff-renew')
    const renewed = run(later,
      'renew', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--evidence', fresh.evidence, '--proof', fresh.proof)
    expect(renewed.status, renewed.stderr).toBe(0)
    const reverified = run(later,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '2',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(reverified.status, reverified.stderr).toBe(0)
    const handed = run(later,
      'handoff', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '2',
      '--runtime-convergence-proof', entry.runtimeProof, '--video-batch-root', entry.videoBatchRoot)
    expect(handed.status, handed.stderr).toBe(0)
  })

  it('recovers the same handoff after finalize publication even after lease expiry', () => {
    const entry = fixture()
    const prepared = JSON.parse(prepare(entry).stdout)
    recordInstalls(entry, prepared.installAttemptId)
    const verified = run(entry,
      'verify', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--releases-root', entry.releasesRoot, '--profile-state-root', entry.profileStateRoot,
      '--workspace-root', entry.workspaceRoot, '--runtime-convergence-proof', entry.runtimeProof,
      '--gateway-restart-evidence', entry.gatewayRestart)
    expect(verified.status, verified.stderr).toBe(0)
    const args = [
      'handoff', '--attempt-dir', entry.attempt,
      '--install-attempt-id', prepared.installAttemptId, '--expected-revision', '1',
      '--runtime-convergence-proof', entry.runtimeProof, '--video-batch-root', entry.videoBatchRoot,
    ]
    const killed = spawnSync(process.execPath, [controller, ...args], {
      env: {
        ...entry.env,
        AIWORKER_TEST_LEGACY_PREINSTALL_COMMAND_FAILPOINT: 'after-handoff-finalize-publish',
      },
    })
    expect(killed.signal).toBe('SIGKILL')
    const finalizing = JSON.parse(run(entry, 'status', '--attempt-dir', entry.attempt).stdout)
    expect(finalizing).toMatchObject({
      phase: 'BOOTSTRAP_HANDOFF_FINALIZING', terminal: null,
    })
    expect(finalizing.finalize).not.toBeNull()

    const expired = {
      ...entry,
      env: { ...entry.env, AIWORKER_TEST_LEGACY_PREINSTALL_NOW: String(NOW + 301) },
    }
    const recovered = run(expired, ...args)
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({ phase: 'BOOTSTRAP_HANDOFF' })
    const terminal = JSON.parse(run(expired, 'status', '--attempt-dir', entry.attempt).stdout)
    expect(terminal).toMatchObject({
      phase: 'BOOTSTRAP_HANDOFF', expired: true, revision: 1,
      finalize: finalizing.finalize,
    })
  })

  it.each(['after-temp-fsync', 'after-link'])('recovers exact %s SIGKILL publication residue', failpoint => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preinstall-publish.')))
    roots.push(root)
    chmodSync(root, 0o700)
    const output = join(root, 'install-action.r000001.claim.json')
    const moduleUrl = new URL(`file://${controller}`).href
    const source = `import{publishPreinstallImmutableForTest as p}from ${JSON.stringify(moduleUrl)};p(${JSON.stringify(output)},{schema:'test'})`
    const killed = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      env: {
        ...process.env, NODE_ENV: 'test', AIWORKER_TEST_LEGACY_PREINSTALL: '1',
        AIWORKER_TEST_LEGACY_PREINSTALL_FAILPOINT: failpoint,
      },
    })
    expect(killed.signal).toBe('SIGKILL')
    const recovered = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, NODE_ENV: 'test', AIWORKER_TEST_LEGACY_PREINSTALL: '1' },
      encoding: 'utf8',
    })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ schema: 'test' })
    expect(statSync(output).nlink).toBe(1)
    expect(readdirSync(root).filter(name => name.startsWith('.'))).toEqual([])
  })

  it('refuses an unrecognized temporary member instead of silently deleting it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preinstall-publish-unsafe.')))
    roots.push(root)
    chmodSync(root, 0o700)
    writeFileSync(join(root, '.unknown.tmp'), 'untrusted', { mode: 0o400 })
    const output = join(root, 'install-action.r000001.claim.json')
    const moduleUrl = new URL(`file://${controller}`).href
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import{publishPreinstallImmutableForTest as p}from ${JSON.stringify(moduleUrl)};p(${JSON.stringify(output)},{schema:'test'})`], {
      env: { ...process.env, NODE_ENV: 'test', AIWORKER_TEST_LEGACY_PREINSTALL: '1' },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unknown temporary member')
    expect(existsSync(join(root, '.unknown.tmp'))).toBe(true)
  })

  it('all action, report, receipt and terminal publications use the crash-safe primitive', () => {
    const source = readFileSync(controller, 'utf8')
    expect(source.match(/writeImmutable\(/gu)?.length).toBeGreaterThanOrEqual(9)
    expect(source).not.toMatch(/writeFileSync|renameSync/u)
  })
})
