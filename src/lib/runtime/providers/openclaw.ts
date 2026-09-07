import { callOpenClawGateway, parseGatewayJsonOutput } from '@/lib/openclaw-gateway'
import { runOpenClaw } from '@/lib/command'
import type {
  RuntimeProvider, RuntimeSendMessageParams, RuntimeSendMessageResult,
  RuntimeWaitForRunResult, RuntimeSpawnSessionParams, RuntimeControlSessionAction,
  RuntimeSessionSummary, RuntimeSessionConfigPatch,
} from '../contracts'

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
