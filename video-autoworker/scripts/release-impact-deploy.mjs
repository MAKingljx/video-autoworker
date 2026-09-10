#!/usr/bin/env node

// Thin daily-release coordinator. The existing installers and blue/green
// controller remain authoritative for every mutation and rollback.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runManagedChild } from './legacy-release-runner.mjs'
import {
  assertCleanGitSource,
  gitSourceEnvironment,
  resolveGitCommitProductPrefix,
  resolveGitSourceLayout,
} from './lib/git-source-layout.mjs'
import { resolveInstalledBlueGreenManager } from './lib/blue-green-installed-manager.mjs'
import { readRouterState } from './standalone-router.mjs'

const modulePath = fileURLToPath(import.meta.url)
const productRoot = resolve(dirname(modulePath), '..')
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const PLAN_SCHEMA = 'video-autoworker-release-impact-plan/v1'

function fail(message) { throw new Error(`release impact deploy failed: ${message}`) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function git(gitRoot, args, encoding = 'utf8') {
  return execFileSync('/usr/bin/git', ['-C', gitRoot, ...args], {
    encoding, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    env: gitSourceEnvironment(),
  })
}

function resolveCommit(gitRoot, revision) {
  const value = git(gitRoot, ['rev-parse', '--verify', `${revision}^{commit}`]).trim()
  if (!COMMIT.test(value)) fail('source commit is invalid')
  return value
}

function commitProductTree(gitRoot, commit) {
  const prefix = resolveGitCommitProductPrefix(gitRoot, commit)
  const raw = git(gitRoot, ['ls-tree', '-r', '-z', commit], 'buffer')
  const tree = new Map()
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+(\w+)\s+([a-f0-9]{40,64})\t(.+)$/u.exec(record)
    if (!match) fail('Git tree is invalid')
    const [, mode, type, objectId, treePath] = match
    if (prefix && !treePath.startsWith(prefix)) continue
    const logical = prefix ? treePath.slice(prefix.length) : treePath
    if (!logical || tree.has(logical)) fail('product Git tree is ambiguous')
    tree.set(logical, `${mode}:${type}:${objectId}`)
  }
  return tree
}

function isTestOrDoc(pathname) {
  return pathname === 'README.md' || pathname === 'AGENTS.md'
    || pathname.startsWith('docs/') || pathname.startsWith('memory/')
    || /(?:^|\/)(?:__tests__|test|tests|fixtures)(?:\/|$)/u.test(pathname)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(pathname)
    || /^scripts\/test-/u.test(pathname)
}

function componentsFor(pathname) {
  if (isTestOrDoc(pathname)) return []
  if (pathname.startsWith('openclaw-plugins/aiworker-video-command/')
    || pathname === 'scripts/install-aiworker-video-command-plugin.sh') return ['videoCommand']
  if (pathname.startsWith('openclaw-skills/aiworker-task-flow/')
    || pathname === 'scripts/install-aiworker-task-flow-skill.sh') return ['taskFlow']
  if (pathname.startsWith('openclaw-plugins/aiworker-director-brain/')
    || pathname.startsWith('openclaw-skills/aiworker-director-brain/')
    || pathname === 'scripts/install-aiworker-director-brain.sh') return ['directorBrain']
  if (pathname === 'scripts/feishu-director-brain.mjs'
    || pathname === 'scripts/lib/feishu-director-brain.mjs'
    || pathname === 'src/lib/director-evidence-delivery-core.ts'
    || pathname === 'src/lib/director-evidence-outbox.ts') return ['app']
  if (pathname === 'scripts/deploy-blue-green.sh'
    || pathname === 'scripts/run-blue-green-deployment.mjs'
    || pathname === 'scripts/manage-blue-green-services.sh'
    || pathname === 'scripts/install-blue-green-launch-agents.sh'
    || pathname === 'scripts/start-standalone-slot.sh'
    || pathname === 'scripts/standalone-router.mjs'
    || pathname.startsWith('scripts/lib/blue-green-')
    || pathname.startsWith('ops/recovery/install-blue-green-')
    || pathname.startsWith('ops/video-autoworker/launchd/')) return ['control']
  if (pathname.startsWith('src/') || pathname.startsWith('public/')
    || pathname.startsWith('messages/') || pathname.startsWith('prisma/')
    || /^(?:package\.json|pnpm-lock\.yaml|next\.config\.[cm]?js|tsconfig\.json)$/u.test(pathname)) {
    return ['app']
  }
  if (/\.(?:cjs|js|jsx|mjs|cts|ts|tsx|mts|sh)$/u.test(pathname)
    || pathname.startsWith('scripts/') || pathname.startsWith('ops/')) return ['control']
  return []
}

function componentDigest(tree, component) {
  const rows = [...tree.entries()].filter(([pathname]) => componentsFor(pathname).includes(component))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pathname, identity]) => `${pathname}\0${identity}\n`)
  return sha256(rows.join(''))
}

function installedComponentState(component, changed, output) {
  if (!changed) return component
  return { ...component, before: sha256(`installed\0${output}`), changed: true }
}

export function installedControlComponentState(component, installedMatches, evidence = '') {
  return installedMatches
    ? { ...component, before: component.after, changed: false }
    : installedComponentState(component, true, evidence || 'control-resolution-failed')
}

export function releaseComponentSummary(baseTree, targetTree) {
  const result = {}
  for (const name of ['app', 'taskFlow', 'directorBrain', 'videoCommand', 'control']) {
    const before = componentDigest(baseTree, name)
    const after = componentDigest(targetTree, name)
    result[name] = { before, after, changed: before !== after }
  }
  return result
}

export function parseBlueGreenStatus(source) {
  const header = /^active=(blue|green) previous=(blue|green|none) generation=(\d+)$/mu.exec(source)
  const blue = /^blue: [^\s]+ release=([^\s]+)$/mu.exec(source)
  const green = /^green: [^\s]+ release=([^\s]+)$/mu.exec(source)
  if (!header || !blue || !green || !Number.isSafeInteger(Number(header[3]))) {
    fail('blue-green status is invalid')
  }
  const slots = { blue: blue[1], green: green[1] }
  return {
    active: header[1], previous: header[2] === 'none' ? null : header[2],
    generation: Number(header[3]), slots,
  }
}

function validateIntake(control) {
  if (control?.schema !== 'video-autoworker-intake-control/v1'
    || control.globalScope !== true || control.canManage !== true
    || !['active', 'draining', 'paused'].includes(control.mode)
    || typeof control.accepting !== 'boolean'
    || !Number.isSafeInteger(control.revision) || control.revision < 0
    || !Number.isSafeInteger(control.counts?.active) || control.counts.active < 0) {
    fail('intake control is invalid')
  }
  return control
}

const DRAIN_REASON = '准备受控增量发布，暂停接收新任务'
const RESUME_REASON = '受控发布已结束，恢复本次暂停的新任务入口'

function sameIntake(left, right) {
  return left.accepting === right.accepting && left.mode === right.mode
    && left.revision === right.revision && left.counts.active === right.counts.active
}

function plannedActions(components) {
  const appChanged = components.app.changed
  const pluginChanged = ['taskFlow', 'directorBrain', 'videoCommand']
    .some(name => components[name].changed)
  const runtimeChanged = components.directorBrain.changed || components.videoCommand.changed
  return [
    ...(appChanged ? ['stage-app'] : []),
    ...(components.control.changed ? ['separate-control-maintenance'] : []),
    ...(components.taskFlow.changed ? ['install-task-flow'] : []),
    ...(components.directorBrain.changed ? ['install-director-brain'] : []),
    ...(components.videoCommand.changed ? ['install-video-command'] : []),
    ...(runtimeChanged ? ['converge-openclaw-runtime'] : []),
    ...(appChanged ? ['retire-target', 'bind-target', 'start-target', 'probe-target', 'switch-target'] : []),
    ...((appChanged || pluginChanged) ? ['attest-current'] : []),
  ]
}

function validateIntakeUrl(value) {
  let url
  try { url = new URL(value) } catch { fail('plan intake URL is invalid') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.pathname !== '/api/n8n/intake-control' || url.search || url.hash
    || url.username || url.password) fail('plan intake URL is invalid')
  return url.toString()
}

function validatePlan(plan) {
  const intakeUrl = validateIntakeUrl(plan?.intakeUrl)
  if (plan?.schema !== PLAN_SCHEMA || !COMMIT.test(plan.baseCommit)
    || !COMMIT.test(plan.sourceCommit) || !SHA256.test(plan.planSha256)
    || !['blue', 'green'].includes(plan.router?.active)
    || !['blue', 'green'].includes(plan.router?.target)
    || plan.router.active === plan.router.target
    || !Number.isSafeInteger(plan.router?.generation)
    || !Array.isArray(plan.actions) || !plan.components || intakeUrl !== plan.intakeUrl) {
    fail('plan contract is invalid')
  }
  for (const name of ['app', 'taskFlow', 'directorBrain', 'videoCommand', 'control']) {
    const value = plan.components[name]
    if (!value || !SHA256.test(value.before) || !SHA256.test(value.after)
      || value.changed !== (value.before !== value.after)) fail('component summary is invalid')
  }
  const pluginChanged = ['taskFlow', 'directorBrain', 'videoCommand']
    .some(name => plan.components[name].changed)
  if (pluginChanged && !isAbsolute(plan.receiptDir || '')) fail('plan receipt directory is invalid')
  if (plan.router.releaseId !== `${plan.sourceCommit}-runtime`
    || JSON.stringify(plan.actions) !== JSON.stringify(plannedActions(plan.components))) {
    fail('plan actions are invalid')
  }
  const copy = structuredClone(plan)
  delete copy.planSha256
  if (sha256(JSON.stringify(copy)) !== plan.planSha256) fail('plan digest is invalid')
  validateIntake(plan.intake)
  return plan
}

function sealPlan(plan) {
  return { ...plan, planSha256: sha256(JSON.stringify(plan)) }
}

export function buildReleaseImpactPlan({ baseCommit, sourceCommit, router, intake,
  components, artifactRoot = null, runtimeConvergenceProof = null, toolBaseline = null,
  receiptDir = null,
  intakeUrl = 'http://127.0.0.1:3017/api/n8n/intake-control' }) {
  if (!COMMIT.test(baseCommit) || !COMMIT.test(sourceCommit)) fail('plan commits are invalid')
  validateIntake(intake)
  const appChanged = components.app.changed
  const pluginChanged = ['taskFlow', 'directorBrain', 'videoCommand']
    .some(name => components[name].changed)
  const runtimeChanged = components.directorBrain.changed || components.videoCommand.changed
  if (appChanged && !isAbsolute(artifactRoot || '')) fail('changed app requires an artifact')
  if (runtimeChanged && !isAbsolute(toolBaseline || '')) {
    fail('changed OpenClaw payload requires a tool baseline')
  }
  if ((appChanged || pluginChanged) && !runtimeChanged
    && !isAbsolute(runtimeConvergenceProof || '')) {
    fail('release attestation requires a current runtime convergence proof')
  }
  if (pluginChanged && !isAbsolute(receiptDir || '')) {
    fail('changed component installation requires a private receipt directory')
  }
  const target = router.active === 'blue' ? 'green' : 'blue'
  const releaseId = `${sourceCommit}-runtime`
  const actions = plannedActions(components)
  return sealPlan({
    schema: PLAN_SCHEMA, baseCommit, sourceCommit, createdAt: Math.floor(Date.now() / 1000),
    router: { ...router, target, releaseId }, intake: structuredClone(intake),
    components: structuredClone(components), actions, artifactRoot,
    runtimeConvergenceProof, toolBaseline, receiptDir, intakeUrl,
  })
}

export async function restoreOwnedIntake({ before, paused, read, mutate }) {
  if (!before.accepting) return { restored: false, reason: 'not_owned' }
  const current = validateIntake(await read())
  if (current.accepting === true) return { restored: true, revision: current.revision, reason: 'already_active' }
  if (current.revision !== paused.revision || current.mode !== 'paused') {
    return { restored: false, reason: 'revision_changed', revision: current.revision }
  }
  let restored
  try {
    restored = validateIntake(await mutate('resume', current.revision, RESUME_REASON))
  } catch (error) {
    const readback = validateIntake(await read())
    if (readback.accepting && readback.mode === 'active'
      && readback.revision === current.revision + 1 && readback.reason === RESUME_REASON) {
      return { restored: true, revision: readback.revision, reason: 'cas_restored_after_readback' }
    }
    throw error
  }
  if (!restored.accepting || restored.mode !== 'active' || restored.revision !== current.revision + 1) {
    fail('intake restore result is invalid')
  }
  return { restored: true, revision: restored.revision, reason: 'cas_restored' }
}

export async function applyReleaseImpactPlan(planSource, services) {
  const plan = validatePlan(structuredClone(planSource))
  if (plan.components.control.changed) fail('control change requires separate managed maintenance')
  await services.assertSource(plan.sourceCommit)
  await services.assertComponents(plan)
  const currentRouter = await services.routerStatus()
  if (currentRouter.active !== plan.router.active
    || currentRouter.generation !== plan.router.generation
    || currentRouter.slots[currentRouter.active] !== plan.router.slots[plan.router.active]) {
    fail('router state changed after plan')
  }
  const before = validateIntake(await services.intake.read())
  if (!sameIntake(before, plan.intake)) fail('intake state changed after plan')
  if (plan.actions.length === 0) {
    return { ok: true, sourceCommit: plan.sourceCommit, actions: [],
      intake: { restored: false, reason: 'unchanged' } }
  }
  if (plan.components.app.changed) await services.stage(plan)

  let paused = before
  let operationError = null
  let restore = { restored: false, reason: 'not_owned' }
  const receipts = []
  let installInFlight = null
  let switched = false
  let recovery = { ok: true, reason: 'not_needed' }
  try {
    if (before.accepting) {
      try {
        paused = validateIntake(await services.intake.mutate('drain', before.revision, DRAIN_REASON))
      } catch (error) {
        const readback = validateIntake(await services.intake.read())
        if (readback.revision !== before.revision + 1 || readback.accepting
          || readback.reason !== DRAIN_REASON) throw error
        paused = readback
      }
      if (paused.revision !== before.revision + 1 || paused.accepting) fail('intake drain result is invalid')
      paused = validateIntake(await services.intake.waitPaused(paused.revision))
      if (paused.accepting || paused.mode !== 'paused' || paused.revision !== before.revision + 1
        || paused.counts.active !== 0) fail('intake did not reach the owned paused revision')
    } else if (before.mode !== 'paused' || before.counts.active !== 0) {
      fail('pre-existing intake hold has not drained')
    }
    for (const component of ['taskFlow', 'directorBrain', 'videoCommand']) {
      if (plan.components[component].changed) {
        installInFlight = component
        receipts.push(await services.install(component, plan))
        installInFlight = null
      }
    }
    if (plan.components.directorBrain.changed || plan.components.videoCommand.changed) {
      await services.converge(plan)
    }
    if (plan.components.app.changed) {
      const targetRelease = currentRouter.slots[plan.router.target]
      if (!targetRelease.startsWith('unbound-')) await services.retire(plan.router.target)
      await services.bind(plan)
      await services.start(plan.router.target)
      await services.probe(plan.router.target)
      await services.switch(plan.router.target)
      switched = true
    }
    if (plan.actions.includes('attest-current')) await services.attest(plan)
  } catch (error) {
    operationError = error
  } finally {
    if (operationError) {
      try {
        recovery = await services.recover({ plan, receipts, installInFlight, switched })
      } catch (error) {
        recovery = { ok: false, reason: 'recovery_failed', error: String(error?.message || error) }
      }
    }
    if (!operationError || recovery.ok) {
      try {
        restore = await restoreOwnedIntake({
          before, paused, read: services.intake.read, mutate: services.intake.mutate,
        })
      } catch (error) {
        restore = { restored: false, reason: 'restore_failed', error: String(error?.message || error) }
      }
    } else {
      restore = { restored: false, reason: 'recovery_incomplete' }
    }
  }
  if (operationError) {
    const error = new Error(`${operationError.message}; recovery=${recovery.reason}; intake=${restore.reason}`)
    error.cause = operationError
    error.recovery = { components: recovery, intake: restore }
    throw error
  }
  if (before.accepting && !restore.restored) fail(`intake recovery incomplete: ${restore.reason}`)
  return { ok: true, sourceCommit: plan.sourceCommit, actions: plan.actions, intake: restore }
}

function privateWrite(pathname, value) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname) fail('output path is invalid')
  const fd = openSync(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
}

function privateRead(pathname) {
  if (!isAbsolute(pathname) || realpathSync.native(pathname) !== pathname) fail('plan path is unsafe')
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())
    || (entry.mode & 0o777) !== 0o600 || entry.size > 128 * 1024) fail('plan file is unsafe')
  return JSON.parse(readFileSync(pathname, 'utf8'))
}

function privateDirectory(pathname) {
  if (!isAbsolute(pathname) || realpathSync.native(pathname) !== pathname) {
    fail('private directory is unsafe')
  }
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) {
    fail('private directory is unsafe')
  }
  return pathname
}

function installerReceipt(pathname, expectedComponent, sourceCommit, operation = 'apply') {
  const value = privateRead(pathname)
  const component = {
    taskFlow: 'task-flow', directorBrain: 'director-brain', videoCommand: 'video-command',
  }[expectedComponent]
  if (value?.schema !== 'video-autoworker-installer-result/v1'
    || value.component !== component || value.operation !== operation
    || (operation === 'apply' && !['applied', 'noop'].includes(value.status))
    || (operation === 'rollback' && value.status !== 'restored')
    || value.sourceCommit !== sourceCommit
    || value.targetReleaseId !== `${sourceCommit}-runtime`
    || !SHA256.test(value.beforeManifestSha256) || !SHA256.test(value.afterManifestSha256)
    || typeof value.requiresFreshRestart !== 'boolean'
    || (['applied', 'restored'].includes(value.status) && (!isAbsolute(value.backup?.path || '')
      || !SHA256.test(value.backup?.manifestSha256 || '')))
    || (value.status === 'noop' && value.backup !== null)) {
    fail(`installer receipt is invalid: ${expectedComponent}`)
  }
  return { ...value, componentKey: expectedComponent, path: pathname }
}

function parseArgs(argv) {
  const command = argv.shift()
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined
      || values.has(argv[index])) fail('arguments are invalid')
    values.set(argv[index], argv[index + 1])
  }
  return { command, values }
}

function assertAllowedArguments(command, values) {
  const allowed = command === 'plan'
    ? new Set(['--source-commit', '--artifact', '--runtime-convergence-proof',
      '--tool-baseline', '--receipt-dir', '--intake-url', '--output'])
    : command === 'apply' ? new Set(['--plan']) : new Set()
  if ([...values.keys()].some(key => !allowed.has(key))) fail('arguments are invalid')
}

export function releaseCommandEnvironment(source = process.env, extra = {}) {
  const env = { ...source, ...extra, NODE_ENV: 'production', NODE_BIN: process.execPath,
    AIWORKER_NODE_BIN: process.execPath }
  for (const key of Object.keys(env)) {
    if (key.startsWith('AIWORKER_') && (key.includes('_TEST') || key.includes('TEST_'))) {
      delete env[key]
    }
  }
  return env
}

async function managed(command, args, timeoutMs = 900_000, extraEnvironment = {}) {
  return runManagedChild(command, args, {
    cwd: productRoot, timeoutMs, env: releaseCommandEnvironment(process.env, extraEnvironment),
    maxBytes: 8 * 1024 * 1024,
  })
}

function controlHeaders() {
  let token = process.env.AIWORKER_BG_CONTROL_TOKEN || ''
  const tokenFile = process.env.AIWORKER_BG_CONTROL_TOKEN_FILE || ''
  if (!token && tokenFile) {
    const entry = lstatSync(tokenFile)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
      || (entry.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) {
      fail('control token file is unsafe')
    }
    token = readFileSync(tokenFile, 'utf8').trim()
  }
  return { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

function intakeClient(url) {
  const request = async init => {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000), ...init,
      headers: { ...controlHeaders(), ...(init?.headers || {}) } })
    const payload = await response.json().catch(() => null)
    if (!response.ok) fail(`intake HTTP ${response.status}`)
    return validateIntake(payload?.control)
  }
  return {
    read: () => request(),
    mutate: (action, expectedRevision, reason) => request({ method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, reason, expectedRevision }) }),
    waitPaused: async revision => {
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const control = await request()
        if (control.revision !== revision || control.accepting) fail('intake revision changed while draining')
        if (control.mode === 'paused' && control.counts.active === 0) return control
        await new Promise(resolveWait => setTimeout(resolveWait, 1000))
      }
      fail('intake drain did not finish within 180 seconds')
    },
  }
}

async function routerStatus() {
  return parseBlueGreenStatus(await managed('/bin/bash', [join(productRoot,
    'scripts/deploy-blue-green.sh'), 'status'], 120_000))
}

async function plannedRouterState(intakeUrl) {
  const runDirectory = process.env.AIWORKER_BG_RUN_DIR || join(productRoot, '.run/blue-green')
  const statePath = process.env.AIWORKER_BG_ROUTER_STATE || join(runDirectory, 'router-state.json')
  const state = readRouterState(statePath)
  const origin = new URL(intakeUrl).origin
  const response = await fetch(`${origin}/__router/health`, {
    cache: 'no-store', signal: AbortSignal.timeout(8000), headers: controlHeaders(),
  })
  const health = await response.json().catch(() => null)
  if (!response.ok || health?.ok !== true || health.active !== state.active
    || health.generation !== state.generation
    || health.releaseId !== state.slots[state.active].releaseId) {
    fail('live router does not match its validated state file')
  }
  return {
    active: state.active, previous: state.previous, generation: state.generation,
    slots: { blue: state.slots.blue.releaseId, green: state.slots.green.releaseId },
  }
}

async function actualInstalledComponents(components, sourceCommit) {
  const stateRoot = process.env.AIWORKER_OPENCLAW_QWEN_STATE_DIR
    || join(homedir(), '.openclaw-qwen-current')
  const workspace = process.env.AIWORKER_QWEN_WORKSPACE
    || join(homedir(), 'AI-worker-second-original-workspace')
  const result = structuredClone(components)
  const inspections = []
  if (components.taskFlow.changed) {
    const output = await managed('/bin/bash', [join(productRoot,
      'scripts/install-aiworker-task-flow-skill.sh'), '--dry-run'])
    inspections.push(['taskFlow',
      !/skill_matches=1 agents_matches=1 memory_matches=1/u.test(output), output])
  }
  if (components.directorBrain.changed) {
    const output = await managed('/bin/bash', [join(productRoot,
      'scripts/install-aiworker-director-brain.sh'), '--dry-run', '--profile', 'qwen-current',
    '--state-dir', stateRoot, '--workspace', workspace])
    inspections.push(['directorBrain',
      !/Would change: plugin=0 skill=0 config=0\./u.test(output), output])
  }
  if (components.videoCommand.changed) {
    const output = await managed('/bin/bash', [join(productRoot,
      'scripts/install-aiworker-video-command-plugin.sh'), '--dry-run', '--target-sha', sourceCommit])
    inspections.push(['videoCommand',
      !/Current plugin .* is already installed and passed runtime validation\./u.test(output), output])
  }
  for (const [name, changed, output] of inspections) {
    result[name] = installedComponentState(result[name], changed, output)
    if (!changed) result[name] = { ...result[name], before: result[name].after, changed: false }
  }
  const runDir = process.env.AIWORKER_BG_RUN_DIR || join(productRoot, '.run/blue-green')
  const releasesDir = process.env.AIWORKER_BG_RELEASES_DIR || join(productRoot, '.runtime/releases')
  const launchAgentsDir = process.env.AIWORKER_BG_LAUNCH_AGENTS_DIR
    || join(homedir(), 'Library/LaunchAgents')
  try {
    const installed = resolveInstalledBlueGreenManager({
      deploymentProjectRoot: productRoot, runDir, releasesDir, launchAgentsDir,
    })
    await managed(installed.manager, ['preflight', 'all'], 120_000, {
      AIWORKER_BG_RUN_DIR: runDir,
      AIWORKER_BG_RELEASES_DIR: releasesDir,
      AIWORKER_BG_SUPERVISOR_DIR: join(runDir, 'supervisor'),
      AIWORKER_BG_LAUNCH_AGENTS_DIR: launchAgentsDir,
      AIWORKER_BG_ROUTER_STATE: process.env.AIWORKER_BG_ROUTER_STATE
        || join(runDir, 'router-state.json'),
    })
    result.control = installedControlComponentState(result.control, true)
  } catch (error) {
    result.control = installedControlComponentState(result.control, false,
      error instanceof Error ? error.message : 'control-resolution-failed')
  }
  return result
}

async function createPlan(values) {
  const layout = resolveGitSourceLayout(productRoot)
  const sourceCommit = resolveCommit(layout.gitRoot, values.get('--source-commit') || 'HEAD')
  assertCleanGitSource(productRoot, sourceCommit)
  const url = values.get('--intake-url') || 'http://127.0.0.1:3017/api/n8n/intake-control'
  const intakeUrl = validateIntakeUrl(url)
  const router = await plannedRouterState(intakeUrl)
  const activeRelease = router.slots[router.active]
  const match = /^([a-f0-9]{7,40})(?:-runtime)?$/u.exec(activeRelease)
  if (!match) fail('active release does not identify a Git commit')
  const baseCommit = resolveCommit(layout.gitRoot, match[1])
  const sourceComponents = releaseComponentSummary(
    commitProductTree(layout.gitRoot, baseCommit), commitProductTree(layout.gitRoot, sourceCommit),
  )
  const components = await actualInstalledComponents(sourceComponents, sourceCommit)
  const plan = buildReleaseImpactPlan({
    baseCommit, sourceCommit, router, intake: await intakeClient(url).read(), components,
    artifactRoot: values.get('--artifact') || null,
    runtimeConvergenceProof: values.get('--runtime-convergence-proof') || null,
    toolBaseline: values.get('--tool-baseline') || null,
    receiptDir: values.get('--receipt-dir') || null, intakeUrl,
  })
  if (plan.receiptDir) privateDirectory(plan.receiptDir)
  if (components.app.changed) {
    await managed(process.execPath, [join(productRoot, 'scripts/check-standalone-artifact.mjs'),
      plan.artifactRoot], 180_000)
    const provenance = JSON.parse(readFileSync(join(plan.artifactRoot,
      'release-provenance.json'), 'utf8'))
    if (provenance?.gitCommit !== sourceCommit) fail('artifact source commit does not match the plan')
  }
  const output = values.get('--output')
  if (!output) fail('plan output is required')
  privateWrite(output, plan)
  process.stdout.write(`${JSON.stringify({ schema: plan.schema, sourceCommit, components,
    actions: plan.actions, planSha256: plan.planSha256, output })}\n`)
}

async function applyPlan(values) {
  const pathname = values.get('--plan')
  if (!pathname) fail('plan path is required')
  const plan = validatePlan(privateRead(pathname))
  if (plan.receiptDir) privateDirectory(plan.receiptDir)
  const deploy = (...args) => managed('/bin/bash', [join(productRoot, 'scripts/deploy-blue-green.sh'), ...args])
  let runtimeProof = plan.runtimeConvergenceProof
  const deployWithProof = (...args) => managed('/bin/bash', [join(productRoot,
    'scripts/deploy-blue-green.sh'), ...args], 900_000,
  { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof })
  const services = {
    assertSource: commit => assertCleanGitSource(productRoot, commit),
    assertComponents: async currentPlan => {
      const sourceLayout = resolveGitSourceLayout(productRoot)
      const source = releaseComponentSummary(
        commitProductTree(sourceLayout.gitRoot, currentPlan.baseCommit),
        commitProductTree(sourceLayout.gitRoot, currentPlan.sourceCommit),
      )
      const current = await actualInstalledComponents(source, currentPlan.sourceCommit)
      for (const name of ['app', 'taskFlow', 'directorBrain', 'videoCommand', 'control']) {
        if (current[name].after !== currentPlan.components[name].after
          || current[name].changed !== currentPlan.components[name].changed) {
          fail(`component state changed after plan: ${name}`)
        }
      }
    },
    routerStatus,
    intake: intakeClient(plan.intakeUrl),
    stage: () => deploy('stage', plan.router.releaseId, plan.artifactRoot),
    retire: slot => deploy('retire', slot),
    bind: () => deploy('bind', plan.router.target, plan.router.releaseId,
      join(process.env.AIWORKER_BG_RELEASES_DIR || join(productRoot, '.runtime/releases'),
        plan.router.releaseId, 'standalone')),
    start: slot => managed('/bin/bash', [join(productRoot, 'scripts/manage-blue-green-services.sh'), 'start', slot]),
    probe: slot => deploy('probe', slot),
    switch: slot => deployWithProof('switch', slot),
    install: async component => {
      const output = join(plan.receiptDir, `${plan.sourceCommit}.${component}.apply.json`)
      if (existsSync(output)) fail(`installer receipt already exists: ${component}`)
      if (component === 'taskFlow') await managed('/bin/bash', [join(productRoot,
        'scripts/install-aiworker-task-flow-skill.sh'), '--apply', '--result-output', output])
      if (component === 'directorBrain') await managed('/bin/bash', [join(productRoot,
        'scripts/install-aiworker-director-brain.sh'), '--apply', '--profile', 'qwen-current',
      '--state-dir', join(homedir(), '.openclaw-qwen-current'), '--workspace',
      join(homedir(), 'AI-worker-second-original-workspace'), '--result-output', output])
      if (component === 'videoCommand') await managed('/bin/bash', [join(productRoot,
        'scripts/install-aiworker-video-command-plugin.sh'), '--apply', '--target-sha',
      plan.sourceCommit, '--result-output', output])
      return installerReceipt(output, component, plan.sourceCommit)
    },
    converge: async () => {
      if (!plan.components.videoCommand.changed) {
        await managed('openclaw', ['--profile', 'qwen-current', 'gateway', 'restart', '--wait', '60s', '--json'], 90_000)
      }
      const output = await managed('/bin/bash', [join(productRoot,
        'scripts/apply-openclaw-runtime-convergence.sh'), '--apply', '--tool-baseline', plan.toolBaseline],
      180_000)
      const match = /Verified session-scoped runtime convergence proof: (\/[^\r\n]+)$/mu.exec(output)
      if (!match) fail('runtime convergence proof path is missing')
      runtimeProof = match[1]
    },
    attest: () => managed('/bin/bash', [join(productRoot, 'scripts/deploy-blue-green.sh'),
      'attest-current'], 180_000, { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof }),
    recover: async ({ receipts, installInFlight }) => {
      if (installInFlight) return { ok: false, reason: `installer_uncertain:${installInFlight}` }
      let current = await routerStatus()
      if (current.active === plan.router.target) {
        await deployWithProof('rollback')
        current = await routerStatus()
      }
      if (current.active !== plan.router.active
        || current.slots[current.active] !== plan.router.slots[plan.router.active]) {
        return { ok: false, reason: 'original_app_not_restored' }
      }
      let directorRolledBack = false
      const rollbackReceipts = []
      for (const receipt of [...receipts].reverse()) {
        if (receipt.status !== 'applied') continue
        const rollbackOutput = join(plan.receiptDir,
          `${plan.sourceCommit}.${receipt.componentKey}.rollback.json`)
        if (existsSync(rollbackOutput)) fail(`rollback receipt already exists: ${receipt.componentKey}`)
        if (receipt.componentKey === 'taskFlow') await managed('/bin/bash', [join(productRoot,
          'scripts/install-aiworker-task-flow-skill.sh'), '--rollback', '--backup',
        receipt.backup.path, '--result-output', rollbackOutput])
        if (receipt.componentKey === 'directorBrain') {
          await managed('/bin/bash', [join(productRoot,
            'scripts/install-aiworker-director-brain.sh'), '--rollback', '--profile', 'qwen-current',
          '--state-dir', join(homedir(), '.openclaw-qwen-current'), '--workspace',
          join(homedir(), 'AI-worker-second-original-workspace'), '--backup', receipt.backup.path,
          '--result-output', rollbackOutput])
          directorRolledBack = true
        }
        if (receipt.componentKey === 'videoCommand') await managed('/bin/bash', [join(productRoot,
          'scripts/install-aiworker-video-command-plugin.sh'), '--rollback', '--target-sha',
        plan.sourceCommit, '--backup', receipt.backup.path, '--result-output', rollbackOutput])
        rollbackReceipts.push(installerReceipt(
          rollbackOutput, receipt.componentKey, plan.sourceCommit, 'rollback',
        ))
      }
      if (directorRolledBack) {
        await managed('openclaw', ['--profile', 'qwen-current', 'gateway', 'restart',
          '--wait', '60s', '--json'], 90_000)
      }
      current = await routerStatus()
      if (current.active !== plan.router.active
        || current.slots[current.active] !== plan.router.slots[plan.router.active]) {
        return { ok: false, reason: 'original_app_health_changed' }
      }
      const healthUrl = `${new URL(plan.intakeUrl).origin}/api/status?action=health`
      const response = await fetch(healthUrl, { cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: controlHeaders() })
      const health = await response.json().catch(() => null)
      const database = Array.isArray(health?.checks)
        ? health.checks.find(check => check?.name === 'Database') : null
      if (!response.ok || !['healthy', 'warning', 'degraded'].includes(health?.status)
        || !database || !['healthy', 'warning'].includes(database.status)
        || typeof health?.version !== 'string' || !health.version) {
        return { ok: false, reason: 'original_app_unhealthy' }
      }
      return { ok: true, reason: 'official_rollbacks_verified',
        rolledBackComponents: rollbackReceipts.map(item => item.componentKey) }
    },
  }
  const result = await applyReleaseImpactPlan(plan, services)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2))
  assertAllowedArguments(command, values)
  if (command === 'plan') return createPlan(values)
  if (command === 'apply') return applyPlan(values)
  fail('expected plan or apply')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
