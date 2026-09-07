import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), 'scripts/openclaw-keychain-secretref.sh')
const TEST_HOME = '/Users/secretref-test'
const TEST_KEYCHAIN = `${TEST_HOME}/Library/Keychains/login.keychain-db`

function runRejected(args: string[], includeHome = true) {
  const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
  if (includeHome) environment.HOME = TEST_HOME
  return spawnSync('/bin/sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: environment,
  })
}

describe('OpenClaw Keychain SecretRef wrapper', () => {
  it('keeps the forward path fixed to the native Keychain getter', () => {
    const source = readFileSync(SCRIPT, 'utf8')

    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0)
    expect(source).toContain(
      'exec /usr/bin/security find-generic-password -a "$1" -s "$2" -w "$3"',
    )
    expect(source).not.toMatch(/\beval\b|sh\s+-c|"\$@"/u)
  })

  it.each([
    { label: 'no arguments', args: [] },
    { label: 'too few arguments', args: ['account-ref', 'service-ref'] },
    { label: 'too many arguments', args: ['account-ref', 'service-ref', TEST_KEYCHAIN, 'extra'] },
    { label: 'empty account reference', args: ['', 'service-ref', TEST_KEYCHAIN] },
    { label: 'empty service reference', args: ['account-ref', '', TEST_KEYCHAIN] },
    { label: 'option-like account reference', args: ['--account', 'service-ref', TEST_KEYCHAIN] },
    { label: 'option-like service reference', args: ['account-ref', '-service', TEST_KEYCHAIN] },
    { label: 'newline in account reference', args: ['account\nref', 'service-ref', TEST_KEYCHAIN] },
    { label: 'tab in service reference', args: ['account-ref', 'service\tref', TEST_KEYCHAIN] },
    { label: 'control byte in account reference', args: ['account\u007fref', 'service-ref', TEST_KEYCHAIN] },
    { label: 'empty keychain path', args: ['account-ref', 'service-ref', ''] },
    { label: 'different keychain path', args: ['account-ref', 'service-ref', '/tmp/login.keychain-db'] },
  ])('rejects $label before invoking security', ({ args }) => {
    const result = runRejected(args)

    expect(result.status).toBe(64)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Invalid OpenClaw Keychain SecretRef arguments.\n')
  })

  it('rejects a valid-shaped request when HOME was not passed', () => {
    const result = runRejected(['account-ref', 'service-ref', TEST_KEYCHAIN], false)

    expect(result.status).toBe(64)
    expect(result.stdout).toBe('')
  })
})
