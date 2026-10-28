// @vitest-environment node
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), database: vi.fn(), audit: vi.fn(), inspect: vi.fn(), intent: vi.fn(), request: vi.fn(), advance: vi.fn(), ack: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.database, logAuditEvent: mocks.audit }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.auth }))
vi.mock('@/lib/n8n-video-stop', () => ({ inspectScopedSingleVideoStop: mocks.inspect, requestScopedSingleVideoStop: mocks.request,
  advanceScopedVideoStop: mocks.advance, readScopedVideoStopIntent: mocks.intent, acknowledgeScopedVideoBatchStop: mocks.ack }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
import { GET, POST } from '@/app/api/n8n/runs/stop/route'
import { POST as ACK } from '@/app/api/n8n/runs/stop/batch-ack/route'
const taskId = 'video-stop-original'
const revision = 'a'.repeat(64)
const user = { id: 9, username: 'operator', tenant_id: 3, workspace_id: 2 }
function request(body: unknown) {
  return new NextRequest('http://localhost/api/n8n/runs/stop', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockReturnValue({ user })
  mocks.database.mockReturnValue({ fixture: true })
  mocks.inspect.mockReturnValue({ taskId, status: 'running', eligible: true, expectedRevision: revision, stop: null })
  mocks.intent.mockReturnValue({ taskId, bindingId: 9, stop: null })
  mocks.request.mockReturnValue({ outcome: 'requested', status: 'running',
    stop: { taskId, requestId: 'b'.repeat(64), currentState: 'requested' } })
  mocks.advance.mockImplementation(() => mocks.request.mock.results.at(-1)?.value)
  mocks.ack.mockReturnValue({ stop: { taskId, requestId: 'b'.repeat(64), targetKind: 'batch_item',
    bindingId: 9, targetSha256: revision, currentState: 'stopped' } })
})
describe('scoped video stop route', () => {
  it('requires viewer access for read-only inspection and operator access for intent', async () => {
    expect((await GET(new NextRequest(`http://localhost/api/n8n/runs/stop?taskId=${taskId}`))).status).toBe(200)
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), 'viewer')
    expect(mocks.inspect).toHaveBeenCalledWith({ fixture: true }, taskId, { tenantId: 3, workspaceId: 2 })
    expect(mocks.request).not.toHaveBeenCalled()
    const response = await POST(request({ taskId, expectedRevision: revision, confirm: true }))
    expect(response.status).toBe(202)
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), 'operator')
    expect(mocks.request).toHaveBeenCalledWith({ fixture: true }, { taskId, expectedRevision: revision, confirm: true },
      { tenantId: 3, workspaceId: 2 }, user.id)
    expect(await response.json()).toMatchObject({ status: 'running', stop: { currentState: 'requested' } })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('rejects unauthorized mutations before opening the database', async () => {
    mocks.auth.mockReturnValue({ error: 'Forbidden', status: 403 })
    expect((await POST(request({ taskId, expectedRevision: revision, confirm: true }))).status).toBe(403)
    expect(mocks.database).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each([{ taskId, expectedRevision: revision, confirm: false },
    { taskId, expectedRevision: revision, confirm: true, pid: 123 },
    { taskId, expectedRevision: revision, confirm: true, proof: { stopped: true } },
    { taskId: '../unsafe', expectedRevision: revision, confirm: true }])('rejects unconfirmed or self-attested execution input', async body => {
    expect((await POST(request(body))).status).toBe(400)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.database).not.toHaveBeenCalled()
  })

  it('reports an already-terminal task without claiming it killed a process', async () => {
    mocks.request.mockReturnValue({ outcome: 'already_terminal', stop: null, status: 'succeeded' })
    const response = await POST(request({ taskId, expectedRevision: revision, confirm: true }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ outcome: 'already_terminal', status: 'succeeded', stop: null })
  })

  it('keeps a committed request idempotent when audit delivery fails', async () => {
    mocks.audit.mockImplementation(() => { throw new Error('audit unavailable') })
    expect((await POST(request({ taskId, expectedRevision: revision, confirm: true }))).status).toBe(202)
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('returns a scoped not-found result without exposing operational details', async () => {
    mocks.request.mockImplementation(() => { throw new Error('stop_task_not_found') })
    const response = await POST(request({ taskId, expectedRevision: revision, confirm: true }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'stop_task_not_found' })
  })

  it('returns the scoped batch stop intent without inventing a parent or a stopped acknowledgement', async () => {
    mocks.request.mockReturnValue({ outcome: 'requested', status: 'staging', stop: {
      taskId, requestId: 'b'.repeat(64), targetKind: 'batch_item', bindingId: 9,
      targetSha256: revision, currentState: 'requested',
    } })
    const response = await POST(request({ taskId, expectedRevision: revision, confirm: true }))
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ status: 'staging', stop: { targetKind: 'batch_item', currentState: 'requested' } })
  })

  it('uses the bounded intent view without scanning a batch or reading model output', async () => {
    const response = await GET(new NextRequest(`http://localhost/api/n8n/runs/stop?taskId=${taskId}&view=request&bindingId=9`))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ inspection: { taskId, bindingId: 9, stop: null } })
    expect(mocks.intent).toHaveBeenCalledWith({ fixture: true }, taskId, 9, { tenantId: 3, workspaceId: 2 })
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it('accepts only the original worker lock transport for a batch acknowledgement', async () => {
    const body = { taskId, requestId: 'b'.repeat(64), workerLease: { pid: 123,
      token: '12345678-1234-4234-8234-123456789abc' } }
    const response = await ACK(request(body))
    expect(response.status).toBe(200)
    expect(mocks.ack).toHaveBeenCalledWith({ fixture: true }, body, { tenantId: 3, workspaceId: 2 })
    expect(await response.json()).toMatchObject({ taskId, stop: { targetKind: 'batch_item', currentState: 'stopped' } })
    mocks.ack.mockClear()
    expect((await ACK(request({ ...body, receipt: { quiescent: true }, path: '/unsafe' }))).status).toBe(400)
    expect(mocks.ack).not.toHaveBeenCalled()
  })
})
