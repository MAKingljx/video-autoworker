// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  gitBoundFile,
  reconcileRecoveredIntake,
  sanitizedEnvironment,
  verifyTargetArtifactWithSlotRuntime,
  verifyRecoveredRouter,
} from '../../ops/recovery/run-legacy-bootstrap-sdk-successor.mjs'

describe('legacy bootstrap SDK successor entry', () => {
  it('validates historical evidence and workflow identity before mapping the requested successor', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'successor-inline-binding-'))
    try {
      const deploy = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
      const evidenceCall = deploy.indexOf('evidence_values="$($NODE_BIN')
      const evidenceProgramStart = deploy.indexOf("const fs = require('node:fs')", evidenceCall)
      const evidenceProgramEnd = deploy.indexOf('\nNODE\n  )"', evidenceProgramStart)
      const evidenceProgram = deploy.slice(evidenceProgramStart, evidenceProgramEnd)
      const evidenceArguments = deploy.slice(evidenceCall, evidenceProgramStart)
      expect(evidenceArguments).toContain('"$authorization_release_id" "$authorization_release_root"')
      expect(evidenceArguments).toContain('"$authorization_manifest"')

      const now = 1_800_000_000
      const historicalTarget = {
        slot: 'blue', releaseId: 'historical-target', releaseRoot: '/releases/historical-target',
        manifestSha256: 'a'.repeat(64),
      }
      const fileIdentity = (path: string) => ({ path, dev: '1', ino: '2' })
      const processIdentity = (pid: number, database: string) => ({
        pid, ppid: 2, uid: process.getuid?.() ?? 0, startTime: 'now', argvSha256: 'b'.repeat(64),
        cwd: fileIdentity('/runtime/cwd'), database: fileIdentity(database),
        executable: fileIdentity('/runtime/node'),
      })
      const evidence = {
        schema: 'video-autoworker-legacy-freeze-evidence/v3',
        generatorSha256: 'c'.repeat(64),
        target: historicalTarget,
        legacy: { ...processIdentity(1, '/mission.db'), releaseId: 'pre-baseline', routerPort: 3017 },
        n8n: { ...processIdentity(3, '/n8n.db'), ppid: 4, launchPid: 4, port: 5678 },
        counts: { mediaNodes: 0, n8nActiveExecutions: 0, queueRunning: 0, queueWaiting: 0 },
        queueDigestSha256: 'd'.repeat(64),
        rollback: { ...fileIdentity('/rollback.json'), sha256: 'e'.repeat(64) },
        supervisor: { disabled: true, loaded: false, lockAbsent: true, workerPids: [] },
        frozen: {
          schema: 'video-autoworker-legacy-freeze-guard/v1', mode: 'dual', ready: true,
          pid: 5, uid: process.getuid?.() ?? 0, startedAt: 'now', issuedAt: now - 60, expiresAt: now + 60,
          argvSha256: 'f'.repeat(64), guardNonceSha256: '1'.repeat(64),
          legacyBindingSha256: '2'.repeat(64), scriptSha256: '3'.repeat(64),
          database: fileIdentity('/mission.db'), n8nDatabase: fileIdentity('/n8n.db'),
          socket: fileIdentity('/guard.sock'),
        },
        observedAt: now - 10,
      }
      const evidencePath = join(root, 'evidence.json')
      const evidenceSource = `${JSON.stringify(evidence)}\n`
      writeFileSync(evidencePath, evidenceSource, { mode: 0o600 })
      chmodSync(evidencePath, 0o600)
      const descriptor = openSync(evidencePath, 'r')
      const runEvidenceValidator = (releaseId: string, releaseRoot: string, manifest: string) =>
        spawnSync(process.execPath, [
          '-', '3', evidencePath, '3017', String(now), '300', 'blue', releaseId, releaseRoot,
          manifest, '/mission.db', '/n8n.db',
          createHash('sha256').update(evidenceSource).digest('hex'), '/rollback.json', '0',
        ], { input: evidenceProgram, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', descriptor] })
      try {
        const historical = runEvidenceValidator(
          historicalTarget.releaseId, historicalTarget.releaseRoot, historicalTarget.manifestSha256,
        )
        expect(historical.status, historical.stderr).toBe(0)
        expect(historical.stdout).toContain('pre-baseline\n1\n/runtime/cwd')

        const requested = runEvidenceValidator('requested', '/releases/requested', '9'.repeat(64))
        expect(requested.status).not.toBe(0)
      } finally {
        closeSync(descriptor)
      }

      const workflowCall = deploy.indexOf('workflow_digest="$($NODE_BIN -e')
      const workflowProgramStart = deploy.indexOf("\n    const value = JSON.parse", workflowCall) + 1
      const workflowProgramEnd = deploy.indexOf("\n  ' \"$workflow_compatibility\"", workflowProgramStart)
      const workflowProgram = deploy.slice(workflowProgramStart, workflowProgramEnd)
      const workflowArguments = deploy.slice(workflowProgramEnd, deploy.indexOf('\\\n', workflowProgramEnd))
      expect(workflowArguments).toContain('"$n8n_source_commit"')
      const historicalCommit = '3'.repeat(40)
      const workflow = JSON.stringify({
        schema: 'video-autoworker-n8n-workflow-compatibility/v2',
        protocol: 'slot-v1-execution-owner-v1', sourceCommit: historicalCommit,
        databasePath: '/n8n.db', runtimeIdentitySha256: '4'.repeat(64),
        combinedSha256: '5'.repeat(64), workflows: [{}, {}],
      })
      const accepted = spawnSync(process.execPath, [
        '-e', workflowProgram, workflow, '/n8n.db', historicalCommit,
      ], { encoding: 'utf8' })
      expect(accepted.status, accepted.stderr).toBe(0)
      expect(accepted.stdout).toBe('5'.repeat(64))
      const rejected = spawnSync(process.execPath, [
        '-e', workflowProgram, workflow, '/n8n.db', '9'.repeat(40),
      ], { encoding: 'utf8' })
      expect(rejected.status).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pins command lookup to the current Node directory without inheriting caller PATH', () => {
    const maliciousBin = mkdtempSync(join(realpathSync(tmpdir()), 'successor-malicious-path-'))
    try {
      const fakeNode = join(maliciousBin, 'node')
      writeFileSync(fakeNode, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
      chmodSync(fakeNode, 0o755)
      const environment = sanitizedEnvironment({
        NODE_ENV: 'production',
        HOME: '/safe-home',
        PATH: `${maliciousBin}:/untrusted/bin`,
      })
      const expectedPath = [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(':')

      expect(environment).toMatchObject({
        HOME: '/safe-home',
        NODE_BIN: process.execPath,
        PATH: expectedPath,
      })
      expect(environment.PATH).not.toContain(maliciousBin)
      const resolvedNode = execFileSync('/bin/sh', ['-c', 'command -v node'], {
        encoding: 'utf8', env: { ...environment, NODE_ENV: 'production' },
      }).trim()
      expect(realpathSync(resolvedNode)).toBe(realpathSync(process.execPath))
    } finally {
      rmSync(maliciousBin, { recursive: true, force: true })
    }
  })

  it('runs the Git-bound slot auditor against the requested artifact before authorization', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'successor-slot-auditor-'))
    try {
      const auditor = join(root, 'auditor.mjs')
      const target = join(root, 'standalone')
      mkdirSync(target, { mode: 0o700 })
      writeFileSync(auditor, `
if (process.argv[2] !== ${JSON.stringify(target)}) process.exit(41)
if (process.env.FORBIDDEN_CALLER_VALUE) process.exit(42)
`, { mode: 0o644 })
      chmodSync(auditor, 0o644)
      const proof = {
        slotRuntime: {
          sourceCommit: 'a'.repeat(40),
          launcher: {},
          auditor: { path: auditor, sha256: createHash('sha256').update(readFileSync(auditor)).digest('hex'), mode: 0o644 },
          dependencies: {},
        },
      }
      expect(() => verifyTargetArtifactWithSlotRuntime(proof, target, {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      })).not.toThrow()
      writeFileSync(auditor, 'process.exit(43)\n', { mode: 0o644 })
      expect(() => verifyTargetArtifactWithSlotRuntime(proof, target, {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      })).toThrow('target artifact is incompatible with the installed slot runtime')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds the Node-invoked compatibility CLI from a real 100644 Git fixture', () => {
    const repository = mkdtempSync(join(realpathSync(tmpdir()), 'successor-runner-mode-'))
    try {
      const relativePath = 'scripts/verify-openclaw-runtime-compatibility.mjs'
      const pathname = join(repository, relativePath)
      mkdirSync(join(repository, 'scripts'), { mode: 0o700 })
      writeFileSync(pathname, '#!/usr/bin/env node\n', { mode: 0o644 })
      writeFileSync(join(repository, 'package.json'), '{"name":"video-autoworker"}\n')
      writeFileSync(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(join(repository, 'next.config.js'), 'export default {}\n')
      chmodSync(pathname, 0o644)
      execFileSync('/usr/bin/git', ['init', '-q', repository])
      execFileSync('/usr/bin/git', ['-C', repository, 'add', '.'])
      execFileSync('/usr/bin/git', [
        '-C', repository,
        '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid',
        'commit', '-qm', 'fixture',
      ])
      const commit = execFileSync('/usr/bin/git', [
        '-C', repository, 'rev-parse', 'HEAD',
      ], { encoding: 'utf8' }).trim()
      const staged = execFileSync('/usr/bin/git', [
        '-C', repository, 'ls-files', '--stage', relativePath,
      ], { encoding: 'utf8' })

      expect(staged).toMatch(/^100644 /u)
      expect(gitBoundFile(repository, commit, relativePath, 0o644)).toBe(pathname)
      expect(() => gitBoundFile(repository, commit, relativePath, 0o755))
        .toThrow('scripts/verify-openclaw-runtime-compatibility.mjs is unsafe')
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })

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
