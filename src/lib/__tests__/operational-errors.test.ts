import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ loggerError: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import {
  logSafeOperationError,
  projectSafeOperationError,
  SafeOperationError,
  sanitizeOperationalDiagnostic,
} from '@/lib/operational-errors'

describe('safe operational errors', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes credentials, URLs, paths and internal identifiers from diagnostics', () => {
    const raw = [
      'Authorization: Bearer secret-value',
      'api_key=top-secret',
      '--session-key agent:private-session',
      'https://private.example/path?token=hidden',
      '/Users/operator/private/source.mp4',
      '/opt/private/runtime/config.json',
      '"secret":"json-secret"',
      'sk-privatecredential',
      'cli_a1b2c3d4e5f6g7h8',
      '123e4567-e89b-42d3-a456-426614174000',
    ].join(' ')
    const safe = sanitizeOperationalDiagnostic(raw)

    expect(safe).toContain('Authorization=[脱敏]')
    expect(safe).toContain('api_key=[脱敏]')
    expect(safe).toContain('--session-key [脱敏]')
    expect(safe).toContain('[链接]')
    expect(safe).toContain('[路径]')
    expect(safe).toContain('[内部ID]')
    expect(safe).toContain('[ID]')
    expect(safe).not.toContain('secret-value')
    expect(safe).not.toContain('top-secret')
    expect(safe).not.toContain('private.example')
    expect(safe).not.toContain('/Users/operator')
    expect(safe).not.toContain('/opt/private')
    expect(safe).not.toContain('json-secret')
    expect(safe).not.toContain('sk-privatecredential')
  })

  it('projects only registered codes and fixed summaries', () => {
    const protectedError = new SafeOperationError(
      'N8N_MODEL_HTTP_FAILED',
      'HTTP 503 /Users/operator/private api_key=secret',
    )
    const protectedProjection = projectSafeOperationError(
      protectedError,
      'N8N_MODEL_EXECUTION_FAILED',
    )
    const unknownProjection = projectSafeOperationError(
      new Error('ssh failed /Users/operator/private --token secret'),
      'MATERIALS_SEARCH_FAILED',
    )

    expect(protectedProjection).toEqual({
      code: 'N8N_MODEL_HTTP_FAILED',
      summary: '模型服务调用失败',
      persistedMessage: '[N8N_MODEL_HTTP_FAILED] 模型服务调用失败',
    })
    expect(unknownProjection).toEqual({
      code: 'MATERIALS_SEARCH_FAILED',
      summary: '素材搜索失败',
      persistedMessage: '[MATERIALS_SEARCH_FAILED] 素材搜索失败',
    })
  })

  it('keeps only a redacted diagnostic in the protected service log', () => {
    const error = new Error('ssh https://private.example /Users/operator/private token=secret')
    const projection = projectSafeOperationError(error, 'MATERIALS_OVERVIEW_FAILED')
    logSafeOperationError('materials_overview', error, projection)

    expect(mocks.loggerError).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(mocks.loggerError.mock.calls[0])
    expect(logged).toContain('MATERIALS_OVERVIEW_FAILED')
    expect(logged).toContain('[链接]')
    expect(logged).toContain('[路径]')
    expect(logged).not.toContain('private.example')
    expect(logged).not.toContain('/Users/operator')
    expect(logged).not.toContain('token=secret')
  })
})
