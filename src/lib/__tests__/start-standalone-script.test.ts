import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
