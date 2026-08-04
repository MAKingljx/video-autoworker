import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { z } from 'zod'

const routeIdSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/)
const safeComponentSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/)
const envReferenceSchema = z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/)

const commonRouteSchema = z.object({
  id: routeIdSchema,
  resourceId: routeIdSchema.optional(),
  resourceLabel: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  location: z.enum(['local', 'cloud']),
  model: z.string().trim().min(1).max(180),
  enabled: z.boolean().default(true),
  timeoutSeconds: z.coerce.number().int().min(5).max(600).default(120),
  thinking: z.string().trim().max(40).default('off'),
  capabilities: z.array(z.enum(['text', 'vision', 'tools', 'reasoning', 'structured-output']))
    .max(10)
    .default(['text']),
  systemPrompt: z.string().trim().max(4_000).default(''),
})

const openClawRouteSchema = commonRouteSchema.extend({
  transport: z.literal('openclaw'),
  profile: safeComponentSchema,
  agentId: safeComponentSchema,
})

const compatibleApiRouteSchema = commonRouteSchema.extend({
  transport: z.literal('openai-compatible'),
  baseUrl: z.string().trim().url().max(500),
  apiKeyEnv: envReferenceSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.coerce.number().int().min(1).max(131_072).optional(),
}).superRefine((route, ctx) => {
  let url: URL
  try {
    url = new URL(route.baseUrl)
  } catch {
    return
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (route.location === 'local' && (!loopback || url.protocol !== 'http:')) {
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: '本地模型地址必须使用回环 HTTP' })
  }
  if (route.location === 'cloud' && url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: '云端模型地址必须使用 HTTPS' })
  }
})

export const n8nModelRouteSchema = z.discriminatedUnion('transport', [
  openClawRouteSchema,
  compatibleApiRouteSchema,
])

const registrySchema = z.object({
  version: z.literal(1),
  routes: z.array(n8nModelRouteSchema).max(100),
}).superRefine((registry, ctx) => {
  const seen = new Set<string>()
  registry.routes.forEach((route, index) => {
    if (seen.has(route.id)) {
      ctx.addIssue({ code: 'custom', path: ['routes', index, 'id'], message: '模型路由 ID 不能重复' })
    }
    seen.add(route.id)
  })
})

export type N8nModelRoute = z.infer<typeof n8nModelRouteSchema>

export interface N8nModelRegistry {
  routes: N8nModelRoute[]
  source: string
  errors: string[]
}

export interface PublicN8nModelRoute {
  id: string
  resourceId: string
  resourceLabel: string
  label: string
  description: string
  location: 'local' | 'cloud'
  transport: 'openclaw' | 'openai-compatible'
  model: string
  enabled: boolean
  available: boolean
  unavailableReason: string | null
  capabilities: string[]
  profile?: string
  agentId?: string
  baseUrl?: string
  credentialReference?: string
}

const nodeSelectionSchema = z.object({
  routeId: routeIdSchema.optional(),
  fallbackRouteIds: z.array(routeIdSchema).max(8).default([]),
  instruction: z.string().trim().max(4_000).default(''),
}).strict()

const nodeKeySchema = z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9._:-]+$/)

export const n8nModelRoutingConfigSchema = z.object({
  allowTaskOverride: z.boolean().default(true),
  nodes: z.record(nodeKeySchema, nodeSelectionSchema).default({}),
}).strict()

export const n8nTaskRoutingOverrideSchema = z.object({
  nodes: z.record(nodeKeySchema, z.object({
    routeId: routeIdSchema,
    fallbackRouteIds: z.array(routeIdSchema).max(8).default([]),
  }).strict()).default({}),
}).strict()

export type N8nTaskRoutingOverride = z.infer<typeof n8nTaskRoutingOverrideSchema>

function registryPath(): string {
  const configured = String(process.env.AIWORKER_MODEL_ROUTES_FILE || '').trim()
  return configured
    ? resolve(configured.replace(/^~(?=\/)/, homedir()))
    : resolve(homedir(), '.config/video-autoworker/model-routes.json')
}

function parseRegistry(raw: string, source: string): N8nModelRegistry {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return { routes: [], source, errors: ['模型注册表不是有效 JSON'] }
  }
  const parsed = registrySchema.safeParse(decoded)
  if (!parsed.success) {
    return {
      routes: [],
      source,
      errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'registry'}: ${issue.message}`),
    }
  }
  return { routes: parsed.data.routes, source, errors: [] }
}

export function loadN8nModelRegistry(): N8nModelRegistry {
  const inline = String(process.env.AIWORKER_MODEL_ROUTES_JSON || '').trim()
  if (inline) return parseRegistry(inline, 'AIWORKER_MODEL_ROUTES_JSON')

  const filePath = registryPath()
  if (!existsSync(filePath)) return { routes: [], source: filePath, errors: [] }
  try {
    return parseRegistry(readFileSync(filePath, 'utf8'), filePath)
  } catch (error) {
    return {
      routes: [],
      source: filePath,
      errors: [error instanceof Error ? error.message : '无法读取模型注册表'],
    }
  }
}

export function publicN8nModelRoute(route: N8nModelRoute): PublicN8nModelRoute {
  const credentialReference = route.transport === 'openai-compatible' ? route.apiKeyEnv : undefined
  const credentialReady = !credentialReference || Boolean(String(process.env[credentialReference] || '').trim())
  const available = route.enabled && credentialReady
  return {
    id: route.id,
    resourceId: route.resourceId || route.id,
    resourceLabel: route.resourceLabel || route.label,
    label: route.label,
    description: route.description,
    location: route.location,
    transport: route.transport,
    model: route.model,
    enabled: route.enabled,
    available,
    unavailableReason: !route.enabled
      ? '已停用'
      : credentialReady ? null : `缺少外部凭据引用 ${credentialReference}`,
    capabilities: route.capabilities,
    ...(route.transport === 'openclaw'
      ? { profile: route.profile, agentId: route.agentId }
      : {
          baseUrl: route.baseUrl,
          ...(credentialReference ? { credentialReference } : {}),
        }),
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function parseN8nModelRoutingConfig(config: unknown) {
  const raw = objectValue(config)
  const parsed = n8nModelRoutingConfigSchema.safeParse(raw.modelRouting || {})
  return parsed.success ? parsed.data : { allowTaskOverride: true, nodes: {} }
}

export function validateN8nModelRoutingConfig(config: unknown): z.ZodIssue[] {
  const raw = objectValue(config)
  if (raw.modelRouting === undefined) return []
  const parsed = n8nModelRoutingConfigSchema.safeParse(raw.modelRouting)
  return parsed.success ? [] : parsed.error.issues
}

export function validateTaskRouteIds(override: N8nTaskRoutingOverride, registry = loadN8nModelRegistry()): string[] {
  const known = new Set(registry.routes.map(route => route.id))
  const missing = new Set<string>()
  for (const selection of Object.values(override.nodes)) {
    for (const routeId of [selection.routeId, ...selection.fallbackRouteIds]) {
      if (!known.has(routeId)) missing.add(routeId)
    }
  }
  return [...missing]
}

export interface ResolvedN8nNodeRoute {
  route: N8nModelRoute
  instruction: string
  candidates: string[]
  source: 'task' | 'binding' | 'legacy'
}

export function resolveN8nNodeRoute(
  routing: Record<string, unknown>,
  nodeKey: string,
  registry = loadN8nModelRegistry(),
): ResolvedN8nNodeRoute {
  if (registry.errors.length) throw new Error(`模型注册表无效：${registry.errors.join('；')}`)
  const config = objectValue(routing.config)
  const modelRouting = parseN8nModelRoutingConfig(config)
  const overrideParsed = n8nTaskRoutingOverrideSchema.safeParse(routing.taskRouting)
  const taskSelection = modelRouting.allowTaskOverride && overrideParsed.success
    ? overrideParsed.data.nodes[nodeKey]
    : undefined
  const bindingSelection = modelRouting.nodes[nodeKey]
  const selection = taskSelection || bindingSelection
  const source: ResolvedN8nNodeRoute['source'] = taskSelection ? 'task' : bindingSelection ? 'binding' : 'legacy'
  const candidates = selection
    ? [...new Set([selection.routeId, ...selection.fallbackRouteIds].filter(Boolean))] as string[]
    : []

  if (candidates.length) {
    const byId = new Map(registry.routes.map(route => [route.id, route]))
    const unavailable: string[] = []
    for (const routeId of candidates) {
      const route = byId.get(routeId)
      if (!route) {
        unavailable.push(`${routeId}: 未登记`)
        continue
      }
      const publicRoute = publicN8nModelRoute(route)
      if (!publicRoute.available) {
        unavailable.push(`${routeId}: ${publicRoute.unavailableReason || '不可用'}`)
        continue
      }
      return { route, instruction: bindingSelection?.instruction || '', candidates, source }
    }
    throw new Error(`没有可用的模型路由：${unavailable.join('；')}`)
  }

  const legacyModel = String(routing.model || '').trim()
  if (!legacyModel) throw new Error(`节点 ${nodeKey} 没有配置模型路由`)
  const profile = String(config.profile || 'qwen-current').trim()
  const agentId = String(config.agentId || 'second-original').trim()
  const legacy = openClawRouteSchema.parse({
    id: 'legacy-binding',
    label: '任务链兼容模型',
    description: '由旧版任务链模型字段提供',
    location: legacyModel.includes('local') ? 'local' : 'cloud',
    transport: 'openclaw',
    model: legacyModel,
    profile,
    agentId,
    thinking: String(config.thinking || 'off'),
    timeoutSeconds: Number(routing.timeoutSeconds) || 120,
    capabilities: ['text', 'tools'],
  })
  return { route: legacy, instruction: bindingSelection?.instruction || '', candidates: [], source }
}
