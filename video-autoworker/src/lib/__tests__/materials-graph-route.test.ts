import { NextRequest, NextResponse } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), get: vi.fn() }))
vi.mock('@/app/api/materials/route', () => ({ authorizeMaterialsRequest: mocks.authorize }))
vi.mock('@/lib/openclaw-materials', () => ({ getMaterialsGraph: mocks.get }))
import { GET } from '@/app/api/materials/graph/route'

afterEach(() => vi.resetAllMocks())
describe('GET materials graph', () => {
  it('uses existing viewer authorization before reading any data', async () => {
    mocks.authorize.mockReturnValue({ response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const response = await GET(new NextRequest('http://localhost/api/materials/graph'))
    expect(response.status).toBe(401)
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it('passes only exact project scope and returns an uncached projection', async () => {
    mocks.authorize.mockReturnValue({ actor: 'viewer' })
    mocks.get.mockResolvedValue({ schemaVersion: 1, materials: [], stats: {} })
    const response = await GET(new NextRequest('http://localhost/api/materials/graph?project=%E9%9B%AA%E5%B1%B1'))
    expect(mocks.get).toHaveBeenCalledWith({ project: '雪山' })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), 'viewer')
  })
  it('rejects path traversal and does not expose backend diagnostics', async () => {
    mocks.authorize.mockReturnValue({ actor: 'viewer' })
    expect((await GET(new NextRequest('http://localhost/api/materials/graph?project=..%2Fsecret'))).status).toBe(400)
    expect(mocks.get).not.toHaveBeenCalled()
    mocks.get.mockRejectedValue(new Error('secret_token=do-not-return /private/workspace'))
    const response = await GET(new NextRequest('http://localhost/api/materials/graph'))
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ code: 'MATERIALS_GRAPH_FAILED', error: '无法读取素材关系图谱' })
  })
})
