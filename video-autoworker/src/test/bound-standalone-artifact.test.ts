// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  auditBoundStandaloneArtifact, auditStandaloneArtifact,
  computeStandaloneArtifactContentBinding, readStandaloneArtifactContractForGitCommit,
} from '../../scripts/check-standalone-artifact.mjs'
import {
  createStandaloneBuildSourceAnchor, sourceClosureForGitCommit,
  writeDirectorExtractionProvenance, DIRECTOR_EXTRACTION_SOURCE_ROOTS,
} from '../../scripts/lib/director-extraction-release-provenance.mjs'
import { readGitProductFile, resolveGitSourceLayout } from '../../scripts/lib/git-source-layout.mjs'

const product = realpathSync(process.cwd()), { gitRoot } = resolveGitSourceLayout(product)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const git = (root: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const historicalCommits = ['664d0949b8249c75275f2f1624c7ef2fe4fa8c7a', 'e553fbda4845675630b9cc17ef6503cf03499b94']
const roots: string[] = []
let baseline: string, repository: string, artifact: string, commit: string
let writeHistoricalManifest: (root: string) => Promise<unknown>
const write = (pathname: string, source: string | Buffer) => {
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 })
  writeFileSync(pathname, source, { mode: 0o600 })
}

beforeAll(async () => {
  baseline = realpathSync(mkdtempSync(join(tmpdir(), 'bound-standalone-baseline-')))
  repository = join(baseline, 'repository'); artifact = join(baseline, 'artifact')
  mkdirSync(repository, { mode: 0o700 }); mkdirSync(artifact, { mode: 0o700 })
  const original = historicalCommits[0]
  // Keep the build fixture small while using the actual historical member
  // contract. Every declared fixture source still belongs to its real Git
  // commit and genuine build anchor; it makes no production-artifact claim.
  for (const member of DIRECTOR_EXTRACTION_SOURCE_ROOTS) {
    write(join(repository, member), member === 'package.json' ? '{"name":"video-autoworker"}\n'
      : member === 'pnpm-lock.yaml' ? 'lockfileVersion: 9\n' : 'export {}\n')
  }
  write(join(repository, 'scripts/check-standalone-artifact.mjs'), readGitProductFile(gitRoot, original, 'scripts/check-standalone-artifact.mjs'))
  write(join(repository, 'scripts/lib/director-extraction-release-provenance.mjs'),
    "export const DIRECTOR_EXTRACTION_PROVENANCE_NAME = 'release-provenance.json'\nexport const STANDALONE_PROVENANCE_SCHEMA = 'video-autoworker-standalone-provenance/v3'\n")
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.name', 'Bound Artifact Test')
  git(repository, 'config', 'user.email', 'artifact-test@example.invalid')
  git(repository, 'config', 'commit.gpgSign', 'false')
  git(repository, 'remote', 'add', 'origin', 'https://github.com/MAKingljx/video-autoworker.git')
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'isolated historical source fixture')
  commit = git(repository, 'rev-parse', 'HEAD')
  const contract = readStandaloneArtifactContractForGitCommit(repository, commit)
  for (const member of contract.requiredFiles) {
    if (member === 'release-provenance.json') continue
    write(join(artifact, member), member.endsWith('.json') ? '{}\n'
      : /\.[cm]?js$/u.test(member) ? 'export {}\n' : 'runtime fixture\n')
  }
  for (const member of ['.next/server/app.js', '.next/static/runtime.css', 'messages/zh-CN.json',
    'node_modules/.pnpm/fixture-package', 'public/favicon.ico']) write(join(artifact, member), 'fixture\n')
  write(join(artifact, 'server.js'), 'const nextConfig = {}\n\nprocess.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)\n')
  write(join(artifact, '.next/required-server-files.json'), JSON.stringify({ config: {}, appDir: '.', files: [] }))
  write(join(artifact, 'scripts/lib/director-extraction-release-provenance.mjs'),
    "export const STANDALONE_PROVENANCE_SCHEMA = 'video-autoworker-standalone-provenance/v3'\n")
  const anchor = createStandaloneBuildSourceAnchor(repository)
  writeDirectorExtractionProvenance(repository, artifact, await computeStandaloneArtifactContentBinding(artifact), anchor)
  // Seal this build with that historical writer, rather than asking today's
  // new-candidate writer to create an intentionally older contract artifact.
  const writerRoot = join(baseline, 'historical-auditor')
  const auditorClosure = sourceClosureForGitCommit(product, original, ['scripts/check-standalone-artifact.mjs'])
  for (const member of auditorClosure.files) write(join(writerRoot, member.path), readGitProductFile(gitRoot, original, member.path))
  const historicalAuditor = await import(/* @vite-ignore */ pathToFileURL(join(writerRoot, 'scripts/check-standalone-artifact.mjs')).href)
  writeHistoricalManifest = historicalAuditor.writeStandaloneReleaseManifest
  await writeHistoricalManifest(artifact)
}, 30_000)
afterAll(() => { rmSync(baseline, { recursive: true, force: true }) })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bound-standalone-case-')))
  roots.push(root)
  cpSync(artifact, root, { recursive: true })
  // Node's cp creates destination directories with its default mode. Preserve
  // the sealed fixture's original modes just as the release copy contract does.
  const manifest = JSON.parse(readFileSync(join(artifact, 'release-manifest.json'), 'utf8'))
  for (const entry of [...manifest.directories, ...manifest.files]) {
    chmodSync(join(root, entry.path), lstatSync(join(artifact, entry.path)).mode & 0o7777)
  }
  const options = { repositoryRoot: repository, releaseId: `${commit}-runtime`,
    manifestSha256: digest(readFileSync(join(root, 'release-manifest.json'))) }
  return { root, options }
}

describe('immutable bound standalone release contracts', () => {
  it.each(historicalCommits)('reads the real %s contract without imposing later learning helpers', original => {
    const value = readStandaloneArtifactContractForGitCommit(product, original)
    expect(value).toMatchObject({ sourceCommit: original,
      auditorSha256: '34e16ebca4a1e0af726c5884e4d2d0e43f4c7eff09b239c2c92e392842eaf4f0' })
    expect(value.requiredFiles).toHaveLength(85)
    expect(value.requiredDirectories).toHaveLength(5)
    expect(value.requiredFiles).not.toContain('openclaw-skills/aiworker-task-flow/lib/video-learning-result.mjs')
    expect(value.requiredFiles).not.toContain('openclaw-skills/aiworker-task-flow/lib/video-segment-report.mjs')
    expect(value.requiredFiles).toContain('release-provenance.json')
  })

  it('audits a genuinely sealed historical-contract artifact but still rejects it as a new candidate', async () => {
    const f = fixture(), before = readFileSync(join(f.root, 'release-manifest.json'))
    const declared = JSON.parse(before.toString())
    expect([...declared.directories, ...declared.files].flatMap((entry: { path: string; mode: string }) => {
      const mode = (lstatSync(join(f.root, entry.path)).mode & 0o7777).toString(8).padStart(4, '0')
      return mode === entry.mode ? [] : [{ path: entry.path, declared: entry.mode, mode }]
    })).toEqual([])
    expect(await computeStandaloneArtifactContentBinding(f.root)).toEqual(declared.artifactContent)
    await expect(auditBoundStandaloneArtifact(f.root, f.options)).resolves.toMatchObject({
      ok: true, auditMode: 'bound-release', sourceCommit: commit,
    })
    await expect(auditStandaloneArtifact(f.root)).rejects.toThrow('standalone_required_file_missing:openclaw-skills/aiworker-task-flow/lib/video-segment-report.mjs')
    expect(readFileSync(join(f.root, 'release-manifest.json'))).toEqual(before)
  })

  it('runs the real bound CLI without a module-loading cycle and emits a sealed verification bundle', () => {
    const f = fixture()
    const result = JSON.parse(execFileSync(process.execPath, [resolve('scripts/check-standalone-artifact.mjs'),
      '--audit-bound', f.root, repository, f.options.releaseId, f.options.manifestSha256], {
      encoding: 'utf8', timeout: 15_000,
    }))
    expect(result).toMatchObject({ ok: true, auditMode: 'bound-release', sourceCommit: commit,
      verificationBundle: { schema: 'video-autoworker-standalone-verification-bundle/v1' } })
  })

  it('rejects a changed manifest despite an otherwise intact old release', async () => {
    const f = fixture(), manifest = join(f.root, 'release-manifest.json')
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}\n`)
    await expect(auditBoundStandaloneArtifact(f.root, f.options)).rejects.toThrow('standalone_bound_manifest_changed')
  })

  it('rejects forged provenance even if its new manifest digest is supplied', async () => {
    const f = fixture(), pathname = join(f.root, 'release-provenance.json')
    const value = JSON.parse(readFileSync(pathname, 'utf8')); value.gitDirty = true
    writeFileSync(pathname, JSON.stringify(value))
    await writeHistoricalManifest(f.root)
    f.options.manifestSha256 = digest(readFileSync(join(f.root, 'release-manifest.json')))
    await expect(auditBoundStandaloneArtifact(f.root, f.options)).rejects.toThrow('app_release_provenance_invalid')
  })

  it('does not accept artifact bytes merely because the original manifest and source are valid', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'public/favicon.ico'), 'post-build drift\n')
    await expect(auditBoundStandaloneArtifact(f.root, f.options)).rejects.toThrow('standalone_release_provenance_artifact_mismatch')
  })

  it.each(['symlink', 'writable'])('rejects an unsafe %s bound manifest', async fault => {
    const f = fixture(), pathname = join(f.root, 'release-manifest.json')
    if (fault === 'symlink') {
      const original = join(f.root, 'manifest-original.json')
      writeFileSync(original, readFileSync(pathname)); rmSync(pathname); symlinkSync(original, pathname)
    } else chmodSync(pathname, 0o666)
    await expect(auditBoundStandaloneArtifact(f.root, f.options)).rejects.toThrow('standalone_bound_manifest_unsafe')
  })

  it('rejects a release identity that does not resolve to the sealed provenance commit', async () => {
    const f = fixture(), source = realpathSync(mkdtempSync(join(tmpdir(), 'bound-wrong-release-')))
    roots.push(source); cpSync(repository, source, { recursive: true })
    git(source, 'commit', '--allow-empty', '-m', 'different immutable release identity')
    await expect(auditBoundStandaloneArtifact(f.root, { ...f.options, repositoryRoot: source,
      releaseId: `${git(source, 'rev-parse', 'HEAD')}-runtime` })).rejects.toThrow('app_release_provenance_invalid')
  })

  it.each(['foreign-origin', 'unpublished-detached-head', 'missing-mainline-ref'])(
    'does not relax canonical source ownership for %s', async fault => {
      const f = fixture(), source = realpathSync(mkdtempSync(join(tmpdir(), 'bound-source-owner-')))
      roots.push(source); cpSync(repository, source, { recursive: true })
      if (fault === 'foreign-origin') git(source, 'remote', 'set-url', 'origin', 'https://example.invalid/foreign.git')
      else if (fault === 'unpublished-detached-head') {
        git(source, 'update-ref', 'refs/remotes/origin/main', commit)
        git(source, 'commit', '--allow-empty', '-m', 'unpublished isolated coordinator')
        git(source, 'checkout', '--detach', 'HEAD')
      } else git(source, 'checkout', '--detach', 'HEAD')
      await expect(auditBoundStandaloneArtifact(f.root, { ...f.options, repositoryRoot: source }))
        .rejects.toThrow(fault === 'foreign-origin' ? 'repository_remote_mismatch' : 'repository_release_mismatch')
    },
  )

  it('rejects an unknown, missing or nonliteral historical contract without executing its expression', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'unknown-standalone-contract-'))); roots.push(root)
    cpSync(repository, root, { recursive: true })
    write(join(root, 'scripts/check-standalone-artifact.mjs'),
      'export const REQUIRED_STANDALONE_FILES = (() => { throw new Error("must never execute") })()\nconst REQUIRED_STANDALONE_DIRECTORIES = []\n')
    git(root, 'add', '.'); git(root, 'commit', '-m', 'unrecognized isolated contract')
    expect(() => readStandaloneArtifactContractForGitCommit(root, git(root, 'rev-parse', 'HEAD')))
      .toThrow('standalone_historical_contract_unrecognized')
    expect(() => readStandaloneArtifactContractForGitCommit(repository, 'f'.repeat(40))).toThrow()
  })

  it.each([
    "let REQUIRED_STANDALONE_FILES = ['server.js']; REQUIRED_STANDALONE_FILES = unknownRequirements()",
    "const REQUIRED_STANDALONE_FILES = ['server.js']; REQUIRED_STANDALONE_FILES.push('unknown.js')",
    "const REQUIRED_STANDALONE_FILES = ['server.js']; REQUIRED_STANDALONE_FILES[0] = 'unknown.js'",
  ])('rejects a mutable historical requirement declaration: %s', source => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mutable-standalone-contract-'))); roots.push(root)
    cpSync(repository, root, { recursive: true })
    write(join(root, 'scripts/check-standalone-artifact.mjs'), `${source}\nconst REQUIRED_STANDALONE_DIRECTORIES = ['.next/server']\n`)
    git(root, 'add', '.'); git(root, 'commit', '-m', 'mutable isolated contract')
    expect(() => readStandaloneArtifactContractForGitCommit(root, git(root, 'rev-parse', 'HEAD')))
      .toThrow('standalone_historical_contract_unrecognized')
  })

  it('keeps the new-copy audit strict while routing only an explicitly bound audit through its historical contract', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bound-audit-routing-'))); roots.push(root)
    const script = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
    const start = script.indexOf('full_audit_release() {'), end = script.indexOf('\nquick_verify_release() {', start)
    const auditor = join(root, 'auditor.mjs'), harness = join(root, 'routing.sh'), calls = join(root, 'calls.jsonl')
    write(auditor, "import{appendFileSync}from'node:fs';appendFileSync(process.env.AUDIT_LOG,JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write('{}')\n")
    write(harness, `${script.slice(start, end)}\nincrement_release_verification_count() { :; }\ncache_release_verification() { :; }\nNODE_BIN="$1"\nAUDITOR="$2"\nPROJECT_ROOT="$3"\nfull_audit_release "$3"\nfull_audit_release "$3" "${commit}-runtime" "${'a'.repeat(64)}"\n`)
    execFileSync('/bin/bash', [harness, process.execPath, auditor, root], {
      env: { ...process.env, AUDIT_LOG: calls }, timeout: 5000,
    })
    const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(invocations).toEqual([[root], ['--audit-bound', root, root, `${commit}-runtime`, 'a'.repeat(64)]])
  })

  it('does not issue a bound-audit digest for a mismatched registered root or an unknown release', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bound-audit-registry-'))); roots.push(root)
    const script = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
    const start = script.indexOf('bound_release_manifest() {'), end = script.indexOf('\nquick_verify_release() {', start)
    const pathname = join(root, 'registry.sh'), marker = join(root, 'state.json')
    write(marker, '{}\n')
    write(pathname, `${script.slice(start, end)}\nSTATE_FILE="$1"\nREGISTERED_ROOT="$2"\nread_state_slot_release() { printf '%s\\n' "${commit}-runtime"; }\nbinding_values() { printf '%s\\n' "${commit}-runtime" "$REGISTERED_ROOT" "${'a'.repeat(64)}"; }\nbound_release_manifest "$3" "$4"\n`)
    const invoke = (registeredRoot: string, releaseId: string, requestedRoot: string) => execFileSync('/bin/bash',
      [pathname, marker, registeredRoot, releaseId, requestedRoot], { encoding: 'utf8', timeout: 5000 })
    expect(invoke(root, `${commit}-runtime`, root).trim()).toBe('a'.repeat(64))
    expect(() => invoke(join(root, 'different'), `${commit}-runtime`, root)).toThrow()
    expect(invoke(root, `${'e'.repeat(40)}-runtime`, root)).toBe('')
    expect(readFileSync(marker, 'utf8')).toBe('{}\n')
  })
})
