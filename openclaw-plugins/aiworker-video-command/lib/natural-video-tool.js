import { createHash } from 'node:crypto'
import { extname, isAbsolute, normalize } from 'node:path'

import { parseNaturalVideoRequest } from './natural-video-request.js'
import { runVideoTask } from './runner.js'
import { deriveStableNaturalDispatchKey } from './stable-message-key.js'

export const NATURAL_VIDEO_TOOL_NAME = 'aiworker_analyze_video'
export const NATURAL_VIDEO_RUN_NAMESPACE = 'natural-video-request'

const TARGET_AGENT = 'second-original'
const TARGET_CHANNEL = 'telegram'
const TASK_PREFIX = 'video-natural-'
const RUN_STATE_VERSION = 1
const STATE_TTL_MS = 15 * 60 * 1_000
const PENDING_TTL_MS = 2 * 60 * 1_000
const MAX_TRACKED_RUNS = 256
const MAX_PENDING_MESSAGES = 64
const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.m4v', '.mkv', '.mov', '.mp4', '.webm'])
const MATCH_STATE_KEYS = [
  'agentId',
  'channel',
  'createdAt',
  'identitySource',
  'kind',
  'runId',
  'senderId',
  'sessionKey',
  'taskId',
  'version',
  'videoPath',
].sort()
const BLOCKED_STATE_KEYS = [
  'agentId',
  'channel',
  'createdAt',
  'kind',
  'reason',
  'runId',
  'sessionKey',
  'version',
].sort()

const TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['videoPath'],
  properties: {
    videoPath: {
      type: 'string',
      minLength: 1,
      maxLength: 4_096,
      description: '当前用户消息中唯一的生产 Mac 绝对视频路径。',
    },
  },
})

function normalizedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isCanonicalString(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function resolveConsistentString(left, right) {
  const normalizedLeft = normalizedString(left)
  const normalizedRight = normalizedString(right)
  if (normalizedLeft && normalizedRight && normalizedLeft !== normalizedRight) return null
  return normalizedLeft || normalizedRight
}

function isTelegramChannel(value) {
  const normalized = normalizedString(value)?.toLowerCase()
  return normalized === TARGET_CHANNEL || normalized?.startsWith(`${TARGET_CHANNEL}:`)
}

function isGroupSession(sessionKey, channelContext) {
  if (sessionKey.split(':').includes('group')) return true
  const chat = channelContext?.chat
  const kind = normalizedString(chat?.kind ?? chat?.type)?.toLowerCase()
  return kind === 'group' || kind === 'supergroup' || kind === 'channel'
}

function isTelegramDirectSession(sessionKey) {
  const parts = sessionKey.split(':')
  return parts.includes('telegram')
    && parts.includes('direct')
    && !parts.includes('group')
    && !parts.includes('channel')
}

function isCanonicalVideoPath(value) {
  return isCanonicalString(value)
    && isAbsolute(value)
    && !value.startsWith('//')
    && normalize(value) === value
    && SUPPORTED_VIDEO_EXTENSIONS.has(extname(value).toLowerCase())
}

function encodePart(value) {
  const text = normalizedString(value) ?? ''
  return `${Buffer.byteLength(text, 'utf8')}:${text}`
}

function hashText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function admissionKey(sessionKey, toolCallId) {
  return `${encodePart(sessionKey)}|${encodePart(toolCallId)}`
}

export function deriveNaturalVideoTaskId({ sessionKey, runId, videoPath }) {
  if (!normalizedString(sessionKey) || !normalizedString(runId) || !normalizedString(videoPath)) {
    throw new TypeError('stable natural-video identity is incomplete')
  }
  const canonical = [
    'aiworker-natural-video-v1',
    sessionKey,
    runId,
    videoPath,
  ].map(encodePart).join('|')
  return `${TASK_PREFIX}${hashText(canonical)}`
}

function shortResult(result, expectedTaskId) {
  if (
    !result
    || result.taskId !== expectedTaskId
    || typeof result.status !== 'string'
    || !/^[a-z][a-z0-9_-]{0,31}$/u.test(result.status)
    || typeof result.duplicate !== 'boolean'
  ) {
    throw new Error('invalid_video_task_result')
  }
  return `已提交：taskId=${result.taskId}，status=${result.status}，duplicate=${result.duplicate}。`
}

function blockedTool(reason = '当前消息未通过视频执行校验。') {
  return { block: true, blockReason: reason }
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort()
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
}

function safeRunState(value, expectedRunId, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.version !== RUN_STATE_VERSION) return undefined
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) return undefined
  if (value.createdAt > now + 60_000 || now - value.createdAt > STATE_TTL_MS) return undefined
  if (value.agentId !== TARGET_AGENT || value.runId !== expectedRunId) return undefined
  if (!isCanonicalString(value.sessionKey)) return undefined

  if (value.kind === 'match') {
    if (!hasExactKeys(value, MATCH_STATE_KEYS)) return undefined
    if (
      value.channel !== TARGET_CHANNEL
      || !isTelegramDirectSession(value.sessionKey)
      || !isCanonicalVideoPath(value.videoPath)
      || !new RegExp(`^${TASK_PREFIX}[a-f0-9]{64}$`, 'u').test(value.taskId)
      || (value.identitySource !== 'telegram-inbound' && value.identitySource !== 'manual-qa')
      || !isCanonicalString(value.senderId)
    ) {
      return undefined
    }
    return value
  }

  if (value.kind === 'blocked') {
    if (!hasExactKeys(value, BLOCKED_STATE_KEYS)) return undefined
    if (
      (value.channel !== TARGET_CHANNEL && value.channel !== 'unsupported')
      || !isCanonicalString(value.reason)
      || value.reason.length > 128
    ) {
      return undefined
    }
    return value
  }
  return undefined
}

function stateFingerprint(state) {
  const keys = state.kind === 'match' ? MATCH_STATE_KEYS : BLOCKED_STATE_KEYS
  return hashText(JSON.stringify(keys.map(key => [key, state[key]])))
}

function statesMatch(left, right) {
  return left.kind === right.kind && stateFingerprint(left) === stateFingerprint(right)
}

export function createNaturalVideoToolRuntime({
  runContext,
  runner = runVideoTask,
} = {}) {
  if (
    !runContext
    || typeof runContext.setRunContext !== 'function'
    || typeof runContext.getRunContext !== 'function'
    || typeof runContext.clearRunContext !== 'function'
  ) {
    throw new TypeError('runContext API is required')
  }
  if (typeof runner !== 'function') throw new TypeError('runner must be a function')

  // Host runContext is the only positive authorization source. These local
  // maps can only reject, pin one call, or retain one already-started promise.
  const guardsByRun = new Map()
  const expectedHostByRun = new Map()
  const trackedRuns = new Map()
  const claimsByRun = new Map()
  const admissionsByKey = new Map()
  const executionsByKey = new Map()
  const promisesByRun = new Map()
  const pendingBySession = new Map()

  function deleteRunOperations(runId) {
    const claim = claimsByRun.get(runId)
    if (claim) {
      const queuedAdmission = admissionsByKey.get(claim.key)
      if (queuedAdmission?.runId === runId) admissionsByKey.delete(claim.key)
      const execution = executionsByKey.get(claim.key)
      if (execution?.runId === runId) executionsByKey.delete(claim.key)
    }
    claimsByRun.delete(runId)
    promisesByRun.delete(runId)
    expectedHostByRun.delete(runId)
    trackedRuns.delete(runId)
  }

  function deleteTrackedRun(runId) {
    deleteRunOperations(runId)
    guardsByRun.delete(runId)
  }

  function guardRun(runId, reason) {
    const createdAt = Date.now()
    guardsByRun.set(runId, { reason, createdAt })
    trackedRuns.set(runId, createdAt)
  }

  function prune(now = Date.now()) {
    for (const [runId, createdAt] of trackedRuns) {
      if (!Number.isFinite(createdAt) || now - createdAt > STATE_TTL_MS) {
        deleteTrackedRun(runId)
      }
    }
    for (const [sessionKey, queue] of pendingBySession) {
      const retained = queue.filter(entry => (
        Number.isFinite(entry.createdAt) && now - entry.createdAt <= PENDING_TTL_MS
      ))
      if (retained.length > 0) pendingBySession.set(sessionKey, retained)
      else pendingBySession.delete(sessionKey)
    }
    while (trackedRuns.size > MAX_TRACKED_RUNS) {
      const oldestRunId = trackedRuns.keys().next().value
      if (!oldestRunId) break
      deleteTrackedRun(oldestRunId)
    }
    let pendingCount = [...pendingBySession.values()]
      .reduce((count, queue) => count + queue.length, 0)
    while (pendingCount > MAX_PENDING_MESSAGES) {
      const oldestSessionKey = pendingBySession.keys().next().value
      if (!oldestSessionKey) break
      const queue = pendingBySession.get(oldestSessionKey)
      queue.shift()
      pendingCount -= 1
      if (queue.length === 0) pendingBySession.delete(oldestSessionKey)
      else pendingBySession.set(oldestSessionKey, queue)
    }
  }

  function readHostRunState(runId) {
    let rawState
    try {
      rawState = runContext.getRunContext({
        runId,
        namespace: NATURAL_VIDEO_RUN_NAMESPACE,
      })
    } catch {
      return { ok: false, reason: 'run_context_read_failed' }
    }
    if (rawState === undefined || rawState === null) {
      return { ok: false, reason: 'run_context_missing' }
    }
    const state = safeRunState(rawState, runId)
    if (!state) return { ok: false, reason: 'run_context_invalid' }
    return { ok: true, state }
  }

  function readAuthorizedHostState(runId) {
    const guard = guardsByRun.get(runId)
    if (guard) return { ok: false, reason: guard.reason }

    const read = readHostRunState(runId)
    if (!read.ok) {
      if (read.reason !== 'run_context_missing' || expectedHostByRun.has(runId)) {
        guardRun(runId, read.reason)
      }
      return read
    }

    const expected = expectedHostByRun.get(runId)
    if (!expected) {
      guardRun(runId, 'run_context_unbound')
      return { ok: false, reason: 'run_context_unbound' }
    }
    if (expected.fingerprint !== stateFingerprint(read.state)) {
      guardRun(runId, 'run_context_diverged')
      return { ok: false, reason: 'run_context_diverged' }
    }
    trackedRuns.set(runId, read.state.createdAt)
    return read
  }

  function storeHostRunState(state) {
    let stored = false
    try {
      stored = runContext.setRunContext({
        runId: state.runId,
        namespace: NATURAL_VIDEO_RUN_NAMESPACE,
        value: state,
      }) === true
    } catch {
      stored = false
    }
    if (!stored) {
      guardRun(state.runId, 'run_context_write_failed')
      return { ok: false, reason: 'run_context_write_failed' }
    }

    const read = readHostRunState(state.runId)
    if (!read.ok || !statesMatch(read.state, state)) {
      guardRun(state.runId, read.ok ? 'run_context_diverged' : read.reason)
      return { ok: false, reason: read.ok ? 'run_context_diverged' : read.reason }
    }
    expectedHostByRun.set(state.runId, {
      fingerprint: stateFingerprint(state),
      createdAt: state.createdAt,
    })
    trackedRuns.set(state.runId, state.createdAt)
    return { ok: true, state: read.state }
  }

  function enqueuePending(sessionKey, pending) {
    const queue = pendingBySession.get(sessionKey) ?? []
    queue.push(pending)
    pendingBySession.delete(sessionKey)
    pendingBySession.set(sessionKey, queue)
    prune()
  }

  function consumePending(sessionKey, content, videoPath) {
    prune()
    const queue = pendingBySession.get(sessionKey) ?? []
    const contentHash = hashText(content)
    const matching = queue.filter(entry => entry.contentHash === contentHash)
    const retained = queue.filter(entry => entry.contentHash !== contentHash)
    if (retained.length > 0) pendingBySession.set(sessionKey, retained)
    else pendingBySession.delete(sessionKey)

    if (matching.length === 0) {
      return { kind: 'blocked', reason: 'inbound_identity_missing' }
    }
    if (matching.length !== 1) {
      return { kind: 'blocked', reason: 'inbound_identity_ambiguous' }
    }
    const pending = matching[0]
    if (pending.kind !== 'match' || pending.videoPath !== videoPath) {
      return { kind: 'blocked', reason: pending.reason ?? 'inbound_identity_invalid' }
    }
    return pending
  }

  function beforeDispatch(event, context) {
    prune()
    const decision = parseNaturalVideoRequest(event?.content)
    if (decision.kind === 'unmatched') return undefined

    const sessionKey = resolveConsistentString(event?.sessionKey, context?.sessionKey)
    if (!sessionKey) return undefined
    const channel = resolveConsistentString(event?.channel, context?.channelId)
    const senderId = resolveConsistentString(event?.senderId, context?.senderId)
    const canonicalSenderId = normalizedString(senderId)
    const trustedDirect = isTelegramChannel(channel)
      && event?.isGroup === false
      && isTelegramDirectSession(sessionKey)

    let pending = {
      kind: 'blocked',
      reason: decision.kind === 'blocked' ? decision.reason : 'inbound_identity_invalid',
      contentHash: hashText(event.content),
      createdAt: Date.now(),
    }
    if (
      decision.kind === 'match'
      && trustedDirect
      && canonicalSenderId
      && Number.isFinite(event?.timestamp)
    ) {
      pending = {
        kind: 'match',
        videoPath: decision.videoPath,
        taskId: deriveStableNaturalDispatchKey({
          channel: TARGET_CHANNEL,
          accountId: context?.accountId,
          conversationId: context?.conversationId,
          sessionKey,
          senderId: canonicalSenderId,
          timestamp: event.timestamp,
          content: event.content,
        }),
        senderId: canonicalSenderId,
        contentHash: hashText(event.content),
        createdAt: Date.now(),
      }
    }
    enqueuePending(sessionKey, pending)
    return undefined
  }

  function guidanceForState(state) {
    if (state?.kind !== 'match') {
      return {
        appendContext: '当前视频请求未通过执行校验。不得调用任何工具或提交任务；只简短说明未执行或请求一个生产 Mac 绝对视频路径。',
      }
    }
    return {
      appendContext: `当前消息已通过自然语言单视频执行校验。第一个且唯一一个工具调用必须是 ${NATURAL_VIDEO_TOOL_NAME}，videoPath 必须原样使用当前消息中的唯一绝对路径。不调用 memory_search、exec、媒体处理或状态查询，不重试；随后只回复工具的短受理回执。`,
    }
  }

  function blockedState({ runId, sessionKey, channel, reason }) {
    return {
      version: RUN_STATE_VERSION,
      createdAt: Date.now(),
      kind: 'blocked',
      reason,
      agentId: TARGET_AGENT,
      runId,
      sessionKey,
      channel,
    }
  }

  function matchState({
    runId,
    sessionKey,
    videoPath,
    taskId,
    identitySource,
    senderId,
  }) {
    return {
      version: RUN_STATE_VERSION,
      createdAt: Date.now(),
      kind: 'match',
      agentId: TARGET_AGENT,
      runId,
      sessionKey,
      channel: TARGET_CHANNEL,
      videoPath,
      taskId,
      identitySource,
      senderId,
    }
  }

  function beforePromptBuild(event, context) {
    if (context?.agentId !== TARGET_AGENT) return undefined
    const decision = parseNaturalVideoRequest(event?.prompt)
    const runId = normalizedString(context?.runId)
    const sessionKey = normalizedString(context?.sessionKey)
    if (!runId || !sessionKey) {
      if (decision.kind === 'unmatched') return undefined
      return guidanceForState({ kind: 'blocked' })
    }

    prune()
    const existing = readAuthorizedHostState(runId)
    if (existing.ok) {
      const state = existing.state
      if (
        state.sessionKey !== sessionKey
        || (state.kind === 'match' && (
          decision.kind !== 'match'
          || decision.videoPath !== state.videoPath
          || !isTelegramChannel(context.messageProvider ?? context.channel)
          || isGroupSession(sessionKey, context.channelContext)
        ))
      ) {
        guardRun(runId, 'run_context_diverged')
        return guidanceForState({ kind: 'blocked' })
      }
      return guidanceForState(state)
    }
    if (existing.reason !== 'run_context_missing' || expectedHostByRun.has(runId)) {
      return guidanceForState({ kind: 'blocked' })
    }
    if (decision.kind === 'unmatched') return undefined

    const channelValue = context.messageProvider ?? context.channel
    const channel = isTelegramChannel(channelValue) ? TARGET_CHANNEL : 'unsupported'
    let state
    if (decision.kind === 'blocked') {
      state = blockedState({ runId, sessionKey, channel, reason: decision.reason })
    } else if (
      channel !== TARGET_CHANNEL
      || !isTelegramDirectSession(sessionKey)
      || isGroupSession(sessionKey, context.channelContext)
    ) {
      state = blockedState({
        runId,
        sessionKey,
        channel,
        reason: 'telegram_direct_required',
      })
    } else if (context?.trigger === 'user') {
      const pending = consumePending(sessionKey, event.prompt, decision.videoPath)
      state = pending.kind === 'match'
        ? matchState({
            runId,
            sessionKey,
            videoPath: decision.videoPath,
            taskId: pending.taskId,
            identitySource: 'telegram-inbound',
            senderId: pending.senderId,
          })
        : blockedState({
            runId,
            sessionKey,
            channel,
            reason: pending.reason,
          })
    } else if (context?.trigger === 'manual') {
      state = matchState({
        runId,
        sessionKey,
        videoPath: decision.videoPath,
        taskId: deriveNaturalVideoTaskId({ sessionKey, runId, videoPath: decision.videoPath }),
        identitySource: 'manual-qa',
        senderId: 'manual-qa',
      })
    } else {
      state = blockedState({
        runId,
        sessionKey,
        channel,
        reason: 'unsupported_trigger',
      })
    }

    const stored = storeHostRunState(state)
    return guidanceForState(stored.ok ? stored.state : { kind: 'blocked' })
  }

  function runIsLocallyKnown(runId) {
    return guardsByRun.has(runId)
      || expectedHostByRun.has(runId)
      || claimsByRun.has(runId)
      || promisesByRun.has(runId)
  }

  function runHasHostState(runId) {
    return readHostRunState(runId).ok
  }

  function beforeToolCall(event, context) {
    prune()
    const eventRunId = normalizedString(event?.runId)
    const contextRunId = normalizedString(context?.runId)
    const eventToolCallId = normalizedString(event?.toolCallId)
    const contextToolCallId = normalizedString(context?.toolCallId)
    const eventToolName = normalizedString(event?.toolName)
    const contextToolName = normalizedString(context?.toolName)
    const targetMentioned = eventToolName === NATURAL_VIDEO_TOOL_NAME
      || contextToolName === NATURAL_VIDEO_TOOL_NAME
    const candidateRunIds = [...new Set([eventRunId, contextRunId].filter(Boolean))]
    const allFieldsPresent = eventRunId && contextRunId
      && eventToolCallId && contextToolCallId
      && eventToolName && contextToolName
    const allFieldsEqual = eventRunId === contextRunId
      && eventToolCallId === contextToolCallId
      && eventToolName === contextToolName

    if (!allFieldsPresent || !allFieldsEqual) {
      const guardedRun = candidateRunIds.some(runId => (
        runIsLocallyKnown(runId) || runHasHostState(runId)
      ))
      return guardedRun || targetMentioned
        ? blockedTool('工具调用上下文不完整或不一致。')
        : undefined
    }

    const runId = eventRunId
    const toolCallId = eventToolCallId
    const toolName = eventToolName
    const authorized = readAuthorizedHostState(runId)
    if (!authorized.ok) {
      return targetMentioned || runIsLocallyKnown(runId) ? blockedTool() : undefined
    }
    const state = authorized.state
    if (state.kind !== 'match') return blockedTool('当前视频请求不允许执行工具。')
    if (toolName !== NATURAL_VIDEO_TOOL_NAME) {
      return blockedTool('当前视频请求只允许一次专用提交工具调用。')
    }

    const sessionKey = normalizedString(context?.sessionKey)
    const agentId = normalizedString(context?.agentId)
    const params = event?.params
    if (
      sessionKey !== state.sessionKey
      || agentId !== TARGET_AGENT
      || state.channel !== TARGET_CHANNEL
      || !params
      || typeof params !== 'object'
      || Array.isArray(params)
      || Object.keys(params).length !== 1
      || params.videoPath !== state.videoPath
    ) {
      return blockedTool('视频工具参数或上下文与当前消息不一致。')
    }

    const key = admissionKey(sessionKey, toolCallId)
    const existingClaim = claimsByRun.get(runId)
    if (existingClaim && existingClaim.key !== key) {
      return blockedTool('当前视频请求已经发起过一次工具调用。')
    }

    const existingAdmission = admissionsByKey.get(key) ?? executionsByKey.get(key)
    if (existingClaim && !existingAdmission) {
      return blockedTool('当前视频请求的工具调用授权已经使用。')
    }
    if (existingAdmission) {
      if (
        existingAdmission.runId !== runId
        || existingAdmission.taskId !== state.taskId
        || existingAdmission.videoPath !== state.videoPath
      ) {
        return blockedTool('工具调用标识已被其他运行占用。')
      }
      if (!existingClaim) claimsByRun.set(runId, existingAdmission)
      return { params: { videoPath: state.videoPath } }
    }

    const admission = {
      agentId,
      sessionKey,
      runId,
      toolCallId,
      key,
      taskId: state.taskId,
      videoPath: state.videoPath,
      createdAt: Date.now(),
    }
    claimsByRun.set(runId, admission)
    admissionsByKey.set(key, admission)
    return { params: { videoPath: state.videoPath } }
  }

  function createTool(toolContext) {
    prune()
    const sessionKey = normalizedString(toolContext?.sessionKey)
    const trustedIngressOwner = toolContext?.senderIsOwner === true
    const explicitManualQa = toolContext?.oneShotCliRun === true
    const explicitlyUntrustedIngress = toolContext?.senderIsOwner === false
    if (
      toolContext?.agentId !== TARGET_AGENT
      || !sessionKey
      || !isTelegramChannel(toolContext.messageChannel)
      || !isTelegramDirectSession(sessionKey)
      || isGroupSession(sessionKey)
      || (explicitlyUntrustedIngress && !explicitManualQa)
      || toolContext.sandboxed === true
    ) {
      return null
    }

    // OpenClaw 2026.7.1-2 tools.effective intentionally omits senderIsOwner.
    // Return the optional tool for that read-only inventory projection, but
    // never let an owner-unknown runtime execute it. Real Telegram turns must
    // carry senderIsOwner=true; the isolated CLI acceptance uses oneShotCliRun.
    const executionAuthorized = trustedIngressOwner || explicitManualQa

    return {
      name: NATURAL_VIDEO_TOOL_NAME,
      label: 'AI-worker 视频分析',
      description: '将当前用户明确要求执行的唯一本地视频提交给 AI-worker 正式 video-analysis 链。仅当前消息为肯定执行、包含唯一绝对视频路径时调用一次；方法询问、否定语义、缺少或多路径时不得调用。',
      parameters: TOOL_PARAMETERS,
      executionMode: 'sequential',
      async execute(toolCallId, params) {
        if (!executionAuthorized) throw new Error('video_admission_missing')
        const normalizedToolCallId = normalizedString(toolCallId)
        if (!normalizedToolCallId) throw new Error('video_admission_missing')
        const key = admissionKey(sessionKey, normalizedToolCallId)
        let execution = executionsByKey.get(key)

        if (!execution) {
          const admission = admissionsByKey.get(key)
          if (!admission) throw new Error('video_admission_missing')
          // Synchronous get+delete is the atomic authorization take. Any later
          // invocation can only reuse the exact execution promise created here.
          admissionsByKey.delete(key)
          if (
            admission.agentId !== TARGET_AGENT
            || admission.sessionKey !== sessionKey
            || params?.videoPath !== admission.videoPath
          ) {
            throw new Error('video_admission_missing')
          }

          let submission = promisesByRun.get(admission.runId)
          if (!submission) {
            submission = Promise.resolve().then(() => runner({
              videoPath: admission.videoPath,
              taskId: admission.taskId,
            }))
            promisesByRun.set(admission.runId, submission)
          }
          execution = { ...admission, promise: submission }
          executionsByKey.set(key, execution)
        } else if (
          execution.agentId !== TARGET_AGENT
          || execution.sessionKey !== sessionKey
          || params?.videoPath !== execution.videoPath
        ) {
          throw new Error('video_admission_missing')
        }

        try {
          const result = await execution.promise
          return {
            content: [{ type: 'text', text: shortResult(result, execution.taskId) }],
          }
        } catch {
          return {
            content: [{ type: 'text', text: '提交失败：暂时无法确认任务状态。' }],
          }
        }
      },
    }
  }

  function cleanupRun(runId) {
    const normalizedRunId = normalizedString(runId)
    if (!normalizedRunId) return
    deleteRunOperations(normalizedRunId)
    guardRun(normalizedRunId, 'run_cleaned')
    try {
      runContext.clearRunContext({
        runId: normalizedRunId,
        namespace: NATURAL_VIDEO_RUN_NAMESPACE,
      })
    } catch {
      // The local deny guard remains even when host cleanup fails.
    }
  }

  return {
    beforeDispatch,
    beforePromptBuild,
    beforeToolCall,
    createTool,
    cleanupRun,
  }
}
