import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PLUGIN_ROOT = resolve(process.cwd(), 'openclaw-plugins/aiworker-video-command')

describe('OpenClaw plugin package contract', () => {
  it('declares one built JavaScript entry and a strict keyless config schema', async () => {
    const rootPackageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'))
    const packageJson = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'package.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'openclaw.plugin.json'), 'utf8'))

    expect(rootPackageJson.scripts.test).toContain('test:openclaw-video-command')
    expect(rootPackageJson.scripts['test:openclaw-video-command']).toContain(
      'openclaw-plugins/aiworker-video-command/vitest.config.mjs',
    )
    expect(packageJson.type).toBe('module')
    expect(packageJson.openclaw.extensions).toEqual(['./index.js'])
    expect(packageJson.openclaw.compat.pluginApi).toBe('>=2026.7.1')
    expect(manifest.id).toBe('aiworker-video-command')
    expect(manifest.activation).toEqual({
      onStartup: true,
      onCapabilities: ['hook', 'tool'],
    })
    expect(manifest.configSchema).toEqual({
      type: 'object', additionalProperties: false, properties: {},
    })
    expect(manifest.contracts).toEqual({ tools: ['aiworker_analyze_video'] })
    expect(manifest.toolMetadata).toEqual({
      aiworker_analyze_video: { optional: true },
    })
    expect(JSON.stringify(manifest)).not.toMatch(/secret|token|password|api.?key/iu)
  })

  it('registers exact dispatch plus the guarded optional model tool', async () => {
    const entry = await readFile(resolve(PLUGIN_ROOT, 'index.js'), 'utf8')
    expect(entry).toContain("from 'openclaw/plugin-sdk/plugin-entry'")
    expect(entry).toContain("api.on('before_dispatch'")
    expect(entry).toContain("api.on('before_prompt_build'")
    expect(entry).toContain("api.on('before_tool_call'")
    expect(entry).toContain('api.registerTool')
    expect(entry).toContain('optional: true')
    expect(entry).not.toContain('inbound_claim')
    expect(entry).not.toContain('message_received')
  })
})
