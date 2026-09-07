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

