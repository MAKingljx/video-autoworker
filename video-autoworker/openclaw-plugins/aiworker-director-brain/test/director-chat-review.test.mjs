import { describe, expect, it, vi } from 'vitest'

import {
  createDirectorBrainChatReviewHandler,
  createDirectorReviewSessionStore,
  prepareDirectorBrainReview,
  rememberProposedDirectorBrainRecord,
} from '../lib/director-chat-review.js'
import {
  createDirectorBrainTool,
  normalizeDirectorBrainToolRequest,
} from '../lib/director-brain-tool.js'

const context = {
  agentId: 'second-original',
  sessionId: 'session-review-1',
  sessionKey: 'agent:second-original:session-review-1',
  trigger: 'user',
}

const reviewStore = () => createDirectorReviewSessionStore({ createCode: () => 'ABC123' })

function candidate({
  table = 'story_nodes',
  stableId = 'NODE-INTERNAL-1',
  name = '暴风雪中的决定',
  state = '候选',
  version = 'v0.2.0',
  summary = '',
  start = '',
  end = '',
  workId = 'WORK-INTERNAL-1',
} = {}) {
  const primary = table === 'material_evidence' ? '证据名称' : '节点名称'
  return {
    table,
    stableId,
    state,
    reviewed: false,
    fields: {
      [primary]: name,
      '作品 ID': workId,
      '版本': version,
      ...(summary ? { '证据摘要': summary } : {}),
      ...(start ? { '起始时间码': start } : {}),
      ...(end ? { '结束时间码': end } : {}),
    },
  }
}

function exactGet(record = candidate()) {
  return {
    ok: true, action: 'get', table: record.table, stableId: record.stableId,
    workId: record.fields['作品 ID'], found: true, record,
  }
}

function exactSearch(request, matches) {
  const filtered = matches.filter(record => record.state === request.status)
  return {
    ok: true, action: 'search', table: request.table, workId: request.workId || null,
    query: request.query, status: request.status, limit: request.limit,
    count: filtered.length, matches: filtered, truncated: false,
  }
}

describe('director brain chat review', () => {
  it('resumes a durable review batch after the plugin store is recreated', async () => {
    let batch = null
    const reviewBatch = vi.fn(async request => {
      if (request.action === 'prepare') {
        batch = {
          batchId: 'DRB-PERSISTED', decision: request.decision,
          confirmationCode: 'ABC123', status: 'pending', targets: request.targets,
          itemStatuses: ['pending'], completedCount: 0, unknownCount: 0,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        }
      } else if (request.action === 'claim') {
        batch = { ...batch, status: 'applying' }
      } else if (request.action === 'record') {
        batch = { ...batch, status: 'completed', itemStatuses: ['completed'], completedCount: 1 }
      }
      return batch
    })
    const loadServices = async () => ({ reviewBatch })
    const firstStore = createDirectorReviewSessionStore({ loadServices })
    const target = {
      table: 'material_evidence', stableId: 'EVIDENCE-1', workId: 'WORK-1',
      state: '候选', version: 'v0.2.0', name: '证据一',
    }
    const prepared = await firstStore.prepare(context, 'approve', [target], 'tool-call-1')
    expect(prepared).toMatchObject({ batchId: 'DRB-PERSISTED', code: 'ABC123' })

    const restartedStore = createDirectorReviewSessionStore({ loadServices })
    const claimed = await restartedStore.claim(context, {
      decision: 'approve', code: 'ABC123', count: 1,
    })
    expect(claimed).toMatchObject({ batchId: 'DRB-PERSISTED', itemStatuses: ['pending'] })
    await restartedStore.record(context, claimed, 0, 'completed', { resultVersion: 'v0.2.1' })
    expect(reviewBatch.mock.calls.map(call => call[0].action))
      .toEqual(['prepare', 'claim', 'record'])
  })

  it('recovers a response-lost item from formal readback without repeating the review write', async () => {
    const target = {
      table: 'material_evidence', stableId: 'EVIDENCE-1', workId: 'WORK-INTERNAL-1',
      state: '候选', version: 'v0.2.0', name: '证据一',
    }
    const receipt = {
      kind: 'review', decision: 'approve', code: 'ABC123', batchId: 'DRB-1',
      targets: [target], itemStatuses: ['unknown'], expiresAt: Date.now() + 60_000,
    }
    const store = {
      get: vi.fn(() => null),
      claim: vi.fn(async () => receipt),
      record: vi.fn(async () => ({ status: 'completed' })),
    }
    const executeOperation = vi.fn(async () => exactGet({
      ...candidate({ table: 'material_evidence', stableId: 'EVIDENCE-1' }),
      state: '已核验', reviewed: true,
      fields: {
        ...candidate({ table: 'material_evidence', stableId: 'EVIDENCE-1' }).fields,
        '版本': 'v0.2.1',
      },
    }))
    const reviewRecord = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      releaseReady: true, targetAgentId: 'second-original', store,
      loadServices: async () => ({ executeOperation, reviewRecord }),
    })
    const result = await handler({ cleanedBody: '确认批准批次 ABC123 共1条' }, context)
    expect(result.reason).toBe('director_brain_review_applied')
    expect(reviewRecord).not.toHaveBeenCalled()
    expect(store.record).toHaveBeenCalledWith(
      context, receipt, 0, 'completed', { resultVersion: 'v0.2.1' },
    )
  })


  it('exposes preview only and rejects model-supplied confirmation flags', async () => {
    expect(normalizeDirectorBrainToolRequest({
      action: 'review_preview', decision: 'approve', table: 'story_nodes',
      query: '暴风雪中的决定', workQuery: '冰原纪事',
    })).toEqual({
      action: 'review_preview', decision: 'approve', table: 'story_nodes',
      query: '暴风雪中的决定', workQuery: '冰原纪事',
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'review_preview', decision: 'approve', table: 'story_nodes',
      query: '暴风雪中的决定', workQuery: '冰原纪事', confirmed: true,
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'review_apply', decision: 'approve', table: 'story_nodes',
      query: '暴风雪中的决定', workQuery: '冰原纪事',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'review_preview', decision: 'approve', table: 'material_evidence',
      workQuery: '冰原纪事', batch: true,
    })).toEqual({
      action: 'review_preview', decision: 'approve', table: 'material_evidence',
      workQuery: '冰原纪事', batch: true,
    })

    const store = reviewStore()
    const service = vi.fn(async request => request.action === 'resolve_work'
      ? { ok: true, action: 'resolve_work', found: true, work: { workId: 'WORK-INTERNAL-1', name: '冰原纪事' } }
      : exactSearch(request, [candidate()]))
    const tool = createDirectorBrainTool({ context, service, reviewSessionStore: store })
    const result = JSON.parse((await tool.execute('preview-call', {
      action: 'review_preview', decision: 'approve', table: 'story_nodes',
      query: '暴风雪中的决定', workQuery: '冰原纪事',
    })).content[0].text)
    expect(result.responseContract.userVisibleAnswer).toContain('确认批准批次 ABC123 共1条')
    expect(service).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'review' }))
  })

  it('previews one bound candidate without writing and requires an exact next-turn confirmation', async () => {
    const store = reviewStore()
    const executeOperation = vi.fn(async request => {
      if (request.action === 'resolve_work') {
        return { ok: true, action: 'resolve_work', found: true, work: { workId: 'WORK-INTERNAL-1', name: '冰原纪事' } }
      }
      return exactSearch(request, [candidate()])
    })

    const preview = await prepareDirectorBrainReview({
      request: {
        action: 'review_preview', decision: 'approve', table: 'story_nodes',
        query: '暴风雪中的决定', workQuery: '冰原纪事',
      },
      executeOperation,
      store,
      context,
    })

    expect(preview.outcome).toBe('preview')
    expect(preview.answer).toContain('故事节点“暴风雪中的决定”(候选)')
    expect(preview.answer).toContain('确认批准批次 ABC123 共1条')
    expect(preview.answer).not.toMatch(/WORK-INTERNAL|NODE-INTERNAL|v0\.2\.0/u)
    expect(store.get(context)).toMatchObject({
      kind: 'review', decision: 'approve',
      targets: [{ stableId: 'NODE-INTERNAL-1', version: 'v0.2.0' }],
    })
  })

  it('does not turn an ambiguous lookup into a silent batch', async () => {
    const store = reviewStore()
    const records = [candidate(), candidate({ stableId: 'NODE-INTERNAL-2', name: '暴风雪后的等待' })]
    const preview = await prepareDirectorBrainReview({
      request: {
        action: 'review_preview', decision: 'approve', table: 'story_nodes',
        query: '暴风雪', workQuery: '冰原纪事',
      },
      executeOperation: vi.fn(async request => request.action === 'resolve_work'
        ? { ok: true, action: 'resolve_work', found: true, work: { workId: 'WORK-INTERNAL-1', name: '冰原纪事' } }
        : exactSearch(request, records)),
      store,
      context,
    })

    expect(preview.outcome).toBe('ambiguous')
    expect(preview.answer).toContain('匹配到2条')
    expect(store.get(context)).toBeNull()
  })

  it('binds one explicit 38-record batch after showing every full name and evidence detail', async () => {
    const store = reviewStore()
    const liveWorkId = `DB-WORKS-${'A'.repeat(64)}`
    const records = Array.from({ length: 38 }, (_, index) => candidate({
      table: 'material_evidence',
      stableId: `EVIDENCE-INTERNAL-${index + 1}`,
      name: `${liveWorkId} ${index === 0 ? '全片摘要' : `时间片段 ${index}`}`,
      start: `00:00:${String(index).padStart(2, '0')}.000`,
      end: `00:00:${String(index + 1).padStart(2, '0')}.000`,
      summary: `人物在第${index + 1}个镜头中回应质疑并形成可核对的导演观察`.padEnd(80, '补充'),
      workId: liveWorkId,
    }))
    const service = vi.fn(async request => request.action === 'resolve_work'
      ? { ok: true, action: 'resolve_work', found: true, work: { workId: liveWorkId, name: '冰原纪事' } }
      : exactSearch(request, records))
    const preview = await prepareDirectorBrainReview({
      request: {
        action: 'review_preview', decision: 'approve', table: 'material_evidence',
        workQuery: '冰原纪事', batch: true,
      },
      executeOperation: service,
      store,
      context,
    })

    expect(preview.outcome).toBe('preview')
    expect(preview.answer).toContain('1. 素材证据“全片摘要”')
    expect(preview.answer).toContain('38. 素材证据“时间片段 37”')
    expect(preview.answer).toContain('00:00:37-00:00:38；摘要：人物在第38个镜头中回应质疑')
    expect(preview.answer).not.toContain('.000')
    expect(preview.answer).toContain('确认批准批次 ABC123 共38条')
    expect(preview.answer).not.toContain(liveWorkId)
    expect(Buffer.byteLength(preview.answer, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(store.get(context)?.targets).toHaveLength(38)

    const tool = createDirectorBrainTool({ context, service, reviewSessionStore: store })
    const result = JSON.parse((await tool.execute('preview-38', {
      action: 'review_preview', decision: 'approve', table: 'material_evidence',
      workQuery: '冰原纪事', batch: true,
    })).content[0].text)
    expect(result.responseContract.userVisibleAnswer).toContain('38. 素材证据“时间片段 37”')
    expect(result.responseContract.userVisibleAnswer).not.toContain(liveWorkId)
    expect(result.responseContract.userVisibleAnswer).not.toContain('导演脑暂时无法读取')
  })

  it('applies only after the exact current-user confirmation and uses CAS versions', async () => {
    const store = reviewStore()
    store.prepare(context, 'approve', [{
      table: 'story_nodes', stableId: 'NODE-INTERNAL-1', workId: 'WORK-INTERNAL-1',
      workName: '冰原纪事', name: '暴风雪中的决定', state: '候选', version: 'v0.2.0',
    }])
    const executeOperation = vi.fn().mockResolvedValue(exactGet())
    const reviewRecord = vi.fn()
      .mockResolvedValueOnce({
        ok: true, action: 'review', table: 'story_nodes', stableId: 'NODE-INTERNAL-1',
        workId: 'WORK-INTERNAL-1', previousStatus: '候选', targetStatus: '待审核',
        previousVersion: 'v0.2.0', version: 'v0.2.1',
        record: {
          ...candidate({ state: '待审核', version: 'v0.2.1' }), reviewed: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true, action: 'review', table: 'story_nodes', stableId: 'NODE-INTERNAL-1',
        workId: 'WORK-INTERNAL-1', previousStatus: '待审核', targetStatus: '已确认',
        previousVersion: 'v0.2.1', version: 'v0.2.2',
        record: {
          ...candidate({ state: '已确认', version: 'v0.2.2' }), reviewed: true,
        },
      })
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store,
      loadServices: async () => ({ executeOperation, reviewRecord }),
    })

    await expect(handler({ cleanedBody: '确认批准批次 ABC123 共1条' }, context)).resolves.toEqual({
      handled: true,
      reply: { text: '已批准1条导演脑候选，正式回读均已确认。' },
      reason: 'director_brain_review_applied',
    })
    expect(reviewRecord).toHaveBeenNthCalledWith(1, expect.objectContaining({
      stableId: 'NODE-INTERNAL-1', expectedVersion: 'v0.2.0', targetStatus: '待审核',
    }))
    expect(reviewRecord).toHaveBeenNthCalledWith(2, expect.objectContaining({
      stableId: 'NODE-INTERNAL-1', expectedVersion: 'v0.2.1', targetStatus: '已确认',
    }))
    expect(store.get(context)).toBeNull()
  })

  it('rejects mismatched confirmations without loading review services', async () => {
    const store = reviewStore()
    store.prepare(context, 'approve', [{
      table: 'story_nodes', stableId: 'NODE-INTERNAL-1', workId: 'WORK-INTERNAL-1',
      name: '暴风雪中的决定', state: '候选', version: 'v0.2.0',
    }])
    const loadServices = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store, loadServices,
    })

    const result = await handler({ cleanedBody: '确认驳回批次 ABC123 共1条' }, context)
    expect(result.reason).toBe('director_brain_review_confirmation_mismatch')
    expect(result.reply.text).toContain('本次未更改状态')
    expect(loadServices).not.toHaveBeenCalled()
  })

  it('uses the preview code so a newer preview cannot be approved by an older confirmation', async () => {
    const codes = ['OLD123', 'NEW456']
    const store = createDirectorReviewSessionStore({ createCode: () => codes.shift() })
    const target = {
      table: 'story_nodes', stableId: 'NODE-INTERNAL-1', workId: 'WORK-INTERNAL-1',
      name: '暴风雪中的决定', state: '候选', version: 'v0.2.0',
    }
    store.prepare(context, 'approve', [target])
    store.prepare(context, 'approve', [{ ...target, stableId: 'NODE-INTERNAL-2' }])
    const loadServices = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store, loadServices,
    })

    const result = await handler({ cleanedBody: '确认批准批次 OLD123 共1条' }, context)
    expect(result.reason).toBe('director_brain_review_confirmation_mismatch')
    expect(loadServices).not.toHaveBeenCalled()
    expect(store.get(context)).toMatchObject({ code: 'NEW456' })
  })

  it('cancels only the matching batch in the same user session without loading services', async () => {
    const store = reviewStore()
    store.prepare(context, 'approve', [{
      table: 'story_nodes', stableId: 'NODE-INTERNAL-1', workId: 'WORK-INTERNAL-1',
      name: '暴风雪中的决定', state: '候选', version: 'v0.2.0',
    }])
    const loadServices = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store, loadServices,
    })

    const mismatch = await handler({ cleanedBody: '取消审核批次 BAD999' }, context)
    expect(mismatch.reason).toBe('director_brain_review_cancel_mismatch')
    expect(store.get(context)).toMatchObject({ code: 'ABC123' })
    const cancelled = await handler({ cleanedBody: '取消审核批次 ABC123' }, context)
    expect(cancelled).toEqual({
      handled: true,
      reply: { text: '已取消审核批次 ABC123，没有更改任何导演脑记录。' },
      reason: 'director_brain_review_cancelled',
    })
    expect(store.get(context)).toBeNull()
    expect(loadServices).not.toHaveBeenCalled()
  })

  it('carries a preview from the 9.2 tool requester field into the hook sender field for cancel', async () => {
    const store = reviewStore()
    const toolContext = {
      agentId: 'second-original',
      sessionId: 'session-review-sdk-shape',
      sessionKey: 'agent:second-original:session-review-sdk-shape',
      requesterSenderId: 'feishu-user-1',
      senderIsOwner: true,
    }
    store.prepare(toolContext, 'approve', [{
      table: 'story_nodes', stableId: 'NODE-INTERNAL-1', workId: 'WORK-INTERNAL-1',
      name: '暴风雪中的决定', state: '候选', version: 'v0.2.0',
    }])
    const loadServices = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store, loadServices,
    })
    const hookContext = {
      agentId: toolContext.agentId,
      sessionId: toolContext.sessionId,
      sessionKey: toolContext.sessionKey,
      senderId: toolContext.requesterSenderId,
      trigger: 'user',
    }

    const result = await handler({ cleanedBody: '取消审核批次 ABC123' }, hookContext)
    expect(result.reason).toBe('director_brain_review_cancelled')
    expect(store.get(toolContext)).toBeNull()
    expect(loadServices).not.toHaveBeenCalled()
  })

  it('carries a preview from the 9.2 tool requester field into exact hook confirmation', async () => {
    const store = reviewStore()
    const toolContext = {
      agentId: 'second-original',
      sessionId: 'session-review-sdk-confirm',
      sessionKey: 'agent:second-original:session-review-sdk-confirm',
      requesterSenderId: 'feishu-user-1',
      senderIsOwner: true,
    }
    store.prepare(toolContext, 'approve', [{
      table: 'material_evidence', stableId: 'EVIDENCE-INTERNAL-1',
      workId: 'WORK-INTERNAL-1', name: '全片摘要', state: '候选', version: 'v0.2.0',
    }])
    const source = candidate({
      table: 'material_evidence', stableId: 'EVIDENCE-INTERNAL-1', name: '全片摘要',
    })
    const executeOperation = vi.fn().mockResolvedValue(exactGet(source))
    const reviewRecord = vi.fn().mockResolvedValue({
      ok: true, action: 'review', table: source.table, stableId: source.stableId,
      workId: 'WORK-INTERNAL-1', previousStatus: '候选', targetStatus: '已核验',
      previousVersion: 'v0.2.0', version: 'v0.2.1',
      record: {
        ...candidate({
          table: source.table, stableId: source.stableId, name: '全片摘要',
          state: '已核验', version: 'v0.2.1',
        }),
        reviewed: true,
      },
    })
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store,
      loadServices: async () => ({ executeOperation, reviewRecord }),
    })

    const result = await handler(
      { cleanedBody: '确认批准批次 ABC123 共1条' },
      {
        agentId: toolContext.agentId,
        sessionId: toolContext.sessionId,
        sessionKey: toolContext.sessionKey,
        senderId: toolContext.requesterSenderId,
        trigger: 'user',
      },
    )
    expect(result.reason).toBe('director_brain_review_applied')
    expect(reviewRecord).toHaveBeenCalledTimes(1)
    expect(store.get(toolContext)).toBeNull()
  })

  it('binds confirmation to the same inbound author and ignores non-user triggers', async () => {
    const store = reviewStore()
    const authorContext = { ...context, senderId: 'author-1' }
    store.prepare(authorContext, 'approve', [{
      table: 'story_nodes', stableId: 'NODE-INTERNAL-1', workId: 'WORK-INTERNAL-1',
      name: '暴风雪中的决定', state: '候选', version: 'v0.2.0',
    }])
    const loadServices = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store, loadServices,
    })

    expect(await handler(
      { cleanedBody: '确认批准批次 ABC123 共1条' },
      { ...authorContext, senderId: 'member-2' },
    )).toMatchObject({ reason: 'director_brain_review_confirmation_mismatch' })
    expect(await handler(
      { cleanedBody: '确认批准批次 ABC123 共1条' },
      { ...authorContext, trigger: 'heartbeat' },
    )).toBeUndefined()
    expect(loadServices).not.toHaveBeenCalled()
    expect(store.get(authorContext)).toMatchObject({ kind: 'review' })
  })

  it('treats a spoken addition as a candidate and previews a later bare approval first', async () => {
    const store = reviewStore()
    expect(rememberProposedDirectorBrainRecord({
      result: { ok: true, action: 'propose', table: 'story_nodes', record: candidate() },
      store,
      context,
    })).toBe(true)
    const loadServices = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store, loadServices,
    })

    const result = await handler({ cleanedBody: '批准' }, context)
    expect(result.reason).toBe('director_brain_review_preview')
    expect(result.reply.text).toContain('确认批准批次 ABC123 共1条')
    expect(loadServices).not.toHaveBeenCalled()
    expect(store.get(context)).toMatchObject({ kind: 'review', decision: 'approve' })
  })

  it('fails closed before any write when a bound version changed', async () => {
    const store = reviewStore()
    store.prepare(context, 'approve', [{
      table: 'story_nodes', stableId: 'NODE-INTERNAL-1', workId: 'WORK-INTERNAL-1',
      name: '暴风雪中的决定', state: '候选', version: 'v0.2.0',
    }])
    const reviewRecord = vi.fn()
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store,
      loadServices: async () => ({
        executeOperation: vi.fn().mockResolvedValue(exactGet(candidate({ version: 'v0.2.1' }))),
        reviewRecord,
      }),
    })

    const result = await handler({ cleanedBody: '确认批准批次 ABC123 共1条' }, context)
    expect(result.reply.text).toContain('版本已变化')
    expect(reviewRecord).not.toHaveBeenCalled()
  })

  it('reports exact completed and unprocessed counts after a batch partially fails', async () => {
    const store = reviewStore()
    const first = candidate({ table: 'material_evidence', stableId: 'EVIDENCE-INTERNAL-1', name: '证据一' })
    const second = candidate({ table: 'material_evidence', stableId: 'EVIDENCE-INTERNAL-2', name: '证据二' })
    store.prepare(context, 'approve', [
      { table: first.table, stableId: first.stableId, workId: 'WORK-INTERNAL-1', name: '证据一', state: '候选', version: 'v0.2.0' },
      { table: second.table, stableId: second.stableId, workId: 'WORK-INTERNAL-1', name: '证据二', state: '候选', version: 'v0.2.0' },
    ])
    const executeOperation = vi.fn(async request => exactGet(
      request.stableId === first.stableId ? first : second,
    ))
    const reviewRecord = vi.fn()
      .mockResolvedValueOnce({
        ok: true, action: 'review', table: first.table, stableId: first.stableId,
        workId: 'WORK-INTERNAL-1', previousStatus: '候选', targetStatus: '已核验',
        previousVersion: 'v0.2.0', version: 'v0.2.1',
        record: { ...candidate({
          table: first.table, stableId: first.stableId, name: '证据一',
          state: '已核验', version: 'v0.2.1',
        }), reviewed: true },
      })
      .mockRejectedValueOnce(new Error('feishu_http_error'))
    const handler = createDirectorBrainChatReviewHandler({
      targetAgentId: 'second-original', store,
      loadServices: async () => ({ executeOperation, reviewRecord }),
    })

    const result = await handler({ cleanedBody: '确认批准批次 ABC123 共2条' }, context)
    expect(result.reason).toBe('director_brain_review_partial')
    expect(result.reply.text).toContain('完成1条后停止')
    expect(result.reply.text).toContain('其余1条未处理')
  })
})
