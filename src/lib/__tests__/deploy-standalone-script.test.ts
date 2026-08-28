import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('standalone deployment script', () => {
  it('stays compatible with the Bash 3.2 bundled with macOS', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-standalone.sh'), 'utf8')

    expect(script).not.toContain('declare -A')
    expect(script).not.toContain('IGNORECASE=1')
    expect(script).toContain('case " $seen_pids " in')
    expect(script).toContain('CI="${CI:-true}" pnpm install --frozen-lockfile')
    expect(script).toContain('curl -fsSL "http://$VERIFY_HOST:$PORT/login"')
    expect(script).toContain('tolower($1) == "content-type:"')
    expect(script).toContain('trap cleanup_failed_new_server EXIT')
    expect(script).toContain('stop_pid "$new_pid" "failed standalone candidate"')
    expect(script).toContain('if [[ "$recorded_pid" == "$new_pid" ]]')
    expect(script).toContain('deployment_verified=1')
    expect(script).toContain('trap - EXIT')
  })
})
