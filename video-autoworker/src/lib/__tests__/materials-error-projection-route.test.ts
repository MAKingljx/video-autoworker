import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getMaterialsOverview: vi.fn(),
  searchMaterials: vi.fn(),
  indexMaterialVectors: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@/lib/openclaw-materials', () => ({
  getMaterialsOverview: mocks.getMaterialsOverview,
  searchMaterials: mocks.searchMaterials,
  indexMaterialVectors: mocks.indexMaterialVectors,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import { GET as getOverview } from '@/app/api/materials/route'
import { GET as search } from '@/app/api/materials/search/route'
import { POST as indexVectors } from '@/app/api/materials/vector-index/route'

const privateFailure = new Error(
  'ssh failed at /Users/operator/private/source.mp4 https://private.example token=secret',
)

describe('materials API error projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MC_DESKTOP_MODE = 'true'
  })

  it.each([
    [
      'overview',
      () => {
        mocks.getMaterialsOverview.mockRejectedValue(privateFailure)
        return getOverview(new NextRequest('http://127.0.0.1:3017/api/materials'))
      },
      'MATERIALS_OVERVIEW_FAILED',
      '无法读取素材库',
    ],
    [
      'search',
      () => {
        mocks.searchMaterials.mockRejectedValue(privateFailure)
        return search(new NextRequest('http://127.0.0.1:3017/api/materials/search?q=test'))
      },
      'MATERIALS_SEARCH_FAILED',
      '素材搜索失败',
    ],
    [
      'vector index',
      () => {
        mocks.indexMaterialVectors.mockRejectedValue(privateFailure)
        return indexVectors(new NextRequest('http://127.0.0.1:3017/api/materials/vector-index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }))
      },
      'MATERIALS_VECTOR_INDEX_FAILED',
      '向量索引失败',
    ],
  ])('hides command details from the %s response', async (_label, invoke, code, summary) => {
    const response = await invoke()
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toEqual({ code, error: summary })
    expect(JSON.stringify(body)).not.toContain('/Users/operator')
    expect(JSON.stringify(body)).not.toContain('private.example')
    expect(JSON.stringify(body)).not.toContain('token=secret')

    const logged = JSON.stringify(mocks.loggerError.mock.calls.at(-1))
    expect(logged).toContain(code)
    expect(logged).not.toContain('/Users/operator')
    expect(logged).not.toContain('private.example')
    expect(logged).not.toContain('token=secret')
  })
})
