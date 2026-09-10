import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENCLAW_PROFILES,
  assertProfileAction,
  assertProfileId,
  getProfileConfigPath,
  parseGatewayStatus,
  parseJsonFromOutput,
  validateOpenClawProfileConfig,
} from '../openclaw-profiles'

describe('openclaw profile controls', () => {
  it('parses gateway status output for an online profile', () => {
    const profile = DEFAULT_OPENCLAW_PROFILES[1]
    const status = parseGatewayStatus(`
CLI version: 2026.5.27 (~/ai-worker/bin/openclaw)
Gateway version: 2026.5.27

Runtime: running (pid 83637, state active)
Connectivity probe: ok
Listening: 127.0.0.1:18889, [::1]:18889
`, profile, Date.now())

    expect(status.id).toBe('qwen-current')
    expect(status.status).toBe('online')
    expect(status.pid).toBe(83637)
    expect(status.cliVersion).toContain('2026.5.27')
    expect(status.gatewayVersion).toBe('2026.5.27')
    expect(status.connectivity).toBe('ok')
    expect(status.listening).toEqual(['127.0.0.1:18889', '[::1]:18889'])
  })

  it('extracts JSON payloads from mixed command output', () => {
    const parsed = parseJsonFromOutput(`warning line
{
  "ok": true,
  "outputs": [{ "text": "好" }]
}
`)

    expect(parsed).toEqual({
      ok: true,
      outputs: [{ text: '好' }],
    })
  })

  it('rejects unknown profiles and unsupported actions', () => {
    expect(() => assertProfileId('qwen-current')).not.toThrow()
    expect(() => assertProfileId('bad-profile')).toThrow('未知 OpenClaw 配置档')

    expect(() => assertProfileAction('model-test')).not.toThrow()
    expect(() => assertProfileAction('delete-everything')).toThrow('不支持的配置档操作')
  })

  it('maps each default profile to its controlled config path', () => {
    expect(getProfileConfigPath(DEFAULT_OPENCLAW_PROFILES[0])).toContain('.openclaw-gpt-main/openclaw.json')
    expect(getProfileConfigPath(DEFAULT_OPENCLAW_PROFILES[1])).toContain('.openclaw-qwen-current/openclaw.json')
    expect(getProfileConfigPath(DEFAULT_OPENCLAW_PROFILES[2])).toContain('.openclaw-qwen-weixin-new/openclaw.json')
  })

  it('validates profile config shape with zod-backed checks', () => {
    expect(validateOpenClawProfileConfig({
      gateway: { port: 18889 },
      agents: {},
      models: {},
      channels: {},
    })).toEqual({ ok: true, issues: [] })

    const invalid = validateOpenClawProfileConfig({
      gateway: { port: 99999 },
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.issues.join('\n')).toContain('gateway.port')
  })
})
