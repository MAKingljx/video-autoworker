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
const pruneGatewaySessionsOlderThan = vi.fn()
const getAgentLiveStatuses = vi.fn()
const logger = { info: vi.fn(), warn: vi.fn() }
const eventBus = { broadcast: vi.fn() }

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

describe('scheduler gateway live-status boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-27T03:00:00.000Z'))
    vi.resetModules()
    vi.clearAllMocks()

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
    pruneGatewaySessionsOlderThan.mockReturnValue({ deleted: 0, filesTouched: 0 })

    getDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => {
        if (sql === 'SELECT value FROM settings WHERE key = ?') {
          return { get: vi.fn(() => undefined) }
        }
        if (sql === 'SELECT id, name, config FROM agents') {
          return { all: vi.fn(() => [{ id: 1, name: 'main', config: null }]) }
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
})
