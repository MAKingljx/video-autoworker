// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentPackageRuntime, packageCiSource, validatePackageReceipt, verifyPackageCiSuccess, verifyRuntimePackage } from '../../scripts/package-runtime-artifact.mjs'

const paths: string[] = []
afterEach(() => { for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-package-')); paths.push(root)
  const runtime = currentPackageRuntime()
  const archive = `runtime-${'a'.repeat(40)}-${runtime.platform}-${runtime.arch}-node${runtime.nodeAbi}.tar.gz`
  const bytes = Buffer.from('exact sealed package bytes')
  const receipt = { schema: 'video-autoworker-runtime-package/v1', sourceCommit: 'a'.repeat(40),
    runtime, archive, archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, manifestSha256: 'b'.repeat(64), artifactContent: { digest: 'c'.repeat(64) },
    ci: null, verification: 'candidate', promotionRequirement: 'explicit-local-validation-receipt' }
  writeFileSync(join(root, archive), bytes)
  const receiptPath = join(root, 'package.json')
  writeFileSync(receiptPath, JSON.stringify(receipt))
  return { root, receipt, receiptPath }
}
describe('verified runtime package promotion', () => {
  it('accepts the same bytes on the matching native platform', async () => {
    const f = fixture()
    expect(await verifyRuntimePackage(f.receiptPath)).toMatchObject({ ok: true, receipt: f.receipt })
  })
  it.each(['arch', 'platform', 'nodeAbi', 'nodeMajor'])('rejects a mismatched %s before deployment', key => {
    const f = fixture()
    expect(() => validatePackageReceipt(f.receipt, { ...f.receipt.runtime, [key]: 'different' }))
      .toThrow(`runtime_package_${key}_mismatch`)
  })
  it('rejects altered bytes and path traversal', async () => {
    const f = fixture()
    writeFileSync(join(f.root, f.receipt.archive), 'exact sealed package byteX')
    await expect(verifyRuntimePackage(f.receiptPath)).rejects.toThrow('runtime_package_archive_changed')
    expect(() => validatePackageReceipt({ ...f.receipt, archive: '../outside.tar.gz' }))
      .toThrow('runtime_package_receipt_invalid')
  })

  it('binds complete CI environment inputs to this project and the sealed source SHA', () => {
    const f = fixture()
    const env = { GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_REPOSITORY: 'MAKingljx/video-autoworker', GITHUB_SHA: f.receipt.sourceCommit }
    expect(packageCiSource(f.receipt.sourceCommit, {})).toBeNull()
    expect(packageCiSource(f.receipt.sourceCommit, env)).toEqual({
      repository: env.GITHUB_REPOSITORY, runId: '12345', attempt: 2,
      headSha: f.receipt.sourceCommit, workflow: 'Quality Gate',
    })
    for (const change of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ATTEMPT: '' }, { GITHUB_REPOSITORY: 'someone/other' }]) {
      expect(() => packageCiSource(f.receipt.sourceCommit, { ...env, ...change })).toThrow('runtime_package_ci_source_invalid')
    }
  })

  it('requires a fresh whole-workflow result for the exact repository, attempt and commit', async () => {
    const f = fixture()
    const ci = { repository: 'MAKingljx/video-autoworker', runId: '12345', attempt: 2,
      headSha: f.receipt.sourceCommit, workflow: 'Quality Gate' }
    const receipt = { ...f.receipt, ci, promotionRequirement: 'quality-gate-success' }
    writeFileSync(f.receiptPath, JSON.stringify(receipt))
    const result = { databaseId: 12345, attempt: 2, headSha: ci.headSha,
      workflowName: 'Quality Gate', status: 'completed', conclusion: 'success',
      url: 'https://github.com/MAKingljx/video-autoworker/actions/runs/12345' }
    const runCommand = vi.fn((..._args: unknown[]) => JSON.stringify(result))
    expect(await verifyRuntimePackage(f.receiptPath, currentPackageRuntime(), { requireCiSuccess: true, runCommand }))
      .toMatchObject({ ok: true, ciVerification: { status: 'verified', runId: '12345', attempt: 2 } })
    expect(runCommand.mock.calls[0][0]).toBe('gh')
    expect(runCommand.mock.calls[0][1]).toContain('--attempt')
    for (const change of [{ attempt: 1 }, { databaseId: 12346 }, { headSha: 'b'.repeat(40) },
      { workflowName: 'Unrelated Check' }, { url: 'https://github.com/other/repo/actions/runs/12345' }]) {
      expect(() => verifyPackageCiSuccess(receipt, { runCommand: () => JSON.stringify({ ...result, ...change }) }))
        .toThrow('runtime_package_ci_run_identity_mismatch')
    }
    for (const change of [{ status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }]) {
      expect(() => verifyPackageCiSuccess(receipt, { runCommand: () => JSON.stringify({ ...result, ...change }) }))
        .toThrow('runtime_package_ci_not_successful')
    }
  })

  it('keeps local candidates unapproved and does not expose gh authentication errors', () => {
    const f = fixture()
    expect(() => verifyPackageCiSuccess(f.receipt)).toThrow('runtime_package_ci_required')
    const ci = { repository: 'MAKingljx/video-autoworker', runId: '12345', attempt: 1,
      headSha: f.receipt.sourceCommit, workflow: 'Quality Gate' }
    expect(() => verifyPackageCiSuccess({ ...f.receipt, ci }, {
      runCommand: () => { throw new Error('sensitive stderr must not escape') },
    })).toThrow('runtime_package_ci_query_failed')
    expect(() => validatePackageReceipt({ ...f.receipt, sourceCommit: 'b'.repeat(40) }))
      .toThrow('runtime_package_receipt_identity_mismatch')
  })
})
