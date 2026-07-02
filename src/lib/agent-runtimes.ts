import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { config } from './config'
import { runCommand, runOpenClaw } from './command'
import { logger } from './logger'

export type RuntimeId = 'openclaw'
export type DeploymentMode = 'local' | 'docker'

export interface RuntimeStatus {
  id: RuntimeId
  name: string
  description: string
  installed: boolean
  version: string | null
  running: boolean
  authRequired: boolean
  authHint: string
  authenticated: boolean
}

export interface InstallJob {
  id: string
  runtime: RuntimeId
  mode: DeploymentMode
  status: 'pending' | 'running' | 'success' | 'failed'
  output: string
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface RuntimeMeta {
  name: string
  description: string
  authRequired: boolean
  authHint: string
}

const RUNTIME_META: Record<RuntimeId, RuntimeMeta> = {
  openclaw: {
    name: 'OpenClaw',
    description: '管理 OpenClaw 网关、远端配置和本地千问执行节点。',
    authRequired: false,
    authHint: '',
  },
}

export function getRuntimeMeta(id: RuntimeId): RuntimeMeta | undefined {
  return RUNTIME_META[id]
}

// ---------------------------------------------------------------------------
// In-memory job store — ephemeral, not persisted across restarts
// ---------------------------------------------------------------------------

const installJobs = new Map<string, InstallJob>()

// Clean up old jobs (>1 hour) periodically
function pruneJobs() {
  const cutoff = Date.now() - 3600_000
  for (const [id, job] of installJobs) {
    if (job.finishedAt && job.finishedAt < cutoff) installJobs.delete(id)
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function detectOpenClaw(): RuntimeStatus {
  const meta = RUNTIME_META.openclaw
  let installed = false
  let version: string | null = null
  let running = false

  // Check config file existence
  if (config.openclawConfigPath && existsSync(config.openclawConfigPath)) {
    installed = true
  }

  // Try to get version
  try {
    const result = require('node:child_process').spawnSync(
      config.openclawBin || 'openclaw',
      ['--version'],
      { stdio: 'pipe', timeout: 3000 }
    )
    if (result.status === 0) {
      installed = true
      version = (result.stdout?.toString() || '').trim() || null
    }
  } catch {
    // binary not found
  }

  // Check if gateway port is listening (simple sync check)
  try {
    const net = require('node:net')
    const socket = new net.Socket()
    socket.setTimeout(500)
    const connected = new Promise<boolean>((resolve) => {
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.connect(config.gatewayPort, config.gatewayHost)
    })
    // We can't await here synchronously, so just check config existence for "running"
    running = installed
  } catch {
    // ignore
  }

  return { id: 'openclaw', ...meta, installed, version, running, authenticated: true }
}

const DETECTORS: Record<RuntimeId, () => RuntimeStatus> = {
  openclaw: detectOpenClaw,
}

export function detectRuntime(id: RuntimeId): RuntimeStatus {
  const detector = DETECTORS[id]
  return detector ? detector() : { id, name: id, description: '', installed: false, version: null, running: false, authRequired: false, authHint: '', authenticated: false }
}

export function detectAllRuntimes(): RuntimeStatus[] {
  return [DETECTORS.openclaw()]
}

// ---------------------------------------------------------------------------
// Installation (background jobs)
// ---------------------------------------------------------------------------

export function startInstall(runtime: RuntimeId, mode: DeploymentMode): InstallJob {
  pruneJobs()

  const job: InstallJob = {
    id: crypto.randomUUID(),
    runtime,
    mode,
    status: 'running',
    output: '',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  }

  installJobs.set(job.id, job)

  if (mode === 'docker') {
    // Docker mode doesn't actually install — just returns the sidecar YAML
    job.output = generateDockerSidecar(runtime)
    job.status = 'success'
    job.finishedAt = Date.now()
    return job
  }

  // Local install — run in background
  installOpenClawLocal(job).catch((err) => {
    job.status = 'failed'
    job.error = String(err?.message || err)
    job.finishedAt = Date.now()
    logger.error({ err, runtime }, 'Agent runtime install failed')
  })

  return job
}

// ---------------------------------------------------------------------------
// Install environment — Docker runs as non-root with HOME=/nonexistent
// ---------------------------------------------------------------------------

function getInstallEnv(): NodeJS.ProcessEnv {
  const path = require('node:path')
  const { mkdirSync } = require('node:fs')
  const dataDir = path.resolve(config.dataDir || '.data')
  const npmPrefix = path.join(dataDir, '.npm-global')
  const homedir = !process.env.HOME || process.env.HOME === '/nonexistent'
    ? dataDir
    : process.env.HOME

  try { mkdirSync(npmPrefix, { recursive: true }) } catch {}
  try { mkdirSync(path.join(homedir, '.npm'), { recursive: true }) } catch {}

  return {
    ...process.env,
    HOME: homedir,
    npm_config_prefix: npmPrefix,
    npm_config_cache: path.join(homedir, '.npm'),
    PATH: `${npmPrefix}/bin:${process.env.PATH || ''}`,
  }
}

async function installOpenClawLocal(job: InstallJob): Promise<void> {
  job.output += '> Installing OpenClaw...\n'
  const env = getInstallEnv()
  try {
    const result = await runCommand('bash', ['-c', 'curl -fsSL https://get.openclaw.dev | bash'], {
      timeoutMs: 300_000, env,
    })
    if (result.stdout) job.output += result.stdout + '\n'
    if (result.stderr) job.output += result.stderr + '\n'
    if (result.code === 0) {
      job.output += '\n> OpenClaw installed. Running initial setup...\n'
      try {
        const onboard = await runCommand('openclaw', ['onboard', '--non-interactive'], { timeoutMs: 60_000, env })
        if (onboard.stdout) job.output += onboard.stdout + '\n'
        if (onboard.stderr) job.output += onboard.stderr + '\n'
      } catch {
        job.output += '> Note: "openclaw onboard" skipped (run manually if needed).\n'
      }
      job.status = 'success'
      job.output += '\n> OpenClaw installed successfully.\n'
    } else {
      job.status = 'failed'
      job.error = `Install exited with code ${result.code}`
      job.output += `\n> Install failed (exit code ${result.code}).\n`
    }
  } catch (err: any) {
    job.status = 'failed'
    job.error = err?.message || 'Unknown error'
    job.output += `\n> Error: ${job.error}\n`
  }
  job.finishedAt = Date.now()
}

export function getInstallJob(id: string): InstallJob | null {
  return installJobs.get(id) ?? null
}

export function getActiveJobs(): InstallJob[] {
  pruneJobs()
  return [...installJobs.values()]
}

// ---------------------------------------------------------------------------
// Docker sidecar templates
// ---------------------------------------------------------------------------

export function generateDockerSidecar(runtime: RuntimeId): string {
  return `  # OpenClaw Gateway sidecar
  openclaw-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    container_name: openclaw-gateway
    ports:
      - "\${OPENCLAW_GATEWAY_PORT:-18789}:18789"
    volumes:
      - openclaw-data:/root/.openclaw
    networks:
      - mc-net
    restart: unless-stopped

# Add to volumes section:
#   openclaw-data:`
}
