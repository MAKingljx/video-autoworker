import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  getDatabase: vi.fn(),
  getN8nVideoResultDetail: vi.fn(),
  getN8nVideoSource: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    getN8nVideoResultDetail: mocks.getN8nVideoResultDetail,
  }
})
vi.mock('@/lib/n8n-video-sources', () => ({ getN8nVideoSource: mocks.getN8nVideoSource }))

import { GET, HEAD } from '@/app/api/n8n/video-library/asset/route'

const roots: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireN8nRole.mockReturnValue({ user: { workspace_id: 2, tenant_id: 3 } })
  mocks.getDatabase.mockReturnValue({})
  mocks.getN8nVideoResultDetail.mockReturnValue({ taskId: 'task-1', title: '视频.mp4' })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function videoSource(content = '0123456789') {
  const root = await mkdtemp(join(tmpdir(), 'n8n-video-asset-'))
  roots.push(root)
  const path = join(root, 'video.mp4')
  await writeFile(path, content)
  return {
    taskId: 'task-1',
    name: 'video.mp4',
    path,
    bytes: Buffer.byteLength(content),
    modifiedAt: Date.now(),
    extension: '.mp4',
  }
}

describe('n8n video library asset route', () => {
  it('requires viewer access before resolving any media', async () => {
    mocks.requireN8nRole.mockReturnValue({ error: '无权访问', status: 403 })
    const response = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/video-library/asset?taskId=task-1',
    ))

    expect(response.status).toBe(403)
    expect(mocks.requireN8nRole).toHaveBeenCalledWith(expect.any(NextRequest), 'viewer')
    expect(mocks.getN8nVideoResultDetail).not.toHaveBeenCalled()
    expect(mocks.getN8nVideoSource).not.toHaveBeenCalled()
  })

  it('checks the requested task inside the authenticated workspace before reading its source', async () => {
    mocks.getN8nVideoResultDetail.mockReturnValue(null)
    const response = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/video-library/asset?taskId=task-1',
    ))

    expect(response.status).toBe(404)
    expect(mocks.getN8nVideoResultDetail).toHaveBeenCalledWith(
      {}, 'task-1', { workspaceId: 2, tenantId: 3 },
    )
    expect(mocks.getN8nVideoSource).not.toHaveBeenCalled()
  })

  it('streams only the requested byte range and supports metadata-only HEAD requests', async () => {
    mocks.getN8nVideoSource.mockResolvedValue(await videoSource())
    const rangeResponse = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/video-library/asset?taskId=task-1',
      { headers: { range: 'bytes=2-5' } },
    ))

    expect(rangeResponse.status).toBe(206)
    expect(rangeResponse.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(rangeResponse.headers.get('content-length')).toBe('4')
    expect(rangeResponse.headers.get('content-type')).toBe('video/mp4')
    expect(rangeResponse.headers.get('cache-control')).toBe('private, no-store')
    expect(await rangeResponse.text()).toBe('2345')

    const headResponse = await HEAD(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/video-library/asset?taskId=task-1',
    ))
    expect(headResponse.status).toBe(200)
    expect(headResponse.headers.get('content-length')).toBe('10')
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0)
  })

  it('rejects invalid ranges and files that changed after indexing', async () => {
    const source = await videoSource()
    mocks.getN8nVideoSource.mockResolvedValue(source)
    const invalidRange = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/video-library/asset?taskId=task-1',
      { headers: { range: 'bytes=99-120' } },
    ))
    expect(invalidRange.status).toBe(416)
    expect(invalidRange.headers.get('content-range')).toBe('bytes */10')

    mocks.getN8nVideoSource.mockResolvedValue({ ...source, bytes: 99 })
    const changedSource = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/video-library/asset?taskId=task-1',
    ))
    expect(changedSource.status).toBe(409)
  })
})
