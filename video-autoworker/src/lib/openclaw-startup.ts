import { runCommand } from './command'
import {
  getOpenClawProfiles,
  getProfileStatus,
  type OpenClawProfileDefinition,
} from './openclaw-profiles'

type StartupServiceState = 'skipped' | 'started' | 'starting' | 'failed'

export interface OpenClawStartupServiceResult {
  id: string
  label: string
  state: StartupServiceState
  summary: string
  detail?: string
}

export interface OpenClawStartupResult {
  ok: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  services: OpenClawStartupServiceResult[]
}

const QWEN_MODEL_URL = 'http://127.0.0.1:18091/v1/models'
const QWEN_LAUNCH_AGENT = 'ai.aiworker.qwen36-server'
const PROFILE_START_TIMEOUT_MS = 30_000
const QWEN_START_TIMEOUT_MS = 90_000

export async function startOpenClawRuntime(platformPort: number): Promise<OpenClawStartupResult> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const qwen = await ensureQwenServer()
  const profiles = await Promise.all(getOpenClawProfiles().map(ensureOpenClawProfile))
  const platform: OpenClawStartupServiceResult = {
    id: 'visual-platform',
    label: '可视化平台',
    state: 'skipped',
    summary: `:${platformPort} 正在处理本次请求，已运行，跳过`,
  }
  const services = [qwen, ...profiles, platform]

  return {
    ok: services.every(service => service.state !== 'failed'),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    services,
  }
}

async function ensureOpenClawProfile(profile: OpenClawProfileDefinition): Promise<OpenClawStartupServiceResult> {
  const current = await getProfileStatus(profile)
  if (current.status === 'online' && current.connectivity === 'ok') {
    return {
      id: profile.id,
      label: profile.label,
      state: 'skipped',
      summary: `Gateway :${profile.gatewayPort} 已运行，跳过`,
    }
  }

  try {
    await kickstart(profile.launchAgent)
  } catch (error) {
    return failed(profile.id, profile.label, '无法提交启动命令', error)
  }

  const ready = await waitForProfile(profile, PROFILE_START_TIMEOUT_MS)
  if (ready) {
    return {
      id: profile.id,
      label: profile.label,
      state: 'started',
      summary: `Gateway :${profile.gatewayPort} 已启动并通过探活`,
    }
  }

  return {
    id: profile.id,
    label: profile.label,
    state: 'starting',
    summary: `Gateway :${profile.gatewayPort} 已提交启动，仍在初始化`,
  }
}

async function ensureQwenServer(): Promise<OpenClawStartupServiceResult> {
  const current = await getQwenHealth()
  if (current.ok) {
    return {
      id: 'qwen-model',
      label: '千问模型',
      state: 'skipped',
      summary: current.summary,
    }
  }

  try {
    await kickstart(QWEN_LAUNCH_AGENT)
  } catch (error) {
    return failed('qwen-model', '千问模型', '无法提交模型启动命令', error)
  }

  const ready = await waitForQwen(QWEN_START_TIMEOUT_MS)
  if (ready.ok) {
    return {
      id: 'qwen-model',
      label: '千问模型',
      state: 'started',
      summary: ready.summary,
    }
  }

  return {
    id: 'qwen-model',
    label: '千问模型',
    state: 'starting',
    summary: '模型启动命令已提交，仍在加载',
    detail: ready.detail,
  }
}

async function kickstart(launchAgent: string): Promise<void> {
  const uid = process.getuid?.()
  if (!uid) throw new Error('无法读取当前用户 ID')
  await runCommand('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${launchAgent}`], { timeoutMs: 15_000 })
}

async function waitForProfile(profile: OpenClawProfileDefinition, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await getProfileStatus(profile)
    if (status.status === 'online' && status.connectivity === 'ok') return true
    await pause(1_500)
  }
  return false
}

async function waitForQwen(timeoutMs: number): Promise<QwenHealth> {
  const deadline = Date.now() + timeoutMs
  let health = await getQwenHealth()
  while (!health.ok && Date.now() < deadline) {
    await pause(2_000)
    health = await getQwenHealth()
  }
  return health
}

interface QwenHealth {
  ok: boolean
  summary: string
  detail?: string
}

async function getQwenHealth(): Promise<QwenHealth> {
  try {
    const response = await fetch(QWEN_MODEL_URL, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) {
      return { ok: false, summary: `模型服务返回 HTTP ${response.status}` }
    }

    const payload = await response.json().catch(() => null) as { data?: Array<{ id?: string }> } | null
    const model = payload?.data?.[0]?.id
    return {
      ok: true,
      summary: model ? `模型 ${model} 已运行，跳过` : '模型服务已运行，跳过',
    }
  } catch (error) {
    return {
      ok: false,
      summary: '模型服务尚未就绪',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function failed(id: string, label: string, summary: string, error: unknown): OpenClawStartupServiceResult {
  return {
    id,
    label,
    state: 'failed',
    summary,
    detail: error instanceof Error ? error.message : String(error),
  }
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
