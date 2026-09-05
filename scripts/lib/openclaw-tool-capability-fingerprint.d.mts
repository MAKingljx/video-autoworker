export type ToolInventoryKind = 'catalog' | 'effective'

export interface OpenClawToolPolicyNotice {
  id: 'browser-filtered-by-profile'
  severity: 'info'
  messageSha256: string
  profileSha256: string
}

export interface OpenClawToolCapability {
  id: string
  source: 'core' | 'plugin' | 'channel' | 'mcp'
  pluginId: string | null
  channelId: string | null
  descriptorSurfaceSha256: string
}

export function normalizeOpenClawToolPolicyNotices(
  value: unknown,
  options?: { kind?: ToolInventoryKind; label?: string },
): OpenClawToolPolicyNotice[]

export function validateNormalizedOpenClawToolPolicyNotices(
  value: unknown,
  options?: { kind?: ToolInventoryKind; label?: string },
): OpenClawToolPolicyNotice[]

export function fingerprintOpenClawToolInventory(
  value: unknown,
  options?: { agentId?: string; kind?: ToolInventoryKind; label?: string },
): OpenClawToolCapability[]
