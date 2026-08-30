import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(process.cwd(), 'openclaw-plugins/aiworker-director-brain')

describe('director brain plugin package', () => {
  it('declares exactly one optional tool and a strict two-field config', async () => {
    const packageJson = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(resolve(ROOT, 'openclaw.plugin.json'), 'utf8'))

    expect(packageJson.type).toBe('module')
    expect(packageJson.version).toBe('0.3.0')
    expect(packageJson.openclaw.extensions).toEqual(['./index.js'])
    expect(manifest).toMatchObject({
      id: 'aiworker-director-brain',
      version: '0.3.0',
      activation: { onStartup: true, onCapabilities: ['tool'] },
      contracts: { tools: ['aiworker_director_brain'] },
      toolMetadata: { aiworker_director_brain: { optional: true } },
    })
    expect(manifest.configSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        releaseReady: { type: 'boolean' },
        targetAgentId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    })
    expect(JSON.stringify(manifest)).not.toMatch(/secret|token|password|api.?key/iu)
  })

  it('registers a tool only and contains no hook or execution-chain registration', async () => {
    const entry = await readFile(resolve(ROOT, 'index.js'), 'utf8')

    expect(entry).toContain("from 'openclaw/plugin-sdk/plugin-entry'")
    expect(entry).toContain('api.registerTool')
    expect(entry).not.toContain('api.on(')
    expect(entry).not.toContain('before_dispatch')
    expect(entry).not.toContain('before_prompt_build')
    expect(entry).not.toContain('registerService')
    expect(entry).not.toContain('registerCommand')
  })
})
