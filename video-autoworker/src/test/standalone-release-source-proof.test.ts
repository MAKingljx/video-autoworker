// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertRepositoryRelease, verifyDirectorExtractionReleaseProvenance,
} from '../../scripts/lib/standalone-release-source-proof.mjs'
import {
  assertRepositoryRelease as readinessRepositoryProof,
  verifyDirectorExtractionReleaseProvenance as readinessArtifactProof,
} from '../../scripts/verify-director-video-release-readiness.mjs'
import {
  createStandaloneBuildSourceAnchor, sourceClosure,
} from '../../scripts/lib/director-extraction-release-provenance.mjs'

const product = realpathSync(process.cwd())
describe('standalone source proof dependency boundary', () => {
  it('keeps readiness exports on the same shared proof implementation', () => {
    expect(readinessRepositoryProof).toBe(assertRepositoryRelease)
    expect(readinessArtifactProof).toBe(verifyDirectorExtractionReleaseProvenance)
  })

  it('derives the actual build-start closure without importing runtime upgrade operations', () => {
    const closure = sourceClosure(product)
    const files = closure.files.map((entry: { path: string }) => entry.path)
    expect(files).toContain('scripts/check-standalone-artifact.mjs')
    expect(files).toContain('scripts/lib/standalone-release-source-proof.mjs')
    expect(files).not.toContain('scripts/verify-director-video-release-readiness.mjs')
    expect(files).not.toContain('scripts/lib/openclaw-canonical-tool-upgrade.mjs')
    expect(files).not.toContain('scripts/lib/openclaw-runtime-convergence.mjs')
    const anchor = createStandaloneBuildSourceAnchor(product, { allowDirty: true })
    expect(anchor.schema).toBe('video-autoworker-standalone-build-source-anchor/v1')
    expect(anchor.sourceClosure).toEqual(closure)
    expect(readFileSync(join(product, 'next.config.js'), 'utf8'))
      .toContain("'./scripts/lib/standalone-release-source-proof.mjs'")
  })

  it('keeps unknown dynamic loaders rejected instead of widening the trace allowlist', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-dynamic-loader-')))
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src/entry.mjs'), 'export const load = target => import(target)\n')
      expect(() => sourceClosure(root, ['src/entry.mjs']))
        .toThrow('director_extraction_source_dynamic_dependency_unresolved:src/entry.mjs')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
