import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PLUGIN_ROOT = resolve(process.cwd(), 'openclaw-plugins/aiworker-video-command')

describe('OpenClaw plugin package contract', () => {
  it('declares one built JavaScript entry and a strict sender-hash config schema', async () => {
    const rootPackageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'))
    const packageJson = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'package.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'openclaw.plugin.json'), 'utf8'))

    expect(rootPackageJson.scripts.test).toContain('test:openclaw-video-command')
    expect(rootPackageJson.scripts['test:openclaw-video-command']).toContain(
      'openclaw-plugins/aiworker-video-command/vitest.config.mjs',
    )
    expect(packageJson.type).toBe('module')
    expect(packageJson.version).toBe('0.4.1')
    expect(packageJson.openclaw.extensions).toEqual(['./index.js'])
    expect(packageJson.openclaw.compat.pluginApi).toBe('>=2026.7.1')
    expect(manifest.id).toBe('aiworker-video-command')
    expect(manifest.version).toBe(packageJson.version)
    expect(manifest.activation).toEqual({
      onStartup: true, onCapabilities: ['hook'],
    })
    expect(manifest.configSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        allowedSenderSha256: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
        },
      },
    })
    expect(manifest).not.toHaveProperty('contracts')
    expect(manifest).not.toHaveProperty('toolMetadata')
    expect(JSON.stringify(manifest)).not.toMatch(/secret|token|password|api.?key/iu)
  })

  it('registers only the native before-dispatch hook', async () => {
    const entry = await readFile(resolve(PLUGIN_ROOT, 'index.js'), 'utf8')
    expect(entry).toContain("from 'openclaw/plugin-sdk/plugin-entry'")
    expect(entry).toContain("api.on('before_dispatch'")
    expect(entry).not.toContain("api.on('before_prompt_build'")
    expect(entry).not.toContain("api.on('before_tool_call'")
    expect(entry).not.toContain('api.registerTool')
    expect(entry).not.toContain('runContext')
    expect(entry).not.toContain('aiworker_analyze_video')
    expect(entry).not.toContain('inbound_claim')
    expect(entry).not.toContain('message_received')
    expect(entry).toContain('api.pluginConfig?.allowedSenderSha256')
    expect(entry).toContain('bounded task status queries')
  })
})
