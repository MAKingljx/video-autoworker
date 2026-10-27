import { z } from 'zod'
import { checkN8nCallbackAdmission, resolveN8nRuntimeIdentity } from '@/lib/n8n-runtime-affinity'

export const videoRepairCallbackBindingSchema = z.object({
  callbackProtocol: z.literal('slot-v1'), runtimeSlot: z.enum(['blue', 'green']),
  runtimeReleaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u),
  port: z.number().int().min(1).max(65_535),
}).strict()
export type VideoRepairCallbackBinding = z.infer<typeof videoRepairCallbackBindingSchema>
const CALLBACKS = {
  nodeCallbackUrl: '/api/n8n/node-execute', mediaCallbackUrl: '/api/n8n/media-execute', claimCallbackUrl: '/api/n8n/claim',
} as const

/** Stable receiver identity, with no PID, process nonce or clock in a queued confirmation. */
export function currentVideoRepairCallbackBinding(): VideoRepairCallbackBinding {
  let runtime: ReturnType<typeof resolveN8nRuntimeIdentity>
  try { runtime = resolveN8nRuntimeIdentity() } catch { throw new Error('recovery_target_runtime_identity_invalid') }
  if (!runtime) throw new Error('recovery_target_runtime_identity_missing')
  const target = videoRepairCallbackBindingSchema.parse({ callbackProtocol: runtime.callbackProtocol,
    runtimeSlot: runtime.runtimeSlot, runtimeReleaseId: runtime.runtimeReleaseId, port: runtime.port })
  const admission = checkN8nCallbackAdmission(target)
  if (!admission.allowed) throw new Error(`recovery_target_${admission.code}`)
  return target
}

export function assertCurrentVideoRepairCallbackBinding(value: unknown): VideoRepairCallbackBinding {
  const parsed = videoRepairCallbackBindingSchema.safeParse(value)
  if (!parsed.success) throw new Error('recovery_target_callback_binding_invalid')
  const current = currentVideoRepairCallbackBinding()
  if (JSON.stringify(parsed.data) !== JSON.stringify(current)) throw new Error('recovery_target_callback_binding_changed')
  return current
}

/** Preserve the original accepted receiver as provenance; never execute its retired URLs. */
export function snapshotVideoRepairCallbackBinding(routing: Record<string, unknown>) {
  const values: Record<string, string> = {}
  const ports = new Set<number>()
  for (const [key, pathname] of Object.entries(CALLBACKS)) {
    if (typeof routing[key] !== 'string') throw new Error('recovery_original_callback_binding_invalid')
    let url: URL
    try { url = new URL(routing[key] as string) } catch { throw new Error('recovery_original_callback_binding_invalid') }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== pathname) {
      throw new Error('recovery_original_callback_binding_invalid')
    }
    ports.add(Number(url.port || 80))
    values[key] = routing[key] as string
  }
  if (ports.size !== 1) throw new Error('recovery_original_callback_binding_invalid')
  const binding = videoRepairCallbackBindingSchema.safeParse({ callbackProtocol: routing.callbackProtocol,
    runtimeSlot: routing.runtimeSlot, runtimeReleaseId: routing.runtimeReleaseId, port: [...ports][0] })
  if (!binding.success) throw new Error('recovery_original_callback_binding_invalid')
  return { ...binding.data, ...values }
}

export function bindVideoRepairCallbacks(routing: Record<string, unknown>, target: VideoRepairCallbackBinding) {
  return { ...routing, callbackProtocol: target.callbackProtocol, runtimeSlot: target.runtimeSlot,
    runtimeReleaseId: target.runtimeReleaseId, ...Object.fromEntries(Object.entries(CALLBACKS)
      .map(([key, pathname]) => [key, `http://127.0.0.1:${target.port}${pathname}`])) }
}
