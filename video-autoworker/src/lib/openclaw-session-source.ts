/**
 * Compatibility type for UI code that has not yet adopted the runtime name.
 * Session discovery and mutation live exclusively behind RuntimeProvider.
 */
export type { RuntimeSessionSummary as GatewaySession } from './runtime/contracts'
