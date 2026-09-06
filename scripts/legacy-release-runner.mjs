#!/usr/bin/env node

// This entrypoint sequences the existing release controllers. Their receipts,
// reservations and CAS revisions remain the authority for business state.
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { redactSensitiveValues } from './lib/sensitive-value-scanner.mjs'
import {
  managedN8nStartupWitnessPath,
  verifyN8nCompleteStartupWitness,
} from './n8n-startup-witness.mjs'

const scriptPath = realpathSync(fileURLToPath(import.meta.url))
const repository = dirname(dirname(scriptPath))
export const OWNER_SCHEMA = 'video-autoworker-maintenance-owner/v1'
export const PROGRESS_SCHEMA = 'video-autoworker-maintenance-progress/v1'
const SHA = /^[a-f0-9]{64}$/u
const BUDGET = Object.freeze({ command: 120, capture: 180, artifact: 180, preinstall: 900, bootstrap: 600 })
const leaseFor = (...seconds) => {
  const value = seconds.reduce((sum, item) => sum + item, 30)
  if (value > 1800) fail('phase budget must be split before acquiring a lease')
  return Math.max(30, value)
}
const now = () => Math.floor(Date.now() / 1000)
const digest = value => createHash('sha256').update(value).digest('hex')
function fail(message) { throw new Error(`legacy release runner failed: ${message}`) }
function privateDirectory(pathname) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname || realpathSync(pathname) !== pathname) fail('directory path is unsafe')
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o7777) !== 0o700) fail('directory mode or owner is unsafe')
}
function privateJson(pathname) {
  if (!isAbsolute(pathname) || realpathSync(pathname) !== pathname) fail('JSON path is unsafe')
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid()
    || (entry.mode & 0o7777) !== 0o600 || entry.size > 1024 * 1024) fail('JSON identity is unsafe')
  return JSON.parse(readFileSync(pathname, 'utf8'))
}
function exclusiveJson(pathname, value) {
  privateDirectory(dirname(pathname))
  const fd = openSync(pathname, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function ownProcess() {
  const output = args => execFileSync('/bin/ps', args, { encoding: 'utf8' }).trim()
  return {
    pid: process.pid,
    startToken: output(['-p', String(process.pid), '-o', 'lstart=']),
    argvSha256: digest(output(['-ww', '-p', String(process.pid), '-o', 'command='])),
    sourceSha256: digest(readFileSync(scriptPath)),
  }
}

// Operational progress is append-only and is not a second release state
// machine. The waiting parent and its orchestrator child never write together.
export function recordMaintenanceProgress(ownerReceiptPath, { step, controllerRevision = 0 }) {
  const owner = privateJson(ownerReceiptPath)
  if (owner.schema !== OWNER_SCHEMA || typeof owner.attemptId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{0,100}$/u.test(step)
    || !Number.isSafeInteger(controllerRevision) || controllerRevision < 0) fail('progress input is invalid')
  const directory = join(dirname(ownerReceiptPath), 'progress')
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 })
  privateDirectory(directory)
  const names = readdirSync(directory).sort()
  if (names.some(name => !/^\d{6}\.json$/u.test(name))) fail('progress directory contains unknown members')
  const previousPath = names.length ? join(directory, names.at(-1)) : null
  const previous = previousPath ? privateJson(previousPath) : null
  if (previous && (previous.schema !== PROGRESS_SCHEMA || previous.attemptId !== owner.attemptId
    || previous.sequence !== names.length || previous.controllerRevision > controllerRevision
    || previous.completedAt > now())) fail('previous progress is invalid')
  if (previous?.step === step && previous.controllerRevision === controllerRevision) fail('progress did not advance')
  const sequence = names.length + 1
  const pathname = join(directory, `${String(sequence).padStart(6, '0')}.json`)
  exclusiveJson(pathname, {
    schema: PROGRESS_SCHEMA, attemptId: owner.attemptId, sequence,
    previousSha256: previousPath ? digest(readFileSync(previousPath)) : null,
    controllerRevision, step, completedAt: now(),
  })
  return { path: pathname, sha256: digest(readFileSync(pathname)), sequence }
}

export function sanitizeMaintenanceFailure(failure, sessionKey = '') {
  return { ...failure, stderr: redactSensitiveValues(String(failure.stderr || ''))
    .split(sessionKey || '\u0000').join('[session]').replace(/[a-f0-9]{64}/giu, '[opaque]').slice(-16000) }
}

export async function waitForGuardCleanup(guardPresent, {
  timeoutMs = 1000,
  pollIntervalMs = 20,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    fail('guard cleanup wait budget is invalid')
  }
  const deadline = Date.now() + timeoutMs
  while (guardPresent()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(pollIntervalMs, remaining)))
  }
  return true
}

export async function settleFailedMaintenance({ stopGateway, gatewayStopped, guardPresent,
  recoveryPending, guardStatus, revokeGuard }) {
  await stopGateway().catch(() => {})
  const stopped = await gatewayStopped().catch(() => false)
  if (!guardPresent()) return { gatewayStopped: stopped, guard: 'absent' }
  // Once shutdown was authorized, only the existing recovery controller may
  // decide when the n8n hold can be released. A failed runner cannot undo it.
  if (!stopped || recoveryPending()) return { gatewayStopped: stopped, guard: 'held' }
  const current = await guardStatus().catch(() => null)
  if (current?.mode !== 'dual') return { gatewayStopped: stopped, guard: 'held' }
  try {
    await revokeGuard()
    const released = await waitForGuardCleanup(guardPresent)
    return { gatewayStopped: stopped, guard: released ? 'released' : 'held' }
  }
  catch { return { gatewayStopped: stopped, guard: 'held' } }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeoutMs: number,
 *   onFailure?: (failure: {code: number | null, signal: string | null,
 *     timedOut: boolean, overflow: boolean, groupStopped: boolean, stderr: string}) => void,
 *   signal?: AbortSignal | null, maxBytes?: number }} options
 * @returns {Promise<string>}
 */
export function runManagedChild(command, args, { cwd, env, timeoutMs, onFailure, signal = null, maxBytes = 8 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1800_000) fail('child timeout is invalid')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) fail('child output budget is invalid')
  if (signal?.aborted) return Promise.reject(new Error('managed child aborted before start'))
  return new Promise((resolveChild, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''; let stderr = ''; let timedOut = false; let overflow = false; let escalation
    const stop = () => {
      if (escalation) return
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000)
    }
    const abort = () => stop()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const collect = (chunk, which) => {
      if (overflow) return
      if (which === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) {
        stdout = stdout.slice(0, maxBytes); stderr = stderr.slice(0, maxBytes)
        overflow = true; stop()
      }
    }
    child.stdout.on('data', chunk => collect(chunk, 'stdout'))
    child.stderr.on('data', chunk => collect(chunk, 'stderr'))
    child.once('error', error => { clearTimeout(timer); if (escalation) clearTimeout(escalation); signal?.removeEventListener('abort', abort); reject(error) })
    child.once('close', async (code, exitSignal) => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation)
      signal?.removeEventListener('abort', abort)
      if (code !== 0 || timedOut || overflow || signal?.aborted) {
        const groupStopped = await stopChildGroup(child.pid)
        try { onFailure?.({ code, signal: exitSignal, timedOut, overflow, groupStopped, stderr }) } catch (error) { reject(error); return }
        reject(new Error(`managed child failed: code=${code} signal=${exitSignal || 'none'} timeout=${timedOut} overflow=${overflow}`))
      } else resolveChild(stdout)
    })
  })
}

async function stopChildGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  const alive = () => {
    try { process.kill(-pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
  }
  if (!alive()) return true
  try { process.kill(-pid, 'SIGTERM') } catch {}
  const deadline = Date.now() + 5000
  while (alive() && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50))
  if (alive()) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  const finalDeadline = Date.now() + 1000
  while (alive() && Date.now() < finalDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 50))
  return !alive()
}

export function validateLegacyReleasePlan(plan) {
  const required = ['schema', 'sourceCommit', 'controlRoot', 'releasesRoot', 'releaseId', 'releaseRoot',
    'runDir', 'missionDb', 'n8nDb', 'transitionRoot', 'legacyPid', 'sessionKeySha256']
  if (!plan || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(required.sort())
    || plan.schema !== 'video-autoworker-legacy-release-plan/v1'
    || !/^[a-f0-9]{40}$/u.test(plan.sourceCommit)
    || plan.releaseId !== `${plan.sourceCommit}-runtime` || !SHA.test(plan.sessionKeySha256)
    || !Number.isSafeInteger(plan.legacyPid) || plan.legacyPid <= 0) fail('plan contract is invalid')
  for (const key of ['controlRoot', 'releasesRoot', 'releaseRoot', 'runDir', 'missionDb', 'n8nDb', 'transitionRoot']) {
    if (!isAbsolute(plan[key]) || resolve(plan[key]) !== plan[key] || /[\r\n\0]/u.test(plan[key])) fail('plan path is invalid')
  }
  if (plan.releaseRoot !== join(plan.releasesRoot, plan.releaseId, 'standalone')) fail('release path is not canonical')
  const home = userInfo().homedir
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/u.test(basename(plan.controlRoot))
    || dirname(plan.controlRoot) !== join(home, 'ai-worker/state/video-autoworker/maint')
    || plan.runDir !== join(home, 'ai-worker/state/video-autoworker/blue-green')
    || plan.missionDb !== join(home, '.mission-control-openclaw-profiles/mission-control.db')
    || plan.n8nDb !== join(home, 'ai-worker/state/n8n/.n8n/database.sqlite')) fail('plan is outside the managed production family')
  return plan
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || argv[0] !== 'run' || argv[1] !== '--plan') fail('expected run --plan <private-json>')
  process.umask(0o077)
  const plan = validateLegacyReleasePlan(privateJson(argv[2]))
  const git = args => execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
  if (git(['rev-parse', '--show-toplevel']) !== repository || git(['rev-parse', 'HEAD']) !== plan.sourceCommit
    || git(['status', '--porcelain=v1', '--untracked-files=all'])) fail('canonical repository is not the exact clean source')
  if (existsSync(plan.controlRoot)) fail('control root already exists; inspect existing controller receipts before recovery')
  mkdirSync(plan.controlRoot, { mode: 0o700 }); privateDirectory(plan.controlRoot)
  const attempt = join(plan.controlRoot, 'attempt'); mkdirSync(attempt, { mode: 0o700 })
  const diagnostics = join(plan.controlRoot, 'diagnostics'); mkdirSync(diagnostics, { mode: 0o700 })
  const ownerReceipt = join(plan.controlRoot, 'runner.owner.json')
  exclusiveJson(ownerReceipt, { schema: OWNER_SCHEMA, attemptId: randomUUID(), ...ownProcess() })
  const home = userInfo().homedir
  const node = process.execPath
  const openclaw = join(home, 'ai-worker/bin/openclaw')
  const profileState = join(home, '.openclaw-qwen-current')
  const workspace = join(home, 'AI-worker-second-original-workspace')
  const guardDir = join(home, 'ai-worker/state/video-autoworker/legacy-freeze')
  if (!existsSync(guardDir)) mkdirSync(guardDir, { mode: 0o700 })
  privateDirectory(guardDir)
  const socket = join(guardDir, 'guard.sock'); const tokenFile = join(guardDir, 'guard.token')
  if (existsSync(socket) || existsSync(tokenFile)) fail('another guard already exists')
  const guardScript = join(repository, 'scripts/legacy-freeze-guard.mjs')
  const runtimeBackup = join(home, 'ai-worker/backups/openclaw-runtime-convergence', basename(plan.controlRoot))
  if (existsSync(runtimeBackup)) fail('runtime backup root already exists')
  mkdirSync(runtimeBackup, { mode: 0o700 })
  const environment = { HOME: home, LANG: process.env.LANG || 'en_US.UTF-8',
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}), NODE_ENV: 'production',
    PATH: `${dirname(node)}:${join(home, 'ai-worker/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    MC_AUTH_MODE: 'openclaw-loopback', AIWORKER_NODE_BIN: node, NODE_BIN: node, OPENCLAW_BIN: openclaw,
    AIWORKER_BG_RUN_DIR: plan.runDir, AIWORKER_BG_RELEASES_DIR: plan.releasesRoot,
    AIWORKER_BG_ROUTER_STATE: join(plan.runDir, 'router-state.json'),
    AIWORKER_BG_LIVE_DB_PATH: plan.missionDb, AIWORKER_BG_N8N_DB_PATH: plan.n8nDb,
    AIWORKER_OPENCLAW_QWEN_STATE_DIR: profileState, AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT: runtimeBackup,
    AIWORKER_LEGACY_RELEASE_OWNER_RECEIPT: ownerReceipt,
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('AIWORKER_TEST_') || ['OPENCLAW_GATEWAY_TOKEN', 'GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_PASSWORD', 'GATEWAY_PASSWORD'].includes(key)) delete environment[key]
  }
  let sessionKey = ''; let guardChild; let completed = false; let stepNumber = 0
  let resourcesMayBeReleased = true
  const cancellation = new AbortController()
  const cancel = () => cancellation.abort()
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel)
  const report = value => process.stdout.write(`${JSON.stringify(value)}\n`)
  const run = async (step, command, args, seconds = BUDGET.command) => {
    report({ step, status: 'running' })
    const number = ++stepNumber
    const stdout = await runManagedChild(command, args, { cwd: repository, env: environment, timeoutMs: seconds * 1000,
      signal: step.startsWith('failure-') ? null : cancellation.signal,
      onFailure: failure => {
        if (!failure.groupStopped) resourcesMayBeReleased = false
        exclusiveJson(join(diagnostics, `${number}-${step}.json`), { step, ...sanitizeMaintenanceFailure(failure, sessionKey) })
      },
    })
    report({ step, status: 'completed' }); return stdout
  }
  const guardArgs = ['--socket', socket, '--token-file', tokenFile, '--database', plan.missionDb, '--n8n-database', plan.n8nDb]
  const progressAndRenew = async (step, revision, seconds) => {
    const progress = recordMaintenanceProgress(ownerReceipt, { step, controllerRevision: revision })
    const current = privateJson(tokenFile)
    await run(`renew-${step}`, node, [guardScript, 'renew', ...guardArgs, '--owner-receipt', ownerReceipt,
      '--progress-receipt', progress.path, '--expected-issued-at', String(current.issuedAt),
      '--expected-expires-at', String(current.expiresAt), '--lease-seconds', String(seconds)])
  }
  const proofs = async prefix => {
    const directory = join(plan.controlRoot, prefix); mkdirSync(directory, { mode: 0o700 })
    const proof = join(directory, 'rollback-proof.json'); const evidence = join(directory, 'freeze.json')
    const target = ['--slot', 'blue', '--release-id', plan.releaseId, '--standalone-root', plan.releaseRoot]
    await run(`${prefix}-proof`, node, [join(repository, 'scripts/generate-legacy-bootstrap-rollback-proof.mjs'), '--output', proof, ...target, '--guard-socket', socket], BUDGET.artifact)
    await run(`${prefix}-evidence`, node, [join(repository, 'scripts/generate-legacy-freeze-evidence.mjs'), '--output', evidence, ...target, '--rollback-proof', proof], BUDGET.artifact)
    return { proof, evidence }
  }
  try {
    report({ step: 'n8n-complete-startup', status: 'running' })
    const startupWitness = managedN8nStartupWitnessPath()
    const completeStartup = await verifyN8nCompleteStartupWitness({
      '--witness': startupWitness,
      '--pid-file': join(dirname(startupWitness), 'n8n.pid'),
      '--runtime-root': join(
        home,
        'ai-worker/services/video-autoworker-n8n/releases',
        plan.sourceCommit,
      ),
      '--node-bin': join(home, 'ai-worker/node/current/bin/node'),
      '--cli': join(
        home,
        'ai-worker/services/video-autoworker-n8n/current/ops/n8n/node_modules/n8n/bin/n8n',
      ),
      '--readiness-url': 'http://127.0.0.1:5678/healthz/readiness',
    })
    if (completeStartup.sourceCommit !== plan.sourceCommit) {
      fail('n8n complete-startup witness belongs to another source commit')
    }
    report({ step: 'n8n-complete-startup', status: 'completed' })
    guardChild = spawn(node, [guardScript, 'serve', ...guardArgs, '--ttl-seconds', String(leaseFor(BUDGET.command, BUDGET.command, BUDGET.capture)), '--legacy-pid', String(plan.legacyPid), '--owner-receipt', ownerReceipt],
      { cwd: repository, env: environment, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
    let guardError = ''
    guardChild.stderr.on('data', value => { guardError = redactSensitiveValues((guardError + value.toString()).slice(-8000)) })
    for (let i = 0; i < 300 && !existsSync(socket); i++) {
      if (cancellation.signal.aborted) fail('release cancelled during guard startup')
      if (guardChild.exitCode !== null) fail(`guard startup failed: ${guardError}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
    await run('guard-ready', node, [guardScript, 'status', '--socket', socket, '--database', plan.missionDb, '--n8n-database', plan.n8nDb])
    await run('qwen-start', openclaw, ['--profile', 'qwen-current', 'gateway', 'start'])
    let gatewayReady = false
    const startupDeadline = Date.now() + 30000
    while (!gatewayReady && Date.now() < startupDeadline) {
      if (cancellation.signal.aborted) fail('release cancelled during Gateway startup')
      try { gatewayReady = (await fetch('http://127.0.0.1:18889/health', { signal: AbortSignal.timeout(2000) })).ok } catch {}
      if (!gatewayReady) await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    if (!gatewayReady) fail('Gateway did not become ready after start')
    const registry = privateJson(join(profileState, 'agents/second-original/sessions/sessions.json'))
    const matches = Object.keys(registry).filter(key => digest(key) === plan.sessionKeySha256)
    if (matches.length !== 1) fail('session binding is not unique')
    sessionKey = matches[0]; environment.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY = sessionKey
    for (const key of Object.keys(registry)) delete registry[key]
    matches.length = 0
    const captured = await run('capture', '/bin/bash', [join(repository, 'scripts/apply-openclaw-runtime-convergence.sh'), '--capture-tool-baseline'], BUDGET.capture)
    const baseline = captured.match(/Captured pre-install catalog and effective-tool baseline: (\/[^\r\n]+)\s*$/mu)?.[1]
    if (!baseline || dirname(baseline) !== runtimeBackup) fail('baseline path is invalid')
    await progressAndRenew('capture-complete', 0, leaseFor(BUDGET.artifact, BUDGET.artifact, BUDGET.preinstall))
    const before = await proofs('preinstall-inputs')
    const transition = ['--transition-intent', join(plan.transitionRoot, 'upgrade-intent.json'),
      '--transition-confirmation', join(plan.transitionRoot, 'current-confirmation.json'),
      '--transition-journal', join(plan.transitionRoot, 'journal'),
      '--transition-attestation', join(plan.transitionRoot, 'transition-attestation.json'),
      '--transition-claim', join(plan.transitionRoot, 'bootstrap-claim.json')]
    await run('preinstall', node, [join(repository, 'scripts/legacy-preinstall-orchestrator.mjs'),
      '--attempt-dir', attempt, '--evidence', before.evidence, '--proof', before.proof, '--source-commit', plan.sourceCommit,
      ...transition, '--releases-root', plan.releasesRoot, '--profile', 'qwen-current', '--profile-state-root', profileState,
      '--workspace-root', workspace, '--agent-id', 'second-original', '--tool-baseline', baseline,
      '--task-flow-backup-root', join(home, 'ai-worker/backups/aiworker-task-flow-skill'),
      '--video-command-backup-root', join(home, 'ai-worker/backups/aiworker-video-command'),
      '--director-brain-backup-root', join(profileState, 'backups/aiworker-director-brain'),
      '--runtime-backup-root', runtimeBackup, '--deployment-run-dir', plan.runDir,
      '--video-batch-root', join(home, 'ai-worker/state/video-autoworker/video-batches')], BUDGET.preinstall)
    sessionKey = ''; delete environment.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
    const status = JSON.parse(await run('preinstall-status', node, [join(repository, 'scripts/legacy-preinstall-controller.mjs'), 'status', '--attempt-dir', attempt]))
    if (status.phase !== 'BOOTSTRAP_HANDOFF' || !status.verification?.path) fail('preinstall did not hand off')
    const verification = JSON.parse(readFileSync(status.verification.path, 'utf8'))
    const runtimeProof = verification.runtimeConvergenceProof?.path
    if (!isAbsolute(runtimeProof || '')) fail('runtime convergence proof is missing')
    environment.AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF = runtimeProof
    await progressAndRenew('preinstall-complete', status.revision,
      leaseFor(BUDGET.artifact, BUDGET.artifact, BUDGET.command, BUDGET.command, BUDGET.command, BUDGET.bootstrap, BUDGET.command))
    const after = await proofs('postinstall-inputs')
    const controller = join(repository, 'scripts/legacy-bootstrap-controller.mjs')
    await run('bootstrap-prepare', node, [controller, 'prepare', '--attempt-dir', attempt,
      '--evidence', after.evidence, '--proof', after.proof, '--source-commit', plan.sourceCommit,
      '--router-run-dir', plan.runDir, '--router-state', join(plan.runDir, 'router-state.json'), '--router-port', '3017',
      '--mission-db', plan.missionDb, '--n8n-db', plan.n8nDb, ...transition,
      '--install-verification', status.verification.path, '--runtime-convergence-proof', runtimeProof])
    const prepare = join(attempt, 'prepare.receipt.json')
    await run('bootstrap-confirm', node, [controller, 'current-confirm', '--prepare', prepare])
    await run('bootstrap-apply', node, [controller, 'apply', '--prepare', prepare, '--confirm', join(attempt, 'current-confirm.receipt.json'), '--token', join(attempt, 'current-confirm.token.json')])
    await run('bootstrap', '/bin/bash', [join(repository, 'scripts/deploy-blue-green.sh'), 'bootstrap', 'blue', plan.releaseId, plan.releaseRoot, after.evidence, after.proof, attempt], BUDGET.bootstrap)
    // The existing bootstrap verifier has already checked health, scheduler,
    // release identity and the n8n transition before revoking the guard.
    const url = 'http://127.0.0.1:3017/api/n8n/intake-control'
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const control = (await response.json())?.control
    if (!response.ok || !control?.canManage || control.accepting !== false) fail('final intake state is not paused')
    const resumed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', reason: '受控部署完成并通过验收，恢复新任务入口', expectedRevision: control.revision }), signal: AbortSignal.timeout(8000) })
    const result = await resumed.json()
    if (!resumed.ok || result?.control?.accepting !== true) fail('intake resume did not succeed')
    completed = true
    exclusiveJson(join(plan.controlRoot, 'result.json'), { ok: true, sourceCommit: plan.sourceCommit, attempt, intakeRevision: result.control.revision, completedAt: now() })
    report({ ok: true, releaseId: plan.releaseId, intakeResumed: true })
  } finally {
    sessionKey = ''; delete environment.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
    if (!completed) {
      // Never let expiry or a failed install silently reopen the old ingress.
      const recovery = await settleFailedMaintenance({
        stopGateway: () => run('failure-stop-qwen', openclaw, ['--profile', 'qwen-current', 'gateway', 'stop']),
        gatewayStopped: async () => {
          const listener = spawnSyncResult('/usr/sbin/lsof', ['-nP', '-iTCP:18889', '-sTCP:LISTEN', '-t'])
          return listener.status === 1 && !listener.stdout.trim()
        },
        guardPresent: () => existsSync(socket) || existsSync(tokenFile),
        recoveryPending: () => !resourcesMayBeReleased || existsSync(join(plan.runDir, 'bootstrap.pending.json'))
          || existsSync(join(attempt, 'shutdown-requested.receipt.json')),
        guardStatus: async () => JSON.parse(await run('failure-guard-status', node,
          [guardScript, 'status', '--socket', socket, '--database', plan.missionDb, '--n8n-database', plan.n8nDb])),
        revokeGuard: async () => {
          await run('failure-revoke', node, [guardScript, 'revoke', ...guardArgs])
        },
      })
      exclusiveJson(join(plan.controlRoot, 'failure-recovery.json'), recovery)
      // A surviving hold is deliberate when cleanup cannot prove safety. Do
      // not keep a failed owner artificially alive through its child's pipes.
      if (guardChild && guardChild.exitCode === null) {
        guardChild.stderr.destroy(); guardChild.unref()
      }
    }
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel)
  }
}
function spawnSyncResult(command, args) {
  try { return { status: 0, stdout: execFileSync(command, args, { encoding: 'utf8', timeout: 10000 }) } }
  catch (error) { return { status: error.status, stdout: String(error.stdout || '') } }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`${redactSensitiveValues(error.message)}\n`); process.exitCode = 1 })
}
