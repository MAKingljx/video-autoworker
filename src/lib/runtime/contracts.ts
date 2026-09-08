// Application-owned conversation contract. Platform SDKs and configuration stay in providers.

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
  /** Authoritative runtime execution state when the provider exposes it. */
  hasActiveRun?: boolean
  /** Recent activity derived from updatedAt and the caller's activity window. */
  active: boolean
}

export type RuntimeSessionListOptions = {
  /** Window used to derive the `active` convenience field. */
  activeWithinMs?: number
  /** Return only sessions updated inside this window. */
  updatedWithinMs?: number
  /** Bypass the provider-local metadata cache. */
  force?: boolean
}

export type RuntimeSessionMessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export type RuntimeSessionMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool'
  parts: RuntimeSessionMessagePart[]
  /** Provider-normalized Unix timestamp in milliseconds. */
  timestamp?: number
}

export type RuntimeSessionHistoryOptions = {
  limit?: number
}

export type RuntimeSessionHistoryResult = {
  messages: RuntimeSessionMessage[]
}

export type RuntimeSessionCapabilities = Readonly<{
  list: boolean
  history: boolean
  delete: boolean
  bulkPrune: boolean
}>

export class RuntimeCapabilityUnavailableError extends Error {
  readonly code = 'RUNTIME_CAPABILITY_UNAVAILABLE'

  constructor(readonly capability: keyof RuntimeSessionCapabilities) {
    super(`Runtime provider does not support session capability: ${capability}`)
    this.name = 'RuntimeCapabilityUnavailableError'
  }
}

export interface RuntimeProvider {
  readonly id: string
  readonly sessionCapabilities: RuntimeSessionCapabilities
  sendMessage(params: RuntimeSendMessageParams): Promise<RuntimeSendMessageResult>
  waitForRun(runId: string, timeoutMs?: number): Promise<RuntimeWaitForRunResult>
  spawnSession(params: RuntimeSpawnSessionParams): Promise<any>
  controlSession(sessionKey: string, action: RuntimeControlSessionAction): Promise<any>

  /** List runtime-backed sessions known to this provider. */
  listSessions(options?: RuntimeSessionListOptions): Promise<RuntimeSessionSummary[]>

  /** Read display-normalized history from the selected runtime. */
  getSessionHistory(sessionKey: string, options?: RuntimeSessionHistoryOptions): Promise<RuntimeSessionHistoryResult>

  /** Set a single session preference/metadata field. */
  updateSessionConfig(sessionKey: string, patch: RuntimeSessionConfigPatch): Promise<any>

  /** Delete/remove a session from the runtime. */
  deleteSession(sessionKey: string): Promise<any>

  /** Preview and execute provider-owned bulk retention maintenance. */
  countSessionsOlderThan(retentionDays: number): Promise<number>
  pruneSessionsOlderThan(retentionDays: number): Promise<{ deleted: number }>
}
