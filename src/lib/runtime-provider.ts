import { callOpenClawGateway, parseGatewayJsonOutput } from '@/lib/openclaw-gateway'
import { runOpenClaw } from '@/lib/command'

export type RuntimeSendAttachments = Array<{
  type: 'image'
  mimeType: string
  fileName?: string
  content: string
}>

export type RuntimeSendMessageParams = {
  sessionKey?: string | null
  agentId?: string | null
  message: string
  idempotencyKey?: string
  attachments?: RuntimeSendAttachments
  deliver?: boolean
}

export type RuntimeSendMessageResult = {
  status?: string
  runId?: string
  session?: string
  raw: any
}

export type RuntimeWaitForRunResult = {
  status?: string
  raw: any
}

export type RuntimeSpawnSessionParams = {
  task: string
  label?: string
  model?: string
  runTimeoutSeconds?: number
  tools?: {
    profile?: string
  }
}

export type RuntimeControlSessionAction = 'monitor' | 'pause' | 'terminate'

export type RuntimeThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type RuntimeVerboseLevel = 'off' | 'on' | 'full'
export type RuntimeReasoningLevel = 'off' | 'on' | 'stream'

export type RuntimeSessionConfigPatch = Partial<{
  thinking: RuntimeThinkingLevel
  verbose: RuntimeVerboseLevel
  reasoning: RuntimeReasoningLevel
  label: string
}>

export type RuntimeSessionSummary = {
  key: string
  agent: string
  sessionId: string
  updatedAt: number
  chatType: string
  channel: string
  model: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  contextTokens: number
  active: boolean
}

export interface RuntimeProvider {
  readonly id: string
  sendMessage(params: RuntimeSendMessageParams): Promise<RuntimeSendMessageResult>
  waitForRun(runId: string, timeoutMs?: number): Promise<RuntimeWaitForRunResult>
  spawnSession(params: RuntimeSpawnSessionParams): Promise<any>
  controlSession(sessionKey: string, action: RuntimeControlSessionAction): Promise<any>

  /** List runtime-backed sessions known to this provider. */
  listSessions(activeWithinMs?: number): Promise<RuntimeSessionSummary[]>

  /** Set a single session preference/metadata field. */
  updateSessionConfig(sessionKey: string, patch: RuntimeSessionConfigPatch): Promise<any>

  /** Delete/remove a session from the runtime. */
  deleteSession(sessionKey: string): Promise<any>
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

  async listSessions(activeWithinMs = 60 * 60 * 1000): Promise<RuntimeSessionSummary[]> {
    const { getAllGatewaySessions } = await import('@/lib/openclaw-session-source')
    return getAllGatewaySessions(activeWithinMs)
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
    return callOpenClawGateway('session_delete', { sessionKey }, 10_000)
  }
}

let defaultProvider: RuntimeProvider | null = null

export function getRuntimeProvider(): RuntimeProvider {
  if (!defaultProvider) defaultProvider = new OpenClawRuntimeProvider()
  return defaultProvider
}

export function __setRuntimeProviderForTests(provider: RuntimeProvider | null) {
  defaultProvider = provider
}
