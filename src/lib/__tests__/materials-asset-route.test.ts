import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMaterialsBotLearningRoot: vi.fn<() => string>(),
}))

vi.mock('@/lib/openclaw-materials', () => ({
  getMaterialsBotLearningRoot: mocks.getMaterialsBotLearningRoot,
  getMaterialsOverview: vi.fn(),
}))

import { GET } from '@/app/api/materials/asset/route'

let root: string
let outside: string

function requestFor(filePath: string, range?: string): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/materials/asset?path=${encodeURIComponent(filePath)}`, {
    headers: range ? { range } : undefined,
  })
}

beforeEach(async () => {
  vi.stubEnv('MC_DESKTOP_MODE', 'true')
  root = await mkdtemp(path.join(os.tmpdir(), 'materials-asset-root-'))
  outside = await mkdtemp(path.join(os.tmpdir(), 'materials-asset-outside-'))
  mocks.getMaterialsBotLearningRoot.mockReturnValue(root)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

describe('GET /api/materials/asset', () => {
  it('returns the complete file with the existing response contract', async () => {
    const target = path.join(root, 'clip.mp4')
    await writeFile(target, '0123456789')

    const response = await GET(requestFor(target))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toBe('0123456789')
  })

  it('preserves partial and invalid range responses', async () => {
    const target = path.join(root, 'clip.mp4')
    await writeFile(target, '0123456789')

    const partial = await GET(requestFor(target, 'bytes=2-5'))
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(partial.headers.get('content-length')).toBe('4')
    await expect(partial.text()).resolves.toBe('2345')

    const invalid = await GET(requestFor(target, 'bytes=20-30'))
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */10')
  })

  it('rejects a symlink instead of serving a file outside the material root', async () => {
    const outsideFile = path.join(outside, 'secret.mp4')
    const link = path.join(root, 'linked.mp4')
    await writeFile(outsideFile, 'secret')
    await symlink(outsideFile, link)

    const response = await GET(requestFor(link))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: '素材路径不在允许范围内' })
  })

  it('rejects an outside directory reached through a symlink', async () => {
    const outsideDirectory = path.join(outside, 'videos')
    await mkdir(outsideDirectory)
    await writeFile(path.join(outsideDirectory, 'secret.mp4'), 'secret')
    await symlink(outsideDirectory, path.join(root, 'linked-directory'))

    const response = await GET(requestFor(path.join(root, 'linked-directory', 'secret.mp4')))

    expect(response.status).toBe(403)
  })
})
