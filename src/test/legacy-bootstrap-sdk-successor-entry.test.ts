// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  reconcileRecoveredIntake,
  verifyRecoveredRouter,
} from '../../ops/recovery/run-legacy-bootstrap-sdk-successor.mjs'

describe('legacy bootstrap SDK successor entry', () => {
  it('verifies the consumed successor before historical recovery logic and preserves historical tools', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const start = source.indexOf('bootstrap_baseline() {')
    const end = source.indexOf('\nbind_slot() {', start)
    const body = source.slice(start, end)
    const successor = body.indexOf('successor_values="$(verify_bootstrap_sdk_successor)"')
    const sourceCommit = body.indexOf('source_commit="$(resolve_baseline_source_commit')
    const consume = body.indexOf('consume_bootstrap_sdk_successor')
    const firstMappingWrite = body.indexOf('write_json_atomic "$(binding_file "$slot")"', consume)
    const serviceStart = body.indexOf('"$manager" start "$slot"')

    expect(successor).toBeGreaterThan(0)
    expect(sourceCommit).toBeGreaterThan(successor)
    expect(consume).toBeGreaterThan(sourceCommit)
    expect(firstMappingWrite).toBeGreaterThan(consume)
    expect(serviceStart).toBeGreaterThan(sourceCommit)
    expect(body).toContain(
      'evidence_generator="$BOOTSTRAP_HISTORICAL_PROJECT_ROOT/scripts/generate-legacy-freeze-evidence.mjs"',
    )
    expect(body).toContain(
      'manager="$BOOTSTRAP_HISTORICAL_PROJECT_ROOT/scripts/manage-blue-green-services.sh"',
    )
    expect(body).toContain('publish_bootstrap_sdk_successor_completion "$source_commit"')
    expect(body).toContain('video-autoworker-legacy-bootstrap-sdk-target-mapping/v1')
    expect(body).toContain('requested:historical')
    expect(body).toContain('historical:requested')
    expect(body).toContain('assert_bootstrap_target_mapping_snapshot')
    expect(body).toContain('BOOTSTRAP_HISTORICAL_PENDING')
    expect(body).toContain('BOOTSTRAP_HISTORICAL_RUN_DIRECTORY')
    const publisher = source.slice(
      source.indexOf('publish_bootstrap_sdk_successor_completion() {'),
      source.indexOf('\nverify_active_director_projection_chain()', source.indexOf('publish_bootstrap_sdk_successor_completion() {')),
    )
    expect(publisher).toContain('video-autoworker-legacy-bootstrap-sdk-successor-baseline-established/v1')
    expect(publisher).toContain('baselineEstablished: true')
    expect(publisher).toContain('intakePaused: true')
    expect(publisher).not.toContain('recovered: true')
  })

  it('publishes an explicit recovered result only after a complete deploy result exists', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs'),
      'utf8',
    )
    const deploy = source.indexOf("execFileSync('/bin/bash'")
    const completion = source.indexOf('publishRecoveredResult(plan, deploy, env, true)', deploy)
    const publisher = source.indexOf('async function publishRecoveredResult')
    const attestation = source.indexOf("[deploy, 'attest-current']", publisher)
    const preResumeRouter = source.indexOf('await verifyRecoveredRouter', attestation)
    const resume = source.indexOf('await reconcileRecoveredIntake', publisher)
    const postResumeRouter = source.indexOf('await verifyRecoveredRouter', resume)
    const finalResult = source.indexOf("schema: 'video-autoworker-legacy-release-recovery-result/v1'", resume)

    expect(deploy).toBeGreaterThan(0)
    expect(completion).toBeGreaterThan(deploy)
    expect(attestation).toBeGreaterThan(0)
    expect(preResumeRouter).toBeGreaterThan(attestation)
    expect(resume).toBeGreaterThan(preResumeRouter)
    expect(postResumeRouter).toBeGreaterThan(resume)
    expect(finalResult).toBeGreaterThan(postResumeRouter)
    const newAttestation = source.slice(attestation, preResumeRouter)
    expect(newAttestation.indexOf('validRecoveredAttestation')).toBeLessThan(
      newAttestation.indexOf('writeImmutable(attestationPath'),
    )
    expect(source).toContain('writeExclusive(resultPath, result, 0o600)')
    expect(source).toContain("[deploy, 'attest-current']")
    expect(source).toContain("'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs', 0o755")
    expect(source).toContain("key.startsWith('AIWORKER_TEST_')")
    expect(source).toContain('fstatSync(descriptor, { bigint: true })')
    expect(source).toContain("schema: 'video-autoworker-legacy-release-recovery-result/v1'")
    expect(source).toContain('recovered: true')
    expect(source).toContain("schema: 'video-autoworker-legacy-bootstrap-sdk-successor-intake-resumed/v1'")
    expect(source).toContain('pausedIntakeRevision: completion.pausedIntakeRevision')
    expect(source).toContain('intakeResumed: true')
    expect(source).toContain('sourceCommit: completion.sourceCommit')
    expect(source).toContain('historicalSourceCommit: plan.historical.commit')
    expect(source).not.toContain("controller, 'consume'")
  })

  it('resumes intake with revision CAS and replays the post-response crash window read-only', async () => {
    const receiptSha = 'a'.repeat(64)
    const reason = `SDK successor 恢复完成，恢复新任务入口 [${receiptSha.slice(0, 24)}]`
    const paused = {
      schema: 'video-autoworker-intake-control/v1', globalScope: true, canManage: true,
      accepting: false, mode: 'paused', revision: 7, counts: { active: 0 },
    }
    const active = {
      ...paused, accepting: true, mode: 'active', revision: 8, reason,
      changedAt: 1_800_000_000, changedBy: { id: 1, name: 'OpenClaw' },
    }
    const calls: Array<{ init?: RequestInit }> = []
    const request = async (_url: string, init?: RequestInit) => {
      calls.push({ init })
      return new Response(JSON.stringify({ control: init?.method === 'POST' ? active : paused }))
    }
    await expect(reconcileRecoveredIntake({
      pausedRevision: 7, recoveryReceiptSha256: receiptSha, request: request as typeof fetch,
    })).resolves.toMatchObject({ pausedRevision: 7, resumedRevision: 8, reason })
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      action: 'resume', reason, expectedRevision: 7,
    })

    const replayCalls: RequestInit[] = []
    const replay = async (_url: string, init?: RequestInit) => {
      replayCalls.push(init ?? {})
      return new Response(JSON.stringify({ control: active }))
    }
    await expect(reconcileRecoveredIntake({
      pausedRevision: 7, recoveryReceiptSha256: receiptSha, request: replay as typeof fetch,
    })).resolves.toMatchObject({ pausedRevision: 7, resumedRevision: 8 })
    expect(replayCalls).toHaveLength(1)
    expect(replayCalls[0].method).toBeUndefined()
  })

  it('rejects pre-resume router drift from the immutable baseline attestation', async () => {
    const request = async () => new Response(JSON.stringify({
      schema: 'video-autoworker-standalone-router-health/v1', ok: true, pid: 123,
      active: 'green', releaseId: 'other-release', generation: 9,
    }))
    await expect(verifyRecoveredRouter({
      slot: 'blue', releaseId: 'expected-release', generation: 8,
      request: request as typeof fetch,
    })).rejects.toThrow('recovered router differs from the baseline attestation')
  })

  it('keeps the valid already-consumed historical derive path before runtime capture', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/legacy-bootstrap-controller.mjs'),
      'utf8',
    )
    const deriveStart = source.indexOf('function deriveBootstrapResume(values) {')
    const deriveEnd = source.indexOf('\nfunction verifyBootstrapResume', deriveStart)
    const derive = source.slice(deriveStart, deriveEnd)
    const consumedBranch = derive.indexOf('if (existsSync(receiptPath) && !existsSync(tokenPath))')
    const consumedReturn = derive.indexOf('\n    return', consumedBranch)
    const runtimeCapture = derive.indexOf('captureResumeSnapshot', consumedReturn)
    const branchClaimStart = source.indexOf('function claimRecoveryBranch(')
    const branchClaimEnd = source.indexOf('\nfunction validateRecoveryBranch', branchClaimStart)
    const branchClaim = source.slice(branchClaimStart, branchClaimEnd)
    const existingClaim = branchClaim.indexOf('if (existsSync(pathname))')
    const existingReturn = branchClaim.indexOf('return loaded.reference', existingClaim)
    const claimWrite = branchClaim.indexOf('return writeExclusiveReceipt', existingClaim)

    expect(consumedBranch).toBeGreaterThan(0)
    expect(consumedReturn).toBeGreaterThan(consumedBranch)
    expect(runtimeCapture).toBeGreaterThan(consumedReturn)
    expect(derive.slice(consumedBranch, consumedReturn)).not.toContain('captureResumeSnapshot')
    expect(derive.slice(consumedBranch, consumedReturn)).not.toContain('writeExclusiveReceipt')
    expect(existingReturn).toBeGreaterThan(existingClaim)
    expect(claimWrite).toBeGreaterThan(existingReturn)
  })
})
