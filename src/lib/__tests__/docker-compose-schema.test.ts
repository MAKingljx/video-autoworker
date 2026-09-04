import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Tests that docker-compose.yml and Dockerfile contain the expected
 * configuration for Compose v5+ compatibility and complete runtime assets.
 */

const ROOT = resolve(__dirname, '../../..')

describe('docker-compose.yml schema', () => {
  const content = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf-8')

  it('uses deploy.resources.limits.pids (not service-level pids_limit)', () => {
    // pids limit must be inside deploy.resources.limits for Compose v5+ compatibility.
    // Service-level pids_limit causes "can't set distinct values" errors on some versions.
    expect(content).not.toContain('pids_limit:')

    const deployBlock = content.match(/deploy:[\s\S]*?(?=\n\s{4}\w|\nvolumes:|\nnetworks:)/)?.[0] ?? ''
    expect(deployBlock).toContain('pids:')
  })

  it('still has memory and cpus in deploy.resources.limits', () => {
    expect(content).toContain('memory:')
    expect(content).toContain('cpus:')
  })
})

describe('Dockerfile runtime stage', () => {
  const content = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf-8')
  const entrypoint = readFileSync(resolve(ROOT, 'docker-entrypoint.sh'), 'utf-8')
  const artifactAuditor = readFileSync(
    resolve(ROOT, 'scripts/check-standalone-artifact.mjs'),
    'utf-8',
  )

  it('copies the complete audited standalone tree into one release root', () => {
    expect(content).toContain('COPY --from=build /app/.next/standalone ./release')
    expect(content).not.toContain('COPY --from=build /app/public ./public')
    expect(content).not.toContain('COPY --from=build /app/.next/static ./.next/static')
  })

  it('audits and starts the server from the immutable release root', () => {
    expect(entrypoint).toContain('node "$AUDITOR" /app/release')
    expect(entrypoint).toContain('cd /app/release')
    expect(entrypoint).toContain('exec node server.js')
  })

  it('keeps public and static assets inside the audited release', () => {
    expect(content).toContain('/app/release/public/')
    expect(artifactAuditor).toContain("'.next/static'")
    expect(artifactAuditor).toContain("'public'")
  })

  it('requires the runtime schema inside the audited release', () => {
    expect(content).toContain('/app/release/runtime/')
    expect(artifactAuditor).toContain("'runtime/schema.sql'")
  })
})

describe('.dockerignore release boundary', () => {
  const content = readFileSync(resolve(ROOT, '.dockerignore'), 'utf-8')
  const patterns = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )

  it.each([
    '.canary-results',
    '**/.canary-results',
    '.tmp',
    '**/.tmp',
    'test-results',
    '**/test-results',
    'backups',
    '**/backups',
    '*.db',
    '**/*.db',
    '*.db-wal',
    '**/*.db-wal',
    '*.db-shm',
    '**/*.db-shm',
    '*.sqlite',
    '**/*.sqlite',
    '*.sqlite-wal',
    '**/*.sqlite-wal',
    '*.sqlite-shm',
    '**/*.sqlite-shm',
    '*.sqlite3',
    '**/*.sqlite3',
    '*.log',
    '**/*.log',
    '*.pid',
    '**/*.pid',
  ])('excludes release-unsafe runtime artifact pattern %s', (pattern) => {
    expect(patterns).toContain(pattern)
  })

  it('does not broadly exclude source, operations, or documentation', () => {
    expect(patterns).not.toContain('scripts')
    expect(patterns).not.toContain('**/scripts')
    expect(patterns).not.toContain('ops')
    expect(patterns).not.toContain('**/ops')
    expect(patterns).not.toContain('*.md')
    expect(patterns).not.toContain('**/*.md')
  })
})
