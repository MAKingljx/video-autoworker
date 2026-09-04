import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(process.cwd(), 'openclaw-plugins/aiworker-director-brain')

describe('director brain plugin package', () => {
  it('declares exactly one optional tool and a strict two-field config', async () => {
    const packageJson = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(resolve(ROOT, 'openclaw.plugin.json'), 'utf8'))

    expect(packageJson.type).toBe('module')
    expect(packageJson.version).toBe('0.4.0')
    expect(packageJson.peerDependencies).toEqual({ openclaw: '2026.7.1-2' })
    expect(packageJson.openclaw.extensions).toEqual(['./index.js'])
    expect(manifest).toMatchObject({
      id: 'aiworker-director-brain',
      version: '0.4.0',
      activation: { onStartup: true, onCapabilities: ['hook', 'tool'] },
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

  it('registers one tool, a deterministic system router, and target-scoped persistence hooks', async () => {
    const entry = await readFile(resolve(ROOT, 'index.js'), 'utf8')

    expect(entry).toContain("from 'openclaw/plugin-sdk/plugin-entry'")
    expect(entry).toContain('api.registerTool')
    expect(entry).toContain("api.on('tool_result_persist'")
    expect(entry).toContain("api.on('before_message_write'")
    expect(entry).toContain("api.on('before_agent_reply'")
    expect(entry).toContain('priority: 200')
    expect(entry).toContain("eligibleTriggers: ['user']")
    expect(entry).toContain('TRANSCRIPT_LAST_DEFENSE_PRIORITY = -1_000')
    expect(entry.match(/priority: TRANSCRIPT_LAST_DEFENSE_PRIORITY/gu)).toHaveLength(2)
    expect(entry).toContain('timeoutMs: 35_000')
    expect(entry).toContain('createDirectorBrainSystemQuestionHandler')
    expect(entry).toContain('projectAiworkerToolResultForTargetAgent(event, context, targetAgentId)')
    expect(entry).toContain('projectAiworkerMessageForTargetAgent(event, context, targetAgentId)')
    const projection = await readFile(resolve(ROOT, 'lib/transcript-tool-result-projection.js'), 'utf8')
    expect(projection).toContain('context?.agentId === targetAgentId')
    expect(entry).not.toContain('registerCompactionProvider')
    expect(entry).not.toContain('registerGatewayMethod')
    expect(entry).not.toContain('before_prompt_build')
    expect(entry).not.toContain("api.on('before_dispatch'")
    expect(entry).not.toContain('registerService')
    expect(entry).not.toContain('registerCommand')
  })

})
