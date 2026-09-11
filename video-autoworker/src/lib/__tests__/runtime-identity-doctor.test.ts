import { createHash } from 'node:crypto'
import {
  chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectRuntimeIdentityDoctor } from '../../../scripts/runtime-identity-doctor.mjs'

const roots: string[] = []
const sha = (value: string) => value.repeat(64)

function privateFile(pathname: string, contents: string) {
  mkdirSync(join(pathname, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(pathname, contents, { mode: 0o600 })
  chmodSync(pathname, 0o600)
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-doctor-')))
  roots.push(root)
  const runDir = join(root, 'run')
  const slots = join(runDir, 'slots')
  const releaseRoot = join(root, 'releases', 'release-a', 'standalone')
  const database = join(root, 'data', 'mission-control.db')
  const platform = join(root, 'platform.env')
  mkdirSync(slots, { recursive: true, mode: 0o700 })
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
  privateFile(database, 'sqlite-fixture')
  privateFile(platform, `MISSION_CONTROL_DB_PATH=${database}\n`)
  privateFile(join(runDir, 'router-state.json'), `${JSON.stringify({
    schema: 'video-autoworker-standalone-router/v1', active: 'blue', previous: 'green',
    generation: 7, slots: { blue: { releaseId: 'release-a' }, green: { releaseId: 'release-b' } },
  })}\n`)
  privateFile(join(slots, 'blue.json'), `${JSON.stringify({
    schema: 'video-autoworker-standalone-slot/v1', slot: 'blue', releaseId: 'release-a',
    releaseRoot, manifestSha256: sha('a'), host: '127.0.0.1', port: 3317,
  })}\n`)
  privateFile(join(slots, 'blue.runtime.json'), `${JSON.stringify({
    schema: 'video-autoworker-standalone-runtime/v1', pid: process.pid, slot: 'blue',
    role: 'active', releaseId: 'release-a', manifestSha256: sha('a'), dbPath: database,
  })}\n`)
  return { root, runDir, releaseRoot, database, platform,
    configSha256: createHash('sha256').update(
      `MISSION_CONTROL_DB_PATH=${database}\n`,
    ).digest('hex') }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('runtime identity doctor', () => {
  it('reports aligned safe identities without exposing paths or mutating files', () => {
    const value = fixture()
    const report = inspectRuntimeIdentityDoctor({
      runDir: value.runDir,
      slot: 'blue',
      platformEnvPath: value.platform,
      expectedConfigSha256: value.configSha256,
    }, {
      processCwd: () => value.releaseRoot,
      processHasOpenFile: () => true,
      nowSeconds: () => 100,
    })
    expect(report).toMatchObject({
      status: 'aligned', mutationPerformed: false,
      router: { active: true, releaseAligned: true },
      process: { alive: true, authoritativeDatabaseOpen: true },
    })
    expect(JSON.stringify(report)).not.toContain(value.root)
  })

  it('reports config, cwd, database, router, and open-file drift using safe fields', () => {
    const value = fixture()
    const otherRelease = join(value.root, 'releases', 'release-b', 'standalone')
    const otherDatabase = join(value.root, 'data', 'other.db')
    mkdirSync(otherRelease, { recursive: true, mode: 0o700 })
    privateFile(otherDatabase, 'other-sqlite')
    privateFile(join(value.runDir, 'slots', 'blue.runtime.json'), `${JSON.stringify({
      schema: 'video-autoworker-standalone-runtime/v1', pid: process.pid, slot: 'blue',
      role: 'drain', releaseId: 'release-b', manifestSha256: sha('b'), dbPath: otherDatabase,
    })}\n`)
    const report = inspectRuntimeIdentityDoctor({
      runDir: value.runDir,
      slot: 'blue',
      platformEnvPath: value.platform,
      expectedConfigSha256: sha('c'),
    }, {
      processCwd: () => otherRelease,
      processHasOpenFile: () => false,
      nowSeconds: () => 100,
    })
    expect(report.status).toBe('drifted')
    expect(report.drift.map((item: { field: string }) => item.field)).toEqual([
      'releaseId', 'manifestSha256', 'configSha256', 'cwdIdentitySha256',
      'database.pathIdentitySha256', 'database.ino',
    ])
    expect(report.router.releaseAligned).toBe(false)
    expect(report.process.authoritativeDatabaseOpen).toBe(false)
    expect(JSON.stringify(report)).not.toContain(value.root)
  })
})
