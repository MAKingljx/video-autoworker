import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { config } from '@/lib/config'

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { role: 'admin', workspace_id: 1 } })),
}))

vi.mock('@/lib/config', () => ({
  config: { openclawConfigPath: '' },
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/lib/security-scan', () => ({
  FIX_SAFETY: {
    rate_limiting: 'safe',
  },
  runSecurityScan: vi.fn(() => ({
    categories: {
      runtime: {
        checks: [
          {
            id: 'rate_limiting',
            status: 'fail',
          },
        ],
      },
    },
  })),
}))

describe('security-scan fix route env mutation', () => {
  const originalCwd = process.cwd()
  const originalEnv = { ...process.env }
  let tempDir = ''
  let platformEnvPath = ''

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-security-fix-'))
    process.chdir(tempDir)
    process.env = { ...originalEnv }
    platformEnvPath = path.join(tempDir, 'platform.env')
    writeFileSync(platformEnvPath, 'MC_DISABLE_RATE_LIMIT=1\n', { encoding: 'utf8', mode: 0o600 })
    process.env.AIWORKER_PLATFORM_ENV_FILE = platformEnvPath
    process.env.AIWORKER_STANDALONE_ROOT = path.join(tempDir, 'standalone')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('preserves runtime env overrides in test mode while updating env files', async () => {
    process.env.MISSION_CONTROL_TEST_MODE = '1'
    process.env.MC_DISABLE_RATE_LIMIT = '1'

    const { POST } = await import('@/app/api/security-scan/fix/route')
    const request = new NextRequest('http://localhost/api/security-scan/fix', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(process.env.MC_DISABLE_RATE_LIMIT).toBe('1')
    expect(readFileSync(platformEnvPath, 'utf-8')).toContain('MC_DISABLE_RATE_LIMIT=\n')
    expect(statSync(platformEnvPath).mode & 0o777).toBe(0o600)
    expect(existsSync(path.join(process.env.AIWORKER_STANDALONE_ROOT!, '.env'))).toBe(false)
  })

  it('mutates runtime env outside test mode so fixes apply immediately', async () => {
    delete process.env.MISSION_CONTROL_TEST_MODE
    process.env.MC_DISABLE_RATE_LIMIT = '1'

    const { POST } = await import('@/app/api/security-scan/fix/route')
    const request = new NextRequest('http://localhost/api/security-scan/fix', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(process.env.MC_DISABLE_RATE_LIMIT).toBeUndefined()
  })

  it('fails closed without an explicit platform environment file', async () => {
    delete process.env.AIWORKER_PLATFORM_ENV_FILE
    process.env.MC_DISABLE_RATE_LIMIT = '1'

    const { POST } = await import('@/app/api/security-scan/fix/route')
    const request = new NextRequest('http://localhost/api/security-scan/fix', {
      method: 'POST',
      body: JSON.stringify({ ids: ['rate_limiting'] }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rate_limiting', fixed: false }),
    ]))
    expect(existsSync(path.join(tempDir, '.env'))).toBe(false)
  })

  it('rejects a platform environment file inside the immutable standalone root', async () => {
    const standaloneRoot = process.env.AIWORKER_STANDALONE_ROOT!
    mkdirSync(standaloneRoot)
    const unsafePath = path.join(standaloneRoot, '.env')
    process.env.AIWORKER_PLATFORM_ENV_FILE = unsafePath
    process.env.MC_DISABLE_RATE_LIMIT = '1'

    const { POST } = await import('@/app/api/security-scan/fix/route')
    const request = new NextRequest('http://localhost/api/security-scan/fix', {
      method: 'POST',
      body: JSON.stringify({ ids: ['rate_limiting'] }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rate_limiting', fixed: false }),
    ]))
    expect(existsSync(unsafePath)).toBe(false)
  })

  it('fails closed for gateway auth without generating an inline token', async () => {
    const configPath = path.join(tempDir, 'openclaw.json')
    const originalConfig = JSON.stringify({ gateway: { auth: {} } }, null, 2) + '\n'
    writeFileSync(configPath, originalConfig, 'utf-8')
    ;(config as { openclawConfigPath: string }).openclawConfigPath = configPath
    process.env.MISSION_CONTROL_TEST_MODE = '1'

    const { POST } = await import('@/app/api/security-scan/fix/route')
    const request = new NextRequest('http://localhost/api/security-scan/fix', {
      method: 'POST',
      body: JSON.stringify({ ids: ['gateway_auth'] }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gateway_auth', fixed: false }),
    ]))
    expect(readFileSync(configPath, 'utf-8')).toBe(originalConfig)
    expect(readFileSync(configPath, 'utf-8')).not.toMatch(/[a-f0-9]{64}/u)
    ;(config as { openclawConfigPath: string }).openclawConfigPath = ''
  })

  it('does not treat an existing inline gateway token as an OpenClaw SecretRef', async () => {
    const configPath = path.join(tempDir, 'openclaw-inline.json')
    const originalConfig = JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'a'.repeat(64) } },
    }, null, 2) + '\n'
    writeFileSync(configPath, originalConfig, 'utf-8')
    ;(config as { openclawConfigPath: string }).openclawConfigPath = configPath
    process.env.MISSION_CONTROL_TEST_MODE = '1'

    const { POST } = await import('@/app/api/security-scan/fix/route')
    const request = new NextRequest('http://localhost/api/security-scan/fix', {
      method: 'POST',
      body: JSON.stringify({ ids: ['gateway_auth'] }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gateway_auth', fixed: false }),
    ]))
    expect(readFileSync(configPath, 'utf-8')).toBe(originalConfig)
    ;(config as { openclawConfigPath: string }).openclawConfigPath = ''
  })
})
