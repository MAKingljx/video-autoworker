export interface ExecSecretReference {
  id: string
  provider: string
  source: 'exec'
}

export interface ExecSecretProvider {
  source: 'exec'
  command: string
  args: string[]
  timeoutMs?: number
  noOutputTimeoutMs?: number
  maxOutputBytes?: number
  jsonOnly?: false
  trustedDirs?: string[]
  allowInsecurePath?: boolean
}

export function isValidExecSecretReference(
  reference: unknown,
  providers: Record<string, ExecSecretProvider> | undefined,
): reference is ExecSecretReference

export function resolveExecSecretReference(
  reference: unknown,
  providers: Record<string, ExecSecretProvider> | undefined,
  options?: { valuePattern?: RegExp; maxBuffer?: number; timeoutMs?: number },
): string

export function resolveOpenClawGatewaySecret(
  reference: unknown,
  providers: Record<string, ExecSecretProvider> | undefined,
): string

export function resolveGatewayTokenFromConfig(config: unknown): string
export function resolveGatewayTokenFromConfigPath(configPath: string): string
