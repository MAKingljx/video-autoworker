import { describe, expect, it, vi } from 'vitest'

import { createDirectorBrainTool } from '../lib/director-brain-tool.js'

// This suite models OpenClaw delivering the same business request again after a
// transcript event. It deliberately does not claim to exercise Gateway
// compaction, a channel, or the Feishu transport. Durable uniqueness belongs to
// the shared director services and is covered by their database/domain tests.

const targetContext = { agentId: 'second-original' }

function resultJson(result) {
  return JSON.parse(result.content[0].text)
}

function expectBoundedAnswer(result, { maxLength = 512 } = {}) {
  const answer = result.responseContract.userVisibleAnswer
  expect(result).toMatchObject({
    ok: true,
    handled: true,
    responseContract: {
      mustQuoteUserVisibleAnswerExactly: true,
      doNotAddFacts: true,
      doNotExposeInternalIds: true,
    },
  })
  expect(answer.length).toBeLessThan(maxLength)
  expect(JSON.stringify(result)).not.toMatch(
    /WORK-HIDDEN|RUN-HIDDEN|SOURCE-HIDDEN|recordId|candidateId|checkpoint|CAS|SQLite|n8n/iu,
  )
}

describe('director brain simulated replay boundary (not Gateway or channel E2E)', () => {
  it('performs at most one formal workflow operation inside each replayed tool invocation', async () => {
    const service = vi.fn(async request => {
      if (request.action === 'resolve_work') {
        return {
          ok: true,
          action: 'resolve_work',
          found: true,
          work: { workId: 'WORK-HIDDEN', name: '冰原纪事' },
        }
      }
      return {
        ok: true,
        action: 'workflow',
        workId: 'WORK-HIDDEN',
        readiness: {
          perception: true,
          people: true,
          story: true,
          judgment: false,
          narrative: false,
          intent: true,
        },
        nextSuggestion: '先确认导演判断。',
      }
    })
    const tool = createDirectorBrainTool({ context: targetContext, service })
    const request = { action: 'workflow', query: '冰原纪事' }

    const invoke = async toolCallId => {
      const workflowCallsBefore = service.mock.calls
        .filter(([operation]) => operation.action === 'workflow').length
      const result = resultJson(await tool.execute(toolCallId, request))
      const workflowCallsAfter = service.mock.calls
        .filter(([operation]) => operation.action === 'workflow').length
      expect(workflowCallsAfter - workflowCallsBefore).toBe(1)
      return result
    }

    const first = await invoke('before-simulated-compaction')
    const replayed = await invoke('after-simulated-compaction')
    expect(service.mock.calls.filter(([operation]) => operation.action === 'workflow')).toHaveLength(2)
    for (const result of [first, replayed]) {
      expectBoundedAnswer(result)
      expect(result.responseContract.userVisibleAnswer).toContain('未就绪：导演判断、叙事结构')
      expect(result.responseContract.userVisibleAnswer.split(/[。！？!?]/u).filter(Boolean))
        .toHaveLength(3)
    }
  })

  it('rejects replayed extraction mutations without resolving, dispatching, or retrying', async () => {
    const service = vi.fn()
    const extractionService = vi.fn()
    const tool = createDirectorBrainTool({ context: targetContext, service, extractionService })

    for (const action of ['start_extraction', 'backfill_extraction']) {
      const first = await tool.execute(`first-${action}`, { action, query: '冰原纪事' })
      const replayed = await tool.execute(`replayed-${action}`, { action, query: '冰原纪事' })
      expect(first.content[0].text).toBe('导演脑请求参数无效。')
      expect(replayed).toEqual(first)
    }
    expect(service).not.toHaveBeenCalled()
    expect(extractionService).not.toHaveBeenCalled()
  })
})
