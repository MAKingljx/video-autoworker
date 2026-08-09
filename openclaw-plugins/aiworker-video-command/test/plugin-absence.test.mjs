import { describe, expect, it } from 'vitest'

import { validatePluginAbsenceReport } from '../scripts/validate-plugin-absence.mjs'

const pluginId = 'aiworker-video-command'

describe('plugin absence report validator', () => {
  it('accepts a complete registry that does not contain the target', () => {
    expect(() => validatePluginAbsenceReport([
      { plugin: { id: 'memory-core' } },
      { plugin: { id: 'telegram' } },
    ], pluginId)).not.toThrow()
  })

  it('rejects a registry that already contains the target', () => {
    expect(() => validatePluginAbsenceReport([
      { plugin: { id: pluginId } },
    ], pluginId)).toThrow(/already discoverable/u)
  })

  it.each([
    {},
    [{ plugin: {} }],
    [{ plugin: { id: '' } }],
  ])('rejects malformed registry JSON shapes', report => {
    expect(() => validatePluginAbsenceReport(report, pluginId)).toThrow()
  })
})
