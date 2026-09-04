import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  MAX_AIWORKER_TRANSCRIPT_PROJECTION_BYTES,
  MAX_AIWORKER_TRANSCRIPT_TOOL_CALL_BYTES,
  projectAiworkerMessageBeforeWrite,
  projectAiworkerMessageForTargetAgent,
  projectAiworkerToolCallForTranscript,
  projectAiworkerToolResultForTranscript,
  projectAiworkerToolResultForTargetAgent,
} from '../lib/transcript-tool-result-projection.js'

function toolResult(toolName, text, details = undefined) {
  return {
    toolName,
    toolCallId: 'call-projection-1',
    message: {
      role: 'toolResult',
      toolName,
      toolCallId: 'call-projection-1',
      content: [{ type: 'text', text }],
      details,
      isError: false,
    },
  }
}

describe('AI-worker persisted tool-result projection', () => {
  it('projects a full director result without changing the in-turn result object', () => {
    const event = toolResult('aiworker_director_brain', JSON.stringify({
      ok: true,
      action: 'search',
      observations: [{
        person: '小林',
        conflict: '村民质疑水质数据。',
        action: '小林重新采样并与村民共同验证。',
        privateMetadata: {
          credentialReference: 'KEYCHAIN_REF_MUST_NOT_PERSIST',
          apiKey: 'sk-local-must-not-persist-123456789',
        },
      }],
      fullPayload: 'x'.repeat(32 * 1024),
    }), { privateMetadata: { password: 'must-not-persist' } })
    event.message.receipt = { path: '/Users/private/receipt.json' }
    event.message.businessId = 'task-private-20260904'
    const before = structuredClone(event.message)
    const sourceBytes = Buffer.from(JSON.stringify(before), 'utf8')
    const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex')

    const result = projectAiworkerToolResultForTranscript(event)
    const persistedText = result.message.content[0].text
    const projectedDigest = createHash('sha256')
      .update(Buffer.from(JSON.stringify(result.message), 'utf8'))
      .digest('hex')

    expect(event.message).toEqual(before)
    expect(result.message).not.toBe(event.message)
    expect(Buffer.byteLength(persistedText, 'utf8'))
      .toBeLessThanOrEqual(MAX_AIWORKER_TRANSCRIPT_PROJECTION_BYTES)
    expect(persistedText).toContain('小林')
    expect(persistedText).toContain('村民质疑水质')
    expect(persistedText).not.toMatch(/KEYCHAIN|sk-local|credentialReference|apiKey|password/u)
    expect(result.message.details).toBeUndefined()
    expect(sourceBytes.byteLength).toBeGreaterThan(Buffer.byteLength(persistedText, 'utf8'))
    expect(sourceDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(projectedDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(projectedDigest).not.toBe(sourceDigest)
    expect(JSON.stringify(result.message)).not.toMatch(/schema|authority|sha256|reference/iu)
    expect(JSON.stringify(result.message)).not.toMatch(/receipt|businessId|task-private|\/Users/iu)
  })

  it('keeps safe narrative from a full video report without a metadata receipt', () => {
    const event = toolResult(
      'aiworker_analyze_video',
      '小林先坚持自己的水质判断。\n村民的质疑促使他重新采样，人物从自证转向共同验证。\n'.repeat(400),
    )

    const result = projectAiworkerToolResultForTranscript(event)
    const persistedText = result.message.content[0].text

    expect(Buffer.byteLength(persistedText, 'utf8'))
      .toBeLessThanOrEqual(MAX_AIWORKER_TRANSCRIPT_PROJECTION_BYTES)
    expect(persistedText).toContain('小林')
    expect(persistedText).toContain('共同验证')
    expect(result.message.details).toBeUndefined()
    expect(Buffer.byteLength(event.message.content[0].text, 'utf8')).toBeGreaterThan(24 * 1024)
  })

  it.each([
    '导演判断：一次性口令 123456!',
    '导演判断：验证码为 654321。',
    '导演判断：密码: AbcDef123456。',
    '导演判断：PIN 7788。',
    '导演判断：OTP="opaque-once-value-123"。',
    '导演判断：验证码123456。',
    '导演判断：PIN码7788。',
    '导演判断：验证码：\r\n654321。',
    '导演判断：验证码&#58;123456。',
    '导演判断：OTP=&quot;html-once-value-123&quot;。',
  ])('drops a narrative credential instead of persisting it: %s', (summary) => {
    const result = projectAiworkerToolResultForTranscript(toolResult(
      'aiworker_director_brain',
      JSON.stringify({ summary }),
    ))

    expect(result.message.content[0].text).not.toMatch(
      /123456|654321|AbcDef|7788|opaque-once|html-once/u,
    )
    expect(result.message.content[0].text)
      .toBe('完整结果保留在业务数据源中，需要时可由原工具重新读取。')
  })

  it('keeps ordinary numbered narrative facts that are not credential assignments', () => {
    const result = projectAiworkerToolResultForTranscript(toolResult(
      'aiworker_director_brain',
      JSON.stringify({ summary: '导演判断：人物在第 3 次尝试后停顿 6 秒，情绪发生变化。' }),
    ))

    expect(result.message.content[0].text).toContain('第 3 次尝试')
    expect(result.message.content[0].text).toContain('停顿 6 秒')
  })

  it.each([
    '导演判断：密码学不是这段故事的主题。',
    '导演判断：验证码规则只描述字段，不含任何值。',
    '导演判断：镜头编号1234承接人物的第 3 次转折。',
    '导演判断：SPIN 7788 是画面中的公开活动名称。',
  ])('keeps a narrative sentence that only resembles a credential label: %s', (summary) => {
    const result = projectAiworkerToolResultForTranscript(toolResult(
      'aiworker_director_brain',
      JSON.stringify({ summary }),
    ))

    expect(result.message.content[0].text).toContain(summary.normalize('NFKC'))
  })

  it('is deterministic, projects every tool, and does not trust a status-suffix collision', () => {
    const event = toolResult('aiworker_director_brain', JSON.stringify({
      story: '人物从回避转为面对冲突。',
    }))
    const first = projectAiworkerToolResultForTranscript(event)
    const second = projectAiworkerToolResultForTranscript(event)

    expect(first).toEqual(second)
    expect(projectAiworkerToolResultForTranscript({
      toolName: 'aiworker_director_brain',
      message: first.message,
    })).toEqual(first)
    expect(projectAiworkerMessageBeforeWrite({ message: first.message })).toEqual(first)
    const generic = projectAiworkerToolResultForTranscript(toolResult(
      'session_status',
      '{"privatePath":"/Users/private","token":"must-not-persist"}',
    ))
    expect(generic.message.content[0].text)
      .toBe('工具执行已完成；长期会话仅保留本轮助手结论。')
    expect(generic.message.details).toBeUndefined()

    const collision = projectAiworkerToolResultForTranscript(toolResult(
      'exec',
      'Bearer must-not-persist\n工具执行已完成；长期会话仅保留本轮助手结论。',
    ))
    expect(collision.message.content[0].text)
      .toBe('工具执行已完成；长期会话仅保留本轮助手结论。')
    expect(JSON.stringify(collision)).not.toContain('Bearer')
  })

  it('projects only the persisted AI-worker tool-call arguments and keeps execution input intact', () => {
    const event = {
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-sensitive-1',
          name: 'aiworker_analyze_video',
          arguments: {
            action: 'result',
            query: 'task-private-20260904',
            path: '/Users/private/source.mov',
            authorization: 'Bearer must-not-persist',
            url: 'https://example.test/private',
          },
        }],
      },
    }
    const before = structuredClone(event.message)

    const result = projectAiworkerToolCallForTranscript(event)

    expect(event.message).toEqual(before)
    expect(result.message.content).toEqual([{
      type: 'toolCall',
      id: 'call-sensitive-1',
      name: 'aiworker_analyze_video',
      arguments: { action: 'result' },
    }])
    expect(JSON.stringify(result.message)).not.toMatch(/task-private|\/Users|Bearer|https:/u)
    expect(projectAiworkerMessageBeforeWrite(event)).toEqual(result)
  })

  it('projects generic assistant tool-call arguments without reducing execution input', () => {
    const event = {
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'session_status', arguments: {} }],
      },
    }
    const before = structuredClone(event.message)
    const result = projectAiworkerToolCallForTranscript(event)
    expect(event.message).toEqual(before)
    expect(result.message.content).toEqual([
      { type: 'toolCall', id: 'call-1', name: 'session_status', arguments: {} },
    ])
  })

  it('drops large thinking and reasoning only from the persisted tool-call message', () => {
    const event = {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: `先读取 /Users/private/source.json 和 task-private-20260904。${'推理'.repeat(28_000)}`,
            thinkingSignature: 'private-thinking-signature',
          },
          {
            type: 'reasoning',
            text: 'Bearer must-not-persist',
            encrypted_content: 'private-reasoning-signature',
          },
          {
            type: 'text',
            text: '正在调用内部工具，路径是 /Users/private/source.json。',
            textSignature: 'private-text-signature',
          },
          {
            type: 'toolCall',
            id: 'call-pairing-1',
            name: 'aiworker_director_brain',
            arguments: {
              action: 'search',
              query: 'task-private-20260904',
              path: '/Users/private/source.json',
            },
            partialJson: '{"private":"value"}',
          },
        ],
      },
    }
    const before = structuredClone(event.message)

    const result = projectAiworkerToolCallForTranscript(event)

    expect(event.message).toEqual(before)
    expect(result.message.content).toEqual([
      { type: 'text', text: '正在调用内部工具,路径是[已省略]' },
      {
        type: 'toolCall',
        id: 'call-pairing-1',
        name: 'aiworker_director_brain',
        arguments: { action: 'search' },
      },
    ])
    expect(JSON.stringify(result.message)).not.toMatch(
      /thinking|reasoning|signature|encrypted|\/Users|task-private|Bearer|partialJson/iu,
    )
    expect(Buffer.byteLength(JSON.stringify(result.message), 'utf8'))
      .toBeLessThanOrEqual(MAX_AIWORKER_TRANSCRIPT_TOOL_CALL_BYTES)
    expect(Buffer.byteLength(JSON.stringify(before), 'utf8'))
      .toBeGreaterThan(Buffer.byteLength(JSON.stringify(result.message), 'utf8') * 100)

    const pairedEvent = toolResult(
      'aiworker_director_brain',
      '{"story":"人物从回避转为面对冲突。"}',
    )
    pairedEvent.toolCallId = 'call-pairing-1'
    pairedEvent.message.toolCallId = 'call-pairing-1'
    const pairedResult = projectAiworkerToolResultForTranscript(pairedEvent)
    expect(pairedResult.message.toolCallId).toBe(result.message.content[1].id)
    expect(pairedResult.message.toolName).toBe(result.message.content[1].name)
  })

  it('sanitizes a length-stopped thinking-only message without persisting an empty turn', () => {
    const event = {
      message: {
        role: 'assistant',
        content: [{
          type: 'thinking',
          thinking: `检查 /Users/private/source.json 和 task-private-20260904。${'内部思考'.repeat(4_000)}`,
          thinkingSignature: 'private-thinking-signature',
        }],
        stopReason: 'length',
        api: 'openai-completions',
        provider: 'qwen38-local',
        model: 'default_model',
      },
    }
    const before = structuredClone(event.message)

    const result = projectAiworkerToolCallForTranscript(event)

    expect(event.message).toEqual(before)
    expect(result.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '本轮未生成可复用回复。' }],
    })
    expect(JSON.stringify(result.message)).not.toMatch(
      /thinking|signature|\/Users|task-private|qwen|default_model|length/iu,
    )
  })

  it('keeps an ordinary final answer while removing its private reasoning part', () => {
    const event = {
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '不得落盘的内部推理。' },
          { type: 'text', text: '首页已经完成响应式调整。' },
        ],
        stopReason: 'stop',
      },
    }
    const result = projectAiworkerToolCallForTranscript(event)

    expect(result.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '首页已经完成响应式调整。' }],
    })
    expect(event.message.content).toHaveLength(2)
  })

  it('preserves input-style action and reduces a generic error result to one status line', () => {
    const callEvent = {
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-generic-2',
          name: 'exec',
          input: { action: 'inspect', command: 'printenv', token: 'must-not-persist' },
        }],
      },
    }
    expect(projectAiworkerToolCallForTranscript(callEvent).message.content[0]).toEqual({
      type: 'toolCall',
      id: 'call-generic-2',
      name: 'exec',
      input: { action: 'inspect' },
    })

    const resultEvent = toolResult('exec', 'private command output', { path: '/private/path' })
    resultEvent.message.isError = true
    const result = projectAiworkerToolResultForTranscript(resultEvent)
    expect(result.message.content).toEqual([{
      type: 'text',
      text: '工具执行未完成；长期会话仅保留失败状态。',
    }])
    expect(result.message.details).toBeUndefined()
  })

  it('does not modify non-tool assistant messages', () => {
    expect(projectAiworkerMessageBeforeWrite({
      message: { role: 'assistant', content: [{ type: 'text', text: '人物发生了变化。' }] },
    })).toBeUndefined()
  })

  it('projects a raw tool result when before_message_write is the only effective hook', () => {
    const event = toolResult(
      'exec',
      `${'large private output '.repeat(8_000)}Bearer must-not-persist /Users/private/result.json`,
      { token: 'must-not-persist' },
    )
    const before = structuredClone(event.message)

    const result = projectAiworkerMessageBeforeWrite({ message: event.message })

    expect(event.message).toEqual(before)
    expect(result.message).toEqual({
      role: 'toolResult',
      toolCallId: 'call-projection-1',
      toolName: 'exec',
      content: [{
        type: 'text',
        text: '工具执行已完成；长期会话仅保留本轮助手结论。',
      }],
      isError: false,
    })
    expect(JSON.stringify(result)).not.toMatch(/Bearer|must-not-persist|\/Users|large private/u)
  })

  it('is idempotent when tool_result_persist already projected the message', () => {
    const event = toolResult('aiworker_director_brain', JSON.stringify({
      story: '人物从回避转为面对冲突。',
      privatePath: '/Users/private/source.mov',
    }))
    const first = projectAiworkerToolResultForTranscript(event)
    const second = projectAiworkerMessageBeforeWrite({ message: first.message })
    const third = projectAiworkerMessageBeforeWrite({ message: second.message })

    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(second.message).not.toBe(first.message)
    expect(second.message.toolCallId).toBe(event.message.toolCallId)
    expect(second.message.toolName).toBe(event.message.toolName)
    expect(JSON.stringify(second)).not.toMatch(/\/Users|privatePath/u)
  })

  it('fails closed for a tool result missing its name without inventing a pairing id', () => {
    const event = {
      message: {
        role: 'toolResult',
        toolCallId: 'call-version-skew-1',
        content: [{ type: 'text', text: 'Bearer must-not-persist /Users/private/result.json' }],
        details: { token: 'must-not-persist' },
        isError: true,
      },
    }

    const result = projectAiworkerMessageBeforeWrite(event)

    expect(result.message).toEqual({
      role: 'toolResult',
      toolCallId: 'call-version-skew-1',
      content: [{ type: 'text', text: '工具执行未完成；长期会话仅保留失败状态。' }],
      isError: true,
    })
    expect(JSON.stringify(result)).not.toMatch(/Bearer|must-not-persist|\/Users|details/u)
  })

  it('keeps safe long plain-text answers and Chinese punctuation byte-for-byte unchanged', () => {
    const text = `人物的变化，不只来自冲突；也来自沉默。${'这是可安全复用的导演判断。'.repeat(800)}`
    const event = {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
      },
    }
    const before = structuredClone(event.message)

    expect(projectAiworkerMessageBeforeWrite(event)).toBeUndefined()
    expect(event.message).toEqual(before)
    expect(event.message.content[0].text).toBe(text)
    expect(event.message.content[0].text.length).toBeGreaterThan(2_048)
  })

  it('redacts sensitive plain text only in the persisted copy', () => {
    const safeLongTail = `；人物仍然选择共同验证。${'这段安全判断应完整保留。'.repeat(300)}`
    const event = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `结果在 /Users/private/source.mov，任务 task-private-20260904；详情 https://example.test/private，凭据 Bearer must-not-persist-token。\u0007${safeLongTail}`,
        }],
        stopReason: 'stop',
      },
    }
    const before = structuredClone(event.message)

    const result = projectAiworkerMessageBeforeWrite(event)

    expect(event.message).toEqual(before)
    expect(result.message).not.toBe(event.message)
    expect(JSON.stringify(result.message)).not.toMatch(
      /\/Users|task-private|https:\/\/|Bearer|must-not-persist|\u0007/u,
    )
    expect(result.message.content[0].text).toContain('[已省略]')
    expect(result.message.content[0].text).toContain(safeLongTail)
    expect(result.message.content[0].text.length).toBeGreaterThan(2_048)
  })

  it.each([
    '飞书凭据 bascnAbCdEfGhIjKlMnOpQrStUvWxYz1234567890 已生效。',
    '导演脑配置 app_secret=supersecretvalue123456789 已生效。',
    '登录信息 password:NeverPersistThis123456 已更新。',
    '请求 token = "private-token-value-123456" 已配置。',
    '接口响应 {"access_token":"opaque-secret-value-123456"} 已收到。',
    "本地配置 {'password':'opaque-secret-value-654321'} 已更新。",
    String.raw`响应字符串 {\"access_token\":\"opaque-secret-value-123456\"}`,
    '响应字符串 {&quot;access_token&quot;:&quot;opaque-secret-value-123456&quot;}',
    '响应字符串 {&apos;password&apos;:&apos;opaque-secret-value-123456&apos;}',
    '响应字符串 {&#34;access_token&#34;:&#34;opaque-secret-value-123456&#34;}',
    '响应字符串 {&#39;password&#39;:&#39;opaque-secret-value-123456&#39;}',
    '联系导演 director@example.test，电话 13800138000。',
    '登录所需的一次性口令 123456 已生成。',
  ])('redacts assistant credential and PII from only the persisted copy: %s', (text) => {
    const event = {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
      },
    }
    const before = structuredClone(event.message)

    const result = projectAiworkerMessageBeforeWrite(event)

    expect(event.message).toEqual(before)
    expect(result.message).not.toBe(event.message)
    expect(result.message.content[0].text).toContain('[已省略]')
    expect(JSON.stringify(result.message)).not.toMatch(
      /bascn|supersecret|NeverPersist|private-token|opaque-secret|director@example|13800138000/u,
    )
  })

  it('does not redact credential-field documentation and is idempotent after redaction', () => {
    const safeText = '字段 access_token 用于表示访问令牌，但这里没有给出任何值。'
    expect(projectAiworkerMessageBeforeWrite({
      message: { role: 'assistant', content: [{ type: 'text', text: safeText }] },
    })).toBeUndefined()

    const event = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: String.raw`公开前缀 {\"access_token\":\"opaque-secret-value-123456\"} 公开后缀`,
        }],
      },
    }
    const first = projectAiworkerMessageBeforeWrite(event)
    expect(first.message.content[0].text).toBe('公开前缀 {[已省略]} 公开后缀')
    expect(projectAiworkerMessageBeforeWrite({ message: first.message })).toBeUndefined()
  })

  it('projects only a verified target-agent main or channel session', () => {
    const resultEvent = toolResult(
      'session_status',
      '{"path":"/Users/private","token":"must-not-persist"}',
    )
    const callEvent = {
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-scoped-1',
          name: 'read',
          arguments: { path: '/Users/private/source.json' },
        }],
      },
    }
    const resultBefore = structuredClone(resultEvent.message)
    const callBefore = structuredClone(callEvent.message)

    expect(projectAiworkerToolResultForTargetAgent(
      resultEvent,
      { agentId: 'second-original', sessionKey: 'agent:second-original:main' },
      'second-original',
    )?.message.content[0].text).toContain('长期会话')
    expect(projectAiworkerMessageForTargetAgent(
      callEvent,
      {
        agentId: 'second-original',
        sessionKey: 'agent:second-original:feishu:dm:opaque-conversation',
      },
      'second-original',
    )?.message.content[0]).toEqual({
      type: 'toolCall',
      id: 'call-scoped-1',
      name: 'read',
      arguments: {},
    })
    expect(projectAiworkerToolResultForTargetAgent(
      resultEvent,
      {
        agentId: 'second-original',
        sessionKey: 'agent:second-original:feishu:test-account:direct:opaque-conversation',
      },
      'second-original',
    )?.message.content[0].text).toContain('长期会话')

    for (const context of [
      undefined,
      {},
      { agentId: 'second-original' },
      { agentId: 'other-agent', sessionKey: 'agent:other-agent:main' },
      { agentId: 'second-original', sessionKey: 'agent:other-agent:main' },
      { agentId: 'second-original', sessionKey: 'agent:second-original:cron:job-1' },
      { agentId: 'second-original', sessionKey: 'agent:second-original:acp:run-1' },
      {
        agentId: 'second-original',
        sessionKey: 'agent:second-original:subagent:account:dm:00000000-0000-4000-8000-000000000003',
      },
      { agentId: 'second-original', sessionKey: 'agent:second-original:feishu:dm' },
      { agentId: 'second-original', sessionKey: 'second-original:feishu:dm:opaque' },
      { agentId: 'second-original', sessionKey: 'agent:second-original:feishu:dm:opaque\n' },
    ]) {
      expect(projectAiworkerToolResultForTargetAgent(
        resultEvent,
        context,
        'second-original',
      )).toBeUndefined()
      expect(projectAiworkerMessageForTargetAgent(
        callEvent,
        context,
        'second-original',
      )).toBeUndefined()
    }
    const malformedContext = new Proxy({}, {
      get() {
        throw new Error('malformed-context')
      },
    })
    expect(() => projectAiworkerToolResultForTargetAgent(
      resultEvent,
      malformedContext,
      'second-original',
    )).not.toThrow()
    expect(projectAiworkerToolResultForTargetAgent(
      resultEvent,
      malformedContext,
      'second-original',
    )).toBeUndefined()
    expect(resultEvent.message).toEqual(resultBefore)
    expect(callEvent.message).toEqual(callBefore)
  })

  it('rejects an official same-agent subagent session key', () => {
    const event = {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'app_secret=subagent-secret-value-123456' }],
      },
    }
    const before = structuredClone(event.message)
    const result = projectAiworkerMessageForTargetAgent(event, {
      agentId: 'second-original',
      sessionKey: 'agent:second-original:subagent:00000000-0000-4000-8000-000000000001',
    }, 'second-original')

    expect(event.message).toEqual(before)
    expect(result).toBeUndefined()
    expect(projectAiworkerMessageForTargetAgent(event, {
      agentId: 'other-agent',
      sessionKey: 'agent:other-agent:subagent:00000000-0000-4000-8000-000000000002',
    }, 'second-original')).toBeUndefined()
  })

  it('keeps 300 tool-call pairings in order and strips arguments, input, and synthetic metadata', () => {
    const content = Array.from({ length: 300 }, (_, index) => ({
      type: 'toolCall',
      id: `call-${index}`,
      name: index % 2 === 0 ? 'read' : 'aiworker_director_brain',
      ...(index % 2 === 0
        ? { arguments: { action: index % 4 === 0 ? 'search' : 'INVALID-ACTION', path: `/Users/private/${index}.json` } }
        : { input: { action: 'result', query: `task-private-${index}` } }),
      synthetic: true,
      partialJson: '{"private":true}',
      signature: 'must-not-persist',
    }))
    const event = { message: { role: 'assistant', content } }
    const result = projectAiworkerToolCallForTranscript(event)

    expect(result.message.content).toHaveLength(300)
    expect(result.message.content).toEqual(content.map((item, index) => ({
      type: 'toolCall',
      id: item.id,
      name: item.name,
      ...(index % 2 === 0
        ? { arguments: index % 4 === 0 ? { action: 'search' } : {} }
        : { input: { action: 'result' } }),
    })))
    expect(JSON.stringify(result)).not.toMatch(/synthetic|partialJson|signature|\/Users|task-private|INVALID-ACTION/iu)
    expect(Buffer.byteLength(JSON.stringify(result.message), 'utf8'))
      .toBeLessThanOrEqual(MAX_AIWORKER_TRANSCRIPT_TOOL_CALL_BYTES)
  })

  it('is total for oversized and malformed persistence inputs and contains no throw path', async () => {
    const oversized = {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `公开说明 ${'内容'.repeat(100_000)} /Users/private/source.json` },
          { type: 'toolCall', id: 'call-total-1', name: 'read', arguments: { path: '/private' } },
        ],
      },
    }
    expect(() => projectAiworkerToolCallForTranscript(oversized)).not.toThrow()
    expect(projectAiworkerToolCallForTranscript(oversized).message.content.at(-1)).toEqual({
      type: 'toolCall', id: 'call-total-1', name: 'read', arguments: {},
    })

    const cyclic = toolResult('aiworker_director_brain', '{"story":"人物面对冲突。"}')
    cyclic.message.details = cyclic.message
    expect(() => projectAiworkerToolResultForTranscript(cyclic)).not.toThrow()

    const source = await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('../lib/transcript-tool-result-projection.js', import.meta.url),
      'utf8',
    ))
    expect(source).not.toMatch(/\bthrow\b/u)
  })

  it('fails closed for a malformed toolCall instead of persisting its arguments unchanged', () => {
    const event = {
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: null,
          name: '',
          arguments: {
            path: '/Users/private/source.json',
            token: 'must-not-persist',
          },
          synthetic: true,
        }],
      },
    }
    const result = projectAiworkerToolCallForTranscript(event)
    expect(result.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '本轮未生成可复用回复。' }],
    })
    expect(JSON.stringify(result)).not.toMatch(/arguments|synthetic|\/Users|must-not-persist/iu)
  })

  it('retains already verified pairing envelopes when a later projection field fails', () => {
    const brokenPart = new Proxy({}, {
      get() {
        throw new Error('malformed-part')
      },
    })
    const assistant = projectAiworkerToolCallForTranscript({
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-safe-before-failure',
            name: 'read',
            arguments: { action: 'inspect', path: '/Users/private/source.json' },
          },
          brokenPart,
        ],
      },
    })
    expect(assistant.message.content).toEqual([{
      type: 'toolCall',
      id: 'call-safe-before-failure',
      name: 'read',
      arguments: { action: 'inspect' },
    }])

    const message = {
      role: 'toolResult',
      toolCallId: 'call-result-before-failure',
      toolName: 'exec',
      content: [],
      get isError() {
        throw new Error('malformed-result')
      },
    }
    const result = projectAiworkerToolResultForTranscript({ toolName: 'exec', message })
    expect(result.message.toolCallId).toBe('call-result-before-failure')
    expect(result.message.toolName).toBe('exec')
    expect(result.message.isError).toBe(true)
  })
})
