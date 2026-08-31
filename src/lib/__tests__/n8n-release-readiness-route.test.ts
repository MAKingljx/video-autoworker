import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireGlobalReleaseManager: vi.fn(),
  getDatabase: vi.fn(),
  getIntakeControl: vi.fn(),
  resolveRuntimeIdentity: vi.fn(),
  getDrainStatus: vi.fn(),
  getRollingDatabaseCompatibility: vi.fn(),
  getSchedulerLeadershipStatus: vi.fn(),
}))

vi.mock('@/lib/n8n-global-release-auth', () => ({
  requireN8nGlobalReleaseManager: mocks.requireGlobalReleaseManager,
}))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n-intake-control', () => ({ getN8nIntakeControl: mocks.getIntakeControl }))
vi.mock('@/lib/n8n-runtime-affinity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-runtime-affinity')>()
  return {
    ...actual,
    resolveN8nRuntimeIdentity: mocks.resolveRuntimeIdentity,
    getN8nRuntimeDrainStatus: mocks.getDrainStatus,
    getN8nRollingDatabaseCompatibility: mocks.getRollingDatabaseCompatibility,
  }
})
vi.mock('@/lib/scheduler', () => ({
  getSchedulerLeadershipStatus: mocks.getSchedulerLeadershipStatus,
}))

import { GET } from '@/app/api/n8n/release-readiness/route'

const runtime = {
  callbackProtocol: 'slot-v1',
  runtimeSlot: 'green',
  runtimeReleaseId: 'release-b',
  port: 3417,
  startedAt: 800,
}
const control = {
  schema: 'video-autoworker-intake-control/v1',
  globalScope: true,
  mode: 'draining',
  accepting: false,
  revision: 3,
  counts: { active: 4, queued: 1, accepted: 2, running: 1, waiting: 3 },
}
const retirement = {
  schema: 'video-autoworker-runtime-drain/v1',
  globalScope: true,
  runtime,
  counts: {
    tracked: 4,
    active: 4,
    queued: 1,
    accepted: 2,
    running: 1,
    topLevel: 1,
    mediaNodes: 3,
    modelNodes: 0,
    childExecutionLeases: 0,
    untrackedCallbacks: 0,
    otherReleaseActive: 0,
  },
  lastActivityAt: 990,
  quietSince: 990,
  quietSeconds: 10,
  requiredQuietSeconds: 120,
  safeToRetire: false,
  observedAt: 1_000,
}
const scheduler = {
  state: 'leader',
  leaseExpiresAt: 1_030,
  leaseExpired: false,
  observedAt: 1_000,
  reason: 'slot_active',
  routerGeneration: 4,
  activeJobs: 1,
}

function request() {
  return new NextRequest('http://127.0.0.1:3417/api/n8n/release-readiness')
}

describe('n8n release readiness route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const now = Math.floor(Date.now() / 1_000)
    scheduler.observedAt = now
    scheduler.leaseExpiresAt = now + 30
    mocks.requireGlobalReleaseManager.mockReturnValue({ user: { id: 1, role: 'admin' } })
    mocks.getDatabase.mockReturnValue({})
    mocks.getIntakeControl.mockReturnValue(control)
    mocks.resolveRuntimeIdentity.mockReturnValue(runtime)
    mocks.getDrainStatus.mockReturnValue(retirement)
    mocks.getRollingDatabaseCompatibility.mockReturnValue({
      schemaEpoch: 1,
      rollingSafeFrom: '052_n8n_intake_controls',
      latestMigration: '056_n8n_parent_execution_claims',
    })
    mocks.getSchedulerLeadershipStatus.mockReturnValue(scheduler)
  })

  it('returns machine-readable readiness while active work drains', async () => {
    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.requireGlobalReleaseManager).toHaveBeenCalledWith(expect.any(NextRequest))
    expect(mocks.getIntakeControl).toHaveBeenCalledWith({})
    expect(mocks.getRollingDatabaseCompatibility).toHaveBeenCalledWith({})
    expect(mocks.getDrainStatus).toHaveBeenCalledWith({}, runtime)
    expect(await response.json()).toEqual({
      readiness: {
        schema: 'video-autoworker-release-readiness/v1',
        globalScope: true,
        observedAt: expect.any(Number),
        intake: {
          schema: 'video-autoworker-intake-control/v1',
          accepting: false,
          mode: 'draining',
          revision: 3,
          counts: control.counts,
        },
        runtime,
        database: {
          schemaEpoch: 1,
          rollingSafeFrom: '052_n8n_intake_controls',
          latestMigration: '056_n8n_parent_execution_claims',
        },
        retirement,
        scheduler,
      },
    })
  })

  it('fails closed while the global intake gate is accepting', async () => {
    mocks.getIntakeControl.mockReturnValue({ ...control, mode: 'active', accepting: true })
    const response = await GET(request())

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'RELEASE_INTAKE_ACTIVE' })
    expect(mocks.getDrainStatus).not.toHaveBeenCalled()
    expect(mocks.getSchedulerLeadershipStatus).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'unavailable'] as const)(
    'fails closed while scheduler leadership is %s',
    async (state) => {
      mocks.getSchedulerLeadershipStatus.mockReturnValue({
        ...scheduler,
        state,
        leaseExpiresAt: null,
        leaseExpired: false,
        reason: `fixture_${state}`,
      })

      const response = await GET(request())

      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'RELEASE_READINESS_UNAVAILABLE' })
    },
  )

  it('fails closed when the live SQLite rolling schema cannot be attested', async () => {
    mocks.getRollingDatabaseCompatibility.mockImplementation(() => {
      throw new Error('missing rolling index')
    })

    const response = await GET(request())

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'RELEASE_READINESS_UNAVAILABLE' })
    expect(mocks.getIntakeControl).not.toHaveBeenCalled()
    expect(mocks.getSchedulerLeadershipStatus).not.toHaveBeenCalled()
  })

  it('rejects legacy or malformed runtime ownership', async () => {
    mocks.resolveRuntimeIdentity.mockReturnValueOnce(null)
    const legacy = await GET(request())
    expect(legacy.status).toBe(409)
    expect(await legacy.json()).toMatchObject({ code: 'RELEASE_RUNTIME_UNATTRIBUTABLE' })

    mocks.resolveRuntimeIdentity.mockImplementationOnce(() => { throw new Error('invalid release') })
    const invalid = await GET(request())
    expect(invalid.status).toBe(503)
    expect(await invalid.json()).toMatchObject({ code: 'RELEASE_RUNTIME_INVALID' })
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('does not expose process-wide counts to a non-admin request', async () => {
    mocks.requireGlobalReleaseManager.mockReturnValue({ error: 'Forbidden', status: 403 })
    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(mocks.resolveRuntimeIdentity).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.getIntakeControl).not.toHaveBeenCalled()
  })
})
