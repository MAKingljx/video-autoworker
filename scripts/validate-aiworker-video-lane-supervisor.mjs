#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const LABEL = 'ai.aiworker.video-lane-supervisor'
const BACKUP_NAME = /^[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const REQUIRED_PLACEHOLDERS = [
  '__NODE_BIN__',
  '__WORKER_SCRIPT__',
  '__BATCH_ROOT__',
  '__SKILL_ROOT__',
  '__HOME__',
  '__NODE_BIN_DIR__',
  '__LOG_DIR__',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertAbsolute(pathname, label) {
  assert(typeof pathname === 'string' && pathname.length > 0, `${label} is required.`)
  assert(!/[\u0000-\u001f\u007f]/u.test(pathname), `${label} contains control characters.`)
  assert(isAbsolute(pathname) && resolve(pathname) === pathname, `${label} must be normalized and absolute.`)
}

async function optionalLstat(pathname) {
  try {
    return await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function assertReal(pathname, kind, label, expectedMode) {
  assertAbsolute(pathname, label)
  const entry = await lstat(pathname)
  assert(!entry.isSymbolicLink(), `${label} must not be a symlink.`)
  assert(kind === 'file' ? entry.isFile() : entry.isDirectory(), `${label} has the wrong type.`)
  assert(await realpath(pathname) === pathname, `${label} must not resolve through a symlink.`)
  if (expectedMode !== undefined) {
    assert((entry.mode & 0o777) === expectedMode,
      `${label} must have mode ${expectedMode.toString(8)}.`)
  }
  return entry
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function renderTemplate(templatePath, values) {
  await assertReal(templatePath, 'file', 'LaunchAgent template')
  let rendered = await readFile(templatePath, 'utf8')
  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    const matches = rendered.split(placeholder).length - 1
    assert(matches >= 1, `LaunchAgent template is missing ${placeholder}.`)
    const value = values[placeholder]
    assertAbsolute(value, placeholder)
    rendered = rendered.replaceAll(placeholder, xmlEscape(value))
  }
  assert(!/__[A-Z0-9_]+__/u.test(rendered), 'LaunchAgent template contains an unresolved placeholder.')
  assert(rendered.includes(`<string>${LABEL}</string>`), 'LaunchAgent label is not pinned.')
  assert(rendered.includes('<key>KeepAlive</key>\n  <true/>'), 'LaunchAgent must be kept alive.')
  assert(rendered.includes('<key>RunAtLoad</key>\n  <true/>'), 'LaunchAgent must run at login.')
  return rendered
}

async function listPayload(root, source) {
  await assertReal(root, 'directory', source ? 'Canonical task-flow skill' : 'Installed task-flow skill')
  const result = []
  const top = await readdir(root, { withFileTypes: true })
  const expectedTop = source
    ? new Set(['SKILL.md', 'WORKSPACE_VIDEO_MEMORY.md', 'WORKSPACE_VIDEO_RULES.md', 'lib', 'scripts'])
    : new Set(['SKILL.md', 'lib', 'scripts'])
  for (const entry of top) {
    assert(expectedTop.has(entry.name), `Unexpected task-flow payload entry: ${entry.name}`)
    const pathname = join(root, entry.name)
    assert(!entry.isSymbolicLink(), `Task-flow payload must not contain symlinks: ${entry.name}`)
    if (entry.name === 'lib' || entry.name === 'scripts') {
      assert(entry.isDirectory(), `Task-flow ${entry.name} must be a directory.`)
      for (const child of await readdir(pathname, { withFileTypes: true })) {
        assert(child.isFile() && !child.isSymbolicLink() && child.name.endsWith('.mjs'),
          `Unexpected task-flow ${entry.name} entry: ${child.name}`)
        const childPath = join(pathname, child.name)
        const childStat = await lstat(childPath)
        if (!source) {
          assert((childStat.mode & 0o777) === (entry.name === 'scripts' ? 0o700 : 0o600),
            `Installed task-flow ${entry.name}/${child.name} has an unsafe mode.`)
        }
        result.push(`${entry.name}/${child.name}\0${createHash('sha256').update(await readFile(childPath)).digest('hex')}`)
      }
      continue
    }
    assert(entry.isFile(), `Task-flow ${entry.name} must be a file.`)
    if (entry.name === 'SKILL.md') {
      const fileStat = await lstat(pathname)
      if (!source) assert((fileStat.mode & 0o777) === 0o600, 'Installed SKILL.md has an unsafe mode.')
      result.push(`SKILL.md\0${createHash('sha256').update(await readFile(pathname)).digest('hex')}`)
    }
  }
  result.sort()
  return result
}

async function validateSkillPayload(sourceRoot, installedRoot) {
  const source = await listPayload(sourceRoot, true)
  const installed = await listPayload(installedRoot, false)
  assert(JSON.stringify(source) === JSON.stringify(installed),
    'Installed task-flow skill does not exactly match the canonical executable payload.')
  assert(installed.some(entry => entry.startsWith('scripts/run-video-batch.mjs\0')),
    'Installed task-flow skill is missing run-video-batch.mjs.')
  return createHash('sha256').update(installed.join('\n')).digest('hex')
}

async function readJson(pathname, label) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(pathname, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be an object.`)
  return parsed
}

async function validateProfile(configPath, workspaceRoot) {
  await assertReal(configPath, 'file', 'qwen-current config', 0o600)
  await assertReal(workspaceRoot, 'directory', 'second-original workspace')
  const config = await readJson(configPath, 'qwen-current config')
  const agents = Array.isArray(config?.agents?.list)
    ? config.agents.list.filter(agent => agent?.id === 'second-original')
    : []
  assert(agents.length === 1, 'qwen-current must contain exactly one second-original agent.')
  if (agents[0].workspace !== undefined) {
    assert(resolve(agents[0].workspace) === workspaceRoot,
      'second-original workspace does not match the supervised task-flow workspace.')
  }
  const bindings = Array.isArray(config?.bindings)
    ? config.bindings.filter(binding => binding?.agentId === 'second-original')
    : []
  assert(bindings.length === 1 && bindings[0]?.match?.channel === 'telegram',
    'qwen-current must contain one Telegram binding for second-original.')
  const plugin = config?.plugins?.entries?.['aiworker-video-command']
  assert(plugin?.enabled === true, 'qwen-current video command plugin must be enabled.')
  return { agentId: 'second-original', workspaceRoot }
}

async function validateGateway(reportPath) {
  const report = await readJson(reportPath, 'qwen-current Gateway report')
  assert(report?.service?.loaded === true, 'qwen-current Gateway LaunchAgent is not loaded.')
  assert(report?.rpc?.ok === true, 'qwen-current Gateway RPC is not healthy.')
  return { loaded: true, rpc: true }
}

async function validatePlist(plistPath, templatePath, values) {
  await assertReal(plistPath, 'file', 'Rendered video-lane LaunchAgent', 0o600)
  const actual = await readFile(plistPath, 'utf8')
  const expected = await renderTemplate(templatePath, values)
  assert(actual === expected, 'Rendered video-lane LaunchAgent does not match the canonical template.')
  return createHash('sha256').update(actual).digest('hex')
}

async function validateLockOwner(lockPath) {
  assertAbsolute(lockPath, 'Global video-lane lock')
  const entry = await optionalLstat(lockPath)
  if (!entry) return null
  assert(entry.isFile() && !entry.isSymbolicLink(), 'Global video-lane lock is unsafe.')
  assert((entry.mode & 0o777) === 0o600, 'Global video-lane lock must have mode 600.')
  const parsed = await readJson(lockPath, 'Global video-lane lock')
  assert(Number.isInteger(parsed.pid) && parsed.pid > 0, 'Global video-lane lock PID is invalid.')
  assert(typeof parsed.token === 'string' && parsed.token.length > 0, 'Global video-lane lock token is invalid.')
  return parsed.pid
}

async function validateRuntime(launchReportPath, lockPath) {
  await assertReal(launchReportPath, 'file', 'LaunchAgent runtime report')
  const report = await readFile(launchReportPath, 'utf8')
  const labelMatch = new RegExp(`(?:^|\\s)${LABEL.replaceAll('.', '\\.')}(?:\\s|$)`, 'u').test(report)
    || report.includes(`path = ${LABEL}`)
  assert(labelMatch, 'LaunchAgent runtime report does not identify the video-lane supervisor.')
  const pidMatch = /\bpid\s*=\s*([1-9][0-9]*)\b/u.exec(report)
  assert(pidMatch, 'LaunchAgent runtime report does not contain a live PID.')
  const launchPid = Number(pidMatch[1])
  const lockPid = await validateLockOwner(lockPath)
  assert(lockPid === launchPid, 'LaunchAgent PID does not own the global video-lane lock.')
  return launchPid
}

function parseBackupState(text) {
  const lines = text.trimEnd().split('\n')
  assert(lines.length === 3 && lines[0] === 'version=1', 'Video-lane backup STATE has an invalid shape.')
  const plist = /^plist_present=([01])$/u.exec(lines[1])
  const loaded = /^service_loaded=([01])$/u.exec(lines[2])
  assert(plist && loaded, 'Video-lane backup STATE values are invalid.')
  assert(!(plist[1] === '0' && loaded[1] === '1'), 'A loaded backup must contain its LaunchAgent plist.')
  return { plistPresent: plist[1] === '1', serviceLoaded: loaded[1] === '1' }
}

async function sha256(pathname) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

async function validateBackup(backupRoot, backupDir) {
  await assertReal(backupRoot, 'directory', 'Video-lane backup root', 0o700)
  await assertReal(backupDir, 'directory', 'Video-lane backup', 0o700)
  assert(dirname(backupDir) === backupRoot && BACKUP_NAME.test(basename(backupDir)),
    'Video-lane backup must be an approved direct child of its backup root.')
  const names = (await readdir(backupDir)).sort()
  const statePath = join(backupDir, 'STATE')
  const manifestPath = join(backupDir, 'MANIFEST.sha256')
  const markerPath = join(backupDir, '.verified')
  const state = parseBackupState(await readFile(statePath, 'utf8'))
  const expectedNames = state.plistPresent
    ? ['.verified', 'MANIFEST.sha256', 'STATE', `${LABEL}.plist`]
    : ['.verified', 'MANIFEST.sha256', 'STATE']
  assert(JSON.stringify(names) === JSON.stringify(expectedNames.sort()),
    'Video-lane backup contains unexpected or missing entries.')
  for (const pathname of [statePath, manifestPath, markerPath]) {
    await assertReal(pathname, 'file', `Video-lane backup ${basename(pathname)}`, 0o600)
  }
  if (state.plistPresent) {
    await assertReal(join(backupDir, `${LABEL}.plist`), 'file', 'Backed-up LaunchAgent plist', 0o600)
  }
  const manifestLines = (await readFile(manifestPath, 'utf8')).trimEnd().split('\n')
  const payloadNames = state.plistPresent ? ['STATE', `${LABEL}.plist`] : ['STATE']
  assert(manifestLines.length === payloadNames.length, 'Video-lane backup manifest has an invalid length.')
  for (let index = 0; index < payloadNames.length; index += 1) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(manifestLines[index])
    assert(match && match[2] === payloadNames[index] && SHA256.test(match[1]),
      'Video-lane backup manifest entry is invalid.')
    assert(await sha256(join(backupDir, match[2])) === match[1],
      `Video-lane backup payload changed: ${match[2]}`)
  }
  const marker = (await readFile(markerPath, 'utf8')).trim()
  assert(marker === await sha256(manifestPath), 'Video-lane backup verified marker is invalid.')
  return state
}

async function listVerifiedBackups(backupRoot) {
  const rootEntry = await optionalLstat(backupRoot)
  if (!rootEntry) return []
  await assertReal(backupRoot, 'directory', 'Video-lane backup root', 0o700)
  const result = []
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    if (!BACKUP_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = join(backupRoot, entry.name)
    try {
      await validateBackup(backupRoot, candidate)
      result.push(candidate)
    } catch {
      // Preserve malformed or incomplete evidence; it is never eligible for
      // automatic deletion or rollback.
    }
  }
  return result.sort()
}

function usage() {
  throw new Error('Unknown video-lane supervisor validator command.')
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'render': {
      const [templatePath, nodeBin, workerScript, batchRoot, skillRoot, home, nodeBinDir, logDir] = args
      const rendered = await renderTemplate(templatePath, {
        __NODE_BIN__: nodeBin,
        __WORKER_SCRIPT__: workerScript,
        __BATCH_ROOT__: batchRoot,
        __SKILL_ROOT__: skillRoot,
        __HOME__: home,
        __NODE_BIN_DIR__: nodeBinDir,
        __LOG_DIR__: logDir,
      })
      process.stdout.write(rendered)
      break
    }
    case 'skill-payload': {
      const [sourceRoot, installedRoot] = args
      process.stdout.write(`${await validateSkillPayload(sourceRoot, installedRoot)}\n`)
      break
    }
    case 'profile': {
      const [configPath, workspaceRoot] = args
      process.stdout.write(`${JSON.stringify(await validateProfile(configPath, workspaceRoot))}\n`)
      break
    }
    case 'gateway': {
      const [reportPath] = args
      process.stdout.write(`${JSON.stringify(await validateGateway(reportPath))}\n`)
      break
    }
    case 'plist': {
      const [plistPath, templatePath, nodeBin, workerScript, batchRoot, skillRoot, home, nodeBinDir, logDir] = args
      process.stdout.write(`${await validatePlist(plistPath, templatePath, {
        __NODE_BIN__: nodeBin,
        __WORKER_SCRIPT__: workerScript,
        __BATCH_ROOT__: batchRoot,
        __SKILL_ROOT__: skillRoot,
        __HOME__: home,
        __NODE_BIN_DIR__: nodeBinDir,
        __LOG_DIR__: logDir,
      })}\n`)
      break
    }
    case 'lock-owner': {
      const [lockPath] = args
      const pid = await validateLockOwner(lockPath)
      process.stdout.write(`${pid ?? 'absent'}\n`)
      break
    }
    case 'runtime': {
      const [launchReportPath, lockPath] = args
      process.stdout.write(`${await validateRuntime(launchReportPath, lockPath)}\n`)
      break
    }
    case 'backup': {
      const [backupRoot, backupDir] = args
      process.stdout.write(`${JSON.stringify(await validateBackup(backupRoot, backupDir))}\n`)
      break
    }
    case 'backup-list': {
      const [backupRoot] = args
      process.stdout.write((await listVerifiedBackups(backupRoot)).map(pathname => `${pathname}\n`).join(''))
      break
    }
    default:
      usage()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
