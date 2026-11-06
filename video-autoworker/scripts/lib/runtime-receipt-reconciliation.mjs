import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

export const RUNTIME_RECEIPT_RECONCILE_SCHEMA = 'video-autoworker-runtime-receipt-reconcile/v1'
const SHA = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u

function fail(code) { throw new Error(`runtime receipt reconcile failed: ${code}`) }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}_invalid`)
  return value
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label}_invalid`)
  return value
}
function hash(value, label) {
  if (typeof value !== 'string' || !SHA.test(value)) fail(`${label}_invalid`)
  return value
}

/**
 * Normalize the small public subset of the image-capability receipt that is
 * relevant to an application runtime receipt. Raw prompts, conversations and
 * model output never enter either plan or receipt.
 */
export function imageCapabilityBinding(receipt, binding = {}) {
  const {
    receiptPath, receiptSha256, pluginRoot, pluginSha256, configPath, configSha256, sourceCommit,
  } = binding
  absolute(receiptPath, 'image_receipt_path')
  absolute(pluginRoot, 'image_plugin_root')
  absolute(configPath, 'image_config_path')
  hash(receiptSha256, 'image_receipt_sha256')
  hash(pluginSha256, 'image_plugin_sha256')
  hash(configSha256, 'image_config_sha256')
  if (!COMMIT.test(sourceCommit || '')) fail('image_source_commit_invalid')
  const attachment = receipt?.attachment
  const runtime = receipt?.runtime
  const tools = Array.isArray(runtime?.toolIds) ? runtime.toolIds : []
  const hooks = Array.isArray(runtime?.hookNames) ? runtime.hookNames : []
  const forbidden = new Set(['aiworker_video_cover_frames', 'aiworker_submit_protected_cover_from_frame'])
  if (receipt !== undefined) {
    if (receipt?.schema !== 'aiworker-openclaw-image-capability-receipt/v1'
      || receipt?.currentState !== 'SERVICE_HEALTHY'
      || receipt?.sourceCommit !== sourceCommit
      || attachment?.pluginId !== 'aiworker-image-command'
      || typeof attachment?.pluginVersion !== 'string' || !attachment.pluginVersion
      || !SHA.test(receipt?.pluginSourceSha256 || '')
      || !tools.includes('aiworker_video_cover_workflow')
      || !hooks.includes('before_prompt_build')
      || tools.some(tool => forbidden.has(tool))) {
      fail('image_capability_receipt_invalid')
    }
  } else {
    if (typeof binding.pluginId !== 'string' || binding.pluginId !== 'aiworker-image-command'
      || typeof binding.pluginVersion !== 'string' || !binding.pluginVersion
      || !SHA.test(binding.pluginSourceSha256 || '')
      || !Array.isArray(binding.toolIds) || !Array.isArray(binding.hookNames)
      || !binding.toolIds.includes('aiworker_video_cover_workflow')
      || !binding.hookNames.includes('before_prompt_build')
      || binding.toolIds.some(tool => forbidden.has(tool))) {
      fail('image_capability_binding_invalid')
    }
  }
  return Object.freeze({
    receiptPath,
    receiptSha256,
    pluginRoot,
    pluginSha256,
    configPath,
    configSha256,
    sourceCommit,
    pluginId: receipt === undefined ? binding.pluginId : attachment.pluginId,
    pluginVersion: receipt === undefined ? binding.pluginVersion : attachment.pluginVersion,
    pluginSourceSha256: receipt === undefined ? binding.pluginSourceSha256 : receipt.pluginSourceSha256,
    toolIds: [...(receipt === undefined ? binding.toolIds : tools)].toSorted(),
    hookNames: [...(receipt === undefined ? binding.hookNames : hooks)].toSorted(),
  })
}

function validateRuntimeBinding(value) {
  if (!value || typeof value !== 'object' || value.schema !== 'video-autoworker-release-runtime-binding/v1') {
    fail('runtime_binding_invalid')
  }
  for (const [name, valuePath] of Object.entries({ runDir: value.runDir, releasesDir: value.releasesDir,
    platformEnvPath: value.platformEnvPath, liveDbPath: value.liveDbPath })) absolute(valuePath, `runtime_${name}`)
  hash(value.configSha256, 'runtime_config_sha256')
  if (!/^\d+$/u.test(value.database?.dev || '') || !/^\d+$/u.test(value.database?.ino || '')) fail('runtime_database_invalid')
  return structuredClone(value)
}

function validateRoute(value) {
  if (!value || typeof value !== 'object' || !['blue', 'green'].includes(value.active)
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.releaseId !== 'string' || !/^[a-f0-9]{40}-runtime$/u.test(value.releaseId)) {
    fail('route_invalid')
  }
  return { active: value.active, generation: value.generation, releaseId: value.releaseId }
}

function validateIntake(value) {
  if (!value || value.schema !== 'video-autoworker-intake-control/v1'
    || value.globalScope !== true || value.accepting !== true || value.mode !== 'active'
    || integer(value.revision, 'intake_revision', 1) < 1
    || integer(value.counts?.active, 'intake_active', 0) !== 0) fail('intake_not_settled')
  return {
    schema: 'video-autoworker-intake-control/v1', globalScope: true,
    accepting: true, mode: 'active', revision: value.revision, counts: { active: 0 },
  }
}

function validateWorker(value) {
  if (!value || typeof value !== 'object') fail('worker_invalid')
  absolute(value.stateDir, 'worker_state_dir')
  absolute(value.manifestPath, 'worker_manifest_path')
  hash(value.manifestSha256, 'worker_manifest_sha256')
  hash(value.contentSha256, 'worker_content_sha256')
  integer(value.pid, 'worker_pid', 1)
  return structuredClone(value)
}

/** Build an immutable, zero-component-mutation reconciliation plan. */
export function buildRuntimeReceiptReconciliationPlan(input) {
  const currentReceipt = input?.currentReceipt
  if (!currentReceipt || typeof currentReceipt !== 'object') fail('current_receipt_invalid')
  const plan = {
    schema: RUNTIME_RECEIPT_RECONCILE_SCHEMA,
    createdAt: input.createdAt || new Date().toISOString(),
    runtimeBinding: validateRuntimeBinding(input.runtimeBinding),
    route: validateRoute(input.route),
    intake: validateIntake(input.intake),
    worker: validateWorker(input.worker),
    currentReceipt: {
      path: absolute(currentReceipt.path, 'current_receipt_path'),
      sha256: hash(currentReceipt.sha256, 'current_receipt_sha256'),
    },
    runtimeConvergence: {
      path: absolute(input?.runtimeConvergence?.path, 'runtime_convergence_path'),
      sha256: hash(input?.runtimeConvergence?.sha256, 'runtime_convergence_sha256'),
    },
    control: {
      sourceCommit: (() => {
        if (!COMMIT.test(input?.control?.sourceCommit || '')) fail('control_source_commit_invalid')
        return input.control.sourceCommit
      })(),
      managerPath: absolute(input?.control?.managerPath, 'control_manager_path'),
      managerSha256: hash(input?.control?.managerSha256, 'control_manager_sha256'),
    },
    imageCapability: imageCapabilityBinding(input.imageCapability?.receipt, input.imageCapability),
  }
  if (!Number.isFinite(Date.parse(plan.createdAt))) fail('created_at_invalid')
  return Object.freeze({ ...plan, planSha256: digest(plan) })
}

export function validateRuntimeReceiptReconciliationPlan(value) {
  const copy = structuredClone(value)
  const expected = buildRuntimeReceiptReconciliationPlan(copy)
  if (copy.planSha256 !== expected.planSha256 || JSON.stringify(copy) !== JSON.stringify(expected)) {
    fail('plan_invalid')
  }
  return expected
}

/** Compare only immutable observations; a mismatch must result in zero write. */
export function assertRuntimeReceiptReconciliationPlan(planValue, observedInput) {
  const plan = validateRuntimeReceiptReconciliationPlan(planValue)
  const observed = buildRuntimeReceiptReconciliationPlan({ ...observedInput, createdAt: plan.createdAt })
  const expected = { ...plan }; delete expected.planSha256
  const actual = { ...observed }; delete actual.planSha256
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('observed_state_changed')
  return plan
}
