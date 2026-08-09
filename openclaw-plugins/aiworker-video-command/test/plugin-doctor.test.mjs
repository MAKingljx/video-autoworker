import { describe, expect, it } from 'vitest'

import { validatePluginDoctorReport } from '../scripts/validate-plugin-doctor.mjs'

const pluginId = 'aiworker-video-command'

describe('plugin doctor report validator', () => {
  it('accepts the exact no-issues report', () => {
    expect(() => validatePluginDoctorReport('No plugin issues detected.\n', pluginId)).not.toThrow()
  })

  it('accepts only the supported hook-only information report', () => {
    const report = [
      'Compatibility:',
      `- ${pluginId} is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet. [info]`,
      '',
      'Docs: https://docs.openclaw.ai/plugin',
      '',
    ].join('\n')
    expect(() => validatePluginDoctorReport(report, pluginId)).not.toThrow()
  })

  it.each([
    'Compatibility:\n- other is hook-only. [info]\nDocs: https://docs.openclaw.ai/plugin\n',
    'Diagnostics:\n- aiworker-video-command failed to load [error]\n',
    'No plugin issues detected.\nUnexpected warning\n',
    '',
  ])('rejects unexpected doctor output', report => {
    expect(() => validatePluginDoctorReport(report, pluginId)).toThrow()
  })
})
