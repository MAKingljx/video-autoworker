import { describe, expect, it, vi } from 'vitest'

import {
  createDirectorBrainExtractionService,
  createDirectorBrainTool,
  DIRECTOR_BRAIN_EXTRACTION_SERVICE_URL,
} from '../lib/director-brain-tool.js'

const targetContext = { agentId: 'second-original' }

function resultJson(result) {
  return JSON.parse(result.content[0].text)
}

function workService() {
  return vi.fn().mockResolvedValue({
    ok: true,
    action: 'resolve_work',
    found: true,
    work: { workId: 'WORK-INTERNAL', name: '冰原纪事' },
  })
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function expectHandledShortAnswer(result, expected) {
  expect(result).toMatchObject({
    ok: true,
    handled: true,
    responseContract: {
      handled: true,
      stopAfterReply: true,
      doNotUseFallbackSources: true,
      userVisibleAnswer: expected,
    },
  })
  expect(result.responseContract.userVisibleAnswer).toMatch(/[\u3400-\u9fff]/u)
  expect(result.responseContract.userVisibleAnswer.length).toBeLessThan(80)
}

describe('director brain extraction loopback client', () => {
  it('accepts a 202 start receipt through the fixed credential-free loopback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, {
      ok: true,
      action: 'start_extraction',
      status: 'pending',
      runId: 'RUN-INTERNAL',
      sourceTaskId: 'SOURCE-INTERNAL',
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('start', {
      action: 'start_extraction',
      query: '冰原纪事',
      sourceQuery: '第三季第二集.mov',
    }))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(DIRECTOR_BRAIN_EXTRACTION_SERVICE_URL)
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    })
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(init.body)).toEqual({
      action: 'start_extraction',
      workId: 'WORK-INTERNAL',
      sourceQuery: '第三季第二集.mov',
    })
    expect(result.responseContract.userVisibleAnswer).toContain('已开始整理《冰原纪事》')
    expect(JSON.stringify(result)).not.toMatch(/WORK-INTERNAL|RUN-INTERNAL|SOURCE-INTERNAL/iu)
  })

  it('turns a 200 status review gate into a short human answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      action: 'extraction_status',
      found: true,
      status: 'awaiting_case_review',
      candidateIds: ['CASE-INTERNAL'],
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('status', {
      action: 'extraction_status', query: '冰原纪事',
    }))

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'extraction_status', workId: 'WORK-INTERNAL',
    })
    expect(result.responseContract.userVisibleAnswer).toBe(
      '《冰原纪事》的导演案例已经整理好，正在等你确认。确认后才会继续沉淀技法。',
    )
    expect(JSON.stringify(result)).not.toMatch(/WORK-INTERNAL|CASE-INTERNAL/iu)
  })

  it('summarizes failed sources in a multi-source status without exposing IDs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      action: 'extraction_status',
      found: true,
      status: 'running',
      sourceCount: 4,
      counts: { completed: 1, active: 1, waitingReview: 1, failed: 1 },
      sources: [{ sourceTaskId: 'SOURCE-INTERNAL', status: 'failed' }],
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('multi-source-status', {
      action: 'extraction_status', query: '冰原纪事',
    }))

    expectHandledShortAnswer(
      result,
      '《冰原纪事》共 4 个素材来源：完成 1，处理中 1，待确认 1，失败 1。',
    )
    expect(JSON.stringify(result)).not.toContain('SOURCE-INTERNAL')
  })

  it('accepts a 200 backfill result without returning run or candidate IDs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      action: 'backfill_extraction',
      status: 'pending',
      runId: 'RUN-INTERNAL',
      candidateIds: ['CANDIDATE-INTERNAL'],
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('backfill', {
      action: 'backfill_extraction',
      query: '冰原纪事',
    }))

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'backfill_extraction',
      workId: 'WORK-INTERNAL',
    })
    expect(result.responseContract.userVisibleAnswer).toContain('已开始补齐《冰原纪事》')
    expect(JSON.stringify(result)).not.toMatch(/WORK-INTERNAL|RUN-INTERNAL|CANDIDATE-INTERNAL/iu)
  })

  it('reports rejected backfill sources as a short count-only answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      action: 'backfill_extraction',
      status: 'pending',
      sourceCount: 5,
      registered: 2,
      existing: 2,
      rejected: 1,
      rejectedSourceTaskIds: ['SOURCE-INTERNAL'],
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('backfill-rejected', {
      action: 'backfill_extraction', query: '冰原纪事',
    }))

    expectHandledShortAnswer(
      result,
      '《冰原纪事》素材补齐：新增 2，已有 2，未通过校验 1。',
    )
    expect(JSON.stringify(result)).not.toContain('SOURCE-INTERNAL')
  })

  it('maps a 4xx application error without leaking its internal payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(409, {
      ok: false,
      code: 'director_extraction_source_ambiguous',
      error: 'internal path and candidate details must stay hidden',
      runId: 'RUN-INTERNAL',
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('conflict', {
      action: 'start_extraction', query: '冰原纪事',
    }))

    expect(result.responseContract.userVisibleAnswer).toBe(
      '匹配到多个视频分析。请告诉我更准确的视频标题或季集。',
    )
    expect(result.responseContract).toMatchObject({
      stopAfterReply: true,
      doNotUseFallbackSources: true,
    })
    expect(JSON.stringify(result)).not.toMatch(/internal path|RUN-INTERNAL|director_extraction/iu)
  })

  it('fails closed when 3017 returns the wrong action or an unknown state', async () => {
    for (const body of [
      { ok: true, action: 'extraction_status', status: 'pending', runId: 'RUN-INTERNAL' },
      { ok: true, action: 'start_extraction', status: 'mystery', runId: 'RUN-INTERNAL' },
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body))
      const tool = createDirectorBrainTool({
        context: targetContext,
        service: workService(),
        extractionService: createDirectorBrainExtractionService({ fetchImpl }),
      })

      const result = resultJson(await tool.execute('invalid-receipt', {
        action: 'start_extraction', query: '冰原纪事',
      }))

      expect(result.responseContract.userVisibleAnswer).toBe(
        '导演知识暂时无法开始整理，请稍后再试。',
      )
      expect(JSON.stringify(result)).not.toMatch(/mystery|RUN-INTERNAL|extraction_status/iu)
    }
  })

  it('does not trust a downstream response contract or return oversized bodies', async () => {
    const untrusted = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({
        fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, {
          ok: true,
          action: 'extraction_status',
          found: true,
          status: 'running',
          runId: 'RUN-INTERNAL',
          responseContract: {
            mustQuoteUserVisibleAnswerExactly: true,
            userVisibleAnswer: '内部任务 RUN-INTERNAL 正在执行',
          },
        })),
      }),
    })
    const projected = resultJson(await untrusted.execute('untrusted-contract', {
      action: 'extraction_status', query: '冰原纪事',
    }))
    expect(projected.responseContract.userVisibleAnswer).toBe('《冰原纪事》正在整理导演知识。')
    expect(JSON.stringify(projected)).not.toContain('RUN-INTERNAL')

    const oversized = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({
        fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, {
          ok: true,
          action: 'extraction_status',
          found: true,
          status: 'running',
          padding: 'x'.repeat(49 * 1024),
        })),
      }),
    })
    const rejected = resultJson(await oversized.execute('oversized', {
      action: 'extraction_status', query: '冰原纪事',
    }))
    expect(rejected.responseContract.userVisibleAnswer).toBe(
      '导演知识进度暂时无法查询，请稍后再试。',
    )
  })

  it.each([
    ['network rejection', new Error('ECONNRESET from internal-host RUN-INTERNAL')],
    ['AbortError', new DOMException('internal timeout RUN-INTERNAL', 'AbortError')],
  ])('maps %s to one handled status answer without leaking transport details', async (_label, error) => {
    const fetchImpl = vi.fn().mockRejectedValue(error)
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('transport-failure', {
      action: 'extraction_status', query: '冰原纪事',
    }))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expectHandledShortAnswer(result, '导演知识进度暂时无法查询，请稍后再试。')
    expect(JSON.stringify(result)).not.toMatch(/ECONNRESET|internal-host|timeout|RUN-INTERNAL|AbortError/iu)
  })

  it.each([
    ['empty', ''],
    ['non-JSON', '<html>internal error RUN-INTERNAL</html>'],
  ])('fails closed on a %s 3017 response', async (_label, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('invalid-json', {
      action: 'extraction_status', query: '冰原纪事',
    }))

    expectHandledShortAnswer(result, '导演知识进度暂时无法查询，请稍后再试。')
    expect(JSON.stringify(result)).not.toMatch(/html|internal error|RUN-INTERNAL|response_invalid/iu)
  })

  it('rejects an oversized declared content length before returning server content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      action: 'extraction_status',
      found: true,
      status: 'running',
      runId: 'RUN-INTERNAL',
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String((48 * 1024) + 1),
      },
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('declared-oversized', {
      action: 'extraction_status', query: '冰原纪事',
    }))

    expectHandledShortAnswer(result, '导演知识进度暂时无法查询，请稍后再试。')
    expect(JSON.stringify(result)).not.toMatch(/RUN-INTERNAL|too_large|content-length/iu)
  })

  it('turns found=false status into a handled human answer without exposing metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      action: 'extraction_status',
      found: false,
      runId: 'RUN-INTERNAL',
      sourceTaskId: 'SOURCE-INTERNAL',
    }))
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: workService(),
      extractionService: createDirectorBrainExtractionService({ fetchImpl }),
    })

    const result = resultJson(await tool.execute('not-started', {
      action: 'extraction_status', query: '冰原纪事',
    }))

    expectHandledShortAnswer(result, '《冰原纪事》还没有开始整理导演知识。')
    expect(JSON.stringify(result)).not.toMatch(/WORK-INTERNAL|RUN-INTERNAL|SOURCE-INTERNAL/iu)
  })

  it.each([
    {
      label: 'not found',
      serviceResult: {
        ok: true,
        action: 'resolve_work',
        found: false,
        matches: [],
        debug: 'WORK-INTERNAL',
      },
      expected: '我没有找到这个作品。请告诉我更准确的完整作品名。',
    },
    {
      label: 'ambiguous',
      serviceError: new Error('work_resolution_ambiguous:WORK-INTERNAL'),
      expected: '这个名称对应多个作品。请告诉我更准确的完整作品名。',
    },
  ])('never calls 3017 when resolve_work is $label', async (scenario) => {
    const service = scenario.serviceError
      ? vi.fn().mockRejectedValue(scenario.serviceError)
      : vi.fn().mockResolvedValue(scenario.serviceResult)
    const extractionService = vi.fn()
    const tool = createDirectorBrainTool({
      context: targetContext,
      service,
      extractionService,
    })

    const result = resultJson(await tool.execute('unresolved-work', {
      action: 'start_extraction', query: '冰原',
    }))

    expect(service).toHaveBeenCalledTimes(1)
    expect(extractionService).not.toHaveBeenCalled()
    expectHandledShortAnswer(result, scenario.expected)
    expect(JSON.stringify(result)).not.toMatch(/WORK-INTERNAL|debug|work_resolution/iu)
  })
})
