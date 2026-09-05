import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const launcherPath = resolve(process.cwd(), 'scripts/start-standalone.sh')
const artifactCheckerPath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
const sensitiveContentCheckerPath = resolve(process.cwd(), 'scripts/check-sensitive-content.mjs')
const sensitiveValueScannerPath = resolve(
  process.cwd(),
  'scripts/lib/sensitive-value-scanner.mjs',
)
const artifactProvenancePath = resolve(
  process.cwd(),
  'scripts/lib/director-extraction-release-provenance.mjs',
)

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
  mkdirSync(join(projectRoot, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(standaloneRoot, '.next', 'static'), { recursive: true })
  mkdirSync(join(standaloneRoot, 'public'), { recursive: true })
  mkdirSync(join(standaloneRoot, 'messages'), { recursive: true })
  mkdirSync(join(standaloneRoot, 'runtime'), { recursive: true })
  copyFileSync(launcherPath, join(projectRoot, 'scripts', 'start-standalone.sh'))
  copyFileSync(artifactCheckerPath, join(projectRoot, 'scripts', 'check-standalone-artifact.mjs'))
  copyFileSync(
    sensitiveContentCheckerPath,
    join(projectRoot, 'scripts', 'check-sensitive-content.mjs'),
  )
  copyFileSync(
    sensitiveValueScannerPath,
    join(projectRoot, 'scripts', 'lib', 'sensitive-value-scanner.mjs'),
  )
  copyFileSync(
    artifactProvenancePath,
    join(projectRoot, 'scripts', 'lib', 'director-extraction-release-provenance.mjs'),
  )
  writeFileSync(
    join(projectRoot, 'scripts', 'write-fixture-attestations.mjs'),
    `import { writeStandaloneReleaseAttestations } from './check-standalone-artifact.mjs'\nawait writeStandaloneReleaseAttestations(process.argv[2])\n`,
  )
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
    'openclaw-plugins/aiworker-director-brain/lib/director-context-summary.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/director-system-question-router.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/transcript-tool-result-projection.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/openclaw.plugin.json': '{}\n',
    'openclaw-plugins/aiworker-director-brain/package.json': '{}\n',
    'openclaw-plugins/aiworker-video-command/index.js': 'export default {}\n',
    'openclaw-plugins/aiworker-video-command/lib/director-work-policy.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/dispatch-identity.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/duplicate-confirmation-store.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/json-command.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/qwen-before-dispatch.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/qwen-video-classifier.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/scheduler-runner.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/stable-message-key.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/task-chain-tool.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/video-path-policy.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/openclaw.plugin.json': '{}\n',
    'openclaw-plugins/aiworker-video-command/package.json': '{}\n',
    'openclaw-plugins/aiworker-video-command/scripts/validate-runtime-inspection.mjs': 'export {}\n',
    'openclaw-skills/aiworker-director-brain/SKILL.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/SKILL.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/lib/director-brain-evidence.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/director-work-policy.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/media-ingest.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/media-policy.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/platform-client.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/task-status-authority.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/video-result-page.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/video-task.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/worker-launch-authorization.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/scripts/project-director-evidence.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs': 'export {}\n',
    'ops/feishu-director-brain/schema.json': '{}\n',
    'ops/openclaw/qwen-current-runtime-convergence.manifest.json': '{}\n',
    'scripts/apply-openclaw-runtime-convergence.sh': '#!/bin/sh\n',
    'scripts/feishu-director-brain.mjs': 'export {}\n',
    'scripts/install-aiworker-task-flow-skill.sh': '#!/bin/sh\n',
    'scripts/install-aiworker-video-command-plugin.sh': '#!/bin/sh\n',
    'scripts/install-aiworker-director-brain.sh': '#!/bin/sh\n',
    'scripts/check-standalone-artifact.mjs': 'export {}\n',
    'scripts/check-sensitive-content.mjs': 'export {}\n',
    'scripts/verify-director-video-release-readiness.mjs': 'export {}\n',
    'scripts/verify-shared-runtime-install-gate.mjs': 'export {}\n',
    'scripts/legacy-preinstall-orchestrator.mjs': 'export {}\n',
    'scripts/legacy-preinstall-controller.mjs': 'export {}\n',
    'scripts/legacy-bootstrap-controller.mjs': 'export {}\n',
    'scripts/generate-legacy-freeze-evidence.mjs': 'export {}\n',
    'scripts/generate-legacy-bootstrap-rollback-proof.mjs': 'export {}\n',
    'scripts/legacy-freeze-guard.mjs': 'export {}\n',
    'scripts/n8n-workflow-transition-anchor.mjs': 'export {}\n',
    'scripts/verify-n8n-blue-green-workflows.mjs': 'export {}\n',
    'scripts/lib/feishu-director-brain.mjs': 'export {}\n',
    'scripts/lib/runtime-safe-offline-queue.mjs': 'export {}\n',
    'scripts/lib/openclaw-secret-reference.mjs': 'export {}\n',
    'scripts/lib/openclaw-private-gateway-rpc.mjs': 'export {}\n',
    'scripts/lib/openclaw-runtime-convergence.mjs': 'export {}\n',
    'scripts/lib/openclaw-tool-capability-fingerprint.mjs': 'export {}\n',
    'scripts/lib/render-managed-markdown-section.mjs': 'export {}\n',
    'scripts/lib/runtime-tree-manifest.mjs': 'export {}\n',
    'scripts/lib/director-extraction-release-provenance.mjs': 'export {}\n',
    'scripts/lib/sensitive-value-scanner.mjs': 'export {}\n',
    'scripts/lib/shared-deployment-lock.mjs': 'export {}\n',
    'scripts/lib/shared-deployment-lock.sh': '#!/bin/sh\n',
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
  profilesNoAuth: process.env.MC_OPENCLAW_PROFILES_NO_AUTH,
}))
`)

  const manifestResult = spawnSync(
    process.execPath,
    [join(projectRoot, 'scripts', 'write-fixture-attestations.mjs'), standaloneRoot],
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
  it('requires every runtime file consumed by the three OpenClaw installers', async () => {
    const repositoryRoot = process.cwd()
    const walk = (relativeRoot: string): string[] => {
      const root = resolve(repositoryRoot, relativeRoot)
      const files: string[] = []
      const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const pathname = join(directory, entry.name)
          if (entry.isDirectory()) visit(pathname)
          else if (entry.isFile()) files.push(relative(repositoryRoot, pathname))
        }
      }
      visit(root)
      return files
    }
    const expectedPayload = [
      'openclaw-plugins/aiworker-director-brain/index.js',
      'openclaw-plugins/aiworker-director-brain/openclaw.plugin.json',
      'openclaw-plugins/aiworker-director-brain/package.json',
      ...walk('openclaw-plugins/aiworker-director-brain/lib'),
      ...walk('openclaw-skills/aiworker-director-brain'),
      'openclaw-plugins/aiworker-video-command/index.js',
      'openclaw-plugins/aiworker-video-command/openclaw.plugin.json',
      'openclaw-plugins/aiworker-video-command/package.json',
      ...walk('openclaw-plugins/aiworker-video-command/lib'),
      ...walk('openclaw-plugins/aiworker-video-command/scripts'),
      'openclaw-skills/aiworker-task-flow/SKILL.md',
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
      ...walk('openclaw-skills/aiworker-task-flow/lib'),
      ...walk('openclaw-skills/aiworker-task-flow/scripts'),
      'scripts/feishu-director-brain.mjs',
      'scripts/lib/feishu-director-brain.mjs',
      'scripts/lib/sensitive-value-scanner.mjs',
      'ops/feishu-director-brain/schema.json',
    ]
    const checker = await import(
      `${pathToFileURL(artifactCheckerPath).href}?payload=${Date.now()}`
    ) as { REQUIRED_STANDALONE_FILES: string[] }

    for (const member of expectedPayload) {
      expect(checker.REQUIRED_STANDALONE_FILES, member).toContain(member)
    }
  })

  it('makes every supported production package entrypoint use the fail-closed launcher', () => {
    const packageDocument = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(packageDocument.scripts?.start).toBe('pnpm run start:standalone')
    expect(packageDocument.scripts?.['start:standalone'])
      .toBe('pnpm run verify:node && bash scripts/start-standalone.sh')
    expect(Object.values(packageDocument.scripts || {}))
      .not.toContain(expect.stringContaining('next start --hostname 0.0.0.0'))
  })

  it('traces the single preinstall orchestrator and every managed executable into standalone', () => {
    const nextConfig = readFileSync(resolve(process.cwd(), 'next.config.js'), 'utf8')
    for (const member of [
      './scripts/legacy-preinstall-orchestrator.mjs',
      './scripts/legacy-preinstall-controller.mjs',
      './scripts/install-aiworker-task-flow-skill.sh',
      './scripts/install-aiworker-video-command-plugin.sh',
      './scripts/install-aiworker-director-brain.sh',
      './scripts/apply-openclaw-runtime-convergence.sh',
      './scripts/lib/openclaw-private-gateway-rpc.mjs',
      './scripts/lib/render-managed-markdown-section.mjs',
      './scripts/lib/runtime-tree-manifest.mjs',
    ]) {
      expect(nextConfig).toContain(member)
    }
  })

  it('imports and audits the immutable artifact without a TypeScript runtime package', () => {
    const fixture = createLauncherFixture()
    try {
      expect(existsSync(join(fixture.projectRoot, 'node_modules', 'typescript'))).toBe(false)
      const audit = spawnSync(
        process.execPath,
        [join(fixture.projectRoot, 'scripts', 'check-standalone-artifact.mjs'), fixture.standaloneRoot],
        { cwd: fixture.projectRoot, encoding: 'utf8' },
      )
      expect(audit.status, audit.stderr).toBe(0)
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

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
    expect(script).toContain('export AIWORKER_PLATFORM_ENV_FILE="$PLATFORM_ENV_FILE"')
    expect(script).toContain('export AIWORKER_STANDALONE_ROOT="$PHYSICAL_STANDALONE_ROOT"')
    expect(script).toContain('AIWORKER_PLATFORM_ENV_FILE must be an absolute single-line path')
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
      const manifestRewrite = spawnSync(
        process.execPath,
        [
          join(fixture.projectRoot, 'scripts', 'check-standalone-artifact.mjs'),
          '--write-manifest',
          fixture.standaloneRoot,
        ],
        { encoding: 'utf8' },
      )
      const result = runLauncher(fixture)

      expect(manifestRewrite.status).toBe(1)
      expect(manifestRewrite.stderr).toContain('standalone_release_provenance_artifact_mismatch')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('standalone_release_provenance_artifact_mismatch')
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
        profilesNoAuth: '0',
      })
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })

  it('overrides a stale no-auth value loaded from checkout-local runtime settings', () => {
    const fixture = createLauncherFixture()
    try {
      writeFileSync(
        join(fixture.projectRoot, '.env.local'),
        'MC_OPENCLAW_PROFILES_NO_AUTH=1\n',
      )

      const result = runLauncher(fixture, { MC_OPENCLAW_PROFILES_NO_AUTH: '1' })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(readFileSync(fixture.resultPath, 'utf8')).profilesNoAuth).toBe('0')
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
    ['openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js', 'file'],
    ['openclaw-plugins/aiworker-video-command/lib/scheduler-runner.js', 'file'],
    ['openclaw-plugins/aiworker-video-command/scripts/validate-runtime-inspection.mjs', 'file'],
    ['openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md', 'file'],
    ['openclaw-skills/aiworker-task-flow/lib/video-task.mjs', 'file'],
    ['openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs', 'file'],
    ['scripts/legacy-preinstall-orchestrator.mjs', 'file'],
    ['scripts/lib/openclaw-private-gateway-rpc.mjs', 'file'],
    ['scripts/lib/render-managed-markdown-section.mjs', 'file'],
    ['scripts/lib/runtime-tree-manifest.mjs', 'file'],
  ] as const)('refuses an artifact missing required %s', (relativePath, kind) => {
    const fixture = createLauncherFixture()
    try {
      rmSync(join(fixture.standaloneRoot, relativePath), { recursive: true, force: true })
      const result = runLauncher(fixture)

      expect(result.status).toBe(1)
      if (relativePath === 'server.js') {
        expect(result.stderr).toContain('standalone server missing')
      } else if (relativePath.startsWith('openclaw-plugins/')
        || relativePath.startsWith('openclaw-skills/')
        || relativePath === 'scripts/legacy-preinstall-orchestrator.mjs'
        || relativePath === 'scripts/lib/openclaw-private-gateway-rpc.mjs'
        || relativePath === 'scripts/lib/render-managed-markdown-section.mjs'
        || relativePath === 'scripts/lib/runtime-tree-manifest.mjs') {
        expect(result.stderr).toContain(`standalone_required_file_missing:${relativePath}`)
      } else {
        expect(result.stderr).toContain(`missing required ${kind}`)
        expect(result.stderr).toContain(relativePath)
      }
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true })
    }
  })
})
