#!/usr/bin/env node

// Thin daily-release coordinator. The existing installers and blue/green
// controller remain authoritative for every mutation and rollback.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runManagedChild, sanitizeMaintenanceFailure } from './legacy-release-runner.mjs'
import {
  assertCleanGitSource,
  gitSourceEnvironment,
  resolveGitCommitProductPrefix,
  resolveGitSourceLayout,
} from './lib/git-source-layout.mjs'
import { resolveInstalledBlueGreenManager } from './lib/blue-green-installed-manager.mjs'
import { readRouterState } from './standalone-router.mjs'
import { verifyInstalledReleasePayloads } from './verify-director-video-release-readiness.mjs'
import { inspectRuntimeIdentityDoctor } from './runtime-identity-doctor.mjs'
import { operationsRecoveryBoundaryDeclaration } from './lib/operations-governance.mjs'
import {
  buildReadOnlyPrewarmPlan,
  summarizeOperationsTelemetry,
} from './lib/operations-maintenance.mjs'
import {
  appendReleaseOperationEvent,
  beginReleaseOperation,
  buildBlueGreenCommand,
  classifyReleaseOperationError,
  createReleaseOperationCancellation,
  createReleaseOperationScope,
  finishReleaseOperation,
  readReleaseOperationJournal,
  ReleaseOperationError,
  releaseOperationPaths,
  releaseOperationStatus,
  requestReleaseOperationCancellation,
} from './lib/release-operation.mjs'

const modulePath = fileURLToPath(import.meta.url)
const coordinatorRoot = resolve(dirname(modulePath), '..')
const requestedProductRoot = process.env.AIWORKER_RELEASE_PRODUCT_ROOT
if (requestedProductRoot && !isAbsolute(requestedProductRoot)) throw new Error('release product root must be absolute')
const productRoot = requestedProductRoot ? realpathSync.native(requestedProductRoot) : coordinatorRoot
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const PLAN_SCHEMA = 'video-autoworker-release-impact-plan/v2'
const INSTALL_STEP_BY_COMPONENT = Object.freeze({
  taskFlow: 'install-task-flow',
  directorBrain: 'install-director-brain',
  videoCommand: 'install-video-command',
})
let activeOperationSignal = null
let activeRuntimeEnvironment = {}

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

export function isCommittedPlanRoute(plan, route) {
  return route?.active === plan?.router?.target
    && route.previous === plan.router.active
    && route.generation === plan.router.generation + 1
    && route.slots?.[plan.router.target] === plan.router.releaseId
    && route.slots?.[plan.router.active] === plan.router.slots[plan.router.active]
}

export function isOriginalPlanRoute(plan, route) {
  return route?.active === plan?.router?.active
    && route.previous === plan.router.previous
    && route.generation === plan.router.generation
    && route.slots?.blue === plan.router.slots.blue
    && route.slots?.green === plan.router.slots.green
}

export function recoveryTargetDisposition(plan, route) {
  if (!plan?.components?.app?.changed
    || route?.slots?.[plan.router.target] !== plan.router.releaseId) return 'unchanged'
  if (route.generation === plan.router.generation) return 'verify-stopped'
  if (route.generation === plan.router.generation + 2 && route.previous === plan.router.target) {
    return 'retire-then-verify'
  }
  return 'invalid'
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
const operationReason = (reason, operationId) => operationId
  ? `${reason} [operation:${operationId}]` : reason

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
  if (plan.runtimeConfigSha256 !== null && plan.runtimeConfigSha256 !== undefined
    && !SHA256.test(plan.runtimeConfigSha256)) fail('runtime configuration digest is invalid')
  const runtimeBinding = validateRuntimeBinding(plan.runtimeBinding)
  if (runtimeBinding && runtimeBinding.configSha256 !== plan.runtimeConfigSha256) {
    fail('runtime configuration does not match its binding')
  }
  if (runtimeBinding && Number(new URL(intakeUrl).port || 80) !== runtimeBinding.ports.router) {
    fail('intake URL does not match the runtime binding')
  }
  for (const name of ['app', 'taskFlow', 'directorBrain', 'videoCommand', 'control']) {
    const value = plan.components[name]
    if (!value || !SHA256.test(value.before) || !SHA256.test(value.after)
      || value.changed !== (value.before !== value.after)) fail('component summary is invalid')
  }
  if (plan.components.app.changed && !SHA256.test(plan.artifactManifestSha256 || '')) {
    fail('artifact manifest binding is invalid')
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
  receiptDir = null, runtimeConfigSha256 = null, runtimeBinding = null,
  artifactManifestSha256 = null,
  intakeUrl = 'http://127.0.0.1:3017/api/n8n/intake-control' }) {
  if (!COMMIT.test(baseCommit) || !COMMIT.test(sourceCommit)) fail('plan commits are invalid')
  validateIntake(intake)
  const appChanged = components.app.changed
  const pluginChanged = ['taskFlow', 'directorBrain', 'videoCommand']
    .some(name => components[name].changed)
  const runtimeChanged = components.directorBrain.changed || components.videoCommand.changed
  if (appChanged && !isAbsolute(artifactRoot || '')) fail('changed app requires an artifact')
  if (appChanged && !SHA256.test(artifactManifestSha256 || '')) {
    fail('changed app requires an artifact manifest binding')
  }
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
  if (runtimeConfigSha256 !== null && !SHA256.test(runtimeConfigSha256)) {
    fail('runtime configuration digest is invalid')
  }
  validateRuntimeBinding(runtimeBinding)
  if (runtimeBinding && runtimeConfigSha256 !== runtimeBinding.configSha256) {
    fail('runtime configuration does not match its binding')
  }
  if (runtimeBinding
    && Number(new URL(validateIntakeUrl(intakeUrl)).port || 80) !== runtimeBinding.ports.router) {
    fail('intake URL does not match the runtime binding')
  }
  const target = router.active === 'blue' ? 'green' : 'blue'
  const releaseId = `${sourceCommit}-runtime`
  const actions = plannedActions(components)
  return sealPlan({
    schema: PLAN_SCHEMA, baseCommit, sourceCommit, createdAt: Math.floor(Date.now() / 1000),
    router: { ...router, target, releaseId }, intake: structuredClone(intake),
    components: structuredClone(components), actions, artifactRoot,
    runtimeConvergenceProof, toolBaseline, receiptDir, intakeUrl,
    runtimeConfigSha256,
    runtimeBinding: runtimeBinding ? structuredClone(runtimeBinding) : null,
    artifactManifestSha256,
  })
}

export async function restoreOwnedIntake({ before, paused, read, mutate,
  resumeReason = RESUME_REASON }) {
  if (!before.accepting) return { restored: false, reason: 'not_owned' }
  const current = validateIntake(await read())
  if (current.accepting === true) {
    if (current.mode === 'active' && current.revision === paused.revision + 1
      && current.reason === resumeReason) {
      return { restored: true, revision: current.revision, reason: 'already_active' }
    }
    return { restored: false, reason: 'revision_changed', revision: current.revision }
  }
  if (current.revision !== paused.revision || current.mode !== 'paused') {
    return { restored: false, reason: 'revision_changed', revision: current.revision }
  }
  let restored
  try {
    restored = validateIntake(await mutate('resume', current.revision, resumeReason))
  } catch (error) {
    const readback = validateIntake(await read())
    if (readback.accepting && readback.mode === 'active'
      && readback.revision === current.revision + 1 && readback.reason === resumeReason) {
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
  const operationId = services.operation?.scope?.operationId || null
  const drainReason = operationReason(DRAIN_REASON, operationId)
  const resumeReason = operationReason(RESUME_REASON, operationId)
  const record = async event => await services.operation?.record?.(event)
  const checkpoint = phase => {
    if (services.operation?.signal?.aborted) {
      throw classifyReleaseOperationError(
        services.operation.signal.reason || new Error('release operation cancelled'),
        { phase, effectState: 'before_step' },
      )
    }
  }
  const runStep = async (step, action, { effectState = 'unchanged' } = {}) => {
    checkpoint(step)
    const startedAt = Date.now()
    await record({ step, status: 'started', phase: step })
    try {
      const result = await action()
      await record({ step, status: 'completed', phase: step, effectState,
        elapsedMs: Date.now() - startedAt })
      return result
    } catch (error) {
      const structured = classifyReleaseOperationError(
        services.operation?.signal?.aborted
          ? (services.operation.signal.reason || new Error('release operation cancelled')) : error,
        { phase: step, effectState },
      )
      if (error?.mutationNotStarted === true) structured.mutationNotStarted = true
      await record({ step, status: 'failed', phase: step, effectState,
        errorCode: structured.errorCode, retryable: structured.retryable,
        elapsedMs: Date.now() - startedAt })
      throw structured
    }
  }
  if (plan.components.control.changed) fail('control change requires separate managed maintenance')
  await runStep('source-preflight', () => services.assertSource(plan.sourceCommit))
  if (plan.runtimeConfigSha256) {
    await runStep('runtime-config-preflight', () => services.assertRuntimeConfig(
      plan.runtimeConfigSha256,
    ))
  }
  await runStep('component-preflight', () => services.assertComponents(plan))
  const currentRouter = await runStep('router-preflight', () => services.routerStatus())
  if (currentRouter.active !== plan.router.active
    || currentRouter.generation !== plan.router.generation
    || currentRouter.slots[currentRouter.active] !== plan.router.slots[plan.router.active]) {
    fail('router state changed after plan')
  }
  const observedIntake = validateIntake(await runStep(
    'intake-preflight', () => services.intake.read(),
  ))
  const resumingOwnedPause = services.operation?.resume === true
    && observedIntake.revision === plan.intake.revision + 1
    && observedIntake.mode === 'paused' && !observedIntake.accepting
    && observedIntake.counts.active === 0 && observedIntake.reason === drainReason
  if (!sameIntake(observedIntake, plan.intake) && !resumingOwnedPause) {
    fail('intake state changed after plan')
  }
  const before = resumingOwnedPause ? validateIntake(plan.intake) : observedIntake
  if (plan.actions.length === 0) {
    return { ok: true, sourceCommit: plan.sourceCommit, actions: [],
      intake: { restored: false, reason: 'unchanged' } }
  }
  if (plan.components.app.changed) {
    await runStep('stage-app', () => services.stage(plan), { effectState: 'artifact_staged' })
    if (services.transitionPreflight) {
      await runStep('transition-preflight', () => services.transitionPreflight(plan),
        { effectState: 'transition_ready' })
    }
  }

  let paused = resumingOwnedPause ? observedIntake : before
  let operationError = null
  let restore = { restored: false, reason: 'not_owned' }
  const receipts = []
  let installInFlight = null
  let switched = false
  let transitionAccepted = false
  let workerMaintenance = false
  let recovery = { ok: true, reason: 'not_needed' }
  try {
    if (resumingOwnedPause) {
      await record({ step: 'drain-intake', status: 'skipped', phase: 'resume',
        effectState: 'owned_pause_verified' })
    } else if (before.accepting) {
      checkpoint('pause-intake')
      try {
        paused = validateIntake(await runStep('pause-intake',
          () => services.intake.mutate('drain', before.revision, drainReason),
          { effectState: 'intake_pause_requested' }))
      } catch (error) {
        const readback = validateIntake(await services.intake.read())
        if (readback.revision !== before.revision + 1 || readback.accepting
          || readback.reason !== drainReason) throw error
        paused = readback
      }
      if (paused.revision !== before.revision + 1 || paused.accepting) fail('intake drain result is invalid')
      paused = validateIntake(await runStep('drain-intake',
        () => services.intake.waitPaused(paused.revision), { effectState: 'intake_paused' }))
      if (paused.accepting || paused.mode !== 'paused' || paused.revision !== before.revision + 1
        || paused.counts.active !== 0) fail('intake did not reach the owned paused revision')
    } else if (before.mode !== 'paused' || before.counts.active !== 0) {
      fail('pre-existing intake hold has not drained')
    }
    if (['taskFlow', 'directorBrain', 'videoCommand'].some(name => plan.components[name].changed)) {
      workerMaintenance = true
      await runStep('pause-shared-worker', () => services.pauseSharedWorker(plan),
        { effectState: 'worker_paused' })
    }
    for (const component of ['taskFlow', 'directorBrain', 'videoCommand']) {
      if (plan.components[component].changed) {
        const installStep = INSTALL_STEP_BY_COMPONENT[component]
        const completed = services.completedInstall?.(component) || null
        if (completed) {
          receipts.push(completed)
          await record({ step: installStep, status: 'skipped',
            phase: installStep, effectState: 'verified_previous_receipt' })
          continue
        }
        installInFlight = component
        receipts.push(await runStep(installStep, () => services.install(component, plan),
          { effectState: 'component_installed' }))
        installInFlight = null
      }
    }
    if (plan.components.directorBrain.changed || plan.components.videoCommand.changed) {
      await runStep('converge-runtime', () => services.converge(plan),
        { effectState: 'runtime_converged' })
    }
    if (plan.components.app.changed) {
      try {
        if (services.transition) {
          await runStep('transition-app', () => services.transition(plan),
            { effectState: 'route_write_attempted' })
          transitionAccepted = services.transitionIncludesAcceptance === true
        } else {
          const targetRelease = currentRouter.slots[plan.router.target]
          if (!targetRelease.startsWith('unbound-')) {
            await runStep('retire-target', () => services.retire(plan.router.target),
              { effectState: 'target_retired' })
          }
          await runStep('bind-target', () => services.bind(plan), { effectState: 'target_bound' })
          await runStep('start-target', () => services.start(plan.router.target),
            { effectState: 'target_started' })
          await runStep('probe-target', () => services.probe(plan.router.target),
            { effectState: 'target_ready' })
          await runStep('switch-target', () => services.switch(plan.router.target),
            { effectState: 'route_write_attempted' })
        }
      } catch (error) {
        const readback = await services.routeReadback?.().catch(() => null)
        if (!isCommittedPlanRoute(plan, readback)) throw error
      }
      const route = services.routeReadback ? await services.routeReadback() : null
      if (route && !isCommittedPlanRoute(plan, route)) fail('route commit readback is invalid')
      switched = true
      await record({ step: 'route', status: 'observed', phase: 'switch-target',
        effectState: 'route_committed' })
    }
    if (plan.actions.includes('attest-current') && !transitionAccepted) {
      await runStep('acceptance', () => services.attest(plan), { effectState: 'acceptance_verified' })
    } else if (transitionAccepted) {
      await record({ step: 'acceptance', status: 'completed', phase: 'transition-app',
        effectState: 'acceptance_verified' })
    }
  } catch (error) {
    if (error?.mutationNotStarted) installInFlight = null
    operationError = error
  } finally {
    if (operationError) {
      services.operation?.beginRecovery?.()
      try {
        recovery = await services.recover({ plan, receipts, installInFlight, switched })
      } catch (error) {
        recovery = { ok: false, reason: 'recovery_failed', error: String(error?.message || error) }
      }
    }
    if (workerMaintenance && (!operationError || recovery.ok)) {
      try { await services.resumeSharedWorker(plan) }
      catch (error) {
        operationError ||= error
        recovery = { ok: false, reason: 'video_worker_restore_failed' }
      }
    }
    if (!operationError || recovery.ok) {
      try {
        restore = await restoreOwnedIntake({
          before, paused, read: services.intake.read, mutate: services.intake.mutate,
          resumeReason,
        })
      } catch (error) {
        restore = { restored: false, reason: 'restore_failed', error: String(error?.message || error) }
      }
    } else {
      restore = { restored: false, reason: 'recovery_incomplete' }
    }
  }
  if (operationError) {
    const classified = classifyReleaseOperationError(operationError, {
      phase: operationError.phase || 'apply',
      effectState: switched ? 'route_committed' : 'route_not_committed',
    })
    const error = new ReleaseOperationError(
      `${classified.message}; recovery=${recovery.reason}; intake=${restore.reason}`,
      { phase: classified.phase, errorCode: classified.errorCode,
        effectState: classified.effectState, retryable: classified.retryable, cause: operationError },
    )
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

function privateFileSha256(pathname, maxBytes = 1024 * 1024) {
  if (!isAbsolute(pathname) || realpathSync.native(pathname) !== pathname) {
    fail('private evidence path is unsafe')
  }
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())
    || (entry.mode & 0o777) !== 0o600 || entry.size < 1 || entry.size > maxBytes) {
    fail('private evidence file is unsafe')
  }
  return sha256(readFileSync(pathname))
}

function artifactPlanBinding(rootPath, sourceCommit) {
  if (!isAbsolute(rootPath || '') || realpathSync.native(rootPath) !== rootPath) {
    fail('artifact root is unsafe')
  }
  const root = lstatSync(rootPath)
  if (!root.isDirectory() || root.isSymbolicLink()) fail('artifact root is unsafe')
  const values = {}
  for (const [name, maximum] of [['release-manifest.json', 32 * 1024 * 1024],
    ['release-provenance.json', 1024 * 1024]]) {
    const pathname = join(rootPath, name)
    const entry = lstatSync(pathname)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
      || entry.size < 2 || entry.size > maximum || (entry.mode & 0o022) !== 0) {
      fail(`artifact ${name} is unsafe`)
    }
    values[name] = readFileSync(pathname)
  }
  let manifest
  let provenance
  try {
    manifest = JSON.parse(values['release-manifest.json'].toString('utf8'))
    provenance = JSON.parse(values['release-provenance.json'].toString('utf8'))
  } catch { fail('artifact attestations are invalid') }
  if (manifest?.schemaVersion !== 2 || manifest.algorithm !== 'sha256'
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)
    || !Array.isArray(manifest.symlinks) || provenance?.gitCommit !== sourceCommit) {
    fail('artifact attestations do not match the plan source')
  }
  return { manifestSha256: sha256(values['release-manifest.json']) }
}

function runtimeProofReferencePath(planPath, attemptId) {
  return join(dirname(planPath), `.${basename(planPath)}.runtime-proof.${attemptId}.json`)
}

function persistRuntimeProofReference(planPath, attemptId, proofPath) {
  const reference = { schema: 'video-autoworker-runtime-proof-reference/v1',
    attemptId, proofPath, proofSha256: privateFileSha256(proofPath) }
  privateWrite(runtimeProofReferencePath(planPath, attemptId), reference)
  return reference
}

function readRuntimeProofReference(planPath, attemptId) {
  const reference = privateRead(runtimeProofReferencePath(planPath, attemptId))
  if (reference?.schema !== 'video-autoworker-runtime-proof-reference/v1'
    || reference.attemptId !== attemptId || !isAbsolute(reference.proofPath || '')
    || !SHA256.test(reference.proofSha256 || '')
    || privateFileSha256(reference.proofPath) !== reference.proofSha256) {
    fail('runtime proof reference is invalid')
  }
  return reference.proofPath
}

function runtimeProofForResume(contract, events) {
  const convergence = [...events].reverse().find(event => event.step === 'converge-runtime'
    && ['started', 'completed'].includes(event.status) && event.attemptId
    && existsSync(runtimeProofReferencePath(contract.pathname, event.attemptId)))
  if (convergence) return readRuntimeProofReference(contract.pathname, convergence.attemptId)
  const runtimeChanged = contract.plan.components.directorBrain.changed
    || contract.plan.components.videoCommand.changed
  if (runtimeChanged) fail('resume runtime proof is missing')
  return contract.plan.runtimeConvergenceProof
}

function workerHoldPath(receiptDir, attemptId) {
  return join(receiptDir, `video-worker-hold.${attemptId}.json`)
}

function previousWorkerHold(plan, events) {
  if (!plan.receiptDir) return null
  const event = [...events].reverse().find(item => item.step === 'pause-shared-worker'
    && ['started', 'completed'].includes(item.status) && item.attemptId
    && existsSync(workerHoldPath(plan.receiptDir, item.attemptId)))
  if (!event) return null
  const value = privateRead(workerHoldPath(plan.receiptDir, event.attemptId))
  if (value?.schema !== 'video-autoworker-video-worker-hold/v1'
    || value.attemptId !== event.attemptId || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !SHA256.test(value.plistSha256 || '')
    || value.label !== `gui/${process.getuid()}/ai.aiworker.video-lane-supervisor`) {
    fail('video worker hold receipt is invalid')
  }
  const restoredPath = join(plan.receiptDir,
    `video-worker-restored.${event.attemptId}.json`)
  if (existsSync(restoredPath)) {
    const restored = privateRead(restoredPath)
    if (restored?.schema !== 'video-autoworker-video-worker-restored/v1'
      || restored.attemptId !== event.attemptId || restored.available !== true
      || !Number.isSafeInteger(restored.pid) || restored.pid <= 0
      || restored.plistSha256 !== value.plistSha256) {
      fail('video worker restored receipt is invalid')
    }
    return null
  }
  return value
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

function runtimeConfigSnapshotSha256(pathname = process.env.AIWORKER_PLATFORM_ENV_FILE
  || join(homedir(), '.config/video-autoworker/platform.env')) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname) {
    fail('platform runtime configuration path is invalid')
  }
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())
    || (entry.mode & 0o777) !== 0o600) fail('platform runtime configuration is unsafe')
  return sha256(readFileSync(pathname))
}

function runtimeBindingSnapshot() {
  const runDirInput = process.env.AIWORKER_BG_RUN_DIR || join(productRoot, '.run/blue-green')
  const releasesDirInput = process.env.AIWORKER_BG_RELEASES_DIR
    || join(productRoot, '.runtime/releases')
  const platformEnvPath = process.env.AIWORKER_PLATFORM_ENV_FILE
    || join(homedir(), '.config/video-autoworker/platform.env')
  const liveDbInput = process.env.AIWORKER_BG_LIVE_DB_PATH || ''
  for (const [label, pathname] of Object.entries({ runDirInput, releasesDirInput,
    platformEnvPath, liveDbInput })) {
    if (!isAbsolute(pathname) || resolve(pathname) !== pathname || /[\r\n\0]/u.test(pathname)) {
      fail(`${label} is invalid`)
    }
  }
  const runDir = realpathSync.native(runDirInput)
  const releasesDir = realpathSync.native(releasesDirInput)
  const liveDbPath = realpathSync.native(liveDbInput)
  if (runDir !== runDirInput || releasesDir !== releasesDirInput || liveDbPath !== liveDbInput) {
    fail('runtime binding traverses a symbolic link')
  }
  const runEntry = lstatSync(runDir)
  const releasesEntry = lstatSync(releasesDir)
  const databaseLink = lstatSync(liveDbPath)
  const databaseEntry = statSync(liveDbPath, { bigint: true })
  const ports = {
    router: Number(process.env.AIWORKER_BG_ROUTER_PORT || 3017),
    blue: Number(process.env.AIWORKER_BG_BLUE_PORT || 3317),
    green: Number(process.env.AIWORKER_BG_GREEN_PORT || 3417),
  }
  if (!runEntry.isDirectory() || runEntry.isSymbolicLink()
    || !releasesEntry.isDirectory() || releasesEntry.isSymbolicLink()
    || databaseLink.isSymbolicLink() || !databaseEntry.isFile() || databaseEntry.size <= 0n
    || Object.values(ports).some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535)
    || new Set(Object.values(ports)).size !== 3
    || (typeof process.getuid === 'function' && (runEntry.uid !== process.getuid()
      || releasesEntry.uid !== process.getuid() || databaseEntry.uid !== BigInt(process.getuid())))) {
    fail('runtime binding is unsafe')
  }
  return Object.freeze({
    schema: 'video-autoworker-release-runtime-binding/v1',
    runDir, releasesDir, platformEnvPath: realpathSync.native(platformEnvPath), liveDbPath,
    configSha256: runtimeConfigSnapshotSha256(platformEnvPath),
    database: { dev: databaseEntry.dev.toString(), ino: databaseEntry.ino.toString() },
    ports,
  })
}

function validateRuntimeBinding(value) {
  if (value === null || value === undefined) return null
  const paths = [value.runDir, value.releasesDir, value.platformEnvPath, value.liveDbPath]
  if (value.schema !== 'video-autoworker-release-runtime-binding/v1'
    || paths.some(pathname => !isAbsolute(pathname || '') || resolve(pathname) !== pathname
      || /[\r\n\0]/u.test(pathname))
    || !SHA256.test(value.configSha256 || '') || !/^\d+$/u.test(value.database?.dev || '')
    || !/^\d+$/u.test(value.database?.ino || '')
    || !['router', 'blue', 'green'].every(name => Number.isSafeInteger(value.ports?.[name])
      && value.ports[name] > 0 && value.ports[name] <= 65535)
    || new Set(Object.values(value.ports || {})).size !== 3) {
    fail('runtime binding contract is invalid')
  }
  return value
}

function sameRuntimeBinding(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
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
    : ['apply', 'resume', 'status', 'cancel', 'doctor', 'prewarm'].includes(command)
      ? new Set(['--plan']) : new Set()
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

async function managed(command, args, timeoutMs = 900_000, extraEnvironment = {}, signal = activeOperationSignal) {
  return runManagedChild(command, args, {
    cwd: args.some(arg => typeof arg === 'string' && arg.startsWith(`${coordinatorRoot}/scripts/`))
      ? coordinatorRoot : productRoot,
    timeoutMs, env: releaseCommandEnvironment(process.env,
      { ...activeRuntimeEnvironment, ...extraEnvironment }),
    maxBytes: 8 * 1024 * 1024, signal,
    onFailure: failure => {
      const step = basename(args[0] || command)
      process.stderr.write(`${JSON.stringify({ step,
        ...sanitizeMaintenanceFailure(failure, process.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY || ''),
      })}\n`)
      if (step === 'install-aiworker-director-brain.sh' && args.includes('--apply')
        && failure.stderr.includes('shared_runtime_install_not_ready:')) {
        const error = new Error('director installer preflight rejected before target mutation')
        error.mutationNotStarted = true
        throw error
      }
    },
  })
}

export async function waitForGatewayListener(inspect, {
  sleep = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)),
  attempts = 120,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pids = [...new Set(await inspect())]
    if (pids.length > 1 || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
      fail('Gateway listener identity is ambiguous')
    }
    if (pids.length === 1) return pids[0]
    await sleep(500)
  }
  fail('Gateway listener did not become ready after restart')
}

async function waitForCurrentGateway() {
  return waitForGatewayListener(() => {
    try {
      return execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:18889', '-sTCP:LISTEN', '-t'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
        .trim().split('\n').filter(Boolean).map(Number)
    } catch (error) {
      if (error.status === 1 && !String(error.stdout || '').trim()) return []
      throw error
    }
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

async function plannedRouterState(intakeUrl, runtimeBinding = null) {
  const runDirectory = runtimeBinding?.runDir || process.env.AIWORKER_BG_RUN_DIR
    || join(productRoot, '.run/blue-green')
  const statePath = runtimeBinding ? join(runDirectory, 'router-state.json')
    : process.env.AIWORKER_BG_ROUTER_STATE || join(runDirectory, 'router-state.json')
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
  // Exact local payload validation is sufficient to reuse unchanged video and
  // task-flow components; their installation preflight need not access GitHub.
  let reusablePayloads = false
  if (components.taskFlow.changed || components.videoCommand.changed) {
    try {
      verifyInstalledReleasePayloads({ repositoryRoot: productRoot,
        profileStateRoot: stateRoot, workspaceRoot: workspace })
      reusablePayloads = true
    } catch { /* A changed or unknown payload still uses its own installer preflight. */ }
  }
  if (reusablePayloads) {
    for (const name of ['taskFlow', 'videoCommand']) {
      result[name] = { ...result[name], before: result[name].after, changed: false }
    }
  }
  const inspections = []
  if (components.taskFlow.changed && !reusablePayloads) {
    const output = await managed('/bin/bash', [join(coordinatorRoot,
      'scripts/install-aiworker-task-flow-skill.sh'), '--dry-run'])
    inspections.push(['taskFlow',
      !/skill_matches=1 agents_matches=1 memory_matches=1/u.test(output), output])
  }
  if (components.directorBrain.changed) {
    const output = await managed('/bin/bash', [join(coordinatorRoot,
      'scripts/install-aiworker-director-brain.sh'), '--dry-run', '--profile', 'qwen-current',
    '--state-dir', stateRoot, '--workspace', workspace])
    inspections.push(['directorBrain',
      !/Would change: plugin=0 skill=0 config=0\./u.test(output), output])
  }
  if (components.videoCommand.changed && !reusablePayloads) {
    const output = await managed('/bin/bash', [join(coordinatorRoot,
      'scripts/install-aiworker-video-command-plugin.sh'), '--dry-run', '--target-sha', resolveCommit(resolveGitSourceLayout(coordinatorRoot).gitRoot, 'HEAD')])
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
    await managed(installed.manager.path, ['preflight', 'all'], 120_000, {
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
  const runtimeBinding = runtimeBindingSnapshot()
  const artifactRoot = values.get('--artifact') || null
  const artifactBinding = components.app.changed
    ? artifactPlanBinding(artifactRoot, sourceCommit) : null
  const plan = buildReleaseImpactPlan({
    baseCommit, sourceCommit, router, intake: await intakeClient(url).read(), components,
    artifactRoot,
    runtimeConvergenceProof: values.get('--runtime-convergence-proof') || null,
    toolBaseline: values.get('--tool-baseline') || null,
    receiptDir: values.get('--receipt-dir') || null, intakeUrl,
    runtimeConfigSha256: runtimeBinding.configSha256, runtimeBinding,
    artifactManifestSha256: artifactBinding?.manifestSha256 || null,
  })
  if (plan.receiptDir) privateDirectory(plan.receiptDir)
  const output = values.get('--output')
  if (!output) fail('plan output is required')
  privateWrite(output, plan)
  process.stdout.write(`${JSON.stringify({ schema: plan.schema, sourceCommit, components,
    actions: plan.actions, planSha256: plan.planSha256, output })}\n`)
}

async function executePlan(values, operation = null) {
  const pathname = values.get('--plan')
  if (!pathname) fail('plan path is required')
  const plan = validatePlan(privateRead(pathname))
  if (!plan.runtimeBinding) fail('plan runtime binding is required')
  const installerCommit = resolveCommit(resolveGitSourceLayout(coordinatorRoot).gitRoot, 'HEAD')
  if (plan.receiptDir) privateDirectory(plan.receiptDir)
  const resumableInstalls = new Map()
  const priorInstallReceipt = component => {
    if (!operation?.resume || !plan.receiptDir) return null
    const event = [...(operation.previousEvents || [])].reverse().find(item => (
      item.step === INSTALL_STEP_BY_COMPONENT[component]
      && ['started', 'completed'].includes(item.status)
      && item.attemptId
    ))
    if (!event) return null
    const applyPath = join(plan.receiptDir,
      `${plan.sourceCommit}.${component}.${event.attemptId}.apply.json`)
    const receipt = installerReceipt(applyPath, component, installerCommit)
    const rollbackPath = join(plan.receiptDir,
      `${plan.sourceCommit}.${component}.${event.attemptId}.rollback.json`)
    if (existsSync(rollbackPath)) {
      installerReceipt(rollbackPath, component, installerCommit, 'rollback')
      return null
    }
    return receipt
  }
  const completedInstall = component => resumableInstalls.get(component) || null
  const blueGreenScript = join(productRoot, 'scripts/deploy-blue-green.sh')
  const releases = plan.runtimeBinding?.releasesDir || process.env.AIWORKER_BG_RELEASES_DIR
    || join(productRoot, '.runtime/releases')
  const blueGreen = step => buildBlueGreenCommand({
    script: blueGreenScript, step, plan, releasesDir: releases,
  })
  const deploy = (...args) => managed('/bin/bash', [blueGreenScript, ...args])
  const runBlueGreen = (step, timeoutMs = 900_000, extraEnvironment = {}, signal) => {
    const command = blueGreen(step)
    return managed(command.command, command.args, timeoutMs, extraEnvironment, signal)
  }
  let runtimeProof = plan.runtimeConvergenceProof
  const deployWithProof = (...args) => managed('/bin/bash', [join(productRoot,
    'scripts/deploy-blue-green.sh'), ...args], 900_000,
  { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof })
  let workerHold = null
  const workerRoot = join(homedir(), 'ai-worker/state/video-autoworker/video-batches')
  const workerPlist = join(homedir(), 'Library/LaunchAgents/ai.aiworker.video-lane-supervisor.plist')
  const workerLabel = `gui/${process.getuid()}/ai.aiworker.video-lane-supervisor`
  const workerModule = await import(pathToFileURL(join(coordinatorRoot,
    'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs')).href)
  const pauseSharedWorker = async () => {
    const snapshot = workerModule.inspectVideoExecutionControlSnapshotSync(workerRoot)
    if (snapshot.status === 'blocked' && snapshot.reason === 'worker_unavailable') return
    if (snapshot.status !== 'available' || !snapshot.worker?.alive) fail('video worker ownership is not ready')
    const pid = snapshot.worker.pid
    const command = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    if (!command.includes(join(homedir(), 'AI-worker-second-original-workspace',
      'skills/aiworker-task-flow/scripts/run-video-batch.mjs')) || !command.includes('--serve-root')) {
      fail('video worker process identity mismatch')
    }
    const entry = lstatSync(workerPlist)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
      || (entry.mode & 0o022) !== 0) fail('video supervisor plist is unsafe')
    const loaded = execFileSync('/bin/launchctl', ['print', workerLabel], { encoding: 'utf8' })
    const owner = /\n\s*pid = (\d+)/u.exec(loaded)?.[1]
    let ancestor = pid
    for (let n = 0; String(ancestor) !== owner && ancestor > 1 && n < 12; n++) {
      ancestor = Number(execFileSync('/bin/ps', ['-p', String(ancestor), '-o', 'ppid='], { encoding: 'utf8' }).trim())
    }
    if (!owner || String(ancestor) !== owner) fail('video worker is not owned by the managed supervisor')
    workerHold = { schema: 'video-autoworker-video-worker-hold/v1',
      attemptId: operation?.owner?.attemptId || 'legacy', pid,
      plistSha256: sha256(readFileSync(workerPlist)), label: workerLabel }
    const holdOutput = operation?.owner?.attemptId
      ? workerHoldPath(plan.receiptDir, operation.owner.attemptId)
      : join(plan.receiptDir, 'video-worker-hold.json')
    privateWrite(holdOutput, workerHold)
    await managed('/bin/launchctl', ['bootout', workerLabel], 60_000)
    let stopped = false
    for (let n = 0; n < 90; n++) {
      try { process.kill(pid, 0) } catch (error) {
        if (error.code !== 'ESRCH') throw error
        stopped = true; break
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
    if (!stopped) fail('video worker did not finish stopping')
    if (existsSync(join(workerRoot, '.global-video-worker.lock'))) {
      const lock = await workerModule.acquireGlobalBatchLock(join(workerRoot, '.serve-root-anchor'))
      if (!lock.acquired) fail('video worker lock still has an owner')
      await lock.release()
    }
    const { scanOfflineDurableBatchStates } = await import(pathToFileURL(join(coordinatorRoot,
      'scripts/lib/runtime-safe-offline-queue.mjs')).href)
    scanOfflineDurableBatchStates(workerRoot, { includeEvidence: true })
  }
  const resumeSharedWorker = async () => {
    if (!workerHold) return
    if (sha256(readFileSync(workerPlist)) !== workerHold.plistSha256) fail('video supervisor changed during maintenance')
    let loaded = false
    try { execFileSync('/bin/launchctl', ['print', workerLabel], { stdio: 'ignore' }); loaded = true } catch { /* bootstrap only our unloaded job */ }
    if (!loaded) await managed('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, workerPlist], 60_000)
    for (let n = 0; n < 90; n++) {
      const value = workerModule.inspectVideoExecutionControlSnapshotSync(workerRoot)
      if (value.status === 'available' && value.worker?.alive) {
        const restoredName = operation?.owner?.attemptId
          ? `video-worker-restored.${operation.owner.attemptId}.json`
          : 'video-worker-restored.json'
        privateWrite(join(plan.receiptDir, restoredName), {
          schema: 'video-autoworker-video-worker-restored/v1',
          attemptId: operation?.owner?.attemptId || 'legacy',
          available: true, pid: value.worker.pid, plistSha256: workerHold.plistSha256,
        })
        workerHold = null
        return
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
    fail('video worker did not become available')
  }
  const services = {
    operation,
    completedInstall,
    pauseSharedWorker, resumeSharedWorker,
    assertSource: commit => assertCleanGitSource(productRoot, commit),
    assertRuntimeConfig: expected => {
      if (runtimeConfigSnapshotSha256() !== expected) {
        fail('platform runtime configuration changed after plan')
      }
      if (plan.runtimeBinding && !sameRuntimeBinding(runtimeBindingSnapshot(), plan.runtimeBinding)) {
        fail('runtime binding changed after plan')
      }
    },
    assertComponents: async currentPlan => {
      const sourceLayout = resolveGitSourceLayout(productRoot)
      const source = releaseComponentSummary(
        commitProductTree(sourceLayout.gitRoot, currentPlan.baseCommit),
        commitProductTree(sourceLayout.gitRoot, currentPlan.sourceCommit),
      )
      const current = await actualInstalledComponents(source, currentPlan.sourceCommit)
      for (const name of ['app', 'taskFlow', 'directorBrain', 'videoCommand', 'control']) {
        const priorReceipt = currentPlan.components[name].changed
          ? priorInstallReceipt(name) : null
        const resumedInstall = currentPlan.components[name].changed && !current[name].changed
          && ['taskFlow', 'directorBrain', 'videoCommand'].includes(name)
          && priorReceipt
        if (resumedInstall) resumableInstalls.set(name, priorReceipt)
        if (current[name].after !== currentPlan.components[name].after
          || (current[name].changed !== currentPlan.components[name].changed && !resumedInstall)) {
          fail(`component state changed after plan: ${name}`)
        }
      }
    },
    routerStatus,
    routeReadback: () => plannedRouterState(plan.intakeUrl, plan.runtimeBinding),
    intake: intakeClient(plan.intakeUrl),
    stage: async () => {
      const artifactBinding = artifactPlanBinding(plan.artifactRoot, plan.sourceCommit)
      if (artifactBinding.manifestSha256 !== plan.artifactManifestSha256) {
        fail('artifact manifest changed after plan')
      }
      const target = join(releases, plan.router.releaseId)
      if (!existsSync(target)) return runBlueGreen('stage')
      const entry = lstatSync(target)
      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(target) !== target) {
        fail('existing release directory is unsafe')
      }
      const standalone = join(target, 'standalone')
      await managed(process.execPath, [join(productRoot, 'scripts/check-standalone-artifact.mjs'), standalone], 180_000)
      if (sha256(readFileSync(join(standalone, 'release-manifest.json')))
        !== sha256(readFileSync(join(plan.artifactRoot, 'release-manifest.json')))
        || JSON.parse(readFileSync(join(standalone, 'release-provenance.json'))).gitCommit !== plan.sourceCommit) {
        fail('existing release differs from the verified artifact')
      }
      return 'verified-existing-release'
    },
    transitionPreflight: () => runBlueGreen('preflight-app', 180_000),
    transition: () => runBlueGreen('transition-app', 900_000,
      { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof }),
    transitionIncludesAcceptance: true,
    // Retirement runs the same release-readiness verifier as switching, so it
    // must receive the fresh session-scoped convergence proof as well.
    retire: () => runBlueGreen('retire', 900_000,
      { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof }),
    bind: () => runBlueGreen('bind'),
    start: slot => {
      const installed = resolveInstalledBlueGreenManager({ deploymentProjectRoot: productRoot,
        runDir: plan.runtimeBinding?.runDir || process.env.AIWORKER_BG_RUN_DIR
          || join(productRoot, '.run/blue-green'),
        releasesDir: plan.runtimeBinding?.releasesDir || process.env.AIWORKER_BG_RELEASES_DIR
          || join(productRoot, '.runtime/releases'),
        launchAgentsDir: process.env.AIWORKER_BG_LAUNCH_AGENTS_DIR || join(homedir(), 'Library/LaunchAgents') })
      return managed('/bin/bash', [installed.manager.path, 'start', slot])
    },
    probe: () => runBlueGreen('probe'),
    switch: () => runBlueGreen('switch', 900_000,
      { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof }),
    install: async component => {
      const attemptSuffix = operation?.owner?.attemptId ? `.${operation.owner.attemptId}` : ''
      const output = join(plan.receiptDir,
        `${plan.sourceCommit}.${component}${attemptSuffix}.apply.json`)
      if (existsSync(output)) fail(`installer receipt already exists: ${component}`)
      if (component === 'taskFlow') await managed('/bin/bash', [join(coordinatorRoot,
        'scripts/install-aiworker-task-flow-skill.sh'), '--apply', '--result-output', output])
      if (component === 'directorBrain') await managed('/bin/bash', [join(coordinatorRoot,
        'scripts/install-aiworker-director-brain.sh'), '--apply', '--profile', 'qwen-current',
      '--state-dir', join(homedir(), '.openclaw-qwen-current'), '--workspace',
      join(homedir(), 'AI-worker-second-original-workspace'), '--result-output', output])
      if (component === 'videoCommand') await managed('/bin/bash', [join(coordinatorRoot,
        'scripts/install-aiworker-video-command-plugin.sh'), '--apply', '--target-sha',
      installerCommit, '--result-output', output])
      return installerReceipt(output, component, installerCommit)
    },
    converge: async () => {
      if (!plan.components.videoCommand.changed) {
        await managed('openclaw', ['--profile', 'qwen-current', 'gateway', 'restart'], 90_000)
      }
      await waitForCurrentGateway()
      const output = await managed('/bin/bash', [join(coordinatorRoot,
        'scripts/apply-openclaw-runtime-convergence.sh'), '--apply', '--tool-baseline', plan.toolBaseline],
      180_000)
      const match = /Verified session-scoped runtime convergence proof: (\/[^\r\n]+)$/mu.exec(output)
      if (!match) fail('runtime convergence proof path is missing')
      runtimeProof = match[1]
      operation?.persistRuntimeProof?.(runtimeProof)
    },
    attest: () => runBlueGreen('attest', 180_000,
      { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof }),
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
      const targetDisposition = recoveryTargetDisposition(plan, current)
      if (targetDisposition === 'invalid') {
        return { ok: false, reason: 'compensated_route_identity_invalid' }
      }
      if (targetDisposition !== 'unchanged') {
        if (targetDisposition === 'retire-then-verify') {
          try { await deployWithProof('retire', plan.router.target) }
          catch { return { ok: false, reason: 'compensated_target_retirement_failed' } }
          current = await routerStatus()
          if (current.active !== plan.router.active
            || current.previous !== plan.router.target
            || current.slots[plan.router.target] !== plan.router.releaseId) {
            return { ok: false, reason: 'compensated_target_retirement_unverified' }
          }
        }
        const installed = resolveInstalledBlueGreenManager({ deploymentProjectRoot: productRoot,
          runDir: plan.runtimeBinding.runDir, releasesDir: plan.runtimeBinding.releasesDir,
          launchAgentsDir: process.env.AIWORKER_BG_LAUNCH_AGENTS_DIR
            || join(homedir(), 'Library/LaunchAgents') })
        let stopped = false
        try {
          execFileSync('/bin/bash', [installed.manager.path, 'status', plan.router.target], {
            stdio: 'ignore', timeout: 30_000,
            env: releaseCommandEnvironment(process.env, activeRuntimeEnvironment),
          })
        } catch (error) {
          stopped = error?.status === 1 && !error?.signal && !error?.killed
        }
        if (!stopped) return { ok: false, reason: 'candidate_stop_unverified' }
      }
      let directorRolledBack = false
      const rollbackReceipts = []
      for (const receipt of [...receipts].reverse()) {
        if (receipt.status !== 'applied') continue
        const attemptSuffix = operation?.owner?.attemptId ? `.${operation.owner.attemptId}` : ''
        const rollbackOutput = join(plan.receiptDir,
          `${plan.sourceCommit}.${receipt.componentKey}${attemptSuffix}.rollback.json`)
        if (existsSync(rollbackOutput)) fail(`rollback receipt already exists: ${receipt.componentKey}`)
        if (receipt.componentKey === 'taskFlow') await managed('/bin/bash', [join(coordinatorRoot,
          'scripts/install-aiworker-task-flow-skill.sh'), '--rollback', '--backup',
        receipt.backup.path, '--result-output', rollbackOutput])
        if (receipt.componentKey === 'directorBrain') {
          await managed('/bin/bash', [join(coordinatorRoot,
            'scripts/install-aiworker-director-brain.sh'), '--rollback', '--profile', 'qwen-current',
          '--state-dir', join(homedir(), '.openclaw-qwen-current'), '--workspace',
          join(homedir(), 'AI-worker-second-original-workspace'), '--backup', receipt.backup.path,
          '--result-output', rollbackOutput])
          directorRolledBack = true
        }
        if (receipt.componentKey === 'videoCommand') await managed('/bin/bash', [join(coordinatorRoot,
          'scripts/install-aiworker-video-command-plugin.sh'), '--rollback', '--target-sha',
        installerCommit, '--backup', receipt.backup.path, '--result-output', rollbackOutput])
        rollbackReceipts.push(installerReceipt(
          rollbackOutput, receipt.componentKey, installerCommit, 'rollback',
        ))
      }
      if (directorRolledBack) {
        await managed('openclaw', ['--profile', 'qwen-current', 'gateway', 'restart',
          '--wait', '60s', '--json'], 90_000)
        await waitForCurrentGateway()
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
  return result
}

function operationContract(values) {
  const pathname = values.get('--plan')
  if (!pathname) fail('plan path is required')
  const plan = validatePlan(privateRead(pathname))
  return { pathname, plan, scope: createReleaseOperationScope(plan),
    paths: releaseOperationPaths(pathname, plan.runtimeBinding?.runDir || null) }
}

async function restoreWorkerAfterInterruptedRelease(plan, hold = null) {
  if (!['taskFlow', 'directorBrain', 'videoCommand']
    .some(name => plan.components[name].changed)) return { restored: false, reason: 'unchanged' }
  const workerRoot = join(homedir(), 'ai-worker/state/video-autoworker/video-batches')
  const workerPlist = join(homedir(), 'Library/LaunchAgents/ai.aiworker.video-lane-supervisor.plist')
  const workerLabel = `gui/${process.getuid()}/ai.aiworker.video-lane-supervisor`
  const workerModule = await import(pathToFileURL(join(coordinatorRoot,
    'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs')).href)
  let snapshot = workerModule.inspectVideoExecutionControlSnapshotSync(workerRoot)
  if (snapshot.status === 'available' && snapshot.worker?.alive) {
    return { restored: false, reason: 'already_available', pid: snapshot.worker.pid }
  }
  if (snapshot.status !== 'blocked' || snapshot.reason !== 'worker_unavailable') {
    fail('shared worker state cannot be resumed automatically')
  }
  if (!hold) fail('shared worker has no operation-owned hold receipt')
  const entry = lstatSync(workerPlist)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o022) !== 0
    || sha256(readFileSync(workerPlist)) !== hold.plistSha256) {
    fail('video supervisor plist is unsafe or changed after the owned hold')
  }
  let loaded = false
  try { execFileSync('/bin/launchctl', ['print', workerLabel], { stdio: 'ignore' }); loaded = true }
  catch { /* Resume only the configured job when it is not loaded. */ }
  if (!loaded) await managed('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, workerPlist],
    60_000)
  for (let attempt = 0; attempt < 90; attempt += 1) {
    snapshot = workerModule.inspectVideoExecutionControlSnapshotSync(workerRoot)
    if (snapshot.status === 'available' && snapshot.worker?.alive) {
      return { restored: true, reason: 'managed_supervisor_restored', pid: snapshot.worker.pid }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  fail('video worker did not become available during resume')
}

async function resumeCommittedPlan(contract, previousStatus, operation) {
  const router = await plannedRouterState(contract.plan.intakeUrl, contract.plan.runtimeBinding)
  if (!isCommittedPlanRoute(contract.plan, router)) return null
  operation.record({ step: 'route', status: 'observed', phase: 'resume',
    effectState: 'route_committed' })
  if (!previousStatus.acceptanceVerified) {
    const releases = contract.plan.runtimeBinding?.releasesDir
      || process.env.AIWORKER_BG_RELEASES_DIR || join(productRoot, '.runtime/releases')
    const command = buildBlueGreenCommand({ script: join(productRoot, 'scripts/deploy-blue-green.sh'),
      step: 'attest', plan: contract.plan, releasesDir: releases })
    const startedAt = Date.now()
    operation.record({ step: 'acceptance', status: 'started', phase: 'resume' })
    const runtimeProof = operation.resolveResumeRuntimeProof()
    await managed(command.command, command.args, 180_000,
      { AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: runtimeProof })
    operation.record({ step: 'acceptance', status: 'completed', phase: 'resume',
      effectState: 'acceptance_verified', elapsedMs: Date.now() - startedAt })
  }
  const worker = await restoreWorkerAfterInterruptedRelease(
    contract.plan, operation.previousWorkerHold,
  )
  operation.record({ step: 'resume-shared-worker', status: 'completed', phase: 'resume',
    effectState: worker.reason })
  const intake = intakeClient(contract.plan.intakeUrl)
  const current = validateIntake(await intake.read())
  const drainReason = operationReason(DRAIN_REASON, contract.scope.operationId)
  const resumeReason = operationReason(RESUME_REASON, contract.scope.operationId)
  let restored
  if (current.accepting) {
    const ownedResume = current.revision === contract.plan.intake.revision + 2
      && current.mode === 'active' && current.reason === resumeReason
    if (!ownedResume) fail('active intake does not prove settlement by this release operation')
    restored = { restored: true, revision: current.revision, reason: 'already_active' }
  } else {
    if (current.revision !== contract.plan.intake.revision + 1 || current.mode !== 'paused'
      || current.counts.active !== 0 || current.reason !== drainReason) {
      fail('paused intake is not owned by this release operation')
    }
    restored = await restoreOwnedIntake({ before: contract.plan.intake, paused: current,
      read: intake.read, mutate: intake.mutate, resumeReason })
  }
  operation.record({ step: 'settlement', status: 'completed', phase: 'resume',
    effectState: 'owned_resources_restored' })
  const result = { ok: true, resumed: true, sourceCommit: contract.plan.sourceCommit,
    actions: contract.plan.actions, intake: restored, router }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

async function applyPlan(values, { resume = false } = {}) {
  const contract = operationContract(values)
  const previous = readReleaseOperationJournal(contract.paths.journal, contract.scope.operationId)
  const previousStatus = releaseOperationStatus(contract.scope, previous)
  if (resume && previousStatus.state === 'completed') {
    process.stdout.write(`${JSON.stringify({ ...previousStatus, resumed: false,
      reason: 'already_verified' })}\n`)
    return previousStatus
  }
  const owner = beginReleaseOperation(contract.paths, contract.scope)
  const cancellation = createReleaseOperationCancellation(contract.paths, owner)
  const record = event => appendReleaseOperationEvent(contract.paths.journal, contract.scope,
    { ...event, attemptId: owner.attemptId })
  // The first durable event must exist before any child or external mutation.
  try {
    appendReleaseOperationEvent(contract.paths.journal, contract.scope, {
      attemptId: owner.attemptId, step: 'operation', status: 'started',
      phase: resume ? 'resume' : 'apply',
    })
  } catch (error) {
    cancellation.close()
    finishReleaseOperation(contract.paths, owner, 'failed')
    throw error
  }
  activeOperationSignal = cancellation.signal
  activeRuntimeEnvironment = contract.plan.runtimeBinding ? {
    AIWORKER_BG_RUN_DIR: contract.plan.runtimeBinding.runDir,
    AIWORKER_BG_RELEASES_DIR: contract.plan.runtimeBinding.releasesDir,
    AIWORKER_BG_ROUTER_STATE: join(contract.plan.runtimeBinding.runDir, 'router-state.json'),
    AIWORKER_BG_LIVE_DB_PATH: contract.plan.runtimeBinding.liveDbPath,
    AIWORKER_PLATFORM_ENV_FILE: contract.plan.runtimeBinding.platformEnvPath,
    AIWORKER_BG_ROUTER_PORT: String(contract.plan.runtimeBinding.ports.router),
    AIWORKER_BG_BLUE_PORT: String(contract.plan.runtimeBinding.ports.blue),
    AIWORKER_BG_GREEN_PORT: String(contract.plan.runtimeBinding.ports.green),
  } : {}
  const operation = {
    owner, scope: contract.scope, signal: cancellation.signal, record,
    resume, previousEvents: previous,
    resolveResumeRuntimeProof: () => runtimeProofForResume(contract, previous),
    previousWorkerHold: resume ? previousWorkerHold(contract.plan, previous) : null,
    persistRuntimeProof: proofPath => persistRuntimeProofReference(
      contract.pathname, owner.attemptId, proofPath,
    ),
    beginRecovery: () => { activeOperationSignal = null },
  }
  try {
    let result
    if (resume) {
      result = await resumeCommittedPlan(contract, previousStatus, operation)
      if (!result) {
        await restoreWorkerAfterInterruptedRelease(
          contract.plan, operation.previousWorkerHold,
        )
        result = await executePlan(values, operation)
      }
    } else {
      result = await executePlan(values, operation)
    }
    record({ step: 'operation', status: 'completed', phase: resume ? 'resume' : 'apply',
      effectState: 'acceptance_complete' })
    try { finishReleaseOperation(contract.paths, owner, 'completed') } catch {
      process.stderr.write('{"step":"release-owner","errorCode":"owner_finalize_failed"}\n')
    }
    return result
  } catch (error) {
    const structured = classifyReleaseOperationError(error, {
      phase: error?.phase || (resume ? 'resume' : 'apply'), effectState: error?.effectState || 'unknown',
    })
    try {
      record({ step: 'operation', status: cancellation.signal.aborted
        ? 'cancel_acknowledged' : 'failed', phase: structured.phase,
      effectState: structured.effectState, errorCode: structured.errorCode,
      retryable: structured.retryable })
    } catch {
      process.stderr.write('{"step":"release-journal","errorCode":"journal_write_failed"}\n')
    }
    try { finishReleaseOperation(contract.paths, owner,
      cancellation.signal.aborted ? 'cancelled' : 'failed') } catch {
      process.stderr.write('{"step":"release-owner","errorCode":"owner_finalize_failed"}\n')
    }
    throw structured
  } finally {
    activeOperationSignal = null
    activeRuntimeEnvironment = {}
    cancellation.close()
  }
}

async function statusPlan(values, { emit = true } = {}) {
  const contract = operationContract(values)
  const events = readReleaseOperationJournal(contract.paths.journal, contract.scope.operationId)
  const authorities = {}
  try {
    authorities.router = await plannedRouterState(contract.plan.intakeUrl,
      contract.plan.runtimeBinding)
  }
  catch { authorities.router = { available: false, errorCode: 'router_status_unavailable' } }
  try { authorities.intake = await intakeClient(contract.plan.intakeUrl).read() }
  catch { authorities.intake = { available: false, errorCode: 'intake_status_unavailable' } }
  const timed = events.filter(event => Number.isSafeInteger(event.elapsedMs))
  const telemetry = timed.length ? summarizeOperationsTelemetry(timed.map(event => {
    const completedAtMs = Date.parse(event.at)
    return { phase: event.step, status: event.status === 'completed' ? 'succeeded'
      : event.status === 'failed' ? 'failed' : 'blocked',
    startedAtMs: Math.max(0, completedAtMs - event.elapsedMs), completedAtMs,
    retryCount: 0, waitLockMs: 0, bytes: 0, resources: [] }
  })) : null
  const result = { ...releaseOperationStatus(contract.scope, events, authorities), telemetry }
  if (emit) process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

function cancelPlan(values) {
  const contract = operationContract(values)
  const result = requestReleaseOperationCancellation(contract.paths, contract.scope.operationId)
  process.stdout.write(`${JSON.stringify({ operationId: result.operationId,
    targetAttemptId: result.targetAttemptId, signalled: result.signalled })}\n`)
  return result
}

async function doctorPlan(values) {
  const contract = operationContract(values)
  const status = await statusPlan(values, { emit: false })
  const router = status.authorities.router
  const intake = status.authorities.intake
  const drift = []
  if (router?.available === false) drift.push({ field: 'router', code: router.errorCode })
  else if (!isOriginalPlanRoute(contract.plan, router)
    && !isCommittedPlanRoute(contract.plan, router)) {
    drift.push({ field: 'router.active', code: 'unexpected_route' })
  }
  if (intake?.available === false) drift.push({ field: 'intake', code: intake.errorCode })
  else if (intake.globalScope !== true || intake.canManage !== true) {
    drift.push({ field: 'intake.contract', code: 'intake_contract_invalid' })
  }
  let runtime = null
  if (router?.available !== false && contract.plan.runtimeConfigSha256) {
    try {
      runtime = inspectRuntimeIdentityDoctor({
        runDir: contract.plan.runtimeBinding?.runDir || process.env.AIWORKER_BG_RUN_DIR
          || join(productRoot, '.run/blue-green'),
        slot: router.active,
        platformEnvPath: contract.plan.runtimeBinding?.platformEnvPath
          || process.env.AIWORKER_PLATFORM_ENV_FILE
          || join(homedir(), '.config/video-autoworker/platform.env'),
        expectedConfigSha256: contract.plan.runtimeConfigSha256,
      })
      for (const item of runtime.drift) drift.push({ field: `runtime.${item.field}`,
        code: 'runtime_identity_drift' })
      if (!runtime.router.releaseAligned) drift.push({ field: 'runtime.router',
        code: 'runtime_router_drift' })
      if (!runtime.process.authoritativeDatabaseOpen) drift.push({ field: 'runtime.database',
        code: 'runtime_database_not_open' })
    } catch { drift.push({ field: 'runtime', code: 'runtime_identity_unavailable' }) }
  }
  const result = { schema: 'video-autoworker-release-doctor/v1', operationId: contract.scope.operationId,
    status: drift.length ? 'drifted' : 'aligned', drift, runtime, mutationPerformed: false,
    recovery: operationsRecoveryBoundaryDeclaration() }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

async function prewarmPlan(values) {
  const contract = operationContract(values)
  const router = await plannedRouterState(contract.plan.intakeUrl, contract.plan.runtimeBinding)
  if (router.active === contract.plan.router.target) fail('prewarm target is already active')
  const port = contract.plan.runtimeBinding.ports[contract.plan.router.target]
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('prewarm target port is invalid')
  const identity = inspectRuntimeIdentityDoctor({
    runDir: contract.plan.runtimeBinding.runDir,
    slot: contract.plan.router.target,
    platformEnvPath: contract.plan.runtimeBinding.platformEnvPath,
    expectedConfigSha256: contract.plan.runtimeConfigSha256,
  })
  if (identity.status !== 'aligned'
    || identity.expected.releaseId !== contract.plan.router.releaseId
    || identity.router.active) fail('prewarm target runtime identity does not match the plan')
  const origin = `http://127.0.0.1:${port}`
  const started = Date.now()
  const checks = []
  const plan = buildReadOnlyPrewarmPlan([
    { kind: 'health', targetId: 'router' },
    { kind: 'read-only-query', targetId: 'application-health' },
    { kind: 'static-resource', targetId: 'application-root' },
  ])
  const requests = [
    ['health', `${origin}/api/status?action=health`, 'GET'],
    ['read-only-query', `${origin}/api/n8n/drain-status`, 'GET'],
    ['static-resource', `${origin}/`, 'HEAD'],
  ]
  for (const [name, url, method] of requests) {
    const response = await fetch(url, { method, cache: 'no-store', headers: controlHeaders(),
      signal: AbortSignal.timeout(8000) })
    checks.push({ name, ok: response.ok, status: response.status })
    await response.body?.cancel()
  }
  const result = { schema: 'video-autoworker-release-prewarm/v1', operationId: contract.scope.operationId,
    targetSlot: contract.plan.router.target, readOnlyContract: true,
    sideEffectEvidence: 'unverified', observedCounters: null,
    elapsedMs: Date.now() - started, checks, plan, identity,
    targetP95Ms: null, baselineStatus: 'sample-only' }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2))
  assertAllowedArguments(command, values)
  if (command === 'status') return statusPlan(values)
  if (command === 'cancel') return cancelPlan(values)
  if (command === 'doctor') return doctorPlan(values)
  if (command === 'prewarm') return prewarmPlan(values)
  // A stable coordinator may publish an independently verified application
  // checkout from the same repository. This avoids rebuilding an unchanged app.
  const coordinator = assertCleanGitSource(coordinatorRoot)
  if (productRoot !== coordinatorRoot) {
    const application = assertCleanGitSource(productRoot)
    const canonicalRemote = 'https://github.com/MAKingljx/video-autoworker.git'
    for (const root of [coordinator.gitRoot, application.gitRoot]) {
      if (git(root, ['remote', 'get-url', 'origin']).trim() !== canonicalRemote) fail('coordinator and application repository mismatch')
    }
    const controlCommit = resolveCommit(coordinator.gitRoot, 'HEAD')
    const applicationCommit = resolveCommit(application.gitRoot, 'HEAD')
    let related = false
    for (const root of [coordinator.gitRoot, application.gitRoot]) {
      try {
        related = COMMIT.test(git(root, ['merge-base', controlCommit, applicationCommit]).trim())
        if (related) break
      } catch { /* The other immutable checkout may contain the newer commit. */ }
    }
    if (!related) fail('coordinator and application history mismatch')
    const controlTree = commitProductTree(coordinator.gitRoot, controlCommit)
    const applicationTree = commitProductTree(application.gitRoot, applicationCommit)
    for (const name of ['taskFlow', 'directorBrain', 'videoCommand']) {
      if (componentDigest(controlTree, name) !== componentDigest(applicationTree, name)) {
        fail(`coordinator ${name} payload differs from the verified application source`)
      }
    }
  }
  if (command === 'plan') return createPlan(values)
  if (command === 'apply') return applyPlan(values)
  if (command === 'resume') return applyPlan(values, { resume: true })
  fail('expected plan, apply, resume, status, cancel, doctor, or prewarm')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
