import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { createN8nWorkflowBinding, getN8nWorkflowBinding, n8nWorkflowBindingInputSchema } from '@/lib/n8n-workflows'
import { isOpenClawN8nOperatorRequest } from '@/lib/openclaw-loopback-auth'

const mocks = vi.hoisted(() => ({ db: null as Database.Database | null, audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: () => mocks.db, logAuditEvent: mocks.audit }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
import { PUT } from '@/app/api/n8n/workflows/learning-window/route'

const scope = { tenantId: 1, workspaceId: 1 }
function request(value: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://127.0.0.1:3518/api/n8n/workflows/learning-window', { method: 'PUT', headers, body: JSON.stringify(value) })
}

describe('controlled learning window save', () => {
  const originalMode = process.env.MC_AUTH_MODE
  let id: number
  beforeEach(() => {
    process.env.MC_AUTH_MODE = 'openclaw-loopback'
    mocks.audit.mockReset()
    mocks.db = new Database(':memory:')
    runMigrations(mocks.db)
    id = createN8nWorkflowBinding(mocks.db, n8nWorkflowBindingInputSchema.parse({
      name: '学习', webhookPath: 'webhook/video', taskType: 'video-analysis', config: {
        media: { segmentSeconds: 5, language: 'en' }, modelRouting: { allowTaskOverride: false },
      },
    }), 'test', scope).id
  })
  afterEach(() => {
    mocks.db?.close()
    if (originalMode === undefined) delete process.env.MC_AUTH_MODE
    else process.env.MC_AUTH_MODE = originalMode
  })

  it('saves only the window and reads it back without touching other configuration', async () => {
    const response = await PUT(request({ bindingId: id, segmentSeconds: 3, expectedSegmentSeconds: 5 }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ changed: true, binding: { config: { media: { segmentSeconds: 3, language: 'en' }, modelRouting: { allowTaskOverride: false } } } })
    expect(getN8nWorkflowBinding(mocks.db!, id, scope)?.config.media).toMatchObject({ segmentSeconds: 3 })
    expect(mocks.audit).toHaveBeenCalledOnce()
  })

  it('leaves the database and audit unchanged when saving the current five seconds', async () => {
    const before = mocks.db!.prepare('SELECT total_changes() AS n').get()
    const response = await PUT(request({ bindingId: id, segmentSeconds: 5, expectedSegmentSeconds: 5 }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ changed: false })
    expect(mocks.db!.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('rejects a stale window and out-of-scope bindings', async () => {
    expect((await PUT(request({ bindingId: id, segmentSeconds: 3, expectedSegmentSeconds: 10 }))).status).toBe(409)
    expect((await PUT(request({ bindingId: id + 10, segmentSeconds: 3, expectedSegmentSeconds: 5 }))).status).toBe(404)
    expect(getN8nWorkflowBinding(mocks.db!, id, scope)?.config.media).toMatchObject({ segmentSeconds: 5 })
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it.each([0, 3.5, 301, null, true])('rejects invalid window %s', async value => {
    expect((await PUT(request({ bindingId: id, segmentSeconds: value, expectedSegmentSeconds: 5 }))).status).toBe(400)
  })

  it('rejects remote forwarding and extra fields without granting broad workflow CRUD', async () => {
    const denied = await PUT(request({ bindingId: id, segmentSeconds: 3, expectedSegmentSeconds: 5 }, { 'x-forwarded-for': '203.0.113.1' }))
    expect([401, 403]).toContain(denied.status)
    expect((await PUT(request({ bindingId: id, segmentSeconds: 3, expectedSegmentSeconds: 5, model: 'other' }))).status).toBe(400)
    expect(isOpenClawN8nOperatorRequest(new Request('http://127.0.0.1/api/n8n/workflows', { method: 'PUT' }))).toBe(false)
    expect(isOpenClawN8nOperatorRequest(new Request('http://127.0.0.1/api/n8n/workflows/learning-window', { method: 'POST' }))).toBe(false)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
