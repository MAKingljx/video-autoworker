import { describe, expect, it } from 'vitest'
import {
  readOpenClawAgentEntries,
  writeOpenClawAgentEntries,
} from '../../../scripts/lib/openclaw-agent-config.mjs'

describe('OpenClaw agent config layouts', () => {
  it('reads 9.2 keyed agents and preserves unrelated config when writing', () => {
    const config = { agents: { defaults: { model: 'fixture' }, entries: {
      'second-original': { workspace: '/fixture', tools: { profile: 'coding' } },
    } }, gateway: { port: 18889 } }
    const before = structuredClone(config)
    const agents = readOpenClawAgentEntries(config)
    expect(agents).toEqual([{ ...before.agents.entries['second-original'], id: 'second-original' }])
    expect(config).toEqual(before)
    writeOpenClawAgentEntries(config, [{ ...agents[0], name: 'Updated' }])
    expect(config).toEqual({ ...before, agents: { ...before.agents, entries: {
      'second-original': { ...before.agents.entries['second-original'], name: 'Updated' },
    } } })
  })

  it('retains historical list layout and creates new config in keyed layout', () => {
    const legacy = { agents: { list: [{ id: 'a', name: 'Old' }] } }
    writeOpenClawAgentEntries(legacy, [{ id: 'a', name: 'New' }])
    expect(legacy).toEqual({ agents: { list: [{ id: 'a', name: 'New' }] } })
    const fresh = {}
    writeOpenClawAgentEntries(fresh, [{ id: 'a', name: 'New' }])
    expect(fresh).toEqual({ agents: { entries: { a: { name: 'New' } } } })
  })

  it.each([
    { entries: { a: {} }, list: [{ id: 'a' }] },
    { entries: [] },
    { entries: { a: null } },
    { entries: { a: { id: 'other' } } },
    { entries: { A: {}, a: {} } },
    { entries: { '../escape': {} } },
    { list: null },
    { list: [{ id: 'a' }, { id: 'A' }] },
  ])('rejects ambiguous or invalid agent layouts without mutation: %j', (agents) => {
    const config = { agents }
    const before = structuredClone(config)
    expect(() => readOpenClawAgentEntries(config)).toThrow()
    expect(() => writeOpenClawAgentEntries(config, [{ id: 'safe' }])).toThrow()
    expect(config).toEqual(before)
  })

  it('refuses to remove the final 9.2 agent before any mutation', () => {
    const config = { agents: { entries: { a: {} } } }
    expect(() => writeOpenClawAgentEntries(config, [])).toThrow(/at least one/u)
    expect(config.agents.entries).toEqual({ a: {} })
  })
})
