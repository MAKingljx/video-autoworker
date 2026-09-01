import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDatabase = vi.fn()
const logAuditEvent = vi.fn()
const syncAgentsFromConfig = vi.fn()
const processWebhookRetries = vi.fn()
const syncClaudeSessions = vi.fn()
const syncSkillsFromDisk = vi.fn()
const syncLocalAgents = vi.fn()
const dispatchAssignedTasks = vi.fn()
const runAegisReviews = vi.fn()
const requeueStaleTasks = vi.fn()
const autoRouteInboxTasks = vi.fn()
const spawnRecurringTasks = vi.fn()
const drainN8nMediaCleanupDebts = vi.fn()
const drainDirectorEvidenceOutbox = vi.fn()
const pruneGatewaySessionsOlderThan = vi.fn()
const getAgentLiveStatuses = vi.fn()
const logger = { info: vi.fn(), warn: vi.fn() }
const eventBus = { broadcast: vi.fn() }
const acquireOrRenewSchedulerLeadership = vi.fn(() => ({
  isLeader: true,
  mode: 'lease',
  leaseExpiresAt: 1,
  revision: 1,
}))
const renewSchedulerLeadership = vi.fn(() => ({
  isLeader: true,
  mode: 'lease',
  leaseExpiresAt: 2,
  revision: 2,
}))
const relinquishSchedulerLeadership = vi.fn(() => true)
const getSchedulerRuntimeEligibility = vi.fn(() => ({
  eligible: true,
  mode: 'single-instance',
  reason: 'single_instance',
  activeSlot: null as 'blue' | 'green' | null,
  generation: null as number | null,
}))

vi.mock('@/lib/db', () => ({ getDatabase, logAuditEvent }))
vi.mock('@/lib/agent-sync', () => ({ syncAgentsFromConfig }))
vi.mock('@/lib/config', () => ({
  config: {
    dbPath: '/tmp/mission-control.db',
    tokensPath: '/tmp/tokens.json',
    retention: {
      activities: 7,
      auditLog: 30,
      notifications: 14,
      pipelineRuns: 3,
      tokenUsage: 0,
      gatewaySessions: 10,
    },
  },
  ensureDirExists: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({ logger }))
vi.mock('@/lib/webhooks', () => ({ processWebhookRetries }))
vi.mock('@/lib/claude-sessions', () => ({ syncClaudeSessions }))
vi.mock('@/lib/openclaw-session-source', () => ({ pruneGatewaySessionsOlderThan, getAgentLiveStatuses }))
vi.mock('@/lib/event-bus', () => ({ eventBus }))
vi.mock('@/lib/skill-sync', () => ({ syncSkillsFromDisk }))
vi.mock('@/lib/local-agent-sync', () => ({ syncLocalAgents }))
vi.mock('@/lib/task-dispatch', () => ({ dispatchAssignedTasks, runAegisReviews, requeueStaleTasks, autoRouteInboxTasks }))
vi.mock('@/lib/recurring-tasks', () => ({ spawnRecurringTasks }))
vi.mock('@/lib/n8n-media-cleanup', () => ({ drainN8nMediaCleanupDebts }))
vi.mock('@/lib/director-evidence-outbox', () => ({ drainDirectorEvidenceOutbox }))
vi.mock('@/lib/scheduler-leader', () => ({
  acquireOrRenewSchedulerLeadership,
  createSchedulerHolderId: () => '00000000000000000000000000000000',
  getSchedulerRuntimeEligibility,
  isMultiInstanceSchedulerRuntime: () => false,
  relinquishSchedulerLeadership,
  renewSchedulerLeadership,
}))

describe('scheduler gateway live-status boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-27T03:00:00.000Z'))
    vi.resetModules()
    vi.clearAllMocks()

    acquireOrRenewSchedulerLeadership.mockReset().mockReturnValue({
      isLeader: true,
      mode: 'lease',
      leaseExpiresAt: 1,
      revision: 1,
    })
    renewSchedulerLeadership.mockReset().mockReturnValue({
      isLeader: true,
      mode: 'lease',
      leaseExpiresAt: 2,
      revision: 2,
    })
    relinquishSchedulerLeadership.mockReset().mockReturnValue(true)
    getSchedulerRuntimeEligibility.mockReset().mockReturnValue({
      eligible: true,
      mode: 'single-instance',
      reason: 'single_instance',
      activeSlot: null,
      generation: null,
    })

    getAgentLiveStatuses.mockReturnValue(new Map([
      ['main', { status: 'active', lastActivity: Date.parse('2026-03-27T02:59:00.000Z'), channel: 'cli' }],
    ]))
    syncAgentsFromConfig.mockResolvedValue({ created: 0, updated: 0, synced: 1 })
    processWebhookRetries.mockResolvedValue({ ok: true, message: 'no retries' })
    syncClaudeSessions.mockResolvedValue({ ok: true, message: 'no claude changes' })
    syncSkillsFromDisk.mockResolvedValue({ ok: true, message: 'no skill changes' })
    syncLocalAgents.mockResolvedValue({ ok: true, message: 'no local changes' })
    autoRouteInboxTasks.mockResolvedValue({ ok: true, message: 'No routing work' })
    dispatchAssignedTasks.mockResolvedValue({ ok: true, message: 'No dispatch work' })
    runAegisReviews.mockResolvedValue({ ok: true, message: 'No reviews' })
    requeueStaleTasks.mockResolvedValue({ ok: true, message: 'No stale tasks' })
    spawnRecurringTasks.mockResolvedValue({ ok: true, message: 'No recurring tasks' })
    drainN8nMediaCleanupDebts.mockResolvedValue({ scanned: 1, cleaned: 1, pending: 0, rejected: 0 })
    drainDirectorEvidenceOutbox.mockResolvedValue({
      scanned: 0,
      delivered: 0,
      pending: 0,
      conflict: 0,
    })
    pruneGatewaySessionsOlderThan.mockReturnValue({ deleted: 0, filesTouched: 0 })

    getDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => {
        if (sql === 'SELECT value FROM settings WHERE key = ?') {
          return { get: vi.fn(() => undefined) }
        }
        if (sql === 'SELECT id, name, config FROM agents') {
          return { all: vi.fn(() => [{ id: 1, name: 'main', config: null }]) }
        }
        if (sql.includes("WHERE status != 'offline'")) {
          return { all: vi.fn(() => []) }
        }
        if (sql.startsWith('UPDATE agents SET status = ?')) {
          return { run: vi.fn(() => ({ changes: 1 })) }
        }
        throw new Error(`Unexpected SQL: ${sql}`)
      }),
      transaction: (fn: () => void) => fn,
      backup: vi.fn(),
    })
  })

  it('manual gateway_agent_sync also refreshes live status through openclaw session source boundary', async () => {
    const { triggerTask } = await import('@/lib/scheduler')

    const result = await triggerTask('gateway_agent_sync')

    expect(syncAgentsFromConfig).toHaveBeenCalledWith('manual')
    expect(getAgentLiveStatuses).toHaveBeenCalled()
    expect(eventBus.broadcast).toHaveBeenCalledWith('agent.status_changed', expect.objectContaining({
      id: 1,
      name: 'main',
      status: 'active',
    }))
    expect(result).toEqual({
      ok: true,
      message: 'Gateway sync: 0 created, 0 updated, 1 total | Live status: 1 refreshed',
    })
  })

  it('runs the durable media cleanup debt janitor independently of retention cleanup', async () => {
    const { triggerTask } = await import('@/lib/scheduler')

    const result = await triggerTask('media_cleanup_debt')

    expect(drainN8nMediaCleanupDebts).toHaveBeenCalledWith(
      expect.anything(), { limit: 20 },
    )
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'n8n_media_cleanup_debt_retry',
      actor: 'scheduler',
    }))
    expect(result).toEqual({
      ok: true,
      message: 'Media cleanup debts: 1 cleared, 0 pending, 0 rejected',
    })
  })

  it('keeps a follower passive and begins scheduled work after lease takeover', async () => {
    acquireOrRenewSchedulerLeadership
      .mockReturnValueOnce({ isLeader: false, mode: 'lease', leaseExpiresAt: 1, revision: 1 })
      .mockReturnValue({ isLeader: true, mode: 'lease', leaseExpiresAt: 2, revision: 2 })
    const { getSchedulerLeadershipStatus, initScheduler, stopScheduler } = await import('@/lib/scheduler')

    initScheduler()
    expect(syncAgentsFromConfig).not.toHaveBeenCalled()
    expect(getSchedulerLeadershipStatus()).toMatchObject({
      state: 'follower',
      leaseExpiresAt: 1,
      leaseExpired: true,
      activeJobs: 0,
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(processWebhookRetries).toHaveBeenCalledTimes(1)
    expect(syncAgentsFromConfig).toHaveBeenCalledWith('scheduled')
    expect(getSchedulerLeadershipStatus()).toMatchObject({ state: 'leader' })
    stopScheduler()
  })

  it('does not let an inactive router slot compete for the lease', async () => {
    getSchedulerRuntimeEligibility.mockReturnValue({
      eligible: false,
      mode: 'blue-green',
      reason: 'slot_inactive',
      activeSlot: 'blue',
      generation: 4,
    })
    const { getSchedulerLeadershipStatus, initScheduler, stopScheduler } = await import('@/lib/scheduler')

    initScheduler()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(acquireOrRenewSchedulerLeadership).not.toHaveBeenCalled()
    expect(renewSchedulerLeadership).not.toHaveBeenCalled()
    expect(syncAgentsFromConfig).not.toHaveBeenCalled()
    expect(getSchedulerLeadershipStatus()).toMatchObject({
      state: 'inactive',
      reason: 'slot_inactive',
      routerGeneration: 4,
    })
    stopScheduler()
  })

  it('keeps other scheduler paths moving while director evidence projection is pending', async () => {
    let finishProjection: ((value: {
      scanned: number
      delivered: number
      pending: number
      conflict: number
    }) => void) | undefined
    drainDirectorEvidenceOutbox.mockImplementationOnce(() => new Promise(resolve => {
      finishProjection = resolve
    }))
    const {
      getSchedulerLeadershipStatus,
      getSchedulerStatus,
      initScheduler,
      stopScheduler,
    } = await import('@/lib/scheduler')

    initScheduler()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(drainDirectorEvidenceOutbox).toHaveBeenCalledTimes(1)
    expect(processWebhookRetries).toHaveBeenCalledTimes(1)
    expect(autoRouteInboxTasks).toHaveBeenCalledTimes(1)
    expect(dispatchAssignedTasks).toHaveBeenCalledTimes(1)
    expect(getSchedulerLeadershipStatus()).toMatchObject({ activeJobs: 1 })
    expect(getSchedulerStatus().find(task => task.id === 'director_evidence_outbox'))
      .toMatchObject({ running: true, lastRun: null })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(drainDirectorEvidenceOutbox).toHaveBeenCalledTimes(1)
    expect(processWebhookRetries).toHaveBeenCalledTimes(2)
    expect(autoRouteInboxTasks).toHaveBeenCalledTimes(2)
    expect(dispatchAssignedTasks).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect(drainDirectorEvidenceOutbox).toHaveBeenCalledTimes(1)
    expect(processWebhookRetries).toHaveBeenCalledTimes(5)
    expect(autoRouteInboxTasks).toHaveBeenCalledTimes(5)
    expect(dispatchAssignedTasks).toHaveBeenCalledTimes(5)
    expect(getSchedulerStatus().find(task => task.id === 'agent_heartbeat'))
      .toMatchObject({
        running: false,
        lastResult: expect.objectContaining({ ok: true, message: 'All agents healthy' }),
      })

    finishProjection?.({ scanned: 1, delivered: 1, pending: 0, conflict: 0 })
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    expect(getSchedulerLeadershipStatus()).toMatchObject({ activeJobs: 0 })
    expect(getSchedulerStatus().find(task => task.id === 'director_evidence_outbox'))
      .toMatchObject({
        running: false,
        lastResult: expect.objectContaining({
          ok: true,
          message: 'Director evidence: 1 delivered, 0 pending, 0 conflict',
        }),
      })
    stopScheduler()
  })

  it('renews through an in-flight job, prevents same-job re-entry, then releases after router handoff', async () => {
    let finishRetry: ((value: { ok: boolean; message: string }) => void) | undefined
    processWebhookRetries.mockImplementationOnce(() => new Promise(resolve => {
      finishRetry = resolve
    }))
    const { getSchedulerLeadershipStatus, initScheduler, stopScheduler, triggerTask } = await import('@/lib/scheduler')
    initScheduler()
    await Promise.resolve()

    const running = triggerTask('webhook_retry')
    await Promise.resolve()
    await expect(triggerTask('webhook_retry')).resolves.toEqual({
      ok: false,
      message: 'Scheduler task already running: webhook_retry',
    })

    getSchedulerRuntimeEligibility.mockReturnValue({
      eligible: false,
      mode: 'blue-green',
      reason: 'slot_inactive',
      activeSlot: 'green',
      generation: 2,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(renewSchedulerLeadership).toHaveBeenCalled()
    expect(relinquishSchedulerLeadership).not.toHaveBeenCalled()
    expect(getSchedulerLeadershipStatus()).toMatchObject({
      state: 'leader',
      reason: 'draining_running_jobs',
      activeJobs: 1,
    })
    await expect(triggerTask('task_dispatch')).resolves.toEqual({
      ok: false,
      message: 'Built-in scheduler is passive on this application instance',
    })
    expect(dispatchAssignedTasks).not.toHaveBeenCalled()

    // The first periodic tick also observes the inactive slot. It may renew
    // the draining lease, but must not start webhook retries or later jobs.
    await vi.advanceTimersByTimeAsync(55_000)
    expect(processWebhookRetries).toHaveBeenCalledTimes(1)
    expect(dispatchAssignedTasks).not.toHaveBeenCalled()

    finishRetry?.({ ok: true, message: 'retry completed' })
    await expect(running).resolves.toEqual({ ok: true, message: 'retry completed' })
    expect(relinquishSchedulerLeadership).toHaveBeenCalledTimes(1)
    expect(getSchedulerLeadershipStatus()).toMatchObject({
      state: 'inactive',
      reason: 'slot_inactive',
      activeJobs: 0,
    })
    stopScheduler()
  })
})
