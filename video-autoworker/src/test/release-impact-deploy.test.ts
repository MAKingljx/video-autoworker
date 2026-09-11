// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import {
  applyReleaseImpactPlan,
  buildReleaseImpactPlan,
  installedControlComponentState,
  isCommittedPlanRoute,
  isOriginalPlanRoute,
  parseBlueGreenStatus,
  releaseCommandEnvironment,
  releaseComponentSummary,
  recoveryTargetDisposition,
  restoreOwnedIntake,
  waitForGatewayListener,
} from '../../scripts/release-impact-deploy.mjs'

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

function plan(changed: ComponentName[]) {
  return buildPlan({
    baseCommit, sourceCommit, router, intake: activeIntake(), components: components(changed),
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
