#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TEMPLATE = path.join(ROOT, 'ops', 'openclaw', 'qwen-current-image-guidance.md')
export const START = '<!-- AIWORKER_IMAGE_CAPABILITY_GUIDANCE:START -->'
export const END = '<!-- AIWORKER_IMAGE_CAPABILITY_GUIDANCE:END -->'
const LEGACY_HEADING = '## 图片生成（本地 SDXL + diffusers）'
const FOLLOWING_HEADING = '## 记忆目录映射'
const BACKUP_PREFIX = 'qwen-current-agents-before-image-guidance-'

function fail(code) {
  throw new Error(`qwen_current_image_guidance_${code}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}_invalid`)
  return value
}

function physicalFile(value, label) {
  const pathname = absolute(value, label)
  const entry = fs.lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail(`${label}_unsafe`)
  return { pathname, entry, data: fs.readFileSync(pathname) }
}

export function renderGuidance(template) {
  if (typeof template !== 'string' || template.trim().length === 0 || template.includes(START) || template.includes(END)) {
    fail('template_invalid')
  }
  return `${START}\n${template.trimEnd()}\n${END}`
}

export function replaceImageGuidance(source, template) {
  if (typeof source !== 'string') fail('source_invalid')
  const section = renderGuidance(template)
  const starts = source.split(START).length - 1
  const ends = source.split(END).length - 1
  if (starts !== ends || starts > 1) fail('markers_invalid')
  if (starts === 1) {
    const start = source.indexOf(START)
    const end = source.indexOf(END, start)
    return `${source.slice(0, start)}${section}${source.slice(end + END.length)}`
  }
  const legacyStart = source.indexOf(LEGACY_HEADING)
  if (legacyStart < 0) fail('legacy_anchor_missing')
  const next = source.indexOf(FOLLOWING_HEADING, legacyStart)
  if (next < 0) fail('legacy_following_anchor_missing')
  return `${source.slice(0, legacyStart)}${section}\n\n${source.slice(next)}`
}

function parseArgs(argv) {
  const values = { mode: '', workspace: '', backupDir: '', template: DEFAULT_TEMPLATE }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--check' || value === '--apply') {
      if (values.mode) fail('mode_duplicate')
      values.mode = value.slice(2)
    } else if (value === '--workspace' || value === '--backup-dir' || value === '--template') {
      if (index + 1 >= argv.length || values[{ '--workspace': 'workspace', '--backup-dir': 'backupDir', '--template': 'template' }[value]]) {
        fail('argument_invalid')
      }
      values[{ '--workspace': 'workspace', '--backup-dir': 'backupDir', '--template': 'template' }[value]] = argv[index + 1]
      index += 1
    } else {
      fail('argument_invalid')
    }
  }
  if (!['check', 'apply'].includes(values.mode) || !values.workspace || (values.mode === 'apply' && !values.backupDir)) {
    fail('arguments_required')
  }
  return values
}

function readTemplate(pathname) {
  return physicalFile(pathname, 'template').data.toString('utf8')
}

function backupPath(backupDir, digest) {
  const directory = absolute(backupDir, 'backup_dir')
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const entry = fs.lstatSync(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail('backup_dir_unsafe')
  const existing = fs.readdirSync(directory).filter(name => name.startsWith(BACKUP_PREFIX) && name.endsWith('.md'))
  if (existing.length >= 2) fail('backup_retention_limit')
  return path.join(directory, `${BACKUP_PREFIX}${digest.slice(0, 16)}.md`)
}

export function planImageGuidance({ workspace, template }) {
  const workspacePath = absolute(workspace, 'workspace')
  const workspaceEntry = fs.lstatSync(workspacePath)
  if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) fail('workspace_unsafe')
  const agents = physicalFile(path.join(workspacePath, 'AGENTS.md'), 'agents')
  const source = agents.data.toString('utf8')
  const next = Buffer.from(replaceImageGuidance(source, template), 'utf8')
  return {
    agentsPath: agents.pathname,
    beforeSha256: sha256(agents.data),
    afterSha256: sha256(next),
    changed: !agents.data.equals(next),
    mode: agents.entry.mode & 0o777,
    next,
  }
}

export function applyImageGuidance({ workspace, template, backupDir }) {
  const plan = planImageGuidance({ workspace, template })
  if (!plan.changed) return { currentState: 'ALREADY_CURRENT', ...plan }
  const backup = backupPath(backupDir, plan.beforeSha256)
  fs.writeFileSync(backup, fs.readFileSync(plan.agentsPath), { flag: 'wx', mode: 0o600 })
  if (sha256(fs.readFileSync(backup)) !== plan.beforeSha256) fail('backup_invalid')
  const current = physicalFile(plan.agentsPath, 'agents')
  if (sha256(current.data) !== plan.beforeSha256) fail('concurrent_agents_change')
  const staging = path.join(path.dirname(plan.agentsPath), `.AGENTS.md.image-guidance-${process.pid}-${Date.now()}`)
  fs.writeFileSync(staging, plan.next, { flag: 'wx', mode: plan.mode || 0o600 })
  const staged = physicalFile(staging, 'staging')
  if (sha256(staged.data) !== plan.afterSha256) fail('staging_invalid')
  fs.renameSync(staging, plan.agentsPath)
  const applied = physicalFile(plan.agentsPath, 'agents')
  if (sha256(applied.data) !== plan.afterSha256) fail('apply_invalid')
  return { currentState: 'APPLIED', ...plan, backup }
}

function main() {
  const values = parseArgs(process.argv.slice(2))
  const template = readTemplate(values.template)
  const plan = planImageGuidance({ workspace: values.workspace, template })
  const result = values.mode === 'check'
    ? { currentState: plan.changed ? 'UPDATE_REQUIRED' : 'ALREADY_CURRENT', ...plan }
    : applyImageGuidance({ workspace: values.workspace, template, backupDir: values.backupDir })
  const output = { currentState: result.currentState, agentsPath: result.agentsPath,
    beforeSha256: result.beforeSha256, afterSha256: result.afterSha256, changed: result.changed,
    ...(result.backup ? { backup: result.backup } : {}) }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'qwen_current_image_guidance_failed'}\n`)
    process.exitCode = 1
  }
}
