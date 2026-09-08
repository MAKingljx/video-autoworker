import { callOpenClawGateway, parseGatewayJsonOutput } from '@/lib/openclaw-gateway'
import { runOpenClaw } from '@/lib/command'
import type {
  RuntimeProvider, RuntimeSendMessageParams, RuntimeSendMessageResult,
  RuntimeWaitForRunResult, RuntimeSpawnSessionParams, RuntimeControlSessionAction,
  RuntimeSessionSummary, RuntimeSessionConfigPatch, RuntimeSessionListOptions,
  RuntimeSessionHistoryOptions, RuntimeSessionHistoryResult,
  RuntimeSessionMessage, RuntimeSessionMessagePart,
} from '../contracts'
import { RuntimeCapabilityUnavailableError } from '../contracts'

const SESSION_LIST_PAGE_SIZE = 200
const SESSION_LIST_MAX_PAGES = 50
const SESSION_CACHE_TTL_MS = 30_000

type OpenClawSessionListResult = {
  sessions?: unknown[]
  hasMore?: boolean
  nextOffset?: number
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function agentFromSessionKey(key: string): string {
  const match = /^agent:([^:]+):/u.exec(key)
  return match?.[1] || ''
}

function normalizeSession(value: unknown): Omit<RuntimeSessionSummary, 'active'> | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, any>
  const key = readString(row.key).trim()
  if (!key) return null

  const agent = readString(row.agentId || row.agent).trim() || agentFromSessionKey(key)
  const model = typeof row.model === 'object'
    ? readString(row.model?.primary)
    : readString(row.model)
  const channel = readString(
    row.channel || row.deliveryContext?.channel || row.lastChannel || row.origin?.provider,
  )

  return {
    key,
    agent,
    sessionId: readString(row.sessionId),
    updatedAt: readNumber(row.updatedAt),
    chatType: readString(row.kind || row.chatType) || 'unknown',
    channel,
    model,
    totalTokens: readNumber(row.totalTokens),
    inputTokens: readNumber(row.inputTokens),
    outputTokens: readNumber(row.outputTokens),
    contextTokens: readNumber(row.contextTokens),
    hasActiveRun: row.hasActiveRun === true,
  }
}

function safeJson(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return value.slice(0, maxLength)
  try {
    return JSON.stringify(value ?? {}).slice(0, maxLength)
  } catch {
    return ''
  }
}

function toolResultContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        if (typeof record.text === 'string') return record.text
        if (typeof record.content === 'string') return record.content
      }
      return safeJson(entry, 8000)
    }).filter(Boolean).join('\n')
  }
  return safeJson(value, 8000)
}

function normalizeHistoryParts(
  content: unknown,
  message: Record<string, any>,
): RuntimeSessionMessagePart[] {
  const parts: RuntimeSessionMessagePart[] = []
  const addText = (text: string) => {
    const normalized = text.trim()
    if (normalized && !/^NO_REPLY$/iu.test(normalized)) {
      parts.push({ type: 'text', text: normalized.slice(0, 8000) })
    }
  }

  if (typeof content === 'string') {
    addText(content)
  } else if (Array.isArray(content)) {
    for (const value of content) {
      if (!value || typeof value !== 'object') continue
      const block = value as Record<string, any>
      const blockType = readString(block.type).replaceAll('_', '').toLowerCase()
      if (blockType === 'text' && typeof block.text === 'string') {
        addText(block.text)
      } else if (blockType === 'thinking' && typeof block.thinking === 'string') {
        parts.push({ type: 'thinking', thinking: block.thinking.slice(0, 4000) })
      } else if (blockType === 'toolcall' || blockType === 'tooluse') {
        const fn = block.function && typeof block.function === 'object' ? block.function : {}
        const input = block.arguments ?? block.input ?? block.args ?? block.params ?? fn.arguments ?? {}
        parts.push({
          type: 'tool_use',
          id: readString(block.id || block.toolCallId || block.tool_call_id || block.callId || block.call_id),
          name: readString(block.name || block.toolName || block.tool_name || block.tool || fn.name) || 'unknown',
          input: safeJson(input, 500),
        })
      } else if (blockType === 'toolresult') {
        const resultContent = toolResultContent(block.content || block.text || block.output || block.result)
        if (resultContent.trim()) {
          parts.push({
            type: 'tool_result',
            toolUseId: readString(block.toolCallId || block.tool_call_id || block.toolUseId || block.tool_use_id || block.callId || block.call_id || block.id),
            content: resultContent.trim().slice(0, 8000),
            isError: block.isError === true || block.is_error === true || message.isError === true || message.is_error === true,
          })
        }
      }
    }
  }

  const messageRole = readString(message.role).replaceAll('_', '').toLowerCase()
  if (['toolresult', 'tool', 'function'].includes(messageRole)
    && !parts.some((part) => part.type === 'tool_result')) {
    const text = parts
      .filter((part): part is Extract<RuntimeSessionMessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n') || toolResultContent(message.output ?? message.result ?? message.content ?? message.text)
    if (text.trim()) {
      return [{
        type: 'tool_result',
        toolUseId: readString(message.toolCallId || message.tool_call_id || message.toolUseId || message.tool_use_id || message.callId || message.call_id || message.id),
        content: text.trim().slice(0, 8000),
        isError: message.isError === true || message.is_error === true,
      }]
    }
  }
  return parts
}

function normalizeHistory(messages: unknown[], limit: number): RuntimeSessionMessage[] {
  const normalized: RuntimeSessionMessage[] = []
  for (const value of messages) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, any>
    const parts = normalizeHistoryParts(row.content ?? row.text, row)
    if (parts.length === 0) continue
    const timestamp = typeof row.timestamp === 'number'
      ? row.timestamp
      : typeof row.timestamp === 'string'
        ? Date.parse(row.timestamp)
        : NaN
    const rawRole = readString(row.role).replaceAll('_', '').toLowerCase()
    const role = rawRole === 'assistant'
      ? 'assistant'
      : rawRole === 'system'
        ? 'system'
        : ['toolresult', 'tool', 'function'].includes(rawRole)
          ? 'tool'
          : 'user'
    normalized.push({
      role,
      parts,
      ...(Number.isFinite(timestamp) ? { timestamp } : {}),
    })
  }
  return normalized.slice(-limit)
}

function normalizeSendResult(raw: any, fallbackSession?: string | null): RuntimeSendMessageResult {
  return {
    status: typeof raw?.status === 'string' ? raw.status : undefined,
    runId: typeof raw?.runId === 'string' ? raw.runId : undefined,
    session:
      typeof raw?.sessionKey === 'string' ? raw.sessionKey
      : typeof raw?.sessionId === 'string' ? raw.sessionId
      : fallbackSession || undefined,
    raw,
  }
}

export class OpenClawRuntimeProvider implements RuntimeProvider {
  readonly id = 'openclaw'
  readonly sessionCapabilities = Object.freeze({
    list: true,
    history: true,
    delete: true,
    bulkPrune: false,
  })

  private sessionCache: { data: Array<Omit<RuntimeSessionSummary, 'active'>>; expiresAt: number } | null = null
  private sessionLoad: Promise<Array<Omit<RuntimeSessionSummary, 'active'>>> | null = null

  async sendMessage(params: RuntimeSendMessageParams): Promise<RuntimeSendMessageResult> {
    const { sessionKey, agentId, message, idempotencyKey, attachments, deliver = false } = params

    if (sessionKey) {
      const raw = await callOpenClawGateway<any>(
        'chat.send',
        {
          sessionKey,
          message,
          idempotencyKey,
          deliver,
          attachments,
        },
        12_000,
      )
      return normalizeSendResult(raw, sessionKey)
    }

    if (agentId) {
      const result = await runOpenClaw(
        [
          'gateway',
          'call',
          'agent',
          '--timeout',
          '10000',
          '--params',
          JSON.stringify({
            agentId,
            message,
            idempotencyKey,
            deliver,
          }),
          '--json',
        ],
        { timeoutMs: 12_000 },
      )

      const raw = parseGatewayJsonOutput(result.stdout)
      if (raw == null) {
        throw new Error('Invalid JSON response from gateway method agent')
      }
      return normalizeSendResult(raw, agentId)
    }

    throw new Error('Runtime sendMessage requires sessionKey or agentId')
  }

  async waitForRun(runId: string, timeoutMs = 6_000): Promise<RuntimeWaitForRunResult> {
    const raw = await callOpenClawGateway<any>(
      'agent.wait',
      { runId, timeoutMs },
      Math.max(8_000, timeoutMs + 2_000),
    )

    return {
      status: typeof raw?.status === 'string' ? raw.status : undefined,
      raw,
    }
  }

  async spawnSession(params: RuntimeSpawnSessionParams): Promise<any> {
    try {
      return await callOpenClawGateway('sessions_spawn', params, 15_000)
    } catch (firstError: any) {
      const rawErr = String(firstError?.message || '').toLowerCase()
      const isToolsSchemaError =
        (rawErr.includes('unknown field') || rawErr.includes('unknown key') || rawErr.includes('invalid argument')) &&
        (rawErr.includes('tools') || rawErr.includes('profile'))

      if (!isToolsSchemaError) throw firstError

      const fallbackPayload = { ...params }
      delete (fallbackPayload as any).tools
      const fallbackResult = await callOpenClawGateway('sessions_spawn', fallbackPayload, 15_000)
      return {
        ...((fallbackResult && typeof fallbackResult === 'object') ? fallbackResult : { result: fallbackResult }),
        __compatibilityFallbackUsed: true,
      }
    }
  }

  async controlSession(sessionKey: string, action: RuntimeControlSessionAction): Promise<any> {
    if (action === 'terminate') {
      return this.deleteSession(sessionKey)
    }

    return callOpenClawGateway(
      'sessions_send',
      {
        sessionKey,
        message: { type: 'control', action },
      },
      10_000,
    )
  }

  async listSessions(options: RuntimeSessionListOptions = {}): Promise<RuntimeSessionSummary[]> {
    const now = Date.now()
    const activeWithinMs = options.activeWithinMs ?? 60 * 60 * 1000
    let raw: Array<Omit<RuntimeSessionSummary, 'active'>>

    if (!options.force && this.sessionCache && this.sessionCache.expiresAt > now) {
      raw = this.sessionCache.data
    } else {
      if (!this.sessionLoad) {
        this.sessionLoad = this.loadAllSessions().finally(() => {
          this.sessionLoad = null
        })
      }
      raw = await this.sessionLoad
      this.sessionCache = { data: raw, expiresAt: Date.now() + SESSION_CACHE_TTL_MS }
    }

    const cutoff = options.updatedWithinMs != null && Number.isFinite(options.updatedWithinMs)
      ? now - Math.max(0, options.updatedWithinMs)
      : null
    return raw
      .filter((session) => cutoff == null || session.updatedAt >= cutoff)
      .map((session) => ({
        ...session,
        active: Number.isFinite(activeWithinMs) && activeWithinMs >= 0
          ? now - session.updatedAt < activeWithinMs
          : true,
      }))
  }

  private async loadAllSessions(): Promise<Array<Omit<RuntimeSessionSummary, 'active'>>> {
    const sessions: Array<Omit<RuntimeSessionSummary, 'active'>> = []
    const seenKeys = new Set<string>()
    let offset = 0

    for (let pageIndex = 0; pageIndex < SESSION_LIST_MAX_PAGES; pageIndex += 1) {
      const page = await callOpenClawGateway<OpenClawSessionListResult>(
        'sessions.list',
        { limit: SESSION_LIST_PAGE_SIZE, offset, configuredAgentsOnly: true },
        15_000,
      )
      if (!page || !Array.isArray(page.sessions)) {
        throw new Error('Invalid sessions.list response: sessions must be an array')
      }

      for (const value of page.sessions) {
        const session = normalizeSession(value)
        if (!session || seenKeys.has(session.key)) continue
        seenKeys.add(session.key)
        sessions.push(session)
      }

      if (page.hasMore !== true) {
        return sessions.sort((left, right) => right.updatedAt - left.updatedAt)
      }

      const nextOffset = page.nextOffset
      const expectedNextOffset = offset + page.sessions.length
      if (
        !Number.isSafeInteger(nextOffset)
        || Number(nextOffset) <= offset
        || Number(nextOffset) !== expectedNextOffset
      ) {
        throw new Error(`Invalid sessions.list pagination: offset=${offset}, nextOffset=${String(nextOffset)}`)
      }
      offset = Number(nextOffset)
    }

    throw new Error(`sessions.list exceeded ${SESSION_LIST_MAX_PAGES} pages`)
  }

  async getSessionHistory(
    sessionKey: string,
    options: RuntimeSessionHistoryOptions = {},
  ): Promise<RuntimeSessionHistoryResult> {
    const normalizedKey = String(sessionKey || '').trim()
    if (!normalizedKey) throw new Error('Runtime session history requires sessionKey')
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 1000)
    const raw = await callOpenClawGateway<{ messages?: unknown[] }>(
      'chat.history',
      { sessionKey: normalizedKey, limit },
      15_000,
    )
    if (!raw || !Array.isArray(raw.messages)) {
      throw new Error('Invalid chat.history response: messages must be an array')
    }
    return { messages: normalizeHistory(raw.messages, limit) }
  }

  async updateSessionConfig(sessionKey: string, patch: RuntimeSessionConfigPatch): Promise<any> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length !== 1) {
      throw new Error('Runtime session config update requires exactly one field')
    }

    const [field, value] = entries[0] as [keyof RuntimeSessionConfigPatch, string]
    const methodByField: Record<keyof RuntimeSessionConfigPatch, string> = {
      thinking: 'session_setThinking',
      verbose: 'session_setVerbose',
      reasoning: 'session_setReasoning',
      label: 'session_setLabel',
    }
    const paramKeyByField: Record<keyof RuntimeSessionConfigPatch, string> = {
      thinking: 'level',
      verbose: 'level',
      reasoning: 'level',
      label: 'label',
    }

    return callOpenClawGateway(
      methodByField[field],
      {
        sessionKey,
        [paramKeyByField[field]]: value,
      },
      10_000,
    )
  }

  async deleteSession(sessionKey: string): Promise<any> {
    const normalizedKey = String(sessionKey || '').trim()
    if (!normalizedKey) throw new Error('Runtime session delete requires sessionKey')
    const sessions = await this.listSessions({ force: true })
    const session = sessions.find((candidate) => candidate.key === normalizedKey)
    if (!session?.sessionId) {
      throw new Error('Runtime session delete requires current session identity from sessions.list')
    }

    const result = await callOpenClawGateway(
      'sessions.delete',
      {
        key: normalizedKey,
        ...(session.agent ? { agentId: session.agent } : {}),
        expectedSessionId: session.sessionId,
        deleteTranscript: true,
      },
      15_000,
    )
    this.sessionCache = null
    return result
  }

  async countSessionsOlderThan(_retentionDays: number): Promise<number> {
    throw new RuntimeCapabilityUnavailableError('bulkPrune')
  }

  async pruneSessionsOlderThan(_retentionDays: number): Promise<{ deleted: number }> {
    throw new RuntimeCapabilityUnavailableError('bulkPrune')
  }
}
