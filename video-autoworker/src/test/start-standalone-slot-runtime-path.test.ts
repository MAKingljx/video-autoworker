import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const sourceLauncher = resolve(process.cwd(), 'scripts/start-standalone-slot.sh')

function fixture(role: 'active' | 'drain') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `slot-path-${role}-`)))
  roots.push(root)
  const project = join(root, 'product')
  const scripts = join(project, 'scripts')
  const runDir = join(root, 'run')
  const releases = join(root, 'releases')
  const releaseId = 'release-path-test'
  const releaseRoot = join(releases, releaseId, 'standalone')
  for (const directory of [scripts, join(runDir, 'slots'), releaseRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const launcher = join(scripts, 'start-standalone-slot.sh')
  copyFileSync(sourceLauncher, launcher)
  chmodSync(launcher, 0o700)
  writeFileSync(join(scripts, 'check-standalone-artifact.mjs'), 'process.exit(0)\n', { mode: 0o600 })
  writeFileSync(join(releaseRoot, 'release-manifest.json'), '{}\n', { mode: 0o600 })
  const manifestSha256 = createHash('sha256')
    .update(readFileSync(join(releaseRoot, 'release-manifest.json'))).digest('hex')
  writeFileSync(join(runDir, 'router-state.json'), '{}\n', { mode: 0o600 })
  writeFileSync(join(runDir, 'slots', 'blue.json'), `${JSON.stringify({
    schema: 'video-autoworker-standalone-slot/v1',
    slot: 'blue', releaseId, releaseRoot, manifestSha256, host: '127.0.0.1', port: 3317,
  })}\n`, { mode: 0o600 })
  const environment = { ...process.env,
    AIWORKER_BG_RUN_DIR: runDir,
    AIWORKER_BG_RELEASES_DIR: releases,
    AIWORKER_BG_ROUTER_STATE: join(runDir, 'router-state.json'),
    AIWORKER_PLATFORM_ENV_FILE: join(root, 'missing-platform.env'),
    NODE_BIN: process.execPath,
  } as NodeJS.ProcessEnv
  for (const key of [
    'MISSION_CONTROL_DATA_DIR', 'MISSION_CONTROL_DB_PATH', 'MISSION_CONTROL_TOKENS_PATH',
  ]) delete environment[key]
  return { root, project, launcher, role, environment }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('standalone slot external runtime paths', () => {
  it.each(['active', 'drain'] as const)(
    'rejects %s before creating a checkout-local fallback database',
    role => {
      const value = fixture(role)
      const result = spawnSync('/bin/bash', [value.launcher, 'blue', role], {
        encoding: 'utf8', env: value.environment,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        `managed ${role} runtime requires explicit MISSION_CONTROL_DATA_DIR`,
      )
      expect(existsSync(join(value.project, '.data'))).toBe(false)
    },
  )

  it('executes the current launcher source rather than a rewritten fixture', () => {
    const value = fixture('active')
    expect(execFileSync('/usr/bin/shasum', ['-a', '256', value.launcher], { encoding: 'utf8' })
      .split(/\s/u)[0]).toBe(execFileSync('/usr/bin/shasum', [
      '-a', '256', sourceLauncher,
    ], { encoding: 'utf8' }).split(/\s/u)[0])
    expect(dirname(value.launcher)).toBe(join(value.project, 'scripts'))
  })
})
