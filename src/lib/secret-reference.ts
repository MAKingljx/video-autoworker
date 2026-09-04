import {
  isValidExecSecretReference as isValidSharedExecSecretReference,
  resolveExecSecretReference as resolveSharedExecSecretReference,
  resolveOpenClawGatewaySecret as resolveSharedOpenClawGatewaySecret,
} from '../../scripts/lib/openclaw-secret-reference.mjs'

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
}

export function isValidExecSecretReference(
  reference: unknown,
  providers: Record<string, ExecSecretProvider> | undefined,
): reference is ExecSecretReference {
  return isValidSharedExecSecretReference(reference, providers)
}

/** Resolve one strict exec SecretRef without a shell or inherited environment. */
export function resolveExecSecretReference(
  reference: unknown,
  providers: Record<string, ExecSecretProvider> | undefined,
  options: { valuePattern: RegExp; maxBuffer?: number; timeoutMs?: number },
): string {
  return resolveSharedExecSecretReference(reference, providers, options)
}

export function resolveOpenClawGatewaySecret(
  reference: unknown,
  providers: Record<string, ExecSecretProvider> | undefined,
): string {
  return resolveSharedOpenClawGatewaySecret(reference, providers)
}
