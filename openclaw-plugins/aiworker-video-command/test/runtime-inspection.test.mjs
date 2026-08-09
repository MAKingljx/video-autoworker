import { describe, expect, it } from 'vitest'

import { validateRuntimeInspection } from '../scripts/validate-runtime-inspection.mjs'

function report(overrides = {}) {
  return {
    plugin: { id: 'aiworker-video-command', status: 'loaded' },
    shape: 'non-capability',
    typedHooks: [{ name: 'before_dispatch', priority: 100 }],
    diagnostics: [],
    ...overrides,
  }
}

describe('runtime inspection validator', () => {
  it('accepts the loaded plugin with its typed dispatch hook', () => {
    expect(() => validateRuntimeInspection(
      report(),
      'aiworker-video-command',
    )).not.toThrow()
  })

  it('does not depend on the runtime shape label', () => {
    expect(() => validateRuntimeInspection(
      report({ shape: 'hook-only' }),
      'aiworker-video-command',
    )).not.toThrow()
  })

  it.each([
    ['wrong id', report({ plugin: { id: 'other', status: 'loaded' } })],
    ['not loaded', report({ plugin: { id: 'aiworker-video-command', status: 'disabled' } })],
    ['missing hook', report({ typedHooks: [] })],
    ['missing diagnostics', report({ diagnostics: undefined })],
    ['error diagnostic', report({ diagnostics: [{ level: 'error', message: 'load failed' }] })],
  ])('rejects %s', (_label, value) => {
    expect(() => validateRuntimeInspection(value, 'aiworker-video-command')).toThrow()
  })
})
