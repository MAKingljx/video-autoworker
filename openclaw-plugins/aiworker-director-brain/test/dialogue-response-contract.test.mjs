import { describe, expect, it, vi } from 'vitest'

import { createDirectorBrainTool } from '../lib/director-brain-tool.js'

const targetContext = { agentId: 'second-original' }
const forbiddenUserVisibleData = [
  /workId|taskId|recordId|tableId|runId|extractionId|candidateId|sourceTaskId|work_id|task_id|record_id|table_id/iu,
  /WORK-HIDDEN|TASK-HIDDEN|RECORD-HIDDEN|RUN-HIDDEN|EXTRACTION-HIDDEN/iu,
  /awaiting_[a-z_]+|\bpending\b|\brunning\b|\bfailed\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/iu,
  /\b[0-9a-f]{7,64}\b/iu,
  /\b(?:rec|tbl)(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{8,24}\b/u,
  /\/Users\/phoenix|\/tmp\/director-brain/iu,
  /token\s*[:=]|secret\s*[:=]|password\s*[:=]|bearer\s+/iu,
]

function resultJson(result) {
  return JSON.parse(result.content[0].text)
}

function expectHumanContract(result, expected) {
  expect(result).toMatchObject({
    ok: true,
    handled: true,
    responseContract: {
      mustQuoteUserVisibleAnswerExactly: true,
      doNotAddFacts: true,
      doNotExposeInternalIds: true,
      handled: true,
      stopAfterReply: true,
      doNotUseFallbackSources: true,
    },
  })
  const answer = result.responseContract.userVisibleAnswer
  expect(answer).toBe(expected)
  expect(answer.length).toBeLessThanOrEqual(360)
  expect(answer.split(/[。！？!?]/u).filter(Boolean).length).toBeLessThanOrEqual(3)
  for (const pattern of forbiddenUserVisibleData) expect(answer).not.toMatch(pattern)
}

function reviewedAnswer(action, userVisibleAnswer) {
  return {
    ok: true,
    action,
    responseContract: {
      mustQuoteUserVisibleAnswerExactly: true,
      userVisibleAnswer,
    },
    workId: 'WORK-HIDDEN',
    taskId: 'TASK-HIDDEN',
    recordId: 'RECORD-HIDDEN',
  }
}

const ready = {
  perception: true,
  people: true,
  story: true,
  judgment: true,
  narrative: true,
  intent: true,
}

describe('director brain human dialogue response contract', () => {
  it('answers a director-brain learning question from one reviewed blueprint read', async () => {
    const answer = '原始素材到导演判断，再记录判断原因、上下文、采用或拒绝、成片位置和最终效果，形成可复核案例并提炼技法；重点学习为什么这样判断。'
    const service = vi.fn().mockResolvedValue({
      ok: true,
      action: 'get',
      table: 'system_blueprint',
      stableId: 'DB-LOOP-CASE',
      found: true,
      record: {
        stableId: 'DB-LOOP-CASE',
        reviewed: true,
        fields: { 内容: answer },
      },
    })
    const tool = createDirectorBrainTool({ context: targetContext, service })
    const result = resultJson(await tool.execute('explain-learning', {
      action: 'explain', topic: 'technique_learning',
    }))

    expect(service).toHaveBeenCalledTimes(1)
    expect(service).toHaveBeenCalledWith({
      action: 'get', table: 'system_blueprint', stableId: 'DB-LOOP-CASE',
    })
    expectHumanContract(result, answer)
    expect(JSON.stringify(result)).not.toContain('DB-LOOP-CASE')
  })

  it('fails closed when the requested blueprint is not reviewed', async () => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true,
        action: 'get',
        table: 'system_blueprint',
        found: true,
        record: { reviewed: false, fields: { 内容: '未审核内容' } },
      }),
    })
    const result = resultJson(await tool.execute('explain-unreviewed', {
      action: 'explain', topic: 'technique_learning',
    }))

    expectHumanContract(result, '导演脑暂时无法读取，请稍后再试。')
  })

  it('resolves a unique title internally and returns a short six-layer answer', async () => {
    const service = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        action: 'resolve_work',
        found: true,
        work: { workId: 'WORK-HIDDEN', name: '冰原纪事' },
      })
      .mockResolvedValueOnce({
        ok: true,
        action: 'workflow',
        readiness: ready,
        nextSuggestion: '可以进入导演复核。',
      })
    const tool = createDirectorBrainTool({ context: targetContext, service })
    const result = resultJson(await tool.execute('unique-title', {
      action: 'workflow', query: '冰原纪事',
    }))

    expect(service).toHaveBeenNthCalledWith(2, { action: 'workflow', workId: 'WORK-HIDDEN' })
    expectHumanContract(
      result,
      '《冰原纪事》的导演脑：6/6 层就绪。六层均已就绪。下一步：可以进入导演复核。',
    )
  })

  it.each([
    {
      name: 'asks for a precise title when the title is ambiguous',
      resolution: { ambiguous: true, matches: [{}, {}] },
      expected: '这个名称对应多个作品。请告诉我更准确的完整作品名。',
    },
    {
      name: 'asks for a precise title when the work does not exist',
      resolution: { found: false, matches: [] },
      expected: '我没有找到这个作品。请告诉我更准确的完整作品名。',
    },
  ])('$name', async ({ resolution, expected }) => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true, action: 'resolve_work', ...resolution,
      }),
    })
    const result = resultJson(await tool.execute('blocked-title', {
      action: 'workflow', query: '冰原',
    }))
    expectHumanContract(result, expected)
  })

  it('summarizes the six-layer overview without exposing service diagnostics', async () => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true,
        action: 'workflow',
        workId: 'WORK-HIDDEN',
        readiness: { ...ready, narrative: false },
        nextSuggestion: '先确认叙事结构。',
        debugPath: '/tmp/director-brain/state.json',
        responseContract: {
          mustQuoteUserVisibleAnswerExactly: true,
          userVisibleAnswer: 'taskId=TASK-HIDDEN state=running',
        },
      }),
    })
    const result = resultJson(await tool.execute('overview', {
      action: 'workflow', workId: 'WORK-HIDDEN',
    }))
    expectHumanContract(
      result,
      '导演脑：5/6 层就绪。未就绪：叙事结构。下一步：先确认叙事结构。',
    )
  })

  it.each([
    {
      name: 'answers a character-change question',
      request: { action: 'search', workId: 'WORK-HIDDEN', table: 'people_profiles', query: '人物变化' },
      answer: '核心人物从坚持独自判断，转向邀请村民共同验证；转折来自第一次公开质疑。',
    },
    {
      name: 'answers a conflict question',
      request: { action: 'search', workId: 'WORK-HIDDEN', table: 'story_nodes', query: '冲突' },
      answer: '最有力的冲突是村民质疑水质数据，与主人公的专业自信正面碰撞。',
    },
    {
      name: 'answers a shot-value question',
      request: { action: 'search', workId: 'WORK-HIDDEN', table: 'material_judgments', query: '镜头价值' },
      answer: '主人公沉默后重新取样的镜头最有价值：它把争执变成行动，也完成了人物转折。',
    },
    {
      name: 'answers a narrative question',
      request: { action: 'search', workId: 'WORK-HIDDEN', table: 'narrative_plans', query: '三段式' },
      answer: '建议按“建立自信—公开质疑—共同验证”三段推进，让人物选择带动主题落点。',
    },
  ])('$name with a short professional answer', async ({ request, answer }) => {
    const action = request.action
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue(reviewedAnswer(action, answer)),
    })
    const result = resultJson(await tool.execute(`dialogue-${request.table}`, request))
    expectHumanContract(result, answer)
    expect(Object.keys(result).sort()).toEqual(['action', 'handled', 'ok', 'responseContract'])
  })

  it('does not expose extraction mutation actions to dialogue', async () => {
    const service = vi.fn()
    const extractionService = vi.fn()
    const tool = createDirectorBrainTool({ context: targetContext, service, extractionService })
    for (const action of ['start_extraction', 'backfill_extraction']) {
      const result = await tool.execute(`reject-${action}`, { action, query: '冰原纪事' })
      expect(result.content[0].text).toBe('导演脑请求参数无效。')
    }
    expect(service).not.toHaveBeenCalled()
    expect(extractionService).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'reports extraction in progress',
      state: 'running',
      expected: '《冰原纪事》正在整理导演知识。',
    },
    {
      name: 'reports a human review gate',
      state: 'awaiting_judgment_review',
      expected: '《冰原纪事》的导演判断已经整理好，正在等你确认。',
    },
    {
      name: 'reports extraction failure',
      state: 'failed',
      expected: '《冰原纪事》的导演知识没有整理完成，可以稍后重试。',
    },
  ])('$name without exposing the internal state', async ({ state, expected }) => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true, action: 'resolve_work', found: true,
        work: { workId: 'WORK-HIDDEN', name: '冰原纪事' },
      }),
      extractionService: vi.fn().mockResolvedValue({
        ok: true,
        action: 'extraction_status',
        state,
        runId: 'RUN-HIDDEN',
        taskId: 'TASK-HIDDEN',
      }),
    })
    const result = resultJson(await tool.execute(`status-${state}`, {
      action: 'extraction_status', query: '冰原纪事',
    }))
    expectHumanContract(result, expected)
  })

  it('fails closed when a downstream short answer contains IDs, state, path, and credentials', async () => {
    const leaked = [
      'workId=WORK-HIDDEN',
      'taskId=TASK-HIDDEN',
      'recordId=RECORD-HIDDEN',
      'state=awaiting_judgment_review',
      'path=/Users/phoenix/private/state.json',
      'token=secret-value',
    ].join(' ')
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue(reviewedAnswer('search', leaked)),
    })
    const result = resultJson(await tool.execute('reject-leak', {
      action: 'search', workId: 'WORK-HIDDEN', table: 'story_nodes', query: '冲突',
    }))
    expectHumanContract(result, '导演脑暂时无法读取，请稍后再试。')
    expect(JSON.stringify(result)).not.toContain(leaked)
  })

  it('fails closed with a stop contract when the read service throws', async () => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockRejectedValue(new Error(
        'record_id=recvrM4UW5oztr path=/Users/phoenix/private/state.json',
      )),
    })
    const result = resultJson(await tool.execute('service-failure', {
      action: 'workflow', workId: 'WORK-HIDDEN',
    }))

    expectHumanContract(result, '导演脑暂时无法读取，请稍后再试。')
    expect(JSON.stringify(result)).not.toMatch(/recvrM4UW5oztr|\/Users\/phoenix|record_id/iu)
  })

  it.each([
    ['UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['short hexadecimal hash', '1a2b3c4'],
    ['32-digit hexadecimal identifier', 'a'.repeat(32)],
    ['40-digit hexadecimal identifier', 'b'.repeat(40)],
    ['64-digit hexadecimal identifier', 'c'.repeat(64)],
    ['Feishu record identifier', 'recvrM4UW5oztr'],
    ['Feishu table identifier', 'tblFOw3ABC123xyZ'],
    ['snake-case record field', 'record_id=opaque-value'],
    ['snake-case table field', 'table_id=opaque-value'],
  ])('fails closed when a downstream answer contains a %s', async (_name, identifier) => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue(reviewedAnswer(
        'search',
        `关键结论对应内部标识 ${identifier}，请直接采用。`,
      )),
    })
    const result = resultJson(await tool.execute('reject-opaque-id', {
      action: 'search', workId: 'WORK-HIDDEN', table: 'story_nodes', query: '冲突',
    }))
    expectHumanContract(result, '导演脑暂时无法读取，请稍后再试。')
    expect(JSON.stringify(result)).not.toContain(identifier)
  })
})
