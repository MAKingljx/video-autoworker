import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  scanReleaseFile,
  scanSourceSensitiveContent,
  scanStandaloneSensitiveContent,
} from '../../../scripts/check-sensitive-content.mjs'
import {
  scanHighConfidenceSensitiveValues,
  scanSensitiveValues,
} from '../../../scripts/lib/sensitive-value-scanner.mjs'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function write(root: string, member: string, value: string | Buffer): void {
  const pathname = join(root, member)
  mkdirSync(dirname(pathname), { recursive: true })
  writeFileSync(pathname, value)
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function writeManifest(root: string, files: string[]): void {
  write(root, 'release-manifest.json', `${JSON.stringify({
    schemaVersion: 2,
    files: files.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
  })}\n`)
}

describe('release sensitive-content scanner', () => {
  it('preserves broad runtime assignment detection while release raw scanning stays precise', () => {
    const assignment = ['api_key', '=', 'assigned-secret-value'].join('')
    expect(scanSensitiveValues(assignment).some(item => item.type === 'credential_assignment'))
      .toBe(true)
    expect(scanHighConfidenceSensitiveValues(assignment)).toEqual([])
  })

  it('ignores types and credential references but rejects a hard-coded sensitive literal', () => {
    const safe = [
      'type Input = { token: string }',
      'const token = process.env.API_TOKEN',
      'const ref = { apiKey: secretRef }',
      'const dynamic = { authorization: `Bearer ${credential}` }',
    ].join('\n')
    expect(scanReleaseFile('src/safe.ts', safe)).toEqual([])

    const unsafe = "export const config = { apiKey: 'generic-release-secret' }"
    expect(scanReleaseFile('src/unsafe.ts', unsafe)).toMatchObject([
      { path: 'src/unsafe.ts', type: 'hardcoded_credential', severity: 'critical' },
    ])
  })

  it('recognizes explicit sensitive suffixes without treating every key suffix as a credential', () => {
    const unsafe = [
      "const CONTROL_TOKEN = 'generic-control-secret'",
      "const OPENAI_API_KEY = 'generic-openai-secret'",
      "const config = { adminPassword: 'generic-admin-secret' }",
      "const model = { modelApiKey: 'generic-model-secret' }",
      "const identity = { idToken: 'generic-identity-secret' }",
    ].join('\n')
    expect(scanReleaseFile('src/config.ts', unsafe)).toHaveLength(5)

    const safe = "const labels = { monkey: 'ordinary-value', publicKey: 'ordinary-value' }"
    expect(scanReleaseFile('src/labels.ts', safe)).toEqual([])
    expect(scanReleaseFile('.github/workflows/publish.yml', 'id-token: write\n')).toEqual([])
  })

  it('detects alphabetic credentials in generated first-party chunks but ignores header aliases', () => {
    const generated = [
      "const config={password:'SuperSecret'}",
      "const identity={controlToken:'abcdefghijklmnop'}",
    ].join('\n')
    expect(scanReleaseFile('.next/server/chunks/src_app_runtime.js', generated, {
      requireOpaqueCredential: true,
      useTypescript: false,
    })).toHaveLength(2)

    const alias = "const names={'x-scalar-secret-client-secret':'clientSecret'}"
    expect(scanReleaseFile('.next/static/chunks/docs.js', alias, {
      requireOpaqueCredential: true,
      useTypescript: false,
    })).toEqual([])
  })

  it('limits synthetic placeholder exemptions to explicit source-test scans', () => {
    const fixture = "export const config = { apiKey: 'must-not-persist-fixture' }"
    expect(scanReleaseFile('tests/fixture.test.ts', fixture, {
      allowTestPlaceholders: true,
    })).toEqual([])
    expect(scanReleaseFile('tests/fixture.test.ts', fixture)).toMatchObject([
      { type: 'hardcoded_credential' },
    ])
  })

  it('binds source commit scans to Git blobs instead of a dirty worktree', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-source-git-')))
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Sensitive Scan Test')
    git(root, 'config', 'user.email', 'sensitive-scan@example.invalid')
    git(root, 'config', 'commit.gpgSign', 'false')
    write(root, 'src/config.ts', 'export const token = process.env.API_TOKEN\n')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'safe source')
    const commit = git(root, 'rev-parse', 'HEAD')

    write(root, 'src/config.ts', "export const apiKey = 'dirty-hardcoded-value'\n")
    expect(scanSourceSensitiveContent({ repositoryRoot: root, commit })).toMatchObject({
      ok: true,
      mode: 'source-commit',
      commit,
    })
    expect(() => scanSourceSensitiveContent({ repositoryRoot: root }))
      .toThrow('sensitive_content_detected')
  })

  it('allows only exact, counted test fingerprints and rejects stale allowances', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-source-allowlist-')))
    git(root, 'init', '-b', 'main')
    const token = ['ghp', '_', 'Z'.repeat(36)].join('')
    const fixture = `export const fixture = ${JSON.stringify(token)}\n`
    write(root, 'tests/detector.test.ts', fixture)
    write(root, 'scripts/allowlist.json', `${JSON.stringify({
      schema: 'video-autoworker-sensitive-content-source-allowlist/v1',
      entries: [{
        path: 'tests/detector.test.ts',
        type: 'github_token',
        fingerprint: sha256(token),
        occurrences: 1,
        reason: 'Synthetic detector fixture',
      }],
    })}\n`)

    expect(scanSourceSensitiveContent({
      repositoryRoot: root,
      allowlistPath: 'scripts/allowlist.json',
    })).toMatchObject({ ok: true, allowlistEntries: 1 })

    write(root, 'tests/detector.test.ts', fixture + fixture)
    expect(() => scanSourceSensitiveContent({
      repositoryRoot: root,
      allowlistPath: 'scripts/allowlist.json',
    })).toThrow('sensitive_scan_allowlist_stale')
  })

  it('scans the exact standalone manifest without applying source-test exemptions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-standalone-')))
    write(root, 'scripts/runtime.js', 'export const token = process.env.RUNTIME_TOKEN\n')
    writeManifest(root, ['scripts/runtime.js'])
    expect(scanStandaloneSensitiveContent(root)).toMatchObject({
      ok: true,
      mode: 'standalone',
      filesScanned: 2,
    })

    const secret = 'must-not-persist-fixture'
    write(root, 'scripts/runtime.js', `export const apiKey = ${JSON.stringify(secret)}\n`)
    writeManifest(root, ['scripts/runtime.js'])
    try {
      scanStandaloneSensitiveContent(root)
      throw new Error('expected sensitive scan to fail')
    } catch (error) {
      const report = (error as Error & { report?: unknown }).report
      expect(report).toMatchObject({
        ok: false,
        findings: [{ path: 'scripts/runtime.js', type: 'hardcoded_credential' }],
      })
      expect(JSON.stringify(report)).not.toContain(secret)
      expect(JSON.stringify(report)).not.toContain('fingerprint')
    }
  })

  it('accepts a physical artifact below an aliased ancestor but rejects a symlink root', () => {
    const container = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-root-boundary-')))
    try {
      const physicalParent = join(container, 'physical')
      const aliasedParent = join(container, 'aliased')
      const physicalRoot = join(physicalParent, 'artifact')
      mkdirSync(physicalParent)
      symlinkSync(physicalParent, aliasedParent, 'dir')
      write(physicalRoot, 'scripts/runtime.js', 'export const token = process.env.RUNTIME_TOKEN\n')
      writeManifest(physicalRoot, ['scripts/runtime.js'])

      expect(scanStandaloneSensitiveContent(join(aliasedParent, 'artifact')))
        .toMatchObject({ ok: true, mode: 'standalone' })

      const rootLink = join(container, 'artifact-link')
      symlinkSync(physicalRoot, rootLink, 'dir')
      expect(() => scanStandaloneSensitiveContent(rootLink))
        .toThrow('sensitive_standalone_root_unsafe')
    } finally {
      rmSync(container, { recursive: true, force: true })
    }
  })

  it('contextually scans first-party Next output while excluding identified generated vendor data', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-standalone-next-')))
    const firstPartyMembers = [
      '.next/server/app/api/example/route.js',
      '.next/server/chunks/src_app_api_example_route.js',
      '.next/static/chunks/0123456789abcdef.js',
    ]
    for (const member of firstPartyMembers) {
      write(root, member, "const config={modelApiKey:'generic-release-secret'}\n")
    }
    write(
      root,
      '.next/server/chunks/ssr/node_modules__pnpm_vendor.js',
      "const config={modelApiKey:'generic-release-secret'}\n",
    )
    write(
      root,
      '.next/server/chunks/a191e_next_dist_runtime.js',
      "const config={modelApiKey:'generic-release-secret'}\n",
    )
    write(
      root,
      '.next/server/chunks/ssr/messages_en_json_fixture.js',
      "const messages={modelApiKey:'Use your project API key here'}\n",
    )
    writeManifest(root, [
      ...firstPartyMembers,
      '.next/server/chunks/ssr/node_modules__pnpm_vendor.js',
      '.next/server/chunks/a191e_next_dist_runtime.js',
      '.next/server/chunks/ssr/messages_en_json_fixture.js',
    ])

    try {
      scanStandaloneSensitiveContent(root)
      throw new Error('expected sensitive scan to fail')
    } catch (error) {
      const report = (error as Error & { report?: { findings?: Array<{ path: string }> } }).report
      expect(report?.findings?.map(item => item.path)).toEqual(firstPartyMembers)
    }
  })

  it('finds a high-confidence token embedded in a binary manifest member', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-binary-')))
    const token = ['github', '_pat_', 'B'.repeat(24)].join('')
    write(root, 'public/blob.bin', Buffer.concat([
      Buffer.from([0, 1, 2, 3]),
      Buffer.from(token),
      Buffer.from([0, 4, 5]),
    ]))
    writeManifest(root, ['public/blob.bin'])
    expect(() => scanStandaloneSensitiveContent(root)).toThrow('sensitive_content_detected')
  })
})
