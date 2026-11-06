import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertRuntimeReceiptReconciliationPlan,
  buildRuntimeReceiptReconciliationPlan,
  imageCapabilityBinding,
  validateRuntimeReceiptReconciliationPlan,
} from './lib/runtime-receipt-reconciliation.mjs'

const sha = value => String(value).repeat(64).slice(0, 64)
const commit = 'a'.repeat(40)

function input(overrides = {}) {
  const image = {
    schema: 'aiworker-openclaw-image-capability-receipt/v1',
    currentState: 'SERVICE_HEALTHY',
    sourceCommit: commit,
    pluginSourceSha256: sha('b'),
    attachment: { pluginId: 'aiworker-image-command', pluginVersion: '0.5.5' },
    runtime: {
      toolIds: [
        'aiworker_image_help', 'aiworker_image_task', 'aiworker_submit_creative_image',
        'aiworker_submit_designed_cover', 'aiworker_submit_protected_cover',
        'aiworker_video_cover_read_directory', 'aiworker_video_cover_get_candidates',
        'aiworker_video_cover_submit_protected', 'aiworker_video_cover_task',
      ],
      hookNames: ['before_message_write', 'before_prompt_build', 'tool_result_persist'],
    },
  }
  return {
    createdAt: '2026-11-06T12:00:00.000Z',
    runtimeBinding: {
      schema: 'video-autoworker-release-runtime-binding/v1',
      runDir: '/tmp/aiworker-reconcile/run', releasesDir: '/tmp/aiworker-reconcile/releases',
      platformEnvPath: '/tmp/aiworker-reconcile/platform.env',
      liveDbPath: '/tmp/aiworker-reconcile/mission-control.db', configSha256: sha('c'),
      database: { dev: '1', ino: '2' }, ports: { router: 3017, blue: 3317, green: 3417 },
    },
    route: { active: 'green', generation: 20, releaseId: `${commit}-runtime` },
    intake: {
      schema: 'video-autoworker-intake-control/v1', globalScope: true,
      accepting: true, mode: 'active', revision: 146, counts: { active: 0 },
    },
    worker: {
      stateDir: '/tmp/aiworker-reconcile/worker',
      manifestPath: '/tmp/aiworker-reconcile/worker/worker-manifest.json',
      manifestSha256: sha('d'), contentSha256: sha('e'), pid: 42,
    },
    currentReceipt: { path: '/tmp/aiworker-reconcile/run/current-runtime.json', sha256: sha('f') },
    runtimeConvergence: { path: '/tmp/aiworker-reconcile/proof.json', sha256: sha('1') },
    control: {
      sourceCommit: commit,
      managerPath: '/tmp/aiworker-reconcile/control/manage-blue-green-services.sh',
      managerSha256: sha('2'),
    },
    imageCapability: {
      receipt: image,
      receiptPath: '/tmp/aiworker-reconcile/image-capability.json', receiptSha256: sha('3'),
      pluginRoot: '/tmp/aiworker-reconcile/extensions/aiworker-image-command', pluginSha256: sha('4'),
      configPath: '/tmp/aiworker-reconcile/openclaw.json', configSha256: sha('5'), sourceCommit: commit,
    },
    ...overrides,
  }
}

test('seals and revalidates a zero-mutation runtime receipt reconciliation plan', () => {
  const plan = buildRuntimeReceiptReconciliationPlan(input())
  assert.equal(validateRuntimeReceiptReconciliationPlan(plan).planSha256, plan.planSha256)
  assert.equal(assertRuntimeReceiptReconciliationPlan(plan, input()).route.generation, 20)
})

test('refuses a changed image capability binding before any receipt write', () => {
  const plan = buildRuntimeReceiptReconciliationPlan(input())
  const changed = input()
  changed.imageCapability.configSha256 = sha('9')
  assert.throws(() => assertRuntimeReceiptReconciliationPlan(plan, changed), /observed_state_changed/u)
})

test('refuses legacy frame tools in the image capability receipt', () => {
  const value = input().imageCapability
  value.receipt.runtime.toolIds.push('aiworker_video_cover_frames')
  assert.throws(() => imageCapabilityBinding(value.receipt, value), /image_capability_receipt_invalid/u)
})

test('refuses the retired action-only workflow facade in the image capability receipt', () => {
  const value = input().imageCapability
  value.receipt.runtime.toolIds.push('aiworker_video_cover_workflow')
  assert.throws(() => imageCapabilityBinding(value.receipt, value), /image_capability_receipt_invalid/u)
})
