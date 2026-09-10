import { describe, expect, it, vi } from 'vitest'
import {
  createDirectorBrainTool,
  DIRECTOR_BRAIN_REVIEW_GUIDANCE,
  normalizeDirectorBrainToolRequest,
  reportDirectorBrainFailure,
} from '../lib/director-brain-tool.js'
import {
  createDirectorBrainSystemQuestionHandler,
  isDirectorBrainReviewRequest,
} from '../lib/director-system-question-router.js'

describe('director review guidance and private diagnostics', () => {
  it('answers review requests without reading or writing business records', async () => {
    const service = vi.fn(() => { throw new Error('must_not_access_business_records') })
    const tool = createDirectorBrainTool({ context: { agentId: 'second-original' }, service })
    const result = JSON.parse((await tool.execute('test', { action: 'review_guidance' })).content[0].text)
    expect(result.responseContract.userVisibleAnswer).toBe(DIRECTOR_BRAIN_REVIEW_GUIDANCE)
    expect(result.responseContract.stopAfterReply).toBe(true)
    expect(service).not.toHaveBeenCalled()
    expect(normalizeDirectorBrainToolRequest({ action: 'review_guidance', workId: 'unneeded' })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({ action: 'approve' })).toBeNull()
  })

  it('leaves explicit review requests to review_preview while keeping unrelated and quoted requests out', async () => {
    const service = vi.fn()
    const handler = createDirectorBrainSystemQuestionHandler({ targetAgentId: 'second-original', service })
    expect(isDirectorBrainReviewRequest('请批准导演脑的作品候选')).toBe(true)
    expect(await handler(
      { cleanedBody: '请批准导演脑的作品候选' },
      { agentId: 'second-original', trigger: 'user' },
    )).toBeUndefined()
    for (const text of ['批准', '批准这个视频任务', '不要批准导演脑候选', '如果我说批准导演脑候选', '“批准导演脑候选”是什么意思', '批准导演脑候选然后启动视频任务']) {
      expect(isDirectorBrainReviewRequest(text), text).toBe(false)
    }
    expect(await handler({ cleanedBody: '批准导演脑候选' }, { agentId: 'another-agent', trigger: 'user' })).toBeUndefined()
    expect(service).not.toHaveBeenCalled()
  })

  it('logs only whitelisted error codes and leaves user replies free of runtime details', async () => {
    const onDiagnostic = vi.fn()
    const tool = createDirectorBrainTool({
      context: { agentId: 'second-original' }, onDiagnostic,
      service: async () => { throw new Error('director_brain_keychain_unavailable') },
    })
    const result = await tool.execute('private-call-id', { action: 'health' })
    expect(onDiagnostic).toHaveBeenCalledTimes(1)
    expect(onDiagnostic).toHaveBeenCalledWith({
      schema: 'aiworker-director-diagnostic/v1', action: 'health', code: 'director_brain_keychain_unavailable',
    })
    expect(JSON.stringify(result)).not.toContain('keychain')
    onDiagnostic.mockClear()
    reportDirectorBrainFailure(new Error('private response body and credentials'), 'private-action', onDiagnostic)
    expect(onDiagnostic).toHaveBeenCalledTimes(1)
    expect(onDiagnostic).toHaveBeenCalledWith({
      schema: 'aiworker-director-diagnostic/v1', action: 'unknown', code: 'unexpected_error',
    })
    onDiagnostic.mockClear()
    reportDirectorBrainFailure(new Error('feishu_http_error:403:private API response'), 'search', onDiagnostic)
    expect(onDiagnostic).toHaveBeenCalledWith({
      schema: 'aiworker-director-diagnostic/v1', action: 'search', code: 'feishu_http_error:403',
    })
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private')
    expect(() => reportDirectorBrainFailure(new Error('failure'), 'health', () => { throw new Error('logger_failed') })).not.toThrow()
  })

  it('does not blame candidate content when credentials are missing', async () => {
    const tool = createDirectorBrainTool({
      context: { agentId: 'second-original' },
      service: async () => { throw new Error('director_brain_keychain_secret_missing') },
    })
    const result = await tool.execute('test', { action: 'health' })
    expect(JSON.stringify(result)).toContain('导演脑暂时无法读取')
    expect(JSON.stringify(result)).not.toContain('候选内容不符合')
  })
})
