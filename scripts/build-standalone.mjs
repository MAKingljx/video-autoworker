#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditStandaloneArtifact,
  sanitizeStandaloneArtifact,
} from './check-standalone-artifact.mjs'
import { createStandaloneBuildSourceAnchor } from './lib/director-extraction-release-provenance.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const standaloneRoot = resolve(repositoryRoot, '.next', 'standalone')
const moduleRequire = createRequire(import.meta.url)

export async function buildStandalone() {
  // Dirty local builds remain available for development and are attested as
  // ineligible for release. Only a clean build-start anchor can pass readiness.
  const buildSourceAnchor = createStandaloneBuildSourceAnchor(repositoryRoot, { allowDirty: true })
  const nextCli = moduleRequire.resolve('next/dist/bin/next')
  execFileSync(process.execPath, [nextCli, 'build'], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })
  const sanitized = await sanitizeStandaloneArtifact(standaloneRoot, { buildSourceAnchor })
  const audited = await auditStandaloneArtifact(standaloneRoot)
  return { sanitized, audited }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildStandalone()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
