import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    default: { ...actual, spawnSync: spawnSyncMock },
    spawnSync: spawnSyncMock,
  }
})

vi.mock('@/lib/config', () => ({
  config: { openclawConfigPath: '' },
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

describe('registerMcAsDashboard', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''
  let configPath = ''
  let providerCommand = ''

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-gateway-runtime-'))
    configPath = path.join(tempDir, 'openclaw.json')
    providerCommand = path.join(tempDir, 'fixture-secret-provider')
    writeFileSync(providerCommand, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    chmodSync(providerCommand, 0o700)
    process.env = { ...originalEnv }
    delete process.env.OPENCLAW_GATEWAY_TOKEN
    delete process.env.GATEWAY_TOKEN
    delete process.env.OPENCLAW_GATEWAY_PASSWORD
    delete process.env.GATEWAY_PASSWORD
    spawnSyncMock.mockReset()

    const { config } = await import('@/lib/config')
    config.openclawConfigPath = configPath
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('adds the Mission Control origin without disabling device auth', async () => {
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        controlUi: {
          allowedOrigins: ['https://existing.example.com'],
          dangerouslyDisableDeviceAuth: false,
        },
      },
    }, null, 2) + '\n', 'utf-8')

    const { registerMcAsDashboard } = await import('@/lib/gateway-runtime')
    const result = registerMcAsDashboard('https://mc.example.com/dashboard')

    expect(result).toEqual({ registered: true, alreadySet: false })

    const updated = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(updated.gateway.controlUi.allowedOrigins).toEqual([
      'https://existing.example.com',
      'https://mc.example.com',
    ])
    expect(updated.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false)
  })

  it('does not rewrite config when the origin is already present', async () => {
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        controlUi: {
          allowedOrigins: ['https://mc.example.com'],
          dangerouslyDisableDeviceAuth: false,
        },
      },
    }, null, 2) + '\n', 'utf-8')

    const before = readFileSync(configPath, 'utf-8')
    const { registerMcAsDashboard } = await import('@/lib/gateway-runtime')
    const result = registerMcAsDashboard('https://mc.example.com/sessions')
    const after = readFileSync(configPath, 'utf-8')

    expect(result).toEqual({ registered: false, alreadySet: true })
    expect(after).toBe(before)
  })

  it('does not mutate OpenClaw config in isolated test mode', async () => {
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        controlUi: {
          allowedOrigins: ['https://existing.example.com'],
        },
      },
    }, null, 2) + '\n', 'utf-8')
    process.env.MISSION_CONTROL_TEST_MODE = '1'

    const before = readFileSync(configPath, 'utf-8')
    const { registerMcAsDashboard } = await import('@/lib/gateway-runtime')
    const result = registerMcAsDashboard('http://127.0.0.1:3917')
    const after = readFileSync(configPath, 'utf-8')

    expect(result).toEqual({ registered: false, alreadySet: false })
    expect(after).toBe(before)
  })

  it('resolves the configured exec SecretRef as one strict lowercase token', async () => {
    const token = 'a'.repeat(64)
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        auth: {
          mode: 'token',
          token: { source: 'exec', provider: 'login-keychain', id: 'gateway-token' },
        },
      },
      secrets: {
        providers: {
          'login-keychain': {
            source: 'exec',
            command: providerCommand,
            args: ['find-generic-password', '-w', '-s', 'gateway-token'],
          },
        },
      },
    }), 'utf-8')
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 0,
      stdout: `${token}\n`,
      stderr: '',
    })

    const { withDetectedGatewayProcessEnvironment } = await import('@/lib/gateway-runtime')

    expect(withDetectedGatewayProcessEnvironment({ NODE_ENV: 'test' }).OPENCLAW_GATEWAY_TOKEN).toBe(token)
    expect(spawnSyncMock).toHaveBeenCalledWith(
      realpathSync(providerCommand),
      ['find-generic-password', '-w', '-s', 'gateway-token'],
      expect.objectContaining({ env: {}, maxBuffer: 4096, timeout: 10_000 }),
    )
    const { logger } = await import('@/lib/logger')
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(token)
  })

  it('accepts and honors the OpenClaw exec provider timeout without widening provider keys', async () => {
    const token = 'b'.repeat(64)
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        auth: {
          mode: 'token',
          token: { source: 'exec', provider: 'login-keychain', id: 'gateway-token' },
        },
      },
      secrets: {
        providers: {
          'login-keychain': {
            source: 'exec',
            command: providerCommand,
            args: ['find-generic-password', '-w', '-s', 'gateway-token'],
            timeoutMs: 5_000,
          },
        },
      },
    }), 'utf-8')
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 0,
      stdout: `${token}\n`,
      stderr: '',
    })

    const { withDetectedGatewayProcessEnvironment } = await import('@/lib/gateway-runtime')

    expect(withDetectedGatewayProcessEnvironment({ NODE_ENV: 'test' }).OPENCLAW_GATEWAY_TOKEN).toBe(token)
    expect(spawnSyncMock).toHaveBeenCalledWith(
      realpathSync(providerCommand),
      ['find-generic-password', '-w', '-s', 'gateway-token'],
      expect.objectContaining({ env: {}, maxBuffer: 4096, timeout: 5_000 }),
    )
  })

  it.each([999, 120_001])('rejects an out-of-range exec provider timeout (%s)', async timeoutMs => {
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        auth: {
          mode: 'token',
          token: { source: 'exec', provider: 'provider', id: 'gateway-token' },
        },
      },
      secrets: {
        providers: {
          provider: { source: 'exec', command: '/usr/bin/secret-provider', args: [], timeoutMs },
        },
      },
    }), 'utf-8')

    const { withDetectedGatewayProcessEnvironment } = await import('@/lib/gateway-runtime')

    expect(withDetectedGatewayProcessEnvironment({ NODE_ENV: 'test' })).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('reports a valid SecretRef structurally without executing it for UI status', async () => {
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        auth: {
          mode: 'token',
          token: { source: 'exec', provider: 'login-keychain', id: 'gateway-token' },
        },
      },
      secrets: {
        providers: {
          'login-keychain': {
            source: 'exec',
            command: providerCommand,
            args: ['find-generic-password', '-w', '-s', 'gateway-token'],
          },
        },
      },
    }), 'utf-8')

    const { getDetectedGatewayCredentialStatus } = await import('@/lib/gateway-runtime')

    expect(getDetectedGatewayCredentialStatus()).toEqual({
      configured: true,
      source: 'exec-reference',
    })
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it.each([
    ['uppercase output', 'A'.repeat(64)],
    ['short output', 'a'.repeat(63)],
    ['additional output', `${'a'.repeat(64)}\nextra`],
  ])('fails closed for %s from an exec SecretRef', async (_label, stdout) => {
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        auth: {
          mode: 'token',
          token: { source: 'exec', provider: 'provider', id: 'gateway-token' },
        },
      },
      secrets: {
        providers: {
          provider: { source: 'exec', command: providerCommand, args: [] },
        },
      },
    }), 'utf-8')
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 0,
      stdout,
      stderr: '',
    })

    const { withDetectedGatewayProcessEnvironment } = await import('@/lib/gateway-runtime')

    expect(withDetectedGatewayProcessEnvironment({ NODE_ENV: 'test' })).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN')
  })

  it('does not stringify an invalid SecretRef object as a credential', async () => {
    writeFileSync(configPath, JSON.stringify({
      gateway: {
        auth: {
          mode: 'token',
          token: { source: 'exec', provider: 'missing-id' },
        },
      },
    }), 'utf-8')

    const { withDetectedGatewayProcessEnvironment } = await import('@/lib/gateway-runtime')

    expect(withDetectedGatewayProcessEnvironment({ NODE_ENV: 'test' })).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})
