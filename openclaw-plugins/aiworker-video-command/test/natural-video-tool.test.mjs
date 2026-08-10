import { describe, expect, it, vi } from 'vitest'

import {
  createNaturalVideoToolRuntime,
  NATURAL_VIDEO_RUN_NAMESPACE,
  NATURAL_VIDEO_TOOL_NAME,
} from '../lib/natural-video-tool.js'

function createRunContext() {
  const values = new Map()
  const key = ({ runId, namespace }) => `${runId}\0${namespace}`
  return {
    values,
    setRunContext(patch) {
      values.set(key(patch), structuredClone(patch.value))
      return true
    },
    getRunContext(params) {
      return values.get(key(params))
    },
    clearRunContext(params) {
      values.delete(key({ runId: params.runId, namespace: params.namespace }))
    },
  }
}

const promptContext = {
  agentId: 'second-original',
  sessionKey: 'agent:second-original:telegram:direct:owner',
  runId: 'run-1',
  messageProvider: 'telegram',
  channel: '123456789',
  trigger: 'manual',
}

const toolContext = {
  agentId: 'second-original',
  sessionKey: promptContext.sessionKey,
  messageChannel: 'telegram',
  senderIsOwner: true,
}

function targetCall(overrides = {}) {
  return {
    event: {
      toolName: NATURAL_VIDEO_TOOL_NAME,
      params: { videoPath: '/tmp/demo.mp4' },
      runId: 'run-1',
      toolCallId: 'call-1',
      ...overrides.event,
    },
    context: {
      agentId: 'second-original',
      sessionKey: promptContext.sessionKey,
      runId: 'run-1',
      toolName: NATURAL_VIDEO_TOOL_NAME,
      toolCallId: 'call-1',
      ...overrides.context,
    },
  }
}

function dispatchNaturalRequest(runtime, {
  content = '帮我分析一下这个视频 /tmp/demo.mp4',
  senderId = 'owner-id',
  timestamp = 1_786_240_000_123,
  event = {},
  context = {},
} = {}) {
  const inboundEvent = {
    content,
    channel: 'telegram',
    isGroup: false,
    sessionKey: promptContext.sessionKey,
    senderId,
    timestamp,
    ...event,
  }
  const inboundContext = {
    channelId: 'telegram',
    accountId: 'account-id',
    conversationId: 'conversation-id',
    sessionKey: promptContext.sessionKey,
    senderId,
    ...context,
  }
  runtime.beforeDispatch(inboundEvent, inboundContext)
  return { inboundEvent, inboundContext }
}

describe('guarded natural-language video tool', () => {
  it('admits one model tool call, pins its path, and runs the submission once', async () => {
    const runContext = createRunContext()
    const runner = vi.fn(async ({ taskId }) => ({ taskId, status: 'accepted', duplicate: false }))
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })

    const { inboundEvent } = dispatchNaturalRequest(runtime)
    const productionPromptContext = { ...promptContext, trigger: 'user' }

    const promptResult = runtime.beforePromptBuild(
      { prompt: inboundEvent.content, messages: [] },
      productionPromptContext,
    )
    expect(promptResult.appendContext).toContain(NATURAL_VIDEO_TOOL_NAME)
    const hostState = runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })
    expect(hostState).toMatchObject({
      version: 1,
      kind: 'match',
      runId: 'run-1',
      agentId: 'second-original',
      channel: 'telegram',
      sessionKey: promptContext.sessionKey,
      videoPath: '/tmp/demo.mp4',
      identitySource: 'telegram-inbound',
      senderId: 'owner-id',
    })
    expect(Object.keys(hostState).sort()).toEqual([
      'agentId', 'channel', 'createdAt', 'identitySource', 'kind', 'runId',
      'senderId', 'sessionKey', 'taskId', 'version', 'videoPath',
    ].sort())

    const otherTool = runtime.beforeToolCall({
      toolName: 'memory_search', params: {}, runId: 'run-1', toolCallId: 'memory-1',
    }, {
      agentId: 'second-original', sessionKey: promptContext.sessionKey,
      runId: 'run-1', toolName: 'memory_search', toolCallId: 'memory-1',
    })
    expect(otherTool).toMatchObject({ block: true })

    const call = targetCall()
    expect(runtime.beforeToolCall(call.event, call.context)).toEqual({
      params: { videoPath: '/tmp/demo.mp4' },
    })
    const tool = runtime.createTool(toolContext)
    const [first, second] = await Promise.all([
      tool.execute('call-1', { videoPath: '/tmp/demo.mp4' }),
      tool.execute('call-1', { videoPath: '/tmp/demo.mp4' }),
    ])

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0]).toMatchObject({ videoPath: '/tmp/demo.mp4' })
    expect(runner.mock.calls[0][0].taskId).toMatch(/^video-natural-[a-f0-9]{64}$/u)
    expect(first).toEqual(second)
    expect(first.content[0].text).toMatch(
      /^已提交：taskId=video-natural-[a-f0-9]{64}，status=accepted，duplicate=false。$/u,
    )

    const secondCall = targetCall({
      event: { toolCallId: 'call-2' },
      context: { toolCallId: 'call-2' },
    })
    expect(runtime.beforeToolCall(secondCall.event, secondCall.context)).toMatchObject({ block: true })
    expect(runner).toHaveBeenCalledTimes(1)

    runtime.cleanupRun('run-1')
    expect(runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })).toBeUndefined()
  })

  it('blocks mismatched paths, identities, and call identifiers before execution', () => {
    const runContext = createRunContext()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })
    runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    )

    for (const call of [
      targetCall({ event: { params: { videoPath: '/tmp/other.mp4' } } }),
      targetCall({ context: { sessionKey: 'different-session' } }),
      targetCall({ context: { sessionKey: undefined } }),
      targetCall({ context: { agentId: undefined } }),
      targetCall({ event: { runId: 'different-run' } }),
      targetCall({ event: { runId: undefined } }),
      targetCall({ context: { runId: undefined } }),
      targetCall({ event: { toolCallId: undefined } }),
      targetCall({ context: { toolCallId: undefined } }),
      targetCall({ event: { toolCallId: undefined }, context: { toolCallId: undefined } }),
      targetCall({ event: { toolName: undefined } }),
      targetCall({ context: { toolName: undefined } }),
      targetCall({ context: { toolName: 'memory_search' } }),
    ]) {
      expect(runtime.beforeToolCall(call.event, call.context)).toMatchObject({ block: true })
    }
  })

  it('keeps manual one-shot QA independent from inbound dispatch state', () => {
    const runContext = createRunContext()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })

    expect(runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    ).appendContext).toContain(NATURAL_VIDEO_TOOL_NAME)
    expect(runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })).toMatchObject({
      kind: 'match',
      identitySource: 'manual-qa',
      senderId: 'manual-qa',
    })
    const call = targetCall()
    expect(runtime.beforeToolCall(call.event, call.context)).toEqual({
      params: { videoPath: '/tmp/demo.mp4' },
    })
  })

  it.each([
    ['missing', runContext => runContext.clearRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })],
    ['read failure', runContext => {
      runContext.getRunContext = () => {
        throw new Error('host read unavailable')
      }
    }],
    ['divergence', runContext => {
      const state = runContext.getRunContext({
        runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
      })
      runContext.setRunContext({
        runId: 'run-1',
        namespace: NATURAL_VIDEO_RUN_NAMESPACE,
        value: { ...state, senderId: 'different-sender' },
      })
    }],
  ])('blocks target execution when authorized host state has a %s', (_label, mutateHost) => {
    const runContext = createRunContext()
    const runner = vi.fn()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    )

    mutateHost(runContext)
    const call = targetCall()
    expect(runtime.beforeToolCall(call.event, call.context)).toMatchObject({ block: true })
    expect(runner).not.toHaveBeenCalled()
  })

  it.each([
    ['missing required field', state => {
      delete state.senderId
    }],
    ['unexpected field', state => {
      state.unexpected = true
    }],
  ])('requires the complete exact host-state schema: %s', (_label, mutateState) => {
    const runContext = createRunContext()
    const runner = vi.fn()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    )
    const state = runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })
    mutateState(state)
    runContext.setRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE, value: state,
    })

    const call = targetCall()
    expect(runtime.beforeToolCall(call.event, call.context)).toMatchObject({ block: true })
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not authorize a complete host state without this runtime local binding', () => {
    const runContext = createRunContext()
    const seeder = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })
    seeder.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    )
    const runner = vi.fn()
    const unboundRuntime = createNaturalVideoToolRuntime({ runContext, runner })

    const call = targetCall()
    expect(unboundRuntime.beforeToolCall(call.event, call.context)).toMatchObject({ block: true })
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed when identical pending messages make same-session identity ambiguous', () => {
    const runContext = createRunContext()
    const runner = vi.fn()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    const first = dispatchNaturalRequest(runtime)
    dispatchNaturalRequest(runtime, { timestamp: first.inboundEvent.timestamp + 1 })

    expect(runtime.beforePromptBuild(
      { prompt: first.inboundEvent.content, messages: [] },
      { ...promptContext, trigger: 'user' },
    ).appendContext).toContain('不得调用任何工具')
    expect(runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })).toMatchObject({ kind: 'blocked', reason: 'inbound_identity_ambiguous' })
    const call = targetCall()
    expect(runtime.beforeToolCall(call.event, call.context)).toMatchObject({ block: true })
    expect(runner).not.toHaveBeenCalled()
  })

  it('binds queued same-path messages by exact content instead of arrival order', () => {
    const runContext = createRunContext()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })
    const first = dispatchNaturalRequest(runtime, {
      content: '帮我分析一下这个视频 /tmp/demo.mp4',
      timestamp: 1_786_240_000_123,
    })
    const second = dispatchNaturalRequest(runtime, {
      content: '请帮我处理这个视频 /tmp/demo.mp4',
      timestamp: 1_786_240_000_124,
    })

    runtime.beforePromptBuild(
      { prompt: second.inboundEvent.content, messages: [] },
      { ...promptContext, runId: 'run-2', trigger: 'user' },
    )
    const secondState = runContext.getRunContext({
      runId: 'run-2', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })
    runtime.beforePromptBuild(
      { prompt: first.inboundEvent.content, messages: [] },
      { ...promptContext, runId: 'run-1', trigger: 'user' },
    )
    const firstState = runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })

    expect(firstState).toMatchObject({ kind: 'match', videoPath: '/tmp/demo.mp4' })
    expect(secondState).toMatchObject({ kind: 'match', videoPath: '/tmp/demo.mp4' })
    expect(firstState.taskId).not.toBe(secondState.taskId)
  })

  it('requires a trusted inbound sender identity for production requests', () => {
    const runContext = createRunContext()
    const runner = vi.fn()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    const { inboundEvent } = dispatchNaturalRequest(runtime, {
      event: { senderId: undefined },
      context: { senderId: undefined },
    })

    expect(runtime.beforePromptBuild(
      { prompt: inboundEvent.content, messages: [] },
      { ...promptContext, trigger: 'user' },
    ).appendContext).toContain('不得调用任何工具')
    expect(runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })).toMatchObject({ kind: 'blocked', reason: 'inbound_identity_invalid' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('blocks a conflicting run id even when the model selected another tool', () => {
    const runContext = createRunContext()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })
    runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    )

    expect(runtime.beforeToolCall({
      toolName: 'memory_search', params: {}, runId: 'run-1', toolCallId: 'call-x',
    }, {
      agentId: 'second-original', sessionKey: promptContext.sessionKey,
      runId: 'different-run', toolName: 'memory_search', toolCallId: 'call-x',
    })).toMatchObject({ block: true })
  })

  it('stores blocked video intent and prevents every tool from running', () => {
    const runContext = createRunContext()
    const runner = vi.fn()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    const guidance = runtime.beforePromptBuild(
      { prompt: '先告诉我怎么分析这个视频 /tmp/demo.mp4', messages: [] },
      promptContext,
    )
    expect(guidance.appendContext).toContain('不得调用任何工具')

    expect(runtime.beforeToolCall({
      toolName: 'memory_search', params: {}, runId: 'run-1', toolCallId: 'call-x',
    }, {
      agentId: 'second-original', sessionKey: promptContext.sessionKey,
      runId: 'run-1', toolName: 'memory_search', toolCallId: 'call-x',
    })).toMatchObject({ block: true })
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed locally when the host run-context store refuses a write', () => {
    const runContext = createRunContext()
    runContext.setRunContext = vi.fn(() => false)
    const runtime = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })

    expect(runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    ).appendContext).toContain('不得调用任何工具')
    expect(runtime.beforeToolCall({
      toolName: 'memory_search', params: {}, runId: 'run-1', toolCallId: 'call-x',
    }, {
      agentId: 'second-original', sessionKey: promptContext.sessionKey,
      runId: 'run-1', toolName: 'memory_search', toolCallId: 'call-x',
    })).toMatchObject({ block: true })
  })

  it('fails closed locally when the host run-context store throws', () => {
    const runContext = createRunContext()
    runContext.setRunContext = vi.fn(() => {
      throw new Error('host context unavailable')
    })
    const runtime = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })

    expect(runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    ).appendContext).toContain('不得调用任何工具')
    expect(runtime.beforeToolCall({
      toolName: 'exec', params: {}, runId: 'run-1', toolCallId: 'call-x',
    }, {
      agentId: 'second-original', sessionKey: promptContext.sessionKey,
      runId: 'run-1', toolName: 'exec', toolCallId: 'call-x',
    })).toMatchObject({ block: true })
  })

  it('does not affect unrelated prompts or non-target tools', () => {
    const runContext = createRunContext()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner: vi.fn() })
    expect(runtime.beforePromptBuild(
      { prompt: '请查看今天的任务', messages: [] },
      promptContext,
    )).toBeUndefined()
    expect(runtime.beforeToolCall({
      toolName: 'memory_search', params: {}, runId: 'run-1', toolCallId: 'call-x',
    }, {
      agentId: 'second-original', sessionKey: promptContext.sessionKey,
      runId: 'run-1', toolName: 'memory_search', toolCallId: 'call-x',
    })).toBeUndefined()
    expect(runtime.beforeToolCall(targetCall().event, targetCall().context)).toMatchObject({ block: true })
  })

  it('exposes the optional tool only to direct Telegram second-original contexts', () => {
    const runtime = createNaturalVideoToolRuntime({ runContext: createRunContext(), runner: vi.fn() })
    expect(runtime.createTool(toolContext)?.name).toBe(NATURAL_VIDEO_TOOL_NAME)
    expect(runtime.createTool({ ...toolContext, agentId: 'main' })).toBeNull()
    expect(runtime.createTool({ ...toolContext, messageChannel: 'whatsapp' })).toBeNull()
    expect(runtime.createTool({
      ...toolContext,
      sessionKey: 'agent:second-original:telegram:group:123',
    })).toBeNull()
    expect(runtime.createTool({ ...toolContext, senderIsOwner: false })).toBeNull()
    expect(runtime.createTool({ ...toolContext, senderIsOwner: undefined })).toBeNull()
    expect(runtime.createTool({ ...toolContext, sandboxed: true })).toBeNull()
    expect(runtime.createTool({
      ...toolContext,
      senderIsOwner: undefined,
      oneShotCliRun: true,
    })?.name).toBe(NATURAL_VIDEO_TOOL_NAME)
  })

  it('rejects session and tool-call admission collisions across runs without overwriting', async () => {
    const runContext = createRunContext()
    const runner = vi.fn(async ({ taskId }) => ({ taskId, status: 'accepted', duplicate: false }))
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })

    for (const runId of ['run-1', 'run-2']) {
      runtime.beforePromptBuild(
        { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
        { ...promptContext, runId },
      )
    }
    const firstCall = targetCall()
    expect(runtime.beforeToolCall(firstCall.event, firstCall.context)).toEqual({
      params: { videoPath: '/tmp/demo.mp4' },
    })
    const collidingCall = targetCall({
      event: { runId: 'run-2' },
      context: { runId: 'run-2' },
    })
    expect(runtime.beforeToolCall(collidingCall.event, collidingCall.context)).toMatchObject({
      block: true,
    })

    const firstState = runContext.getRunContext({
      runId: 'run-1', namespace: NATURAL_VIDEO_RUN_NAMESPACE,
    })
    await runtime.createTool(toolContext).execute('call-1', { videoPath: '/tmp/demo.mp4' })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].taskId).toBe(firstState.taskId)

    runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      { ...promptContext, runId: 'run-3' },
    )
    const executedCollision = targetCall({
      event: { runId: 'run-3' },
      context: { runId: 'run-3' },
    })
    expect(runtime.beforeToolCall(
      executedCollision.event,
      executedCollision.context,
    )).toMatchObject({ block: true })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('atomically consumes an admission before validating execute parameters', async () => {
    const runContext = createRunContext()
    const runner = vi.fn()
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    )
    const call = targetCall()
    expect(runtime.beforeToolCall(call.event, call.context)).toEqual({
      params: { videoPath: '/tmp/demo.mp4' },
    })
    const tool = runtime.createTool(toolContext)

    await expect(tool.execute('call-1', { videoPath: '/tmp/other.mp4' }))
      .rejects.toThrow('video_admission_missing')
    await expect(tool.execute('call-1', { videoPath: '/tmp/demo.mp4' }))
      .rejects.toThrow('video_admission_missing')
    expect(runtime.beforeToolCall(call.event, call.context)).toMatchObject({ block: true })
    expect(runner).not.toHaveBeenCalled()
  })

  it('derives the same task identity when Telegram replays the same inbound message', async () => {
    const runContext = createRunContext()
    const runner = vi.fn(async ({ taskId }, index) => ({
      taskId,
      status: 'accepted',
      duplicate: index > 0,
    }))
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    const inboundEvent = {
      content: '帮我分析一下这个视频 /tmp/demo.mp4',
      channel: 'telegram',
      isGroup: false,
      sessionKey: promptContext.sessionKey,
      senderId: 'owner-id',
      timestamp: 1_786_240_000_123,
    }
    const inboundContext = {
      channelId: 'telegram',
      accountId: 'account-id',
      conversationId: 'conversation-id',
      sessionKey: promptContext.sessionKey,
      senderId: 'owner-id',
    }

    for (const [runId, toolCallId] of [['run-1', 'call-1'], ['run-2', 'call-2']]) {
      runtime.beforeDispatch(inboundEvent, inboundContext)
      const context = { ...promptContext, runId, trigger: 'user' }
      expect(runtime.beforePromptBuild({
        prompt: inboundEvent.content,
        messages: [],
      }, context).appendContext).toContain(NATURAL_VIDEO_TOOL_NAME)
      const hookContext = {
        agentId: 'second-original', sessionKey: promptContext.sessionKey,
        runId, toolName: NATURAL_VIDEO_TOOL_NAME, toolCallId,
      }
      expect(runtime.beforeToolCall({
        toolName: NATURAL_VIDEO_TOOL_NAME,
        params: { videoPath: '/tmp/demo.mp4' },
        runId,
        toolCallId,
      }, hookContext)).toEqual({ params: { videoPath: '/tmp/demo.mp4' } })
      await runtime.createTool(toolContext).execute(toolCallId, { videoPath: '/tmp/demo.mp4' })
      runtime.cleanupRun(runId)
    }

    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[0][0].taskId).toBe(runner.mock.calls[1][0].taskId)
    expect(runner.mock.calls[0][0].taskId).toMatch(/^video-natural-[a-f0-9]{64}$/u)
  })

  it('returns a safe failure without retrying or leaking runner errors', async () => {
    const runContext = createRunContext()
    const runner = vi.fn(async () => {
      throw new Error('stderr /private/demo.mp4 secret-value')
    })
    const runtime = createNaturalVideoToolRuntime({ runContext, runner })
    runtime.beforePromptBuild(
      { prompt: '帮我分析 /tmp/demo.mp4', messages: [] },
      promptContext,
    )
    const call = targetCall()
    runtime.beforeToolCall(call.event, call.context)
    const result = await runtime.createTool(toolContext).execute('call-1', {
      videoPath: '/tmp/demo.mp4',
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: '提交失败：暂时无法确认任务状态。' }],
    })
    expect(JSON.stringify(result)).not.toMatch(/private|secret-value/u)
    expect(runner).toHaveBeenCalledTimes(1)
  })
})
