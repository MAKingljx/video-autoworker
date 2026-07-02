import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runCommand, runOpenClaw } from './command'

export type OpenClawProfileId = 'gpt-main' | 'qwen-current' | 'qwen-weixin-new'
export type OpenClawProfileAction = 'restart' | 'model-test' | 'agent-test'

export interface OpenClawProfileDefinition {
  id: OpenClawProfileId
  label: string
  gatewayPort: number
  launchAgent: string
  agent: string
  workspace: string
  model: string
  channel: string
  configPath?: string
}

export interface OpenClawProfileStatus extends OpenClawProfileDefinition {
  status: 'online' | 'offline' | 'error' | 'unknown'
  pid: number | null
  cliVersion: string | null
  gatewayVersion: string | null
  connectivity: 'ok' | 'failed' | 'unknown'
  listening: string[]
  checkedAt: string
  latencyMs: number
  error?: string
  raw?: string
}

export interface OpenClawProfileActionResult {
  profile: OpenClawProfileId
  action: OpenClawProfileAction
  ok: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  summary: string
  output: string
}

export interface OpenClawProfileConfigBackup {
  name: string
  path: string
  size: number
  mtimeMs: number
  createdAt: string
}

export interface OpenClawProfileConfigValidation {
  ok: boolean
  issues: string[]
}

export interface OpenClawProfileConfigReadResult {
  profile: OpenClawProfileId
  path: string
  raw: string
  rawSize: number
  hash: string
  mtimeMs: number
  backups: OpenClawProfileConfigBackup[]
  validation: OpenClawProfileConfigValidation
}

export interface OpenClawProfileConfigWriteResult {
  profile: OpenClawProfileId
  path: string
  ok: boolean
  hash?: string
  backup?: OpenClawProfileConfigBackup
  backups?: OpenClawProfileConfigBackup[]
  removed?: string[]
  validation?: OpenClawProfileConfigValidation
  error?: string
  code?: string
}

export interface OpenClawProfilesAcceptanceReport {
  generatedAt: string
  markdown: string
  issues: string[]
  profiles: Array<{
    id: OpenClawProfileId
    label: string
    status: OpenClawProfileStatus['status']
    connectivity: OpenClawProfileStatus['connectivity']
    pid: number | null
    gatewayPort: number
    model: string
    channel: string
    configPath: string
    configValid: boolean
    backupCount: number
  }>
}

export const DEFAULT_OPENCLAW_PROFILES: OpenClawProfileDefinition[] = [
  {
    id: 'gpt-main',
    label: 'GPT 主入口',
    gatewayPort: 18789,
    launchAgent: 'ai.openclaw.gpt-main',
    agent: 'main',
    workspace: '/Users/heisenbergs-1/AI-worker-workspace',
    model: 'openai/gpt-5.5',
    channel: '微信',
    configPath: '/Users/heisenbergs-1/.openclaw-gpt-main/openclaw.json',
  },
  {
    id: 'qwen-current',
    label: '千问当前入口',
    gatewayPort: 18889,
    launchAgent: 'ai.openclaw.qwen-current',
    agent: 'second-original',
    workspace: '/Users/heisenbergs-1/AI-worker-second-original-workspace',
    model: 'qwen36-tools-local/default_model',
    channel: 'Telegram',
    configPath: '/Users/heisenbergs-1/.openclaw-qwen-current/openclaw.json',
  },
  {
    id: 'qwen-weixin-new',
    label: '千问微信新入口',
    gatewayPort: 18989,
    launchAgent: 'ai.openclaw.qwen-weixin-new',
    agent: 'main',
    workspace: '/Users/heisenbergs-1/AI-worker-qwen-weixin-new-workspace',
    model: 'qwen36-tools-local/default_model',
    channel: '微信 / WhatsApp',
    configPath: '/Users/heisenbergs-1/.openclaw-qwen-weixin-new/openclaw.json',
  },
]

const PROFILE_IDS = new Set(DEFAULT_OPENCLAW_PROFILES.map(profile => profile.id))
const ACTIONS = new Set<OpenClawProfileAction>(['restart', 'model-test', 'agent-test'])
const DEFAULT_PROMPT = '只输出一个字：好'
const CONFIG_BACKUP_KEEP = 2
const REDACTED_SECRET_VALUE = '--------'

const openClawProfileConfigSchema = z.object({
  gateway: z.object({
    port: z.number().int().min(1).max(65535).optional(),
  }).passthrough().optional(),
  agents: z.record(z.string(), z.unknown()).optional(),
  models: z.record(z.string(), z.unknown()).optional(),
  channels: z.record(z.string(), z.unknown()).optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export function getOpenClawProfiles(): OpenClawProfileDefinition[] {
  const raw = String(process.env.MC_OPENCLAW_PROFILES_JSON || '').trim()
  if (!raw) return DEFAULT_OPENCLAW_PROFILES

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_OPENCLAW_PROFILES
    return parsed
      .filter(isProfileDefinition)
      .slice(0, 20)
  } catch {
    return DEFAULT_OPENCLAW_PROFILES
  }
}

export function getOpenClawProfile(id: string): OpenClawProfileDefinition | null {
  return getOpenClawProfiles().find(profile => profile.id === id) || null
}

export function getProfileConfigPath(profile: OpenClawProfileDefinition): string {
  if (profile.configPath) return profile.configPath
  return `/Users/heisenbergs-1/.openclaw-${profile.id}/openclaw.json`
}

export function assertProfileId(id: string): asserts id is OpenClawProfileId {
  if (!PROFILE_IDS.has(id as OpenClawProfileId)) {
    throw new Error('未知 OpenClaw 配置档')
  }
}

export function assertProfileAction(action: string): asserts action is OpenClawProfileAction {
  if (!ACTIONS.has(action as OpenClawProfileAction)) {
    throw new Error('不支持的配置档操作')
  }
}

export function parseGatewayStatus(raw: string, profile: OpenClawProfileDefinition, startedAtMs: number): OpenClawProfileStatus {
  const text = String(raw || '')
  const runtimeMatch = text.match(/Runtime:\s+([^\n]+)/i)
  const pidMatch = text.match(/Runtime:\s+[^\n]*\(pid\s+(\d+)/i)
  const cliVersionMatch = text.match(/CLI version:\s+([^\n]+)/i)
  const gatewayVersionMatch = text.match(/Gateway version:\s+([^\n]+)/i)
  const probeMatch = text.match(/Connectivity probe:\s+([^\n]+)/i)
  const listeningMatch = text.match(/Listening:\s+([^\n]+)/i)

  const runtime = runtimeMatch?.[1]?.toLowerCase() || ''
  const probe = probeMatch?.[1]?.trim().toLowerCase() || ''
  const status =
    runtime.includes('running') && probe === 'ok'
      ? 'online'
      : runtime.includes('running')
        ? 'unknown'
        : runtime
          ? 'offline'
          : 'unknown'

  return {
    ...profile,
    status,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    cliVersion: cliVersionMatch?.[1]?.trim() || null,
    gatewayVersion: gatewayVersionMatch?.[1]?.trim() || null,
    connectivity: probe === 'ok' ? 'ok' : probe ? 'failed' : 'unknown',
    listening: listeningMatch?.[1]?.split(',').map(item => item.trim()).filter(Boolean) || [],
    checkedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - startedAtMs),
    raw: text,
  }
}

export async function getProfileStatus(profile: OpenClawProfileDefinition): Promise<OpenClawProfileStatus> {
  const startedAtMs = Date.now()
  try {
    const result = await runProfileOpenClaw(profile.id, ['gateway', 'status', '--deep'], 20000)
    return parseGatewayStatus(`${result.stdout}\n${result.stderr}`, profile, startedAtMs)
  } catch (error) {
    const detail = commandErrorDetail(error)
    return {
      ...profile,
      status: 'error',
      pid: null,
      cliVersion: null,
      gatewayVersion: null,
      connectivity: 'failed',
      listening: [],
      checkedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedAtMs),
      error: localizeProfileError(detail || 'Profile status command failed'),
    }
  }
}

export async function runProfileAction(profile: OpenClawProfileDefinition, action: OpenClawProfileAction): Promise<OpenClawProfileActionResult> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const args = actionArgs(profile, action)

  try {
    const result = await runProfileOpenClaw(profile.id, args, action === 'restart' ? 90000 : 240000)
    const output = `${result.stdout}\n${result.stderr}`.trim()
    return {
      profile: profile.id,
      action,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      summary: summarizeActionOutput(action, output),
      output,
    }
  } catch (error) {
    const output = commandErrorDetail(error)
    return {
      profile: profile.id,
      action,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      summary: summarizeCommandFailure(action, output),
      output,
    }
  }
}

export function computeConfigHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export function validateOpenClawProfileConfig(configValue: unknown): OpenClawProfileConfigValidation {
  if (!configValue || typeof configValue !== 'object' || Array.isArray(configValue)) {
    return { ok: false, issues: ['根节点：必须是对象'] }
  }

  const result = openClawProfileConfigSchema.safeParse(configValue)
  if (result.success) return { ok: true, issues: [] }

  return {
    ok: false,
    issues: result.error.issues.map(issue => {
      const path = issue.path.length ? issue.path.join('.') : '根节点'
      return `${path}：${localizeValidationIssue(issue.message)}`
    }),
  }
}

export async function readProfileConfig(profile: OpenClawProfileDefinition): Promise<OpenClawProfileConfigReadResult> {
  const configPath = getProfileConfigPath(profile)
  const result = await runProfileNodeScript(READ_PROFILE_CONFIG_SCRIPT, [configPath], 15000)
  const payload = parseRemotePayload(result.stdout)
  const raw = String(payload.raw || '')
  let validation: OpenClawProfileConfigValidation
  let displayRaw = raw

  try {
    const parsed = JSON.parse(raw)
    validation = validateOpenClawProfileConfig(parsed)
    displayRaw = JSON.stringify(redactProfileConfigSecrets(parsed), null, 2) + '\n'
  } catch (error) {
    validation = { ok: false, issues: [`json: ${(error as Error).message}`] }
  }

  return {
    profile: profile.id,
    path: String(payload.path || configPath),
    raw: displayRaw,
    rawSize: Number(payload.rawSize || raw.length),
    hash: computeConfigHash(raw),
    mtimeMs: Number(payload.mtimeMs || 0),
    backups: normalizeBackups(payload.backups),
    validation,
  }
}

function redactProfileConfigSecrets(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map(item => redactProfileConfigSecrets(item, parentKey))
  if (!value || typeof value !== 'object') return value

  const redacted: Record<string, unknown> = {}
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveConfigKey(key, parentKey) && typeof childValue === 'string' && childValue.trim()) {
      redacted[key] = REDACTED_SECRET_VALUE
    } else {
      redacted[key] = redactProfileConfigSecrets(childValue, key)
    }
  }
  return redacted
}

function isSensitiveConfigKey(key: string, parentKey = ''): boolean {
  const joined = `${parentKey}.${key}`.toLowerCase()
  return ['password', 'secret', 'token', 'apikey', 'api_key'].some(marker => joined.includes(marker))
}

export async function saveProfileConfig(
  profile: OpenClawProfileDefinition,
  raw: string,
  expectedHash?: string,
): Promise<OpenClawProfileConfigWriteResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      profile: profile.id,
      path: getProfileConfigPath(profile),
      ok: false,
      validation: { ok: false, issues: [`json: ${(error as Error).message}`] },
      error: 'JSON 格式无效',
      code: 'INVALID_JSON',
    }
  }

  const validation = validateOpenClawProfileConfig(parsed)
  if (!validation.ok) {
    return {
      profile: profile.id,
      path: getProfileConfigPath(profile),
      ok: false,
      validation,
      error: '配置校验失败',
      code: 'VALIDATION_FAILED',
    }
  }

  const configPath = getProfileConfigPath(profile)
  const input = JSON.stringify({
    raw: JSON.stringify(parsed, null, 2) + '\n',
    hash: expectedHash || '',
    keep: CONFIG_BACKUP_KEEP,
  })
  const result = await runProfileNodeScript(SAVE_PROFILE_CONFIG_SCRIPT, [configPath], 20000, input)
  const payload = parseRemotePayload(result.stdout)

  return {
    profile: profile.id,
    path: String(payload.path || configPath),
    ok: payload.ok === true,
    hash: typeof payload.hash === 'string' ? payload.hash : undefined,
    backup: normalizeBackups(payload.backup ? [payload.backup] : [])[0],
    backups: normalizeBackups(payload.backups),
    removed: Array.isArray(payload.removed) ? payload.removed.map(String) : [],
    validation,
    error: typeof payload.error === 'string' ? payload.error : undefined,
    code: typeof payload.code === 'string' ? payload.code : undefined,
  }
}

export async function restoreProfileConfigBackup(
  profile: OpenClawProfileDefinition,
  backupName: string,
  expectedHash?: string,
): Promise<OpenClawProfileConfigWriteResult> {
  const configPath = getProfileConfigPath(profile)
  const input = JSON.stringify({
    backupName,
    hash: expectedHash || '',
    keep: CONFIG_BACKUP_KEEP,
  })
  const result = await runProfileNodeScript(RESTORE_PROFILE_CONFIG_SCRIPT, [configPath], 20000, input)
  const payload = parseRemotePayload(result.stdout)

  let validation: OpenClawProfileConfigValidation | undefined
  if (payload.rawAfter) {
    try {
      validation = validateOpenClawProfileConfig(JSON.parse(String(payload.rawAfter)))
    } catch (error) {
      validation = { ok: false, issues: [`json: ${(error as Error).message}`] }
    }
  }

  return {
    profile: profile.id,
    path: String(payload.path || configPath),
    ok: payload.ok === true,
    hash: typeof payload.hash === 'string' ? payload.hash : undefined,
    backup: normalizeBackups(payload.backup ? [payload.backup] : [])[0],
    backups: normalizeBackups(payload.backups),
    removed: Array.isArray(payload.removed) ? payload.removed.map(String) : [],
    validation,
    error: typeof payload.error === 'string' ? payload.error : undefined,
    code: typeof payload.code === 'string' ? payload.code : undefined,
  }
}

export async function generateProfilesAcceptanceReport(): Promise<OpenClawProfilesAcceptanceReport> {
  const generatedAt = new Date().toISOString()
  const profiles = getOpenClawProfiles()
  const statuses = await Promise.all(profiles.map(profile => getProfileStatus(profile)))
  const configResults = await Promise.allSettled(profiles.map(profile => readProfileConfig(profile)))
  const configsByProfile = new Map<OpenClawProfileId, OpenClawProfileConfigReadResult>()
  const issues: string[] = []

  configResults.forEach((result, index) => {
    const profile = profiles[index]
    if (result.status === 'fulfilled') {
      configsByProfile.set(profile.id, result.value)
      if (!result.value.validation.ok) {
        issues.push(`${profile.id}：配置校验失败（${result.value.validation.issues.join('；')}）`)
      }
      if (result.value.backups.length > CONFIG_BACKUP_KEEP) {
        issues.push(`${profile.id}：轻量备份有 ${result.value.backups.length} 个，预期不超过 ${CONFIG_BACKUP_KEEP} 个`)
      }
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      issues.push(`${profile.id}：配置读取失败（${localizeProfileError(reason)}）`)
    }
  })

  statuses.forEach(status => {
    if (status.status !== 'online' || status.connectivity !== 'ok') {
      issues.push(`${status.id}：网关状态 ${describeProfileStatus(status.status)}，连通性 ${describeConnectivity(status.connectivity)}`)
    }
  })

  const rows = statuses.map(status => {
    const configResult = configsByProfile.get(status.id)
    return {
      id: status.id,
      label: status.label,
      status: status.status,
      connectivity: status.connectivity,
      pid: status.pid,
      gatewayPort: status.gatewayPort,
      model: status.model,
      channel: status.channel,
      configPath: getProfileConfigPath(status),
      configValid: configResult?.validation.ok ?? false,
      backupCount: configResult?.backups.length ?? 0,
    }
  })

  const markdown = buildAcceptanceMarkdown(generatedAt, rows, issues)

  return {
    generatedAt,
    markdown,
    issues,
    profiles: rows,
  }
}

function buildAcceptanceMarkdown(
  generatedAt: string,
  rows: OpenClawProfilesAcceptanceReport['profiles'],
  issues: string[],
): string {
  const lines = [
    '# OpenClaw 控制台首版验收报告',
    '',
    `生成时间：${generatedAt}`,
    '',
    '## 配置档状态',
    '',
    '| 配置档 | 状态 | 连通性 | PID | 端口 | 模型 | 通道 | 配置校验 | 备份数 |',
    '| --- | --- | --- | ---: | ---: | --- | --- | --- | ---: |',
    ...rows.map(row => [
      row.id,
      describeProfileStatus(row.status),
      describeConnectivity(row.connectivity),
      row.pid ?? '-',
      row.gatewayPort,
      row.model,
      row.channel,
      row.configValid ? '通过' : '失败',
      row.backupCount,
    ].join(' | ')).map(line => `| ${line} |`),
    '',
    '## 配置路径',
    '',
    ...rows.map(row => `- ${row.id}: \`${row.configPath}\``),
    '',
    '## 问题清单',
    '',
  ]

  if (issues.length === 0) {
    lines.push('- 未发现阻塞问题。')
  } else {
    lines.push(...issues.map(issue => `- ${issue}`))
  }

  lines.push(
    '',
    '## 验收结论',
    '',
    issues.length === 0
      ? '三套 OpenClaw profile 当前满足首版网页控制台验收口径：状态可见、配置可读、配置校验通过，并具备保存前备份与轻量备份保留机制。'
      : '首版网页控制台已生成验收证据，但仍存在需要处理的问题，见问题清单。',
  )

  return lines.join('\n')
}

function normalizeBackups(value: unknown): OpenClawProfileConfigBackup[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      const backup = item as Partial<OpenClawProfileConfigBackup>
      return {
        name: String(backup.name || ''),
        path: String(backup.path || ''),
        size: Number(backup.size || 0),
        mtimeMs: Number(backup.mtimeMs || 0),
        createdAt: typeof backup.createdAt === 'string'
          ? backup.createdAt
          : new Date(Number(backup.mtimeMs || 0)).toISOString(),
      }
    })
    .filter(backup => backup.name && backup.path)
}

function parseRemotePayload(stdout: string): Record<string, any> {
  const text = String(stdout || '').trim()
  if (!text) throw new Error('远端命令没有返回 JSON 数据')
  const parsed = parseJsonFromOutput(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`远端命令返回的 JSON 无效：${text.slice(0, 200)}`)
  }
  return parsed as Record<string, any>
}

async function runProfileNodeScript(script: string, args: string[], timeoutMs: number, input?: string) {
  const target = String(process.env.MC_OPENCLAW_PROFILE_TARGET || 'ssh').trim().toLowerCase()
  const nodeBin = String(process.env.MC_OPENCLAW_REMOTE_NODE || 'node').trim() || 'node'
  const commandArgs = ['-e', script, '--', ...args]

  if (target === 'local') {
    return runCommand(nodeBin, commandArgs, { timeoutMs, input })
  }

  const sshHost = String(process.env.MC_OPENCLAW_PROFILE_SSH_HOST || 'heisenbergs-1').trim()
  if (!sshHost) throw new Error('MC_OPENCLAW_PROFILE_SSH_HOST is not configured')

  const remoteCommand = [nodeBin, ...commandArgs].map(shellQuote).join(' ')
  return runCommand('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    sshHost,
    remoteCommand,
  ], { timeoutMs, input })
}

const SHARED_REMOTE_CONFIG_HELPERS = `
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function hash(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function listBackups(configPath) {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(base + '.bak-'))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const st = fs.statSync(fullPath);
      return {
        name,
        path: fullPath,
        size: st.size,
        mtimeMs: st.mtimeMs,
        createdAt: new Date(st.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function pruneBackups(configPath, keep) {
  const backups = listBackups(configPath);
  const removed = [];
  for (const backup of backups.slice(Math.max(0, keep))) {
    fs.unlinkSync(backup.path);
    removed.push(backup.name);
  }
  return removed;
}
function readStdin() {
  return fs.readFileSync(0, 'utf8');
}
function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}
function backupCurrent(configPath, suffix) {
  const st = fs.statSync(configPath);
  const backupPath = configPath + '.bak-' + suffix + '-' + stamp();
  fs.copyFileSync(configPath, backupPath);
  fs.chmodSync(backupPath, st.mode & 0o777);
  const bst = fs.statSync(backupPath);
  return {
    name: path.basename(backupPath),
    path: backupPath,
    size: bst.size,
    mtimeMs: bst.mtimeMs,
    createdAt: new Date(bst.mtimeMs).toISOString(),
  };
}
function isSensitiveConfigKey(key, parentKey) {
  const joined = String(parentKey || '') + '.' + String(key || '');
  const lowered = joined.toLowerCase();
  return ['password', 'secret', 'token', 'apikey', 'api_key'].some((marker) => lowered.includes(marker));
}
function mergeRedactedSecrets(proposed, current, parentKey) {
  if (Array.isArray(proposed)) {
    return proposed.map((item, index) => mergeRedactedSecrets(item, Array.isArray(current) ? current[index] : undefined, parentKey));
  }
  if (!proposed || typeof proposed !== 'object') return proposed;
  const output = {};
  for (const [key, value] of Object.entries(proposed)) {
    const currentValue = current && typeof current === 'object' ? current[key] : undefined;
    if (isSensitiveConfigKey(key, parentKey) && value === '--------' && typeof currentValue === 'string') {
      output[key] = currentValue;
    } else {
      output[key] = mergeRedactedSecrets(value, currentValue, key);
    }
  }
  return output;
}
`

const READ_PROFILE_CONFIG_SCRIPT = `
${SHARED_REMOTE_CONFIG_HELPERS}
const configPath = process.argv[1];
const raw = fs.readFileSync(configPath, 'utf8');
const st = fs.statSync(configPath);
emit({
  path: configPath,
  raw,
  rawSize: Buffer.byteLength(raw, 'utf8'),
  mtimeMs: st.mtimeMs,
  backups: listBackups(configPath),
});
`

const SAVE_PROFILE_CONFIG_SCRIPT = `
${SHARED_REMOTE_CONFIG_HELPERS}
const configPath = process.argv[1];
const payload = JSON.parse(readStdin() || '{}');
const raw = String(payload.raw || '');
const keep = Number.isFinite(Number(payload.keep)) ? Number(payload.keep) : 2;
try {
  JSON.parse(raw);
} catch (error) {
  emit({ ok: false, path: configPath, code: 'INVALID_JSON', error: error.message, backups: listBackups(configPath) });
  process.exit(0);
}
const currentRaw = fs.readFileSync(configPath, 'utf8');
const currentHash = hash(currentRaw);
if (payload.hash && payload.hash !== currentHash) {
  emit({ ok: false, path: configPath, code: 'CONFLICT', error: 'Config changed on disk', hash: currentHash, backups: listBackups(configPath) });
  process.exit(0);
}
const proposedConfig = JSON.parse(raw);
const currentConfig = JSON.parse(currentRaw);
const mergedRaw = JSON.stringify(mergeRedactedSecrets(proposedConfig, currentConfig, ''), null, 2) + '\\n';
const backup = backupCurrent(configPath, 'mc');
const tmpPath = configPath + '.tmp-mc-' + process.pid;
fs.writeFileSync(tmpPath, mergedRaw, { mode: fs.statSync(configPath).mode & 0o777 });
fs.renameSync(tmpPath, configPath);
const removed = pruneBackups(configPath, keep);
const savedRaw = fs.readFileSync(configPath, 'utf8');
emit({
  ok: true,
  path: configPath,
  hash: hash(savedRaw),
  backup,
  removed,
  backups: listBackups(configPath),
});
`

const RESTORE_PROFILE_CONFIG_SCRIPT = `
${SHARED_REMOTE_CONFIG_HELPERS}
const configPath = process.argv[1];
const payload = JSON.parse(readStdin() || '{}');
const backupName = String(payload.backupName || '');
const keep = Number.isFinite(Number(payload.keep)) ? Number(payload.keep) : 2;
const dir = path.dirname(configPath);
const base = path.basename(configPath);
if (!backupName || path.basename(backupName) !== backupName || !backupName.startsWith(base + '.bak-')) {
  emit({ ok: false, path: configPath, code: 'INVALID_BACKUP', error: 'Invalid backup name', backups: listBackups(configPath) });
  process.exit(0);
}
const backupPath = path.join(dir, backupName);
if (!fs.existsSync(backupPath)) {
  emit({ ok: false, path: configPath, code: 'BACKUP_NOT_FOUND', error: 'Backup not found', backups: listBackups(configPath) });
  process.exit(0);
}
const currentRaw = fs.readFileSync(configPath, 'utf8');
const currentHash = hash(currentRaw);
if (payload.hash && payload.hash !== currentHash) {
  emit({ ok: false, path: configPath, code: 'CONFLICT', error: 'Config changed on disk', hash: currentHash, backups: listBackups(configPath) });
  process.exit(0);
}
const backup = backupCurrent(configPath, 'before-restore');
fs.copyFileSync(backupPath, configPath);
const removed = pruneBackups(configPath, keep);
const rawAfter = fs.readFileSync(configPath, 'utf8');
emit({
  ok: true,
  path: configPath,
  hash: hash(rawAfter),
  backup,
  removed,
  rawAfter,
  backups: listBackups(configPath),
});
`

function actionArgs(profile: OpenClawProfileDefinition, action: OpenClawProfileAction): string[] {
  if (action === 'restart') return ['gateway', 'restart']
  if (action === 'model-test') {
    return [
      'infer',
      'model',
      'run',
      '--gateway',
      '--model',
      profile.model,
      '--prompt',
      DEFAULT_PROMPT,
      '--json',
    ]
  }

  return [
    'agent',
    '--agent',
    profile.agent,
    '--message',
    DEFAULT_PROMPT,
    '--json',
    '--timeout',
    '180',
  ]
}

async function runProfileOpenClaw(profileId: OpenClawProfileId, args: string[], timeoutMs: number) {
  const sshHost = String(process.env.MC_OPENCLAW_PROFILE_SSH_HOST || 'heisenbergs-1').trim()
  const target = String(process.env.MC_OPENCLAW_PROFILE_TARGET || 'ssh').trim().toLowerCase()
  const openclawBin = String(process.env.MC_OPENCLAW_REMOTE_BIN || 'openclaw').trim() || 'openclaw'

  if (target === 'local' || !sshHost) {
    return runOpenClaw(['--profile', profileId, ...args], { timeoutMs })
  }

  const command = [openclawBin, '--profile', profileId, ...args].map(shellQuote).join(' ')
  return runCommand('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    sshHost,
    command,
  ], { timeoutMs })
}

function summarizeActionOutput(action: OpenClawProfileAction, output: string): string {
  if (action === 'restart') return '网关重启命令已完成。'

  const json = parseJsonFromOutput(output)
  if (json && typeof json === 'object') {
    const payload = json as Record<string, any>
    const text = extractVisibleText(payload)
    if (text) return `${describeProfileAction(action)}通过：${text}`
    if (payload.ok === true || payload.status === 'ok') return `${describeProfileAction(action)}已完成。`
  }

  const snippet = output.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join('\n')
  return localizeProfileError(snippet) || `${describeProfileAction(action)}已完成。`
}

export function parseJsonFromOutput(output: string): unknown | null {
  const raw = String(output || '').trim()
  if (!raw) return null
  const firstObject = raw.indexOf('{')
  const firstArray = raw.indexOf('[')
  const starts = [firstObject, firstArray].filter(index => index >= 0)
  if (starts.length === 0) return null
  const start = Math.min(...starts)
  const open = raw[start]
  const close = open === '{' ? '}' : ']'
  const end = raw.lastIndexOf(close)
  if (end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function extractVisibleText(payload: Record<string, any>): string {
  const direct = payload.outputs?.[0]?.text
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const resultText = payload.result?.payloads?.[0]?.text
  if (typeof resultText === 'string' && resultText.trim()) return resultText.trim()
  const finalText = payload.result?.finalAssistantVisibleText
  if (typeof finalText === 'string' && finalText.trim()) return finalText.trim()
  return ''
}

function commandErrorDetail(error: unknown): string {
  const err = error as { stdout?: string; stderr?: string; message?: string }
  return [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
}

export function describeProfileAction(action: OpenClawProfileAction | string): string {
  if (action === 'restart') return '重启'
  if (action === 'model-test') return '模型测试'
  if (action === 'agent-test') return '智能体测试'
  return String(action || '操作')
}

export function describeProfileStatus(status: OpenClawProfileStatus['status'] | string): string {
  if (status === 'online') return '在线'
  if (status === 'offline') return '离线'
  if (status === 'error') return '异常'
  if (status === 'unknown') return '未知'
  return String(status || '未知')
}

export function describeConnectivity(connectivity: OpenClawProfileStatus['connectivity'] | string): string {
  if (connectivity === 'ok') return '正常'
  if (connectivity === 'failed') return '失败'
  if (connectivity === 'unknown') return '未知'
  return String(connectivity || '未知')
}

function summarizeCommandFailure(action: OpenClawProfileAction, output: string): string {
  const detail = localizeProfileError(output || 'Command failed')
  return `${describeProfileAction(action)}失败${detail ? `：${detail}` : ''}`
}

function localizeProfileError(message: string): string {
  let text = String(message || '').trim()
  if (!text) return ''

  const replacements: Array<[RegExp, string]> = [
    [/Profile status command failed/gi, '配置档状态命令执行失败'],
    [/Command failed/gi, '命令执行失败'],
    [/Invalid JSON/gi, 'JSON 格式无效'],
    [/Config validation failed/gi, '配置校验失败'],
    [/Config changed on disk/gi, '配置文件已被远端更新，请重新读取后再保存'],
    [/Invalid backup name/gi, '备份名称无效'],
    [/Backup not found/gi, '未找到备份'],
    [/Remote command returned no JSON payload/gi, '远端命令没有返回 JSON 数据'],
    [/Remote command returned invalid JSON/gi, '远端命令返回的 JSON 无效'],
    [/No such file or directory/gi, '没有这个文件或目录'],
    [/Connection refused/gi, '连接被拒绝'],
    [/Operation timed out|timed out/gi, '连接或命令超时'],
    [/Permission denied/gi, '权限被拒绝'],
  ]

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement)
  }

  return text
}

function localizeValidationIssue(message: string): string {
  let text = String(message || '').trim()
  const replacements: Array<[RegExp, string]> = [
    [/Expected an object/gi, '必须是对象'],
    [/Invalid input/gi, '输入无效'],
    [/Required/gi, '必填'],
    [/Expected number/gi, '必须是数字'],
    [/Number must be greater than or equal to (\d+)/gi, '数字必须大于或等于 $1'],
    [/Number must be less than or equal to (\d+)/gi, '数字必须小于或等于 $1'],
    [/Too small: expected number to be >=(\d+)/gi, '数字必须大于或等于 $1'],
    [/Too big: expected number to be <=(\d+)/gi, '数字必须小于或等于 $1'],
  ]

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement)
  }
  return text || message
}

function isProfileDefinition(value: unknown): value is OpenClawProfileDefinition {
  const profile = value as Partial<OpenClawProfileDefinition>
  return (
    typeof profile?.id === 'string' &&
    typeof profile?.label === 'string' &&
    typeof profile?.gatewayPort === 'number' &&
    typeof profile?.launchAgent === 'string' &&
    typeof profile?.agent === 'string' &&
    typeof profile?.workspace === 'string' &&
    typeof profile?.model === 'string' &&
    typeof profile?.channel === 'string'
  )
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
