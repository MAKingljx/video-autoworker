import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/lib/config'
import { readSystemUptimeSeconds, runSecurityScan } from '@/lib/security-scan'

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ integrity_check: 'ok' })) })),
  })),
}))

describe('readSystemUptimeSeconds', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when uptime is unavailable', () => {
    vi.spyOn(os, 'uptime').mockImplementation(() => {
      throw new Error('EPERM')
    })

    expect(readSystemUptimeSeconds()).toBeNull()
  })

  it('returns uptime when available', () => {
    vi.spyOn(os, 'uptime').mockReturnValue(123)

    expect(readSystemUptimeSeconds()).toBe(123)
  })
})

describe('runSecurityScan gateway SecretRef handling', () => {
  it('accepts an object SecretRef without calling trim or string coercion', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-security-scan-'))
    const configPath = path.join(tempDir, 'openclaw.json')
    const previousConfigPath = config.openclawConfigPath
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        auth: {
          mode: 'token',
          token: { id: 'gateway-token', provider: 'keychain', source: 'exec' },
        },
        bind: 'loopback',
      },
      secrets: {
        providers: {
          keychain: { source: 'exec', command: '/usr/bin/security', args: ['find-generic-password'] },
        },
      },
    }), 'utf8')
    config.openclawConfigPath = configPath
    try {
      const report = runSecurityScan()
      expect(report.categories.openclaw.checks.find(check => check.id === 'gateway_auth')).toMatchObject({
        status: 'pass',
        detail: 'Token auth enabled',
      })
    } finally {
      config.openclawConfigPath = previousConfigPath
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
