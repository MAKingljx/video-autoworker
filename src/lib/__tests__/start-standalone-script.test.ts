import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const launcherPath = resolve(process.cwd(), 'scripts/start-standalone.sh')
const artifactCheckerPath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')

type LauncherFixture = {
  projectRoot: string
  standaloneRoot: string
  resultPath: string
}

function createLauncherFixture(): LauncherFixture {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aiworker-standalone-launcher-')))
  const standaloneRoot = join(projectRoot, '.next', 'standalone')
  const resultPath = join(projectRoot, 'launch-result.json')

  mkdirSync(join(projectRoot, 'scripts'), { recursive: true })
  mkdirSync(join(standaloneRoot, '.next', 'static'), { recursive: true })
  mkdirSync(join(standaloneRoot, 'public'), { recursive: true })
  mkdirSync(join(standaloneRoot, 'messages'), { recursive: true })
  mkdirSync(join(standaloneRoot, 'runtime'), { recursive: true })
  copyFileSync(launcherPath, join(projectRoot, 'scripts', 'start-standalone.sh'))
  copyFileSync(artifactCheckerPath, join(projectRoot, 'scripts', 'check-standalone-artifact.mjs'))
  writeFileSync(join(projectRoot, 'package.json'), '{}\n')
  writeFileSync(join(standaloneRoot, 'package.json'), '{}\n')
  writeFileSync(join(standaloneRoot, '.next', 'BUILD_ID'), 'fixture-build\n')
  writeFileSync(join(standaloneRoot, '.next', 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(join(standaloneRoot, '.next', 'required-server-files.json'), JSON.stringify({
    version: 1,
    config: {},
    appDir: '.',
    relativeAppDir: '',
    files: [],
    ignore: [],
  }))
  writeFileSync(join(standaloneRoot, '.next', 'static', 'runtime.css'), 'body {}\n')
  writeFileSync(join(standaloneRoot, 'public', 'favicon.ico'), 'fixture\n')
  writeFileSync(join(standaloneRoot, 'messages', 'zh-CN.json'), '{}\n')
  writeFileSync(join(standaloneRoot, 'runtime', 'schema.sql'), 'SELECT 1;\n')
  const requiredRuntimeFiles: Record<string, string> = {
    '.next/server/app.js': 'module.exports = {}\n',
    'node_modules/.pnpm/store-version': 'fixture\n',
    'openapi.json': '{}\n',
    'openclaw-plugins/aiworker-director-brain/index.js': 'export default {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/director-brain-tool.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/openclaw.plugin.json': '{}\n',
    'openclaw-plugins/aiworker-director-brain/package.json': '{}\n',
    'openclaw-skills/aiworker-director-brain/SKILL.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/SKILL.md': 'runtime\n',
    'ops/feishu-director-brain/schema.json': '{}\n',
    'scripts/feishu-director-brain.mjs': 'export {}\n',
    'scripts/install-aiworker-director-brain.sh': '#!/bin/sh\n',
    'scripts/lib/feishu-director-brain.mjs': 'export {}\n',
  }
  for (const [member, content] of Object.entries(requiredRuntimeFiles)) {
    const pathname = join(standaloneRoot, member)
    mkdirSync(dirname(pathname), { recursive: true })
    writeFileSync(pathname, content)
  }
  writeFileSync(join(standaloneRoot, 'server.js'), `const nextConfig = {}

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)
require('node:fs').writeFileSync(process.env.LAUNCH_RESULT_PATH, JSON.stringify({
  cwd: process.cwd(),
  dataDir: process.env.MISSION_CONTROL_DATA_DIR,
  dbPath: process.env.MISSION_CONTROL_DB_PATH,
  tokensPath: process.env.MISSION_CONTROL_TOKENS_PATH,
  pidFile: process.env.PID_FILE,
}))
`)

  const manifestResult = spawnSync(
    process.execPath,
    [join(projectRoot, 'scripts', 'check-standalone-artifact.mjs'), '--write-manifest', standaloneRoot],
    { encoding: 'utf8' },
  )
  if (manifestResult.status !== 0) {
    throw new Error(`fixture manifest failed: ${manifestResult.stderr}`)
  }

  return { projectRoot, standaloneRoot, resultPath }
}

function runLauncher(fixture: LauncherFixture, overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_BIN: process.execPath,
    AIWORKER_SOURCE_APP_DIR: fixture.projectRoot,
    AIWORKER_PLATFORM_ENV_FILE: join(fixture.projectRoot, 'missing-platform.env'),
    LAUNCH_RESULT_PATH: fixture.resultPath,
    MISSION_CONTROL_DATA_DIR: join(fixture.projectRoot, '.data'),
    MISSION_CONTROL_DB_PATH: join(fixture.projectRoot, '.data', 'mission-control.db'),
    MISSION_CONTROL_TOKENS_PATH: join(fixture.projectRoot, '.data', 'mission-control-tokens.json'),
    PID_FILE: join(fixture.projectRoot, '.run', 'standalone.pid'),
    ...overrides,
  }

  return spawnSync('bash', [join(fixture.projectRoot, 'scripts', 'start-standalone.sh')], {
    cwd: fixture.projectRoot,
    env,
    encoding: 'utf8',
  })
}

describe('standalone runtime launcher', () => {
  it('uses the local OpenClaw binary on the managed production host', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/start-standalone.sh'), 'utf8')

    expect(script).toContain('configure_openclaw_profile_target()')
    expect(script).toContain('MC_OPENCLAW_PROFILE_TARGET="local"')
    expect(script).toContain('OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/ai-worker/bin/openclaw}"')
    expect(script.indexOf('load_runtime_env\n\n')).toBeLessThan(script.indexOf('configure_openclaw_profile_target()'))
    expect(script).toContain('configure_openclaw_profile_target\n\nfind_standalone_server')
  })

  it('loads the canonical external platform environment after checkout-local files', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/start-standalone.sh'), 'utf8')

    expect(script).toContain('PLATFORM_ENV_FILE="${AIWORKER_PLATFORM_ENV_FILE:-$HOME/.config/video-autoworker/platform.env}"')
    expect(script).toContain('find_source_project_root()')
    expect(script).toContain('拒绝加载不安全的平台环境文件')
    expect(script.indexOf('load_runtime_env_file "$SOURCE_PROJECT_ROOT/.env.local"'))
      .toBeLessThan(script.indexOf('load_runtime_env_file "$PLATFORM_ENV_FILE"'))
  })

  it('starts an already complete immutable artifact without copying assets at runtime', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/start-standalone.sh'), 'utf8')

    expect(script).toContain('immutable standalone artifact is missing required')
    expect(script).toContain('"$STANDALONE_STATIC_DIR"')
    expect(script).toContain('"$STANDALONE_PUBLIC_DIR"')
    expect(script).not.toContain('rm -rf "$STANDALONE_STATIC_DIR"')
    expect(script).not.toContain('cp -R "$SOURCE_STATIC_DIR"')
    expect(script).not.toContain('cp -R "$SOURCE_PUBLIC_DIR"')
    expect(script).toContain('"$ARTIFACT_AUDIT_SCRIPT" "$STANDALONE_DIR"')
  })

  it('refuses a complete-looking artifact whose release manifest no longer matches', () => {
    const fixture = createLauncherFixture()
    try {
      writeFileSync(join(fixture.standaloneRoot, '.next', 'static', 'runtime.css'), 'tampered {}\n')
      const result = runLauncher(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('standalone_release_manifest_mismatch')
      expect(result.stderr).toContain('standalone artifact integrity verification failed')
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('defaults runtime state to source-root .data and .run directories', () => {
    const fixture = createLauncherFixture()
    try {
      const result = runLauncher(fixture, {
        MISSION_CONTROL_DATA_DIR: undefined,
        MISSION_CONTROL_DB_PATH: undefined,
        MISSION_CONTROL_TOKENS_PATH: undefined,
        PID_FILE: undefined,
      })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(readFileSync(fixture.resultPath, 'utf8'))).toEqual({
        cwd: fixture.standaloneRoot,
        dataDir: join(fixture.projectRoot, '.data'),
        dbPath: join(fixture.projectRoot, '.data', 'mission-control.db'),
        tokensPath: join(fixture.projectRoot, '.data', 'mission-control-tokens.json'),
        pidFile: join(fixture.projectRoot, '.run', 'standalone.pid'),
      })
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it.each([
    'MISSION_CONTROL_DATA_DIR',
    'MISSION_CONTROL_DB_PATH',
    'MISSION_CONTROL_TOKENS_PATH',
    'PID_FILE',
  ])('rejects a relative %s', (variable) => {
    const fixture = createLauncherFixture()
    try {
      const result = runLauncher(fixture, { [variable]: 'relative/runtime-path' })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`${variable} must be an absolute path`)
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it.each([
    'MISSION_CONTROL_DATA_DIR',
    'MISSION_CONTROL_DB_PATH',
    'MISSION_CONTROL_TOKENS_PATH',
    'PID_FILE',
  ])('rejects %s when an external symlink resolves inside the release', (variable) => {
    const fixture = createLauncherFixture()
    try {
      const releaseTarget = variable === 'MISSION_CONTROL_DATA_DIR'
        ? join(fixture.standaloneRoot, 'runtime')
        : join(fixture.standaloneRoot, 'runtime', 'schema.sql')
      const externalLink = join(fixture.projectRoot, `external-${variable.toLowerCase()}`)
      symlinkSync(releaseTarget, externalLink)

      const result = runLauncher(fixture, { [variable]: externalLink })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`${variable} must be outside the physical standalone root`)
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ['server.js', 'file'],
    ['.next/BUILD_ID', 'file'],
    ['.next/static', 'directory'],
    ['public', 'directory'],
    ['messages', 'directory'],
    ['runtime/schema.sql', 'file'],
    ['package.json', 'file'],
  ] as const)('refuses an artifact missing required %s', (relativePath, kind) => {
    const fixture = createLauncherFixture()
    try {
      rmSync(join(fixture.standaloneRoot, relativePath), { recursive: true, force: true })
      const result = runLauncher(fixture)

      expect(result.status).toBe(1)
      if (relativePath === 'server.js') {
        expect(result.stderr).toContain('standalone server missing')
      } else {
        expect(result.stderr).toContain(`missing required ${kind}`)
        expect(result.stderr).toContain(relativePath)
      }
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })
})
