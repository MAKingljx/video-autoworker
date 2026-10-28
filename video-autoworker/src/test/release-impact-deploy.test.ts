// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyReleaseImpactPlan,
  assertSharedInstallerActivityUnchanged,
  assertAllowedArguments,
  assertControlSourceBinding,
  buildReleaseImpactPlan,
  captureSharedInstallerActivity,
  installedControlComponentState,
  inspectReleasePayloadComponents,
  inspectSharedRuntimeDatabase,
  requireSharedRuntimeDatabase,
  isCommittedPlanRoute,
  isOriginalPlanRoute,
  parseBlueGreenStatus,
  persistSharedInstallerBaseline,
  releaseCommandEnvironment,
  releaseComponentSummary,
  releaseFailureSummary,
  prepareReleaseReceiptDirectory,
  prepareSharedInstallerBaseline,
  releaseSourceRoles,
  recoveryTargetDisposition,
  readSharedInstallerBaseline,
  restoreOwnedIntake,
  sharedInstallerGateFailure,
  sharedReleaseQueueHasPendingWork,
  resumeCommittedPlan,
  validateResumeRuntimeProofOverride,
  waitForGatewayListener,
} from '../../scripts/release-impact-deploy.mjs'
import { scanOfflineDurableBatchStates } from '../../scripts/lib/runtime-safe-offline-queue.mjs'
import { appendReleaseOperationEvent, createReleaseOperationScope, readReleaseOperationJournal } from '../../scripts/lib/release-operation.mjs'

describe('release failure diagnostics', () => {
  it('prepares an idempotent private receipt leaf and rejects unsafe existing permissions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-receipt-')))
    try {
      const receipt = join(root, 'receipts')
      expect(prepareReleaseReceiptDirectory(receipt)).toBe(receipt)
      expect(prepareReleaseReceiptDirectory(receipt)).toBe(receipt)
      chmodSync(receipt, 0o755)
      expect(() => prepareReleaseReceiptDirectory(receipt)).toThrow('private directory is unsafe')
      expect(() => prepareReleaseReceiptDirectory(join(root, 'missing', 'nested'))).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('keeps the actionable cause without exposing session identifiers or credentials', () => {
    const failure = releaseFailureSummary(new Error(`release impact deploy failed: artifact source mismatch session-private-id token=${'a'.repeat(64)}`), 'session-private-id')
    expect(failure.diagnostic).toContain('artifact source mismatch')
    expect(failure.diagnostic).not.toContain('session-private-id')
    expect(failure.diagnostic).not.toContain('a'.repeat(64))
    expect(failure.currentState).toBe('state_unknown')
  })
})

const baseCommit = '1'.repeat(40)
const sourceCommit = '2'.repeat(40)
type ComponentName = 'app' | 'taskFlow' | 'directorBrain' | 'videoCommand' | 'control'
type ComponentState = { before: string; after: string; changed: boolean }
type ComponentSummary = Record<ComponentName, ComponentState>
type IntakeFixture = {
  schema: string
  globalScope: boolean
  canManage: boolean
  accepting: boolean
  mode: 'active' | 'draining' | 'paused'
  revision: number
  counts: { active: number }
  reason: string | null
}
type BuildPlan = (options: {
  baseCommit: string
  sourceCommit: string
  router: typeof router
  intake: IntakeFixture
  components: ComponentSummary
  artifactRoot?: string | null
  runtimeConvergenceProof?: string | null
  toolBaseline?: string | null
  receiptDir?: string | null
  runtimeConfigSha256?: string | null
  runtimeBinding?: Record<string, unknown> | null
  artifactManifestSha256?: string | null
  workerBinding?: Record<string, unknown> | null
  failurePolicy?: 'assess-first' | 'restore-previous'
  controlSourceCommit?: string
}) => ReturnType<typeof buildReleaseImpactPlan>
const digest = (value: string) => (value.charCodeAt(0) % 16).toString(16).repeat(64)
const router = {
  active: 'green', previous: 'blue', generation: 7,
  slots: { blue: `${baseCommit}-runtime`, green: `${baseCommit}-runtime` },
}
const activeIntake = (revision = 18): IntakeFixture => ({
  schema: 'video-autoworker-intake-control/v1', globalScope: true,
  canManage: true, accepting: true, mode: 'active', revision,
  counts: { active: 0 }, reason: null,
})
const pausedIntake = (revision = 19): IntakeFixture => ({
  ...activeIntake(revision), accepting: false, mode: 'paused', counts: { active: 0 },
})

const buildPlan = buildReleaseImpactPlan as unknown as BuildPlan
const componentNames: ComponentName[] = [
  'app', 'taskFlow', 'directorBrain', 'videoCommand', 'control',
]

function components(changed: ComponentName[] = []): ComponentSummary {
  return Object.fromEntries(componentNames
    .map(name => [name, {
      before: digest(name[0]), after: digest(changed.includes(name) ? '9' : name[0]),
      changed: changed.includes(name),
    }])) as ComponentSummary
}

// Compensation regression cases explicitly select the prior-version recovery policy.
function plan(changed: ComponentName[], failurePolicy: 'assess-first' | 'restore-previous' = 'restore-previous') {
  return buildPlan({
    baseCommit, sourceCommit, router, intake: activeIntake(), components: components(changed),
    failurePolicy,
    artifactRoot: changed.includes('app') ? '/private/tmp/release/standalone' : null,
    artifactManifestSha256: changed.includes('app') ? 'a'.repeat(64) : null,
    runtimeConvergenceProof: '/private/tmp/runtime-proof.json',
    toolBaseline: changed.some(name => ['taskFlow', 'directorBrain', 'videoCommand'].includes(name))
      ? '/private/tmp/tool-baseline.json' : null,
    receiptDir: changed.some(name => ['taskFlow', 'directorBrain', 'videoCommand'].includes(name))
      ? '/private/tmp/release-receipts' : null,
  })
}

function services(events: string[], {
  failAt = '', revisionDrift = false, uncertainDrain = false, recoveryOk = true,
  initialControl = activeIntake(),
} = {}) {
  let control = initialControl
  const action = async (name: string) => {
    events.push(name)
    if (name === failAt) throw new Error(`failed:${name}`)
  }
  return {
    assertSource: async () => action('source'),
    assertComponents: async () => action('components'),
    routerStatus: async () => { await action('status'); return router },
    stage: async () => action('stage'),
    inspectSharedQueue: async () => ({ items: [], snapshot: { activeJournals: 0 } }),
    prepareSharedInstallerBaseline: async () => undefined,
    pauseSharedWorker: async () => action('worker:pause'),
    resumeSharedWorker: async () => action('worker:resume'),
    install: async (name: string) => {
      await action(`install:${name}`)
      return { component: name, status: 'applied' }
    },
    converge: async () => action('converge'),
    retire: async () => action('retire'),
    bind: async () => action('bind'),
    start: async () => action('start'),
    probe: async () => action('probe'),
    switch: async () => action('switch'),
    attest: async () => action('attest'),
    recover: async ({ receipts }: { receipts: Array<{ component: string }> }) => {
      events.push(`recover:${receipts.map(item => item.component).reverse().join(',') || 'none'}`)
      return recoveryOk
        ? { ok: true, reason: 'official_rollbacks_verified' }
        : { ok: false, reason: 'official_rollback_failed' }
    },
    intake: {
      read: async () => {
        events.push('intake:read')
        return revisionDrift && control.accepting === false ? pausedIntake(control.revision + 1) : control
      },
      mutate: async (operation: string, expectedRevision: number, reason?: string) => {
        events.push(`intake:${operation}:${expectedRevision}`)
        control = operation === 'drain'
          ? { ...pausedIntake(expectedRevision + 1),
              reason: reason || '准备受控增量发布，暂停接收新任务' }
          : { ...activeIntake(expectedRevision + 1),
              reason: reason || '受控发布已结束，恢复本次暂停的新任务入口' }
        if (operation === 'drain' && uncertainDrain) throw new Error('response lost')
        return control
      },
      waitPaused: async () => { events.push('intake:wait'); return control },
    },
  }
}

describe('release impact deployment', () => {
  const pendingQueue = () => ({ items: [{ taskId: 'original-video-8', status: 'staging', origin: 'durable' }],
    snapshot: { activeJournals: 1, backupActiveJournals: 1 } })
  const gateFailure = () => sharedInstallerGateFailure('install-aiworker-task-flow-skill.sh', ['--apply'], {
    code: 1, signal: null, timedOut: false, overflow: false, groupStopped: true,
    stderr: 'shared_runtime_install_not_ready:active_tasks_present\n',
  })!
  const operationId = 'e'.repeat(64)

  it('uses authoritative queue evidence without counting retained backups as new work', () => {
    expect(sharedReleaseQueueHasPendingWork({ items: [], snapshot: {
      activeJournals: 0, backupActiveJournals: 3, retainedAttentionBatches: [{ batchId: 'retained-29' }],
    } })).toBe(false)
    expect(sharedReleaseQueueHasPendingWork(pendingQueue())).toBe(true)
    expect(sharedReleaseQueueHasPendingWork({ items: [], snapshot: { activeJournals: 1 } })).toBe(true)
    expect(() => sharedReleaseQueueHasPendingWork({ items: [] })).toThrow('evidence is invalid')
  })

  it('defers before staging, pausing intake, or stopping the original worker', async () => {
    const events: string[] = []
    const actions = services(events)
    const evidence = pendingQueue()
    const frozen = JSON.stringify(evidence)
    Object.assign(actions, { inspectSharedQueue: async () => evidence })
    await expect(applyReleaseImpactPlan(plan(['app', 'taskFlow'], 'assess-first'), actions))
      .rejects.toMatchObject({ currentState: 'deferred_pending_handoff', errorCode: 'deferred_pending_handoff',
        nextAction: 'wait_for_tasks_then_replan', effectState: 'unchanged', keepIntakeHold: false })
    expect(events).not.toContain('stage')
    expect(events).not.toContain('worker:pause')
    expect(events.some(event => event.startsWith('intake:drain') || event.startsWith('install:'))).toBe(false)
    expect(await actions.intake.read()).toEqual(activeIntake())
    expect(JSON.stringify(evidence)).toBe(frozen)
  })

  it('reads the real primary/backup projection and leaves staged bytes and both journals unchanged', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-pending-handoff-')))
    const batchRoot = join(root, 'batches')
    mkdirSync(batchRoot, { mode: 0o700 })
    const primary = join(batchRoot, `${'a'.repeat(64)}.json`)
    const video = join(root, 'original-staged.mp4')
    const state = { schemaVersion: 2, batchId: 'original-batch-8', status: 'staging',
      items: [{ taskId: 'original-video-8', status: 'staging',
        stagingRecovery: { phase: 'triggering', videoKey: 'original-staged.mp4' } }] }
    writeFileSync(primary, JSON.stringify(state), { mode: 0o600 })
    writeFileSync(`${primary}.bak`, JSON.stringify({ ...state, status: 'queued' }), { mode: 0o600 })
    writeFileSync(video, Buffer.alloc(4096, 0x78), { mode: 0o600 })
    const snapshot = () => [primary, `${primary}.bak`, video].map(pathname => {
      const details = statSync(pathname)
      return { pathname, ino: details.ino, size: details.size, mtimeMs: details.mtimeMs,
        sha256: createHash('sha256').update(readFileSync(pathname)).digest('hex') }
    })
    try {
      const before = snapshot()
      const events: string[] = []
      const actions = services(events)
      Object.assign(actions, { inspectSharedQueue: async () => scanOfflineDurableBatchStates(batchRoot, { includeEvidence: true }) })
      await expect(applyReleaseImpactPlan(plan(['taskFlow'], 'assess-first'), actions))
        .rejects.toMatchObject({ currentState: 'deferred_pending_handoff', effectState: 'unchanged' })
      expect(snapshot()).toEqual(before)
      expect(events).not.toContain('worker:pause')
      expect(events.some(event => event.startsWith('install:') || event.startsWith('intake:drain'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('defers a real running task before taking its intake away', async () => {
    const events: string[] = []
    const initialControl = { ...activeIntake(), counts: { active: 1 } }
    const value = buildPlan({ baseCommit, sourceCommit, router, intake: initialControl,
      components: components(['taskFlow']), toolBaseline: '/private/baseline.json', receiptDir: '/private/receipts',
      runtimeConvergenceProof: '/private/runtime-proof.json' })
    const actions = services(events, { initialControl })
    actions.inspectSharedQueue = vi.fn(async () => { throw new Error('active writer must not be sampled') })
    await expect(applyReleaseImpactPlan(value, actions))
      .rejects.toMatchObject({ errorCode: 'deferred_pending_handoff', effectState: 'unchanged' })
    expect(actions.inspectSharedQueue).not.toHaveBeenCalled()
    expect(events).not.toContain('worker:pause')
    expect(events.some(event => event.startsWith('intake:drain'))).toBe(false)
  })

  it.each(['install-aiworker-task-flow-skill.sh', 'install-aiworker-director-brain.sh',
    'install-aiworker-video-command-plugin.sh'])('classifies an official gate rejection without claiming a mutation phase: %s', script => {
    const failure = { code: 1, signal: null, timedOut: false, overflow: false, groupStopped: true,
      stderr: 'shared_runtime_install_not_ready:active_tasks_present\n' }
    expect(sharedInstallerGateFailure(script, ['--apply'], failure)).toMatchObject({
      sharedInstallGateRejected: true, errorCode: 'shared_runtime_install_not_ready',
      effectState: 'component_mutation_unverified',
      sharedInstallGateReason: 'active_tasks_present', installerFailure: failure,
    })
    expect(sharedInstallerGateFailure(script, ['--apply'], failure)).not.toHaveProperty('mutationNotStarted')
    expect(sharedInstallerGateFailure(script, ['--rollback'], failure)).toBeNull()
    expect(sharedInstallerGateFailure(script, ['--apply'], { ...failure, groupStopped: false })).toBeNull()
    expect(sharedInstallerGateFailure(script, ['--apply'], { ...failure, timedOut: true })).toBeNull()
    expect(sharedInstallerGateFailure('unrecognized.sh', ['--apply'], failure)).toBeNull()
  })

  function raceServices(events: string[], initialControl = activeIntake()) {
    const actions = services(events, { initialControl })
    let inspections = 0
    Object.assign(actions, {
      operation: { scope: { operationId }, record: vi.fn() },
      inspectSharedQueue: async () => ++inspections === 1
        ? { items: [], snapshot: { activeJournals: 0 } } : pendingQueue(),
      install: async () => { events.push('gate:reject'); throw gateFailure() },
      assertSharedRuntimeMatchesBefore: vi.fn(async () => { events.push('components:unchanged') }),
      assertOwnedSharedWorkerHold: vi.fn(async () => { events.push('worker:owned'); return true }),
    })
    return actions as typeof actions & {
      operation: { scope: { operationId: string }; record: ReturnType<typeof vi.fn> }
      assertSharedRuntimeMatchesBefore: ReturnType<typeof vi.fn>
      assertOwnedSharedWorkerHold: ReturnType<typeof vi.fn>
    }
  }

  function activityFixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-installer-activity-')))
    const options = { workspaceRoot: join(root, 'workspace'), profileStateRoot: join(root, 'profile'),
      backupRoots: ['task-backups', 'video-backups', 'director-backups'].map(name => join(root, name)) }
    const target = join(options.workspaceRoot, 'skills/aiworker-task-flow/script.mjs')
    for (const pathname of [join(options.workspaceRoot, 'skills/aiworker-task-flow'),
      join(options.profileStateRoot, 'extensions/aiworker-video-command/node_modules'), ...options.backupRoots]) {
      mkdirSync(pathname, { recursive: true, mode: 0o700 })
    }
    writeFileSync(target, 'original target', { mode: 0o600 })
    return { root, options, target, receipt: join(root, 'current.apply.json') }
  }

  async function persistentBaselineFixture() {
    const fixture = activityFixture()
    const receiptDir = join(fixture.root, 'receipts')
    mkdirSync(receiptDir, { mode: 0o700 })
    const summary = components(['taskFlow'])
    for (const name of ['taskFlow', 'directorBrain', 'videoCommand'] as const) {
      Object.assign(summary[name], { installedFingerprint: 'b'.repeat(64) })
    }
    const value = buildPlan({ baseCommit, sourceCommit, router, intake: activeIntake(), components: summary,
      receiptDir, toolBaseline: '/private/tool-baseline.json', runtimeConvergenceProof: '/private/runtime-proof.json' })
    const scope = createReleaseOperationScope(value)
    const attemptId = '11111111-1111-4111-8111-111111111111'
    const journal = join(receiptDir, 'operation.jsonl')
    const record = (event: Record<string, unknown>) => appendReleaseOperationEvent(journal, scope, { ...event, attemptId })
    const activity = captureSharedInstallerActivity(fixture.options)
    const baseline = await persistSharedInstallerBaseline(value, { scope, owner: { attemptId }, record }, activity)
    return { ...fixture, value, scope, attemptId, journal, record, baseline }
  }

  it('recovers an interrupted same-operation hold using its durable original baseline and verified journal', async () => {
    const fixture = await persistentBaselineFixture()
    try {
      fixture.record({ step: 'pause-intake', status: 'completed' })
      fixture.record({ step: 'pause-shared-worker', status: 'completed' })
      fixture.record({ step: 'install-task-flow', status: 'started' })
      const previousEvents = readReleaseOperationJournal(fixture.journal, fixture.scope.operationId)
      const loaded = readSharedInstallerBaseline(fixture.value, fixture.scope.operationId, previousEvents)
      expect(loaded.value.activitySha256).toBe(fixture.baseline.value.activitySha256)
      expect(JSON.stringify(loaded.value)).not.toContain('pathname')
      const events: string[] = []
      const capture = vi.fn(() => { throw new Error('resume must reuse the original digest') })
      const resumeRecord = vi.fn()
      const journalBefore = readFileSync(fixture.journal, 'utf8')
      const actions = raceServices(events, { ...pausedIntake(),
        reason: `准备受控增量发布，暂停接收新任务 [operation:${fixture.scope.operationId}]` })
      Object.assign(actions, { inspectSharedQueue: async () => pendingQueue(),
        prepareSharedInstallerBaseline: async () => prepareSharedInstallerBaseline(fixture.value,
          { resume: true, scope: fixture.scope, previousEvents, record: resumeRecord }, capture),
        operation: { ...actions.operation, scope: fixture.scope, resume: true,
          owner: { attemptId: '22222222-2222-4222-8222-222222222222' },
          previousWorkerHold: { attemptId: fixture.attemptId }, previousEvents } })
      actions.assertSharedRuntimeMatchesBefore.mockImplementation(async () =>
        assertSharedInstallerActivityUnchanged(loaded.value.activitySha256, fixture.options, [fixture.receipt]))
      await expect(applyReleaseImpactPlan(fixture.value, actions)).rejects.toMatchObject({
        currentState: 'deferred_pending_handoff', recovery: { intake: { restored: true } },
      })
      expect(events).toContain('worker:resume')
      expect(events).toContain('intake:resume:19')
      expect(events).not.toContain('worker:pause')
      expect(capture).not.toHaveBeenCalled()
      expect(resumeRecord).not.toHaveBeenCalled()
      expect(readFileSync(fixture.journal, 'utf8')).toBe(journalBefore)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })

  it.each(['missing', 'receipt-tampered', 'reference-sha', 'forged-binding', 'different-operation', 'old-attempt', 'event-order', 'directory-drift'])(
    'rejects an untrusted or changed persistent baseline without releasing the hold: %s', async fault => {
      const fixture = await persistentBaselineFixture()
      try {
        const reference = readReleaseOperationJournal(fixture.journal, fixture.scope.operationId)[0]
        let previousEvents = readReleaseOperationJournal(fixture.journal, fixture.scope.operationId)
        if (fault === 'missing') previousEvents = []
        if (fault === 'receipt-tampered') writeFileSync(fixture.baseline.pathname,
          `${readFileSync(fixture.baseline.pathname, 'utf8')} `, { mode: 0o600 })
        if (['reference-sha', 'forged-binding', 'different-operation', 'old-attempt', 'event-order'].includes(fault)) {
          rmSync(fixture.journal)
          if (fault === 'forged-binding') {
            const value = JSON.parse(readFileSync(fixture.baseline.pathname, 'utf8'))
            writeFileSync(fixture.baseline.pathname, JSON.stringify({ ...value, controlSourceCommit: 'c'.repeat(40) }), { mode: 0o600 })
          }
          if (fault === 'event-order') fixture.record({ step: 'install-task-flow', status: 'started' })
          const event = { step: 'shared-installer-baseline', status: 'completed',
            effectState: fault === 'reference-sha' ? `baseline_sha256:${'f'.repeat(64)}`
              : fault === 'forged-binding' ? `baseline_sha256:${createHash('sha256').update(readFileSync(fixture.baseline.pathname)).digest('hex')}`
                : reference.effectState,
            attemptId: fault === 'old-attempt' ? '33333333-3333-4333-8333-333333333333' : fixture.attemptId }
          if (fault === 'different-operation') appendReleaseOperationEvent(fixture.journal,
            { ...fixture.scope, operationId: 'd'.repeat(64) }, event)
          else appendReleaseOperationEvent(fixture.journal, fixture.scope, event)
          previousEvents = readReleaseOperationJournal(fixture.journal)
        }
        if (fault === 'directory-drift') writeFileSync(fixture.target, 'changed since original baseline')
        const events: string[] = []
        const actions = raceServices(events, { ...pausedIntake(),
          reason: `准备受控增量发布，暂停接收新任务 [operation:${fixture.scope.operationId}]` })
        let loaded: ReturnType<typeof readSharedInstallerBaseline>
        Object.assign(actions, { inspectSharedQueue: async () => pendingQueue(),
          prepareSharedInstallerBaseline: async () => {
            loaded = readSharedInstallerBaseline(fixture.value, fixture.scope.operationId, previousEvents)
          }, operation: { ...actions.operation, scope: fixture.scope, resume: true,
            previousWorkerHold: { attemptId: fixture.attemptId }, previousEvents } })
        actions.assertSharedRuntimeMatchesBefore.mockImplementation(async () =>
          assertSharedInstallerActivityUnchanged(loaded.value.activitySha256, fixture.options, [fixture.receipt]))
        await expect(applyReleaseImpactPlan(fixture.value, actions)).rejects.toThrow()
        expect(events).not.toContain('worker:resume')
        expect(events.some(event => event.startsWith('intake:resume'))).toBe(false)
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })

  it.each(['target-restored', 'transaction', 'backup', 'backup-transaction', 'receipt'])(
    'keeps a same-stderr post-commit gate failure protected using real activity evidence: %s', async scenario => {
      const fixture = activityFixture()
      try {
        const baseline = captureSharedInstallerActivity(fixture.options)
        const events: string[] = []
        const actions = raceServices(events)
        actions.assertSharedRuntimeMatchesBefore.mockImplementation(async () =>
          assertSharedInstallerActivityUnchanged(baseline, fixture.options, [fixture.receipt]))
        actions.install = async () => {
          if (scenario === 'target-restored') {
            writeFileSync(fixture.target, 'changed temporarily')
            writeFileSync(fixture.target, 'original target')
          }
          if (scenario === 'transaction') mkdirSync(join(fixture.options.profileStateRoot,
            '.aiworker-video-command-install.lock'), { mode: 0o700 })
          if (scenario === 'backup') writeFileSync(join(fixture.options.backupRoots[0], 'new-backup.json'), '{}', { mode: 0o600 })
          if (scenario === 'backup-transaction') mkdirSync(join(fixture.options.backupRoots[0], '.rollback-source-claim.ABCD12'), { mode: 0o700 })
          if (scenario === 'receipt') writeFileSync(fixture.receipt, JSON.stringify({
            schema: 'video-autoworker-installer-result/v1', status: 'applied',
          }), { mode: 0o600 })
          throw gateFailure()
        }
        await expect(applyReleaseImpactPlan(plan(['taskFlow'], 'assess-first'), actions)).rejects.toMatchObject({
          recovery: { components: { ok: false, reason: 'pending_handoff_recovery_unverified' } },
        })
        expect(events).not.toContain('worker:resume')
        expect(events.some(event => event.startsWith('intake:resume'))).toBe(false)
        expect(actions.operation.record).toHaveBeenCalledWith(expect.objectContaining({
          step: 'install-task-flow', effectState: 'component_mutation_unverified',
        }))
        expect(actions.operation.record.mock.calls.some(([event]) =>
          ['mutation_not_started', 'target_state_matches_before'].includes(event.effectState))).toBe(false)
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })

  it('inspects only the recognized target and backup SDK links without following SDK contents', () => {
    const fixture = activityFixture()
    try {
      const legacyRoot = join(fixture.root, 'managed-node')
      const legacySdk = join(legacyRoot, 'lib/node_modules/openclaw')
      const currentSdk = join(fixture.root, 'current-sdk')
      for (const [root, version] of [[legacySdk, '2026.9.2'], [currentSdk, '2026.9.9']]) {
        mkdirSync(root, { recursive: true, mode: 0o700 })
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'openclaw', version }), { mode: 0o600 })
      }
      vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWORKER_OPENCLAW_RUNTIME_TEST_MODE', '1')
      vi.stubEnv('AIWORKER_TEST_OPENCLAW_MANAGED_NODE_ROOT', legacyRoot)
      vi.stubEnv('AIWORKER_TEST_OPENCLAW_SDK_ROOT', currentSdk)
      const targetLink = join(fixture.options.profileStateRoot, 'extensions/aiworker-video-command/node_modules/openclaw')
      const backupModules = join(fixture.options.backupRoots[1],
        'current-release-20261028-090000.ABCD12/previous-plugin/node_modules')
      mkdirSync(backupModules, { recursive: true, mode: 0o700 })
      symlinkSync(legacySdk, targetLink)
      symlinkSync(join(fixture.root, 'retired-and-absent-sdk'), join(backupModules, 'openclaw'))
      const before = captureSharedInstallerActivity(fixture.options)
      expect(before.filter(record => record.sdk)).toHaveLength(1)
      expect(before.filter(record => record.historicalSdkReference)).toHaveLength(1)
      expect(() => assertSharedInstallerActivityUnchanged(before, fixture.options, [fixture.receipt])).not.toThrow()
      symlinkSync(currentSdk, join(fixture.options.workspaceRoot, 'skills/aiworker-task-flow/arbitrary-link'))
      expect(() => captureSharedInstallerActivity(fixture.options)).toThrow('activity path is unsafe')
      rmSync(join(fixture.options.workspaceRoot, 'skills/aiworker-task-flow/arbitrary-link'))
      rmSync(targetLink)
      symlinkSync(join(fixture.root, 'retired-and-absent-sdk'), targetLink)
      expect(() => captureSharedInstallerActivity(fixture.options)).toThrow()
    } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }) }
  })

  it('rejects group/world-writable ordinary activity evidence', () => {
    const fixture = activityFixture()
    try {
      chmodSync(fixture.target, 0o666)
      expect(() => captureSharedInstallerActivity(fixture.options)).toThrow('activity path is unsafe')
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })

  it('restores only its own exact holds after a late handoff race and verified zero installation mutation', async () => {
    const events: string[] = []
    const actions = raceServices(events)
    await expect(applyReleaseImpactPlan(plan(['taskFlow'], 'assess-first'), actions))
      .rejects.toMatchObject({ currentState: 'deferred_pending_handoff', effectState: 'owned_runtime_restored',
        keepIntakeHold: false, recovery: { components: { reason: 'verified_current_equivalent' },
          intake: { restored: true, revision: 20 } } })
    expect(events).toContain('components:unchanged')
    expect(events).toContain('worker:owned')
    expect(events).toContain('worker:resume')
    expect(events).toContain('intake:resume:19')
    expect(events.some(event => event.startsWith('recover:'))).toBe(false)
    expect(events).not.toContain('converge')
    expect(actions.operation.record).toHaveBeenCalledWith(expect.objectContaining({
      step: 'install-task-flow', status: 'failed', effectState: 'component_mutation_unverified',
    }))
    expect(actions.operation.record).toHaveBeenCalledWith(expect.objectContaining({
      step: 'shared-installer-state-verified', effectState: 'target_state_matches_before',
    }))
    expect(actions.operation.record.mock.calls.some(([event]) => event.effectState === 'mutation_not_started')).toBe(false)
    expect(await actions.intake.read()).toMatchObject({ accepting: true, revision: 20 })
  })

  it.each(['foreign-intake', 'component-drift', 'foreign-worker', 'missing-proof'])(
    'keeps the hold closed when late-race recovery cannot prove ownership: %s', async scenario => {
      const events: string[] = []
      const actions = raceServices(events)
      if (scenario === 'foreign-intake') {
        const read = actions.intake.read
        actions.intake.read = async () => {
          const value = await read()
          return value.accepting ? value : { ...value, reason: 'another operation' }
        }
      }
      if (scenario === 'component-drift') actions.assertSharedRuntimeMatchesBefore.mockRejectedValue(new Error('installed fingerprint changed'))
      if (scenario === 'foreign-worker') actions.assertOwnedSharedWorkerHold.mockResolvedValue(false)
      if (scenario === 'missing-proof') Object.assign(actions, { assertOwnedSharedWorkerHold: undefined })
      await expect(applyReleaseImpactPlan(plan(['taskFlow'], 'assess-first'), actions)).rejects.toMatchObject({
        recovery: { components: { ok: false, reason: 'pending_handoff_recovery_unverified' },
          intake: { restored: false, reason: 'recovery_incomplete' } },
      })
      expect(events).not.toContain('worker:resume')
      expect(events.some(event => event.startsWith('intake:resume') || event.startsWith('recover:'))).toBe(false)
    })

  it('refuses a worker owner that changes after the zero-mutation proof', async () => {
    const events: string[] = []
    const actions = raceServices(events)
    actions.assertOwnedSharedWorkerHold.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(applyReleaseImpactPlan(plan(['taskFlow'], 'assess-first'), actions)).rejects.toMatchObject({
      recovery: { components: { ok: false, reason: 'video_worker_restore_failed' } },
    })
    expect(events).not.toContain('worker:resume')
    expect(events.some(event => event.startsWith('intake:resume'))).toBe(false)
  })

  it('does not call a later gate rejection zero mutation after an earlier component was installed', async () => {
    const events: string[] = []
    const actions = raceServices(events)
    let attempts = 0
    actions.install = async () => {
      if (++attempts === 1) return { component: 'taskFlow', status: 'applied' }
      throw gateFailure()
    }
    await expect(applyReleaseImpactPlan(plan(['taskFlow', 'directorBrain'], 'assess-first'), actions))
      .rejects.toMatchObject({ recovery: { components: { ok: false, reason: 'pending_handoff_recovery_unverified' } } })
    expect(actions.assertSharedRuntimeMatchesBefore).not.toHaveBeenCalled()
    expect(events).not.toContain('worker:resume')
    expect(events.some(event => event.startsWith('intake:resume') || event.startsWith('recover:'))).toBe(false)
  })

  it('settles an interrupted same-operation hold before deferring instead of re-pausing work', async () => {
    const events: string[] = []
    const actions = raceServices(events, { ...pausedIntake(),
      reason: `准备受控增量发布，暂停接收新任务 [operation:${operationId}]` })
    Object.assign(actions, { inspectSharedQueue: async () => pendingQueue(),
      operation: { ...actions.operation, resume: true, previousWorkerHold: { attemptId: 'prior-owned-attempt' } } })
    await expect(applyReleaseImpactPlan(plan(['taskFlow'], 'assess-first'), actions))
      .rejects.toMatchObject({ currentState: 'deferred_pending_handoff', keepIntakeHold: false,
        recovery: { intake: { restored: true, revision: 20 } } })
    expect(events).not.toContain('worker:pause')
    expect(events).not.toContain('intake:drain:18')
    expect(events).toContain('worker:resume')
    expect(events).toContain('intake:resume:19')
  })

  it('does not resume a same-revision pause whose owner reason changed', async () => {
    const mutate = vi.fn()
    await expect(restoreOwnedIntake({ before: activeIntake(), paused: pausedIntake(),
      read: async () => ({ ...pausedIntake(), reason: 'foreign owner' }), mutate,
      pauseReason: `准备受控增量发布，暂停接收新任务 [operation:${operationId}]`,
    })).resolves.toMatchObject({ restored: false, reason: 'revision_changed' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('defaults newly sealed plans to assessment before compensation', () => {
    const value = buildPlan({ baseCommit, sourceCommit, router, intake: activeIntake(), components: components() })
    expect(value.failurePolicy).toBe('assess-first')
    expect(value.controlSourceCommit).toBe(sourceCommit)
    expect(() => assertAllowedArguments('plan', new Map([['--failure-policy', 'automatic']]))).toThrow('release_failure_policy_invalid')
    expect(() => assertAllowedArguments('resume', new Map([['--plan', '/private/plan.json'], ['--failure-policy', 'restore-previous']]))).not.toThrow()
  })

  it('seals the independently versioned deployment controller into the application plan', () => {
    const controlSourceCommit = '3'.repeat(40)
    const value = buildPlan({ baseCommit, sourceCommit, controlSourceCommit,
      router, intake: activeIntake(), components: components() })
    expect(value).toMatchObject({ sourceCommit, controlSourceCommit })
    expect(value.planSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(assertControlSourceBinding(value, controlSourceCommit)).toBe(controlSourceCommit)
    expect(() => assertControlSourceBinding(value, '4'.repeat(40)))
      .toThrow('control source changed after plan')
  })

  it('uses one explicit source-role map for control, application, and worker evidence', () => {
    expect(releaseSourceRoles('/private/control', '/private/application')).toEqual({
      control: '/private/control', application: '/private/application', worker: '/private/control',
    })
    expect(() => releaseSourceRoles('relative-control', '/private/application'))
      .toThrow('release source root is invalid')
  })

  it('preserves a committed route and its intake hold after failed acceptance by default', async () => {
    const events: string[] = []
    const value = plan(['app'], 'assess-first')
    const actions = services(events, { failAt: 'attest' })
    Object.assign(actions, { routeReadback: async () => ({ ...router, active: 'blue', previous: 'green', generation: 8,
      slots: { ...router.slots, blue: `${sourceCommit}-runtime` } }) })
    await expect(applyReleaseImpactPlan(value, actions)).rejects.toMatchObject({
      currentState: 'route_committed_unverified', nextAction: 'resume_after_assessment',
      recovery: { components: { ok: false, reason: 'assessment_required' } },
    })
    expect(events.some(event => event.startsWith('recover:'))).toBe(false)
    expect(events).not.toContain('intake:resume:19')
  })

  it('preserves installed components when convergence requires assessment', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['directorBrain'], 'assess-first'), services(events, { failAt: 'converge' })))
      .rejects.toMatchObject({ currentState: 'original_route_preserved', nextAction: 'resume_after_assessment' })
    expect(events).toContain('install:directorBrain')
    expect(events.some(event => event.startsWith('recover:'))).toBe(false)
    expect(events).not.toContain('worker:resume')
    expect(events).not.toContain('intake:resume:19')
  })

  it('honors an explicit attempt recovery choice without changing the sealed policy', async () => {
    const events: string[] = []
    const value = plan(['directorBrain'], 'assess-first')
    const actions = services(events, { failAt: 'converge' })
    Object.assign(actions, { operation: { failurePolicy: 'restore-previous' } })
    await expect(applyReleaseImpactPlan(value, actions)).rejects.toMatchObject({ currentState: 'previous_restored', nextAction: 'prepare_new_release' })
    expect(value.failurePolicy).toBe('assess-first')
    expect(events).toContain('recover:directorBrain')
    expect(events).toContain('intake:resume:19')
  })

  it('keeps unknown routing protected even when recovery was explicitly selected', async () => {
    const events: string[] = []
    const actions = services(events, { failAt: 'probe' })
    Object.assign(actions, { routeReadback: async () => ({ ...router, generation: 999 }) })
    await expect(applyReleaseImpactPlan(plan(['app']), actions)).rejects.toMatchObject({ currentState: 'state_unknown', nextAction: 'resume_after_assessment' })
    expect(events.some(event => event.startsWith('recover:'))).toBe(false)
    expect(events).not.toContain('intake:resume:19')
  })

  it('settles an exactly verified prior route when the explicit shell rollback already completed', async () => {
    const events: string[] = []
    const actions = services(events)
    Object.assign(actions, { transition: async () => { throw new Error('post-check failed; explicit rollback complete') },
      routeReadback: async () => ({ ...router, generation: 9,
        slots: { ...router.slots, blue: `${sourceCommit}-runtime` } }) })
    await expect(applyReleaseImpactPlan(plan(['app']), actions)).rejects.toMatchObject({ currentState: 'previous_restored' })
    expect(events).toContain('recover:none')
    expect(events).toContain('intake:resume:19')
  })

  it('resumes acceptance and settlement on the same sealed operation after assessment', async () => {
    const value = plan(['app'], 'assess-first')
    const originalHash = value.planSha256
    const operationId = 'f'.repeat(64)
    const events: string[] = []
    const actions = services(events, { failAt: 'attest' })
    const committed = { ...router, active: 'blue', previous: 'green', generation: 8,
      slots: { ...router.slots, blue: `${sourceCommit}-runtime` } }
    Object.assign(actions, { routeReadback: async () => committed, operation: { scope: { operationId } } })
    await expect(applyReleaseImpactPlan(value, actions)).rejects.toMatchObject({ currentState: 'route_committed_unverified' })
    const attest = vi.fn(async () => undefined)
    const assertBindings = vi.fn(async () => undefined)
    const records: unknown[] = []
    await expect(resumeCommittedPlan({ plan: value, scope: { operationId } }, { acceptanceVerified: false }, {
      record: (event: unknown) => records.push(event), failurePolicy: 'assess-first',
    }, { readRouter: async () => committed, assertBindings, attest,
      completeHandoff: async () => undefined, restoreWorker: async () => ({ reason: 'unchanged' }), intake: actions.intake }))
      .resolves.toMatchObject({ ok: true, resumed: true, intake: { restored: true, revision: 20 } })
    expect(value.planSha256).toBe(originalHash)
    expect(assertBindings).toHaveBeenCalledTimes(1)
    expect(attest).toHaveBeenCalledTimes(1)
    expect(events.filter(event => event === 'stage')).toHaveLength(1)
    expect(records).toContainEqual(expect.objectContaining({ step: 'acceptance', status: 'completed' }))
  })

  it('leaves a pre-existing preparation pause for its original owner after resume', async () => {
    const before = { ...pausedIntake(25), reason: 'worker handoff preparation' }
    const value = buildPlan({ baseCommit, sourceCommit, router, intake: before,
      components: components(['app']), artifactRoot: '/private/artifact',
      artifactManifestSha256: 'a'.repeat(64),
      runtimeConvergenceProof: '/private/proof.json' })
    const committed = { ...router, active: 'blue', previous: 'green', generation: 8,
      slots: { ...router.slots, blue: `${sourceCommit}-runtime` } }
    const mutate = vi.fn()
    await expect(resumeCommittedPlan({ plan: value, scope: { operationId: 'f'.repeat(64) } },
      { acceptanceVerified: true, state: 'acceptance_verified_pending_settlement' },
      { record: vi.fn(), failurePolicy: 'assess-first' }, {
        readRouter: async () => committed,
        assertBindings: async () => undefined,
        attest: async () => undefined,
        completeHandoff: async () => undefined,
        restoreWorker: async () => ({ reason: 'unchanged' }),
        intake: { read: async () => before, mutate },
      })).resolves.toMatchObject({ intake: { restored: false, reason: 'not_owned' } })
    expect(mutate).not.toHaveBeenCalled()
  })
  it('keeps running work and the independent worker alive for a verified Web-only release', async () => {
    const events: string[] = []
    const binding = { schema: 'video-autoworker-independent-worker-release/v1',
      stateDir: '/private/worker', manifestPath: '/private/worker-artifact/worker-manifest.json',
      manifestSha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64), pid: 123,
      database: { dev: '1', ino: '2', pathSha256: 'd'.repeat(64) }, sourceUnchanged: true, healthy: true }
    let control = { ...activeIntake(), counts: { active: 3 } }
    const value = buildPlan({ baseCommit, sourceCommit, router, intake: control,
      components: components(['app']), artifactRoot: '/private/artifact',
      artifactManifestSha256: 'a'.repeat(64), runtimeConvergenceProof: '/private/proof.json', workerBinding: binding })
    expect(value.admissionPolicy).toBe('pause-new')
    const actions = services(events, { initialControl: control })
    const assertWorker = vi.fn(async () => binding)
    actions.intake.read = async () => control
    actions.intake.mutate = async (action, revision, reason) => {
      control = { ...control, accepting: action === 'resume',
        mode: action === 'resume' ? 'active' : 'draining', revision: revision + 1, reason: reason || null }
      return control
    }
    actions.intake.waitPaused = vi.fn(async () => { throw new Error('must not drain active work') })
    await applyReleaseImpactPlan(value, { ...actions, assertWorker })
    expect(assertWorker).toHaveBeenCalledTimes(2)
    expect(actions.intake.waitPaused).not.toHaveBeenCalled()
    expect(events).not.toContain('worker:pause')
    expect(events).not.toContain('worker:resume')
    expect(control).toMatchObject({ accepting: true, counts: { active: 3 }, revision: 20 })
  })

  it('does not enable a fast release when worker source or health differs', () => {
    const binding = { schema: 'video-autoworker-independent-worker-release/v1',
      stateDir: '/private/worker', manifestPath: '/private/worker-artifact/worker-manifest.json',
      manifestSha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64), pid: 123,
      database: { dev: '1', ino: '2', pathSha256: 'd'.repeat(64) }, sourceUnchanged: false, healthy: true }
    const value = buildPlan({ baseCommit, sourceCommit, router, intake: activeIntake(),
      components: components(['app']), artifactRoot: '/private/artifact',
      artifactManifestSha256: 'a'.repeat(64), runtimeConvergenceProof: '/private/proof.json', workerBinding: binding })
    expect(value.admissionPolicy).toBe('drain-all')
  })

  it('uses logical component tree digests and ignores docs and tests', () => {
    const base = new Map([
      ['src/app/page.tsx', '100644:blob:a'],
      ['openclaw-plugins/aiworker-director-brain/index.js', '100644:blob:b'],
      ['scripts/deploy-blue-green.sh', '100755:blob:c'],
      ['docs/release.md', '100644:blob:d'],
    ])
    const target = new Map(base)
    target.set('src/app/page.tsx', '100644:blob:e')
    target.set('openclaw-plugins/aiworker-director-brain/index.js', '100644:blob:f')
    target.set('src/lib/director-evidence-outbox.ts', '100644:blob:i')
    target.set('docs/release.md', '100644:blob:g')
    target.set('src/test/page.test.ts', '100644:blob:h')

    const summary = releaseComponentSummary(base, target) as ComponentSummary
    expect(summary.app.changed).toBe(true)
    expect(summary.directorBrain.changed).toBe(true)
    expect(summary.taskFlow.changed).toBe(false)
    expect(summary.videoCommand.changed).toBe(false)
    expect(summary.control.changed).toBe(false)
  })

  it.each([
    'scripts/lib/runtime-receipt.mjs',
    'scripts/runtime-identity-doctor.mjs',
    'scripts/lib/independent-worker-release.mjs',
    'scripts/lib/operations-governance.mjs',
  ])('updates Web and CLI when their shared runtime reader dependency changes: %s', pathname => {
    const base = new Map([[pathname, '100644:blob:a']])
    const target = new Map([[pathname, '100644:blob:b']])
    const summary = releaseComponentSummary(base, target) as ComponentSummary
    expect(summary.app.changed).toBe(true)
    expect(summary.control.changed).toBe(true)
    expect(summary.taskFlow.changed).toBe(false)
    expect(summary.videoCommand.changed).toBe(false)
    expect(summary.directorBrain.changed).toBe(false)
  })

  it('classifies migrated Feishu business service as app-only', () => {
    const base = new Map([['scripts/lib/feishu-director-brain.mjs', '100644:blob:a']])
    const target = new Map([['scripts/lib/feishu-director-brain.mjs', '100644:blob:b']])
    const summary = releaseComponentSummary(base, target) as ComponentSummary
    expect(summary.app.changed).toBe(true)
    expect(summary.directorBrain.changed).toBe(false)
  })

  it('parses the existing controller status without inventing another state view', () => {
    expect(parseBlueGreenStatus(`active=green previous=blue generation=7\nblue: 127.0.0.1:3317 release=${baseCommit}-runtime\ngreen: 127.0.0.1:3417 release=${sourceCommit}-runtime\n`))
      .toEqual({
        active: 'green', previous: 'blue', generation: 7,
        slots: { blue: `${baseCommit}-runtime`, green: `${sourceCommit}-runtime` },
      })
  })

  it('attributes a route commit only to the exact next generation and previous slot', () => {
    const value = plan(['app'])
    const committed = { ...router, active: 'blue', previous: 'green', generation: 8,
      slots: { ...router.slots, blue: `${sourceCommit}-runtime` } }
    expect(isCommittedPlanRoute(value, committed)).toBe(true)
    expect(isCommittedPlanRoute(value, { ...committed, generation: 9 })).toBe(false)
    expect(isCommittedPlanRoute(value, { ...committed, previous: 'blue' })).toBe(false)
    expect(isOriginalPlanRoute(value, router)).toBe(true)
    expect(isOriginalPlanRoute(value, { ...router, generation: 8 })).toBe(false)
  })

  it('formally retires a target that was active before automatic compensation', () => {
    const value = plan(['app'])
    const bound = { ...router, slots: { ...router.slots, blue: `${sourceCommit}-runtime` } }
    expect(recoveryTargetDisposition(value, bound)).toBe('verify-stopped')
    expect(recoveryTargetDisposition(value, {
      ...bound, active: 'green', previous: 'blue', generation: 9,
    })).toBe('retire-then-verify')
    expect(recoveryTargetDisposition(value, {
      ...bound, active: 'green', previous: 'green', generation: 9,
    })).toBe('invalid')
    expect(recoveryTargetDisposition(value, {
      ...bound, active: 'green', previous: 'blue', generation: 10,
    })).toBe('invalid')
  })

  it('treats a different app commit as control-unchanged when installed control bytes pass preflight', () => {
    const sourceDiff = { before: digest('a'), after: digest('b'), changed: true }
    expect(installedControlComponentState(sourceDiff, true)).toEqual({
      before: digest('b'), after: digest('b'), changed: false,
    })
    expect(installedControlComponentState(sourceDiff, false, 'installed-preflight-failed').changed)
      .toBe(true)
  })

  it('removes installer failpoints from managed production children', () => {
    const environment = releaseCommandEnvironment({
      NODE_ENV: 'test', AIWORKER_BG_TEST_MODE: '1',
      AIWORKER_INSTALLER_ISOLATED_TEST_ROOT: '/tmp/fake',
      AIWORKER_VIDEO_COMMAND_INSTALL_TEST_FAILPOINT: 'stop',
      AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY: 'kept-private-runtime-input',
    }) as Record<string, string | undefined>
    expect(environment).toMatchObject({
      NODE_ENV: 'production',
      AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY: 'kept-private-runtime-input',
    })
    expect(environment.AIWORKER_BG_TEST_MODE).toBeUndefined()
    expect(environment.AIWORKER_INSTALLER_ISOLATED_TEST_ROOT).toBeUndefined()
    expect(environment.AIWORKER_VIDEO_COMMAND_INSTALL_TEST_FAILPOINT).toBeUndefined()
  })

  it('accepts a private runtime proof override only for resume', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'release-proof-override-')))
    const proof = join(root, 'runtime-proof.json')
    try {
      writeFileSync(proof, '{"schema":"proof"}\n', { mode: 0o600 })
      expect(validateResumeRuntimeProofOverride(proof)).toBe(proof)
      expect(() => assertAllowedArguments('resume', new Map([
        ['--plan', join(root, 'plan.json')],
        ['--runtime-convergence-proof', proof],
      ]))).not.toThrow()
      expect(() => assertAllowedArguments('apply', new Map([
        ['--plan', join(root, 'plan.json')],
        ['--runtime-convergence-proof', proof],
      ]))).toThrow('arguments are invalid')
      chmodSync(proof, 0o644)
      expect(() => validateResumeRuntimeProofOverride(proof))
        .toThrow('private evidence file is unsafe')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds the external runtime configuration digest and checks it before components', async () => {
    const events: string[] = []
    const bound = buildPlan({ baseCommit, sourceCommit, router, intake: activeIntake(),
      components: components([]), runtimeConvergenceProof: '/private/tmp/runtime-proof.json',
      runtimeConfigSha256: 'c'.repeat(64) })
    const boundServices = services(events) as ReturnType<typeof services> & {
      assertRuntimeConfig?: (expected: string) => Promise<void>
    }
    boundServices.assertRuntimeConfig = async expected => {
      expect(expected).toBe('c'.repeat(64)); events.push('runtime-config')
    }
    await expect(applyReleaseImpactPlan(bound, boundServices)).resolves.toMatchObject({ ok: true })
    expect(events.slice(0, 3)).toEqual(['source', 'runtime-config', 'components'])
  })

  it('seals the physical runtime roots and database identity into the plan', () => {
    const configSha256 = 'c'.repeat(64)
    const runtimeBinding = {
      schema: 'video-autoworker-release-runtime-binding/v1',
      runDir: '/private/runtime/run', releasesDir: '/private/runtime/releases',
      platformEnvPath: '/private/runtime/platform.env', liveDbPath: '/private/runtime/live.db',
      configSha256, database: { dev: '1', ino: '2' },
      ports: { router: 3017, blue: 3317, green: 3417 },
    }
    expect(buildPlan({ baseCommit, sourceCommit, router, intake: activeIntake(),
      components: components([]), runtimeConfigSha256: configSha256, runtimeBinding }))
      .toMatchObject({ runtimeBinding })
  })

  it('does not schedule installation, restart, or switch for unchanged components', () => {
    expect(plan([]).actions).toEqual([])
  })

  it('returns unchanged without pausing intake or invoking a component', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan([]), services(events))).resolves.toMatchObject({
      ok: true, actions: [], intake: { reason: 'unchanged' },
    })
    expect(events).toEqual(['source', 'components', 'status', 'intake:read'])
  })

  it('updates a task-flow-only payload without restarting or converging Gateway', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['taskFlow']), services(events))).resolves.toMatchObject({
      ok: true,
    })
    expect(events).toContain('install:taskFlow')
    expect(events.indexOf('worker:pause')).toBeLessThan(events.indexOf('install:taskFlow'))
    expect(events.indexOf('worker:resume')).toBeLessThan(events.indexOf('intake:resume:19'))
    expect(events).not.toContain('converge')
    expect(events).not.toContain('stage')
    expect(events).not.toContain('switch')
  })

  it('records plugin installation steps with journal-safe stable names', async () => {
    const events: string[] = []
    const records: string[] = []
    const journaled = services(events) as ReturnType<typeof services> & {
      operation?: { record: (event: { step: string }) => void }
    }
    journaled.operation = { record: event => {
      if (!/^[a-z0-9][a-z0-9._:-]{0,100}$/u.test(event.step)) {
        throw new Error('journal rejected an unsafe step name')
      }
      records.push(event.step)
    } }
    await expect(applyReleaseImpactPlan(
      plan(['taskFlow', 'directorBrain', 'videoCommand']), journaled,
    )).resolves.toMatchObject({ ok: true })
    expect(records).toEqual(expect.arrayContaining([
      'install-task-flow', 'install-director-brain', 'install-video-command',
    ]))
  })

  it('stages before pausing and delegates the app transition in canonical order', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['app']), services(events))).resolves.toMatchObject({
      ok: true, intake: { restored: true, reason: 'cas_restored', revision: 20 },
    })
    expect(events).toEqual([
      'source', 'components', 'status', 'intake:read', 'stage', 'intake:drain:18', 'intake:wait',
      'retire', 'bind', 'start', 'probe', 'switch', 'attest', 'intake:read',
      'intake:resume:19',
    ])
  })

  it('preflights before intake pause and runs one managed app transition when available', async () => {
    const events: string[] = []
    const managedServices = services(events)
    Object.assign(managedServices, {
      transitionPreflight: async () => { events.push('transition:preflight') },
      transition: async () => { events.push('transition:apply') },
      transitionIncludesAcceptance: true,
      routeReadback: async () => ({
        ...router, active: 'blue', previous: 'green', generation: router.generation + 1,
        slots: { ...router.slots, blue: `${sourceCommit}-runtime` },
      }),
    })
    await expect(applyReleaseImpactPlan(plan(['app']), managedServices)).resolves.toMatchObject({
      ok: true, intake: { restored: true },
    })
    expect(events).toEqual([
      'source', 'components', 'status', 'intake:read', 'stage', 'transition:preflight',
      'intake:drain:18', 'intake:wait', 'transition:apply', 'intake:read',
      'intake:resume:19',
    ])
    expect(events).not.toContain('retire')
    expect(events).not.toContain('bind')
    expect(events).not.toContain('attest')
  })

  it('restores only its exact paused revision after a failed operation', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['app']), services(events, { failAt: 'probe' })))
      .rejects.toThrow('failed:probe; recovery=official_rollbacks_verified; intake=cas_restored')
    expect(events.at(-1)).toBe('intake:resume:19')
  })

  it('uses router readback when the switch response is lost after commit', async () => {
    const events: string[] = []
    const uncertain = services(events, { failAt: 'switch' })
    Object.assign(uncertain, {
      routeReadback: async () => ({
        ...router, active: 'blue', previous: 'green', generation: router.generation + 1,
        slots: { ...router.slots, blue: `${sourceCommit}-runtime` },
      }),
    })
    await expect(applyReleaseImpactPlan(plan(['app']), uncertain)).resolves.toMatchObject({ ok: true })
    expect(events).toContain('switch')
    expect(events).toContain('attest')
    expect(events.some(event => event.startsWith('recover:'))).toBe(false)
  })

  it('honors cancellation before any deterministic preflight child starts', async () => {
    const events: string[] = []
    const controller = new AbortController()
    controller.abort(new Error('cancelled by operator'))
    const cancelled = services(events) as ReturnType<typeof services> & {
      operation?: { signal: AbortSignal }
    }
    cancelled.operation = { signal: controller.signal }
    await expect(applyReleaseImpactPlan(plan(['app']), cancelled)).rejects.toMatchObject({
      errorCode: 'operation_cancelled', effectState: 'before_step',
    })
    expect(events).toEqual([])
  })

  it('stops before the next side effect when the control journal cannot persist its start', async () => {
    const events: string[] = []
    const journaled = services(events) as ReturnType<typeof services> & {
      operation?: { record: (event: { step: string; status: string }) => void }
    }
    journaled.operation = { record: event => {
      if (event.step === 'install-director-brain' && event.status === 'started') {
        throw new Error('journal unavailable')
      }
    } }
    await expect(applyReleaseImpactPlan(plan(['directorBrain']), journaled))
      .rejects.toThrow('recovery=official_rollbacks_verified; intake=cas_restored')
    expect(events).not.toContain('install:directorBrain')
    expect(events).toContain('recover:none')
  })

  it('reads back an uncertain drain write and still restores its owned revision', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['app']), services(events, { uncertainDrain: true })))
      .resolves.toMatchObject({ intake: { restored: true, reason: 'cas_restored' } })
    expect(events).toContain('intake:resume:19')
  })

  it('binds pause and resume ownership to the release operation id', async () => {
    const events: string[] = []
    const owned = services(events)
    const reasons: string[] = []
    const mutate = owned.intake.mutate
    owned.intake.mutate = async (action: string, revision: number, reason?: string) => {
      reasons.push(reason || '')
      return mutate(action, revision, reason)
    }
    Object.assign(owned, { operation: { scope: { operationId: 'f'.repeat(64) } } })
    await expect(applyReleaseImpactPlan(plan(['app']), owned)).resolves.toMatchObject({ ok: true })
    expect(reasons).toHaveLength(2)
    expect(reasons.every(reason => reason.includes(`[operation:${'f'.repeat(64)}]`))).toBe(true)
  })

  it('continues an exact operation-owned paused revision without draining it again', async () => {
    const events: string[] = []
    const operationId = 'e'.repeat(64)
    const initialControl = {
      ...pausedIntake(19), reason: `准备受控增量发布，暂停接收新任务 [operation:${operationId}]`,
    }
    const resumed = services(events, { initialControl })
    Object.assign(resumed, { operation: { resume: true, scope: { operationId } } })
    await expect(applyReleaseImpactPlan(plan(['directorBrain']), resumed))
      .resolves.toMatchObject({ ok: true, intake: { restored: true, revision: 20 } })
    expect(events).not.toContain('intake:drain:18')
    expect(events).toContain('intake:resume:19')
  })

  it('refuses to overwrite a concurrent intake revision while reporting incomplete recovery', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['app']), services(events, {
      failAt: 'probe', revisionDrift: true,
    }))).rejects.toThrow('failed:probe; recovery=official_rollbacks_verified; intake=revision_changed')
    expect(events).not.toContain('intake:resume:20')
  })

  it('leaves a pre-existing pause unchanged', async () => {
    const before = pausedIntake(22)
    const mutate = vi.fn()
    await expect(restoreOwnedIntake({ before, paused: before, read: vi.fn(), mutate }))
      .resolves.toEqual({ restored: false, reason: 'not_owned' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('accepts an uncertain resume only after exact revision and reason readback', async () => {
    const reads = [pausedIntake(19), {
      ...activeIntake(20), reason: '受控发布已结束，恢复本次暂停的新任务入口',
    }]
    await expect(restoreOwnedIntake({
      before: activeIntake(18), paused: pausedIntake(19),
      read: vi.fn(async () => reads.shift()), mutate: vi.fn(async () => { throw new Error('lost') }),
    })).resolves.toEqual({
      restored: true, revision: 20, reason: 'cas_restored_after_readback',
    })
  })

  it('does not claim an intake that another operation already resumed', async () => {
    await expect(restoreOwnedIntake({
      before: activeIntake(18), paused: pausedIntake(19),
      read: vi.fn(async () => ({ ...activeIntake(20), reason: 'another operation' })),
      mutate: vi.fn(),
    })).resolves.toEqual({ restored: false, reason: 'revision_changed', revision: 20 })
  })

  it('routes deployment-control drift to its existing separate maintenance path', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['control']), services(events)))
      .rejects.toThrow('control change requires separate managed maintenance')
    expect(events).toEqual([])
  })

  it('rolls back a completed installer before restoring intake after convergence fails', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['directorBrain']), services(events, {
      failAt: 'converge',
    }))).rejects.toThrow('recovery=official_rollbacks_verified; intake=cas_restored')
    expect(events).toContain('recover:directorBrain')
    expect(events.indexOf('recover:directorBrain')).toBeLessThan(events.indexOf('intake:resume:19'))
  })

  it('preserves a child preflight no-mutation proof through structured errors', async () => {
    const events: string[] = []
    const preflight = services(events)
    preflight.install = async (name: string) => {
      events.push(`install:${name}`)
      const error = new Error('installer preflight rejected') as Error & { mutationNotStarted: boolean }
      error.mutationNotStarted = true
      throw error
    }
    await expect(applyReleaseImpactPlan(plan(['directorBrain']), preflight))
      .rejects.toThrow('recovery=official_rollbacks_verified; intake=cas_restored')
    expect(events).toContain('recover:none')
  })

  it('keeps intake paused when official component recovery cannot be verified', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['directorBrain']), services(events, {
      failAt: 'converge', recoveryOk: false,
    }))).rejects.toThrow('recovery=official_rollback_failed; intake=recovery_incomplete')
    expect(events).not.toContain('intake:resume:19')
    expect(events).not.toContain('worker:resume')
  })
  it('keeps intake paused when the owned video worker cannot be restored', async () => {
    const events: string[] = []
    await expect(applyReleaseImpactPlan(plan(['directorBrain']), services(events, {
      failAt: 'worker:resume',
    }))).rejects.toThrow('video_worker_restore_failed')
    expect(events).toContain('worker:pause')
    expect(events).not.toContain('intake:resume:19')
  })

  it('waits for asynchronous Gateway startup and rejects ambiguous listeners', async () => {
    let calls = 0
    const inspect = async () => ++calls < 3 ? [] : [321, 321]
    await expect(waitForGatewayListener(inspect, { sleep: async () => {}, attempts: 4 })).resolves.toBe(321)
    expect(calls).toBe(3)
    await expect(waitForGatewayListener(async () => [321, 322], { sleep: async () => {} }))
      .rejects.toThrow('Gateway listener identity is ambiguous')
  })

})


describe('local component evidence reuse', () => {
  it('seals a recognized old SDK as a required preinstall update even when component source did not change', () => {
    const components = releaseComponentSummary(new Map(), new Map()) as ComponentSummary
    const oldRoot = '/private/managed-node/lib/node_modules/openclaw'
    const sdkMigrations = [{ currentState: 'legacy-needed-update', before: {
      path: 'node_modules/openclaw', type: 'symlink', target: oldRoot,
      targetSha256: createHash('sha256').update(oldRoot).digest('hex'),
      sdk: { name: 'openclaw', version: '2026.9.2', packageSha256: 'a'.repeat(64) },
    }, expectedSdkRoot: '/private/runtime/2026.9.9/install/lib/node_modules/openclaw',
    expectedSdkIdentity: { root: '/private/runtime/2026.9.9/install/lib/node_modules/openclaw',
      name: 'openclaw', version: '2026.9.9', packageSha256: 'b'.repeat(64) } }]
    const inspect = vi.fn(({ component, allowSdkMigration }) => {
      expect(allowSdkMigration).toBe(true)
      return component === 'videoCommand'
        ? { matches: false, fingerprint: 'c'.repeat(64), reason: 'legacy-needed-update', sdkMigrations }
        : { matches: true, fingerprint: 'd'.repeat(64) }
    })
    const result = inspectReleasePayloadComponents(components, {}, inspect)
    expect(result.videoCommand).toMatchObject({ changed: true, installedFingerprint: 'c'.repeat(64), sdkMigrations })
    expect(result.videoCommand.before).not.toBe(result.videoCommand.after)
    expect(result.directorBrain.changed).toBe(false)
    expect(components.videoCommand.changed).toBe(false)
    for (const invalid of [[], [{ ...sdkMigrations[0], before: { ...sdkMigrations[0].before,
      sdk: { ...sdkMigrations[0].before.sdk, version: '2026.9.3' } } }]]) {
      expect(() => inspectReleasePayloadComponents(components, {}, () => ({ matches: false,
        fingerprint: 'c'.repeat(64), reason: 'legacy-needed-update', sdkMigrations: invalid })))
        .toThrow('component SDK migration evidence is invalid')
    }
  })

  it('reuses matching components independently and detects installed drift even with unchanged source', () => {
    const tree = new Map([['src/app/page.tsx', 'app']])
    const components = releaseComponentSummary(tree, tree) as ComponentSummary
    const inspect = vi.fn(({ component }) => ({ matches: component !== 'taskFlow', fingerprint: component === 'taskFlow' ? 'a'.repeat(64) : 'b'.repeat(64) }))
    const result = inspectReleasePayloadComponents(components, {}, inspect)
    expect(inspect.mock.calls.map(([value]) => value.component)).toEqual(['taskFlow', 'directorBrain', 'videoCommand'])
    expect(result.taskFlow.changed).toBe(true)
    expect(result.taskFlow.before).not.toBe(result.taskFlow.after)
    expect(result.directorBrain.changed).toBe(false)
    expect(result.videoCommand.changed).toBe(false)
    expect(result.videoCommand.installedFingerprint).toBe('b'.repeat(64))
    expect(components.taskFlow.changed).toBe(false)
  })
  it('does not convert unsafe inspection failures or missing evidence into reusable results', () => {
    const components = releaseComponentSummary(new Map(), new Map())
    expect(() => inspectReleasePayloadComponents(components, {}, () => { throw new Error('unsafe source') })).toThrow('unsafe source')
    expect(() => inspectReleasePayloadComponents(components, {}, () => ({ matches: true, fingerprint: "" }))).toThrow('inspection evidence is invalid')
  })
})


describe('shared runtime environment admission', () => {
  it('requires database identity before maintenance only when shared components change', () => {
    expect(() => requireSharedRuntimeDatabase({ taskFlow: { changed: true } }, {})).toThrow('before maintenance')
    expect(() => requireSharedRuntimeDatabase({ taskFlow: { changed: false } }, {})).not.toThrow()
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-database-')))
    try {
      const db = join(root, 'n8n.db')
      writeFileSync(db, 'fixture', { mode: 0o600 })
      const identity = inspectSharedRuntimeDatabase(db)
      expect(identity.path).toBe(db)
      expect(() => requireSharedRuntimeDatabase({ videoCommand: { changed: true } }, { n8nDatabase: identity })).not.toThrow()
      expect(() => inspectSharedRuntimeDatabase('')).toThrow('AIWORKER_BG_N8N_DB_PATH')
      chmodSync(db, 0o644)
      expect(() => inspectSharedRuntimeDatabase(db)).toThrow('unsafe')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
