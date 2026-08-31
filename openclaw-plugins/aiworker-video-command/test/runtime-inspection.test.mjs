import { describe, expect, it } from 'vitest'

import { validateRuntimeInspection } from '../scripts/validate-runtime-inspection.mjs'

function report(overrides = {}) {
  return {
    plugin: { id: 'aiworker-video-command', status: 'loaded', version: '0.5.13' },
    shape: 'non-capability',
    typedHooks: [{ name: 'before_dispatch', priority: 100 }],
    tools: [{ names: ['aiworker_analyze_video'], optional: true }],
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
    ['wrong id', report({ plugin: { id: 'other', status: 'loaded', version: '0.5.13' } })],
    ['not loaded', report({ plugin: { id: 'aiworker-video-command', status: 'disabled', version: '0.5.13' } })],
    ['wrong version', report({ plugin: { id: 'aiworker-video-command', status: 'loaded', version: '0.2.0' } })],
    ['missing hook', report({ typedHooks: [] })],
    ['extra hook', report({ typedHooks: [{ name: 'before_dispatch' }, { name: 'before_tool_call' }] })],
    ['missing tool', report({ tools: [] })],
    ['wrong tool', report({ tools: [{ names: ['other_tool'] }] })],
    ['missing diagnostics', report({ diagnostics: undefined })],
    ['error diagnostic', report({ diagnostics: [{ level: 'error', message: 'load failed' }] })],
  ])('rejects %s', (_label, value) => {
    expect(() => validateRuntimeInspection(value, 'aiworker-video-command')).toThrow()
  })
})
