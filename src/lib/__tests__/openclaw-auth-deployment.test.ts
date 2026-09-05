import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

describe('OpenClaw-only production launch contract', () => {
  const temporary: string[] = []

  afterEach(() => {
    for (const pathname of temporary.splice(0)) rmSync(pathname, { recursive: true, force: true })
  })

  it.each([
    'scripts/deploy-standalone.sh',
    'scripts/start-standalone.sh',
    'scripts/start-standalone-slot.sh',
    'scripts/switch-legacy-standalone-3017.sh',
  ])('%s fixes production auth and listener to the loopback channel', (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
    expect(source).toContain('openclaw-loopback')
    expect(source).toContain('MC_DESKTOP_MODE="0"')
    expect(source).toContain('MC_OPENCLAW_PROFILES_NO_AUTH="0"')
    expect(source).toContain('127.0.0.1')
    expect(source).toMatch(/MC_HOSTNAME must remain 127\.0\.0\.1/u)
  })

  it('keeps the Linux systemd installer on the managed standalone launcher', () => {
    const source = readFileSync(resolve(process.cwd(), 'install.sh'), 'utf8')
    expect(source).toContain('die "Docker deployment is retired; use Docker only for the isolated build check in docs/deployment.md"')
    expect(source).not.toContain('scripts/generate-env.sh')
    expect(source).toContain('ExecStart=/bin/bash $INSTALL_DIR/scripts/start-standalone.sh')
    expect(source).toContain('Environment=MC_AUTH_MODE=openclaw-loopback')
    expect(source).toContain('Environment=MC_HOSTNAME=127.0.0.1')
    expect(source).not.toContain('ExecStart=$node_path $INSTALL_DIR/.next/standalone/server.js')
  })

  it('routes runtime environment writes outside immutable standalone artifacts', () => {
    const standalone = readFileSync(resolve(process.cwd(), 'scripts/start-standalone.sh'), 'utf8')
    const slot = readFileSync(resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'utf8')
    const e2eServer = readFileSync(
      resolve(process.cwd(), 'scripts/e2e-openclaw/start-e2e-server.mjs'),
      'utf8',
    )

    expect(standalone).toContain('export AIWORKER_PLATFORM_ENV_FILE="$PLATFORM_ENV_FILE"')
    expect(standalone).toContain('export AIWORKER_STANDALONE_ROOT="$PHYSICAL_STANDALONE_ROOT"')
    expect(slot).toContain('export AIWORKER_PLATFORM_ENV_FILE="$PLATFORM_ENV_FILE"')
    expect(slot).toContain('export AIWORKER_STANDALONE_ROOT="$PHYSICAL_ROOT"')
    expect(e2eServer).toContain('AIWORKER_PLATFORM_ENV_FILE: platformEnvFile')
    expect(e2eServer).toContain("AIWORKER_STANDALONE_ROOT: path.join(repoRoot, '.next', 'standalone')")
  })

  it('audits immutable standalone content and its manifest digest after every E2E suite', () => {
    const integrityGate = readFileSync(resolve(process.cwd(), 'tests/e2e-artifact-integrity.ts'), 'utf8')
    expect(integrityGate).toContain("name === '.env' || name.startsWith('.env.')")
    expect(integrityGate).toContain('originalManifestSha256')
    expect(integrityGate).toContain('scripts/check-standalone-artifact.mjs')

    for (const relativePath of [
      'playwright.config.ts',
      'playwright.openclaw.local.config.ts',
      'playwright.openclaw.gateway.config.ts',
    ]) {
      const config = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
      expect(config).toContain("globalSetup: './tests/e2e-artifact-integrity.ts'")
    }
  })

  it('makes the Windows local launcher enforce the equivalent auth, host, and artifact gate', () => {
    const source = readFileSync(resolve(process.cwd(), 'install.ps1'), 'utf8')
    expect(source).toContain('$env:MC_AUTH_MODE = "openclaw-loopback"')
    expect(source).toContain('$env:MC_DESKTOP_MODE = "0"')
    expect(source).toContain('$env:MC_HOSTNAME = "127.0.0.1"')
    expect(source).toContain('$env:HOSTNAME = "127.0.0.1"')
    expect(source).toContain('check-standalone-artifact.mjs')
    expect(source).not.toContain('$env:HOSTNAME = "0.0.0.0"')
    expect(source).not.toMatch(/Get-Random(?:Password|Hex)|RandomNumberGenerator/u)
    expect(source).not.toMatch(/AUTH_(?:USER|PASS|SECRET)|API_KEY/u)
  })

  it('keeps the container runtime private and fail-closed', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8')
    const entrypoint = readFileSync(resolve(process.cwd(), 'docker-entrypoint.sh'), 'utf8')
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf8')

    expect(dockerfile).toContain('MC_AUTH_MODE=openclaw-loopback')
    expect(dockerfile).toContain('org.opencontainers.image.source="https://github.com/MAKingljx/video-autoworker"')
    expect(dockerfile).toContain('HOSTNAME=127.0.0.1')
    expect(dockerfile).toContain('http://127.0.0.1:')
    expect(dockerfile).not.toContain('http://localhost:')
    expect(dockerfile).toContain('COPY --from=build /app/.next/standalone ./release')
    expect(dockerfile).not.toMatch(/COPY --from=build \/app\/(?:\.next\/static|public|src) /u)
    expect(dockerfile).toContain('git init')
    expect(dockerfile).toContain('touch .docker-diagnostic-untracked')
    expect(dockerfile).toContain("git status --porcelain | grep -q '^?? .docker-diagnostic-untracked$'")
    expect(dockerfile).not.toContain('HOSTNAME=0.0.0.0')
    expect(entrypoint).toContain('check-standalone-artifact.mjs')
    expect(entrypoint).toContain('export MC_AUTH_MODE="openclaw-loopback"')
    expect(entrypoint).not.toContain('Generated new API_KEY')
    expect(compose).toContain('MC_AUTH_MODE: openclaw-loopback')
    expect(compose).not.toMatch(/^\s+ports:/mu)
    expect(compose).not.toContain('mission-control-standalone:')

    const rejected = spawnSync('sh', [resolve(process.cwd(), 'docker-entrypoint.sh')], {
      encoding: 'utf8',
      env: { ...process.env, MC_AUTH_MODE: 'legacy-local-auth' },
    })
    expect(rejected.status).toBe(64)
    expect(rejected.stderr).toContain('MC_AUTH_MODE must be openclaw-loopback')
  })

  it('keeps private runtime state out of Docker context without hiding build inputs', () => {
    const dockerignore = readFileSync(resolve(process.cwd(), '.dockerignore'), 'utf8')
    const root = mkdtempSync(join(tmpdir(), 'dockerignore-contract-'))
    temporary.push(root)
    writeFileSync(join(root, '.gitignore'), dockerignore)

    for (const relativePath of [
      '.PhoenixBrain',
      '.run/state.json',
      '.runtime/state.json',
      'nested/deep/project/.PhoenixBrain',
      'nested/deep/project/.run/state.json',
      'nested/deep/project/.runtime/state.json',
    ]) {
      mkdirSync(resolve(root, relativePath, '..'), { recursive: true })
      writeFileSync(resolve(root, relativePath), 'private\n')
    }

    const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' })
    expect(init.status, init.stderr).toBe(0)
    const privatePaths = [
      '.PhoenixBrain',
      '.run/state.json',
      '.runtime/state.json',
      'nested/deep/project/.PhoenixBrain',
      'nested/deep/project/.run/state.json',
      'nested/deep/project/.runtime/state.json',
    ]
    const ignored = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', ...privatePaths], {
      encoding: 'utf8',
    })
    expect(ignored.status, ignored.stderr).toBe(0)
    expect(ignored.stdout.trim().split('\n').sort()).toEqual([...privatePaths].sort())

    const requiredBuildInputs = [
      'scripts/build-standalone.mjs',
      'scripts/check-standalone-artifact.mjs',
      'scripts/lib/director-extraction-release-provenance.mjs',
      'ops/feishu-director-brain/schema.json',
      'ops/openclaw/qwen-current-runtime-convergence.manifest.json',
      'openclaw-skills/aiworker-director-brain/SKILL.md',
      'openclaw-skills/aiworker-task-flow/SKILL.md',
    ]
    const required = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', ...requiredBuildInputs], {
      encoding: 'utf8',
    })
    expect(required.status, required.stderr).toBe(1)
    expect(required.stdout).toBe('')
  })

  it('removes direct-server and second-auth instructions from current operator docs', () => {
    for (const relativePath of [
      'README.md',
      'CLAUDE.md',
      'docs/deployment.md',
      'docs/SECURITY-HARDENING.md',
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
      expect(source).not.toMatch(/(?:^|\n)\s*(?:node\s+)?\.next\/standalone\/server\.js\s*(?:$|\n)/u)
      expect(source).not.toContain('HOSTNAME=0.0.0.0')
      expect(source).not.toMatch(/AUTH_(?:USER|PASS|SECRET)=/u)
    }
  })

  it('removes every whitespace/export spelling of the retired webhook secret', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-env-auth-'))
    temporary.push(root)
    const environmentPath = join(root, 'platform.env')
    writeFileSync(environmentPath, [
      'KEEP_VALUE=yes',
      'N8N_WEBHOOK_SECRET=one',
      '  N8N_WEBHOOK_SECRET = two',
      '\texport N8N_WEBHOOK_SECRET=three',
      'export\tN8N_WEBHOOK_SECRET = four',
      '',
    ].join('\n'), { mode: 0o600 })

    const result = spawnSync('bash', [resolve(process.cwd(), 'scripts/install-platform-env.sh')], {
      encoding: 'utf8',
      env: { ...process.env, AIWORKER_PLATFORM_ENV_FILE: environmentPath },
    })
    expect(result.status, result.stderr).toBe(0)
    const output = readFileSync(environmentPath, 'utf8')
    expect(output).toContain('KEEP_VALUE=yes')
    expect(output).not.toMatch(/N8N_WEBHOOK_SECRET/u)
  })
})
