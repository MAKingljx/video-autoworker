// @vitest-environment node

import { createHash } from 'node:crypto'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createStandaloneVerificationBundle,
  verifyStandaloneVerificationBundle,
} from '../../scripts/check-standalone-artifact.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release verification evidence bundle', () => {
  it('binds manifest and provenance identities only after the full audit boundary', async () => {
    const container = realpathSync(mkdtempSync(join(tmpdir(), 'release-verification-bundle-')))
    roots.push(container)
    const root = join(container, 'staged')
    mkdirSync(root, { mode: 0o700 })
    const manifest = Buffer.from('{"schemaVersion":2}\n')
    const provenance = Buffer.from('{"schema":"video-autoworker-standalone-provenance/v3"}\n')
    writeFileSync(join(root, 'release-manifest.json'), manifest, { mode: 0o600 })
    writeFileSync(join(root, 'release-provenance.json'), provenance, { mode: 0o600 })
    writeFileSync(join(root, 'server.js'), 'original\n', { mode: 0o600 })
    const artifactContent = {
      schema: 'video-autoworker-standalone-artifact-content/v1',
      algorithm: 'sha256', digest: 'a'.repeat(64), directories: 1, files: 2, symlinks: 0,
    }
    const bundle = await createStandaloneVerificationBundle(
      root, { artifactContent }, { files: 2, staticImports: 1, dynamicDependencies: 0 },
      { filesScanned: 2, bytesScanned: manifest.length + provenance.length },
    )
    expect(bundle).toMatchObject({
      schema: 'video-autoworker-standalone-verification-bundle/v1',
      scope: 'post-full-audit-reference',
      fullArtifactAuditRequiredAtCopyBoundary: true,
      artifactContent,
      identities: {
        'release-manifest.json': {
          sha256: createHash('sha256').update(manifest).digest('hex'),
        },
        'release-provenance.json': {
          sha256: createHash('sha256').update(provenance).digest('hex'),
        },
      },
      bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    await expect(verifyStandaloneVerificationBundle(root, bundle)).resolves.toMatchObject({
      ok: true, mode: 'fast', bundleSha256: bundle.bundleSha256,
    })
    const published = join(container, 'published')
    renameSync(root, published)
    await expect(verifyStandaloneVerificationBundle(published, bundle)).resolves.toMatchObject({
      ok: true, mode: 'fast', bundleSha256: bundle.bundleSha256,
    })
    writeFileSync(join(published, 'server.js'), 'tampered\n', { mode: 0o600 })
    await expect(verifyStandaloneVerificationBundle(published, bundle))
      .rejects.toThrow('standalone_verification_bundle_tree_changed')

    const auditor = readFileSync(resolve('scripts/check-standalone-artifact.mjs'), 'utf8')
    const audit = auditor.slice(auditor.indexOf('export async function auditStandaloneArtifact'))
    expect(audit.indexOf('findForbiddenStandaloneMembers'))
      .toBeLessThan(audit.indexOf('createStandaloneVerificationBundle'))
    expect(audit.indexOf('verifyStandaloneReleaseManifest'))
      .toBeLessThan(audit.indexOf('createStandaloneVerificationBundle'))
    expect(audit.indexOf('scanStandaloneSensitiveContent'))
      .toBeLessThan(audit.indexOf('createStandaloneVerificationBundle'))
  })

  it('keeps CI cache identity explicit and probes the installed SQLite ABI', () => {
    const workflow = readFileSync(resolve('..', '.github/workflows/quality-gate.yml'), 'utf8')
    for (const field of ['current.os', 'current.arch', 'current.nodeAbi',
      'current.lockSha256', 'current.buildConfigSha256']) {
      expect(workflow).toContain(field)
    }
    expect(workflow).toContain('key: vaw-next-${{ steps.build-cache.outputs.key }}')
    expect(workflow).toContain("const Database = require('better-sqlite3')")
    expect(workflow).toContain("database.prepare('SELECT 1 AS ok').get()")
    expect(workflow).not.toContain('node_modules/**')
  })
})
