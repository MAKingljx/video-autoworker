import { describe, expect, it } from 'vitest'

import {
  buildDirectToolAccessCandidate,
  validateCandidateAgainstBaseline,
} from '../../../scripts/lib/direct-tool-access-policy.mjs'

const agentId = 'second-original'
const toolId = 'aiworker_analyze_video'

function config() {
  return {
    agents: {
      list: [{
        id: agentId,
        tools: {
          allow: ['read', 'exec'],
          loopDetection: { enabled: true },
        },
      }],
    },
  }
}

const effective = {
  agentId,
  groups: [{ tools: [{ id: 'read' }, { id: 'exec' }] }],
}

const catalog = {
  agentId,
  groups: [{ tools: [
    { id: 'read', defaultProfiles: ['coding'] },
    { id: 'exec', defaultProfiles: ['coding'] },
    { id: 'write', defaultProfiles: ['coding'] },
    { id: toolId, defaultProfiles: [] },
  ] }],
}

describe('direct tool access policy', () => {
  it('keeps the effective coding baseline exact while adding one optional plugin tool', () => {
    const legacy = config()
    const candidate = buildDirectToolAccessCandidate(legacy, effective, catalog, { agentId, toolId })

    expect(candidate.agents.list[0].tools).toEqual({
      loopDetection: { enabled: true },
      profile: 'coding',
      alsoAllow: [toolId],
      deny: ['write'],
    })
    validateCandidateAgainstBaseline(candidate, legacy, effective, catalog, { agentId, toolId })
  })
})
