import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

import {
  isValidExecSecretReference,
  resolveOpenClawGatewaySecret,
  type ExecSecretProvider,
} from '@/lib/secret-reference'

const reference = {
  source: 'exec' as const,
  provider: 'login-keychain',
  id: 'gateway-token',
}

let fixtureDir = ''
let fixtureCommand = ''

function productionProvider(overrides: Record<string, unknown> = {}) {
  return {
    source: 'exec' as const,
    command: fixtureCommand,
    args: [
      'find-generic-password',
      '-w',
      '-s',
      'aiworker.gateway',
      '-a',
      'runtime',
      '/Library/Keychains/System.keychain',
    ],
    timeoutMs: 5_000,
    noOutputTimeoutMs: 5_000,
    maxOutputBytes: 4_096,
    jsonOnly: false as const,
    trustedDirs: [fixtureDir],
    allowInsecurePath: true,
    ...overrides,
  }
}

function providers(provider: ExecSecretProvider = productionProvider()) {
  return { 'login-keychain': provider }
}

describe('OpenClaw exec SecretRef compatibility', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'secret-reference-'))
    fixtureCommand = path.join(fixtureDir, 'fixture-provider')
    writeFileSync(fixtureCommand, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    chmodSync(fixtureCommand, 0o700)
  })

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('resolves a lowercase gateway token with the production OpenClaw provider fields', () => {
    const token = 'a'.repeat(64)
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 0,
      stdout: `${token}\n`,
      stderr: '',
    })

    expect(resolveOpenClawGatewaySecret(reference, providers())).toBe(token)
    expect(spawnSyncMock).toHaveBeenCalledWith(
      realpathSync(fixtureCommand),
      productionProvider().args,
      expect.objectContaining({
        cwd: realpathSync(fixtureDir),
        env: {},
        maxBuffer: 4_096,
        shell: false,
        timeout: 5_000,
      }),
    )
  })

  it.each([
    ['an unknown provider field', { shell: true }],
    ['an env passthrough field', { env: { HOME: '/tmp' } }],
    ['a passEnv field', { passEnv: ['HOME'] }],
    ['a non-boolean allowInsecurePath', { allowInsecurePath: 'yes' }],
    ['JSON output mode', { jsonOnly: true }],
    ['a relative trusted directory', { trustedDirs: ['usr/bin'] }],
    ['a zero output byte limit', { maxOutputBytes: 0 }],
    ['an excessive output byte limit', { maxOutputBytes: (20 * 1024 * 1024) + 1 }],
    ['an out-of-range total timeout', { timeoutMs: 999 }],
    ['an out-of-range no-output timeout', { noOutputTimeoutMs: 999 }],
  ])('rejects %s before starting a process', (_label, override) => {
    const invalidProviders = providers(productionProvider(override))

    expect(isValidExecSecretReference(reference, invalidProviders)).toBe(false)
    expect(resolveOpenClawGatewaySecret(reference, invalidProviders)).toBe('')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('does not accept a command outside trustedDirs through a path-prefix match', () => {
    const prefixCollision = providers(productionProvider({
      command: `${fixtureDir}-attacker/provider`,
    }))

    expect(isValidExecSecretReference(reference, prefixCollision)).toBe(false)
    expect(resolveOpenClawGatewaySecret(reference, prefixCollision)).toBe('')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a symlink command during filesystem validation', () => {
    const symlinkCommand = path.join(fixtureDir, 'provider-link')
    symlinkSync(fixtureCommand, symlinkCommand)
    const symlinkProvider = providers(productionProvider({ command: symlinkCommand }))

    expect(isValidExecSecretReference(reference, symlinkProvider)).toBe(true)
    expect(resolveOpenClawGatewaySecret(reference, symlinkProvider)).toBe('')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a physical trustedDirs escape through a symlink parent even when insecure paths are allowed', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'secret-reference-outside-'))
    const outsideCommand = path.join(outsideDir, 'outside-provider')
    const linkedParent = path.join(fixtureDir, 'linked-parent')
    try {
      writeFileSync(outsideCommand, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
      chmodSync(outsideCommand, 0o700)
      symlinkSync(outsideDir, linkedParent)
      const lexicalCommand = path.join(linkedParent, 'outside-provider')
      const escapedProvider = providers(productionProvider({
        command: lexicalCommand,
        allowInsecurePath: true,
      }))

      expect(isValidExecSecretReference(reference, escapedProvider)).toBe(true)
      expect(resolveOpenClawGatewaySecret(reference, escapedProvider)).toBe('')
      expect(spawnSyncMock).not.toHaveBeenCalled()
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects a writable command unless insecure paths are explicitly allowed', () => {
    chmodSync(fixtureCommand, 0o777)
    const writableProvider = providers(productionProvider({ allowInsecurePath: false }))

    expect(isValidExecSecretReference(reference, writableProvider)).toBe(true)
    expect(resolveOpenClawGatewaySecret(reference, writableProvider)).toBe('')
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('keeps the legacy four-key raw provider compatible', () => {
    const token = 'c'.repeat(64)
    const legacyProviders = providers({
      source: 'exec' as const,
      command: fixtureCommand,
      args: ['fixture-argument'],
      timeoutMs: 4_000,
    })
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 0,
      stdout: token,
      stderr: '',
    })

    expect(resolveOpenClawGatewaySecret(reference, legacyProviders)).toBe(token)
    expect(spawnSyncMock).toHaveBeenCalledWith(
      realpathSync(fixtureCommand),
      ['fixture-argument'],
      expect.objectContaining({ maxBuffer: 4_096, timeout: 4_000 }),
    )
  })

  it('enforces configured output and no-output limits when spawning the provider', () => {
    const token = 'b'.repeat(64)
    const limitedProvider = productionProvider({
      timeoutMs: 8_000,
      noOutputTimeoutMs: 2_000,
      maxOutputBytes: 256,
    })
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 0,
      stdout: token,
      stderr: '',
    })

    expect(resolveOpenClawGatewaySecret(reference, providers(limitedProvider))).toBe(token)
    expect(spawnSyncMock).toHaveBeenCalledWith(
      realpathSync(fixtureCommand),
      limitedProvider.args,
      expect.objectContaining({
        maxBuffer: 256,
        timeout: 2_000,
      }),
    )
  })

  it('rejects combined stdout and stderr beyond maxOutputBytes', () => {
    const token = 'd'.repeat(64)
    const byteLimitedProvider = productionProvider({ maxOutputBytes: 64 })
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 0,
      stdout: token,
      stderr: 'x',
    })

    expect(resolveOpenClawGatewaySecret(reference, providers(byteLimitedProvider))).toBe('')
    expect(spawnSyncMock).toHaveBeenCalledWith(
      realpathSync(fixtureCommand),
      byteLimitedProvider.args,
      expect.objectContaining({ maxBuffer: 64 }),
    )
  })

  it.each([
    ['a non-zero exit', { error: undefined, signal: null, status: 1 }],
    ['a signal', { error: undefined, signal: 'SIGTERM', status: null }],
    ['a timed-out process', {
      error: Object.assign(new Error('provider timed out'), { code: 'ETIMEDOUT' }),
      signal: 'SIGTERM',
      status: null,
    }],
  ])('fails closed for %s', (_label, result) => {
    spawnSyncMock.mockReturnValue({
      stdout: 'e'.repeat(64),
      stderr: '',
      ...result,
    })

    expect(resolveOpenClawGatewaySecret(reference, providers())).toBe('')
  })
})
