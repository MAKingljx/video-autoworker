import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('standalone deployment script', () => {
  it('stays compatible with the Bash 3.2 bundled with macOS', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-standalone.sh'), 'utf8')

    expect(script).not.toContain('declare -A')
    expect(script).toContain('case " $seen_pids " in')
    expect(script).toContain('curl -fsSL "http://$VERIFY_HOST:$PORT/login"')
  })
})
