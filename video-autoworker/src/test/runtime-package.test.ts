// @vitest-environment node
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentPackageRuntime, packageCiSource, probeArtifactSqlite, resolveArtifactSqlitePackage, validatePackageReceipt, verifyPackageCiSuccess, verifyRuntimePackage } from '../../scripts/package-runtime-artifact.mjs'

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

function artifactManifest(root: string) {
  const files: Array<{ path: string; mode: string; bytes: number; sha256: string }> = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name)
      if (entry.isDirectory()) walk(pathname)
      else if (entry.isFile()) {
        const stat = lstatSync(pathname)
        files.push({ path: relative(root, pathname), mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
          bytes: stat.size, sha256: createHash('sha256').update(readFileSync(pathname)).digest('hex') })
      }
    }
  }
  walk(root)
  return { schemaVersion: 2, algorithm: 'sha256', files }
}

function pnpmSqliteFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-package-pnpm-'))); paths.push(root)
  const require = createRequire(import.meta.url)
  const source = realpathSync(dirname(require.resolve('better-sqlite3/package.json')))
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const packageRoot = join(root, `node_modules/.pnpm/better-sqlite3@${metadata.version}/node_modules/better-sqlite3`)
  cpSync(source, packageRoot, { recursive: true, dereference: true })
  const packageRequire = createRequire(join(source, 'package.json'))
  const bindingsRoot = dirname(packageRequire.resolve('bindings/package.json'))
  const bindingsRequire = createRequire(join(bindingsRoot, 'package.json'))
  const uriRoot = dirname(bindingsRequire.resolve('file-uri-to-path/package.json'))
  for (const [name, sourceRoot] of [['bindings', bindingsRoot], ['file-uri-to-path', uriRoot]]) {
    cpSync(sourceRoot, join(dirname(packageRoot), name), { recursive: true, dereference: true })
  }
  const top = join(root, 'node_modules/better-sqlite3')
  mkdirSync(top, { recursive: true })
  cpSync(join(source, 'package.json'), join(top, 'package.json'))
  return { root, source, packageRoot, top, metadata }
}
describe('verified runtime package promotion', () => {
  it('opens real SQLite from the unique internal pnpm package when the top-level package is metadata-only', async () => {
    const f = pnpmSqliteFixture()
    const manifest = artifactManifest(f.root)
    const resolved = await resolveArtifactSqlitePackage(f.root, manifest)
    expect(resolved.entrypoint).toBe(join(f.packageRoot, 'lib/index.js'))
    expect(resolved.nativeBinding).toBe(join(f.packageRoot, 'build/Release/better_sqlite3.node'))
    expect(await probeArtifactSqlite(f.root, manifest)).toMatchObject({ ok: true, name: 'better-sqlite3', version: f.metadata.version })
    expect(artifactManifest(f.root)).toEqual(manifest)
    expect(readdirSync(f.top)).toEqual(['package.json'])
  })

  it('accepts equivalent top metadata without depending on package.json whitespace or extra fields', async () => {
    const f = pnpmSqliteFixture()
    writeFileSync(join(f.top, 'package.json'), JSON.stringify({ name: f.metadata.name, version: f.metadata.version, main: f.metadata.main }))
    expect(await probeArtifactSqlite(f.root, artifactManifest(f.root))).toMatchObject({ ok: true, version: f.metadata.version })
  })

  it('rejects two complete internal packages with the same top-level identity before loading either', async () => {
    const f = pnpmSqliteFixture()
    cpSync(f.packageRoot, join(f.root, 'node_modules/.pnpm/second-copy/node_modules/better-sqlite3'), { recursive: true })
    await expect(resolveArtifactSqlitePackage(f.root, artifactManifest(f.root)))
      .rejects.toThrow('runtime_package_sqlite_package_ambiguous_or_missing')
  })

  it('rejects an entrypoint symlink escaping the artifact instead of loading source dependencies', async () => {
    const f = pnpmSqliteFixture()
    const entry = join(f.packageRoot, 'lib/index.js')
    rmSync(entry)
    symlinkSync(join(f.source, 'lib/index.js'), entry)
    await expect(resolveArtifactSqlitePackage(f.root, artifactManifest(f.root)))
      .rejects.toThrow('runtime_package_sqlite_outside_artifact')
  })

  it('rejects changed declared bytes and refuses a different-version package as a fallback', async () => {
    const f = pnpmSqliteFixture()
    const manifest = artifactManifest(f.root)
    writeFileSync(join(f.packageRoot, 'lib/index.js'), 'module.exports = null\n')
    await expect(resolveArtifactSqlitePackage(f.root, manifest)).rejects.toThrow('runtime_package_sqlite_member_changed')
    writeFileSync(join(f.packageRoot, 'package.json'), JSON.stringify({ ...f.metadata, version: '0.0.0' }))
    await expect(resolveArtifactSqlitePackage(f.root, artifactManifest(f.root)))
      .rejects.toThrow('runtime_package_sqlite_package_ambiguous_or_missing')
  })

  it('propagates a real native loading error without treating it as a missing JavaScript entry', async () => {
    const f = pnpmSqliteFixture()
    writeFileSync(join(f.packageRoot, 'build/Release/better_sqlite3.node'), 'invalid native addon')
    await expect(probeArtifactSqlite(f.root, artifactManifest(f.root))).rejects.toMatchObject({ code: 'ERR_DLOPEN_FAILED' })
  })

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
