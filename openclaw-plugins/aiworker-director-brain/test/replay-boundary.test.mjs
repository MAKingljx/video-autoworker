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

  it('does not retry a failed extraction internally and lets the next invocation recover once', async () => {
    const service = vi.fn().mockResolvedValue({
      ok: true,
      action: 'resolve_work',
      found: true,
      work: { workId: 'WORK-HIDDEN', name: '冰原纪事' },
    })
    const extractionService = vi.fn()
      .mockRejectedValueOnce(new Error('simulated timeout RUN-HIDDEN'))
      .mockResolvedValue({
        ok: true,
        action: 'start_extraction',
        status: 'pending',
        runId: 'RUN-HIDDEN',
        sourceTaskId: 'SOURCE-HIDDEN',
      })
    const tool = createDirectorBrainTool({
      context: targetContext,
      service,
      extractionService,
    })
    const request = { action: 'start_extraction', query: '冰原纪事' }

    const failedTurn = resultJson(await tool.execute('failed-simulated-turn', request))
    expect(extractionService).toHaveBeenCalledTimes(1)
    expectBoundedAnswer(failedTurn, { maxLength: 80 })
    expect(failedTurn.responseContract.userVisibleAnswer).toBe(
      '导演知识暂时无法开始整理，请稍后再试。',
    )

    const recoveredTurn = resultJson(await tool.execute('next-simulated-turn', request))
    expect(extractionService).toHaveBeenCalledTimes(2)
    expectBoundedAnswer(recoveredTurn, { maxLength: 80 })
    expect(recoveredTurn.responseContract.userVisibleAnswer).toBe(
      '已开始整理《冰原纪事》的导演知识。稍后直接问我进度就行。',
    )
  })

  it('keeps concurrent replay attempts to one extraction call each and projects short replies', async () => {
    const service = vi.fn().mockResolvedValue({
      ok: true,
      action: 'resolve_work',
      found: true,
      work: { workId: 'WORK-HIDDEN', name: '冰原纪事' },
    })
    const extractionService = vi.fn().mockResolvedValue({
      ok: true,
      action: 'start_extraction',
      status: 'running',
      runId: 'RUN-HIDDEN',
      sourceTaskId: 'SOURCE-HIDDEN',
    })
    const tool = createDirectorBrainTool({
      context: targetContext,
      service,
      extractionService,
    })
    const request = { action: 'start_extraction', query: '冰原纪事' }

    const results = await Promise.all([
      tool.execute('concurrent-replay-a', request),
      tool.execute('concurrent-replay-b', request),
    ])

    expect(extractionService).toHaveBeenCalledTimes(2)
    for (const rawResult of results) {
      const result = resultJson(rawResult)
      expectBoundedAnswer(result, { maxLength: 80 })
      expect(result.responseContract.userVisibleAnswer).toBe(
        '《冰原纪事》已经在整理中，不会重复启动。',
      )
    }
  })

  it('reports a changed extraction objective as a deterministic replay conflict', async () => {
    const service = vi.fn().mockResolvedValue({
      ok: true,
      action: 'resolve_work',
      found: true,
      work: { workId: 'WORK-HIDDEN', name: '冰原纪事' },
    })
    const extractionService = vi.fn().mockRejectedValue(
      new Error('director_extraction_objective_conflict'),
    )
    const tool = createDirectorBrainTool({
      context: targetContext,
      service,
      extractionService,
    })

    const result = resultJson(await tool.execute('different-value-replay', {
      action: 'start_extraction',
      query: '冰原纪事',
      objective: '改为提炼空间结构',
    }))

    expect(extractionService).toHaveBeenCalledTimes(1)
    expectBoundedAnswer(result, { maxLength: 80 })
    expect(result.responseContract.userVisibleAnswer)
      .toBe('这次整理目标与已经开始的整理不一致，未重复启动。')
  })
})
