import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  fingerprintOpenClawToolInventory,
  normalizeOpenClawToolPolicyNotices,
} from '../../../scripts/lib/openclaw-tool-capability-fingerprint.mjs'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const notice = (message = 'Browser is filtered by the active profile.') => ({
  id: 'browser-filtered-by-profile',
  severity: 'info',
  message,
})

const inventory = (overrides: Record<string, unknown> = {}) => ({
  agentId: 'second-original',
  profile: 'coding',
  notices: [notice()],
  groups: [{ source: 'core', tools: [{ id: 'read', description: 'Read a file.' }] }],
  ...overrides,
})

describe('OpenClaw tool policy notices', () => {
  it('normalizes the one supported effective profile notice using raw UTF-8 digests', () => {
    const message = '  浏览器按 profile 过滤。  '
    const profile = ' coding-profile '

    expect(normalizeOpenClawToolPolicyNotices(
      inventory({ profile, notices: [notice(message)] }),
      { kind: 'effective', label: 'effective tools' },
    )).toEqual([{
      id: 'browser-filtered-by-profile',
      severity: 'info',
      messageSha256: sha256(message),
      profileSha256: sha256(profile),
    }])
  })

  it.each([
    ['catalog notice', inventory(), 'catalog'],
    ['unknown effective notice', inventory({ notices: [{ id: 'unknown', severity: 'info', message: 'x' }] }), 'effective'],
    ['duplicate effective notices', inventory({ notices: [notice(), notice()] }), 'effective'],
    ['MCP informational notice', inventory({ notices: [{ id: 'mcp-not-yet-listed', severity: 'info', message: 'x' }] }), 'effective'],
    ['MCP warning notice', inventory({ notices: [{ id: 'mcp-not-yet-listed', severity: 'warning', message: 'x' }] }), 'effective'],
    ['warning profile notice', inventory({ notices: [{ ...notice(), severity: 'warning' }] }), 'effective'],
    ['empty message', inventory({ notices: [notice('   ')] }), 'effective'],
    ['empty profile', inventory({ profile: '   ' }), 'effective'],
    ['browser remains exposed', inventory({ groups: [{ source: 'core', tools: [{ id: 'read' }, { id: 'browser' }] }] }), 'effective'],
    ['malformed notice', inventory({ notices: [{ ...notice(), extra: true }] }), 'effective'],
  ] as const)('rejects %s', (_label, value, kind) => {
    expect(() => normalizeOpenClawToolPolicyNotices(value, {
      kind,
      label: 'fixture inventory',
    })).toThrow(/fixture inventory/u)
  })

  it('binds profile and message drift into policy-separated descriptor fingerprints', () => {
    const base = inventory()
    const profileChanged = inventory({ profile: 'research' })
    const messageChanged = inventory({ notices: [notice('A changed policy explanation.')] })
    const emptyPolicy = inventory({ notices: undefined, profile: undefined })
    const fingerprint = (value: ReturnType<typeof inventory>) => fingerprintOpenClawToolInventory(
      value,
      { agentId: 'second-original', kind: 'effective', label: 'effective tools' },
    )[0].descriptorSurfaceSha256

    const oldDescriptorHash = sha256(JSON.stringify({
      defaultProfiles: null,
      description: 'Read a file.',
      label: null,
      optional: null,
      rawDescription: null,
      risk: null,
      tags: null,
    }))

    expect(fingerprint(emptyPolicy)).toBe(oldDescriptorHash)
    expect(fingerprint(base)).not.toBe(oldDescriptorHash)
    expect(fingerprint(profileChanged)).not.toBe(fingerprint(base))
    expect(fingerprint(messageChanged)).not.toBe(fingerprint(base))
  })
})
