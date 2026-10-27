// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspectManagedOpenClawSdkLink, rebindManagedOpenClawSdkLink, resolveManagedOpenClawSdk } from '../../scripts/lib/openclaw-managed-sdk.mjs'

let home: string
let sdk: string
let legacy: string
let link: string
const file = (p: string, value: string, mode = 0o600) => {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); writeFileSync(p, value, { mode }); chmodSync(p, mode)
}
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'managed-sdk-')))
  vi.stubEnv('HOME', home); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWORKER_OPENCLAW_RUNTIME_TEST_MODE', '1')
  vi.stubEnv('AIWORKER_TEST_OPENCLAW_MANAGED_NODE_ROOT', ''); vi.stubEnv('AIWORKER_TEST_OPENCLAW_SDK_ROOT', '')
  sdk = join(home, 'ai-worker/services/openclaw-runtime/releases/2026.9.9/install/lib/node_modules/openclaw')
  legacy = join(home, 'ai-worker/node/node-v22.22.3-darwin-arm64/lib/node_modules/openclaw')
  const node = join(home, 'ai-worker/services/openclaw-runtime/runtimes/node-v24.21.0-darwin-arm64/bin/node')
  file(node, '#!/bin/sh\nexit 0\n', 0o700)
  file(join(sdk, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.9' }))
  file(join(sdk, 'openclaw.mjs'), 'export const core = true\n')
  file(join(sdk, '.aiworker-cli-entry.sh'), `#!/bin/sh\nset -eu\nexec ${node} ${join(sdk, 'openclaw.mjs')} "$@"\n`, 0o700)
  mkdirSync(join(home, 'ai-worker/bin'), { recursive: true, mode: 0o700 })
  symlinkSync(join(sdk, '.aiworker-cli-entry.sh'), join(home, 'ai-worker/bin/openclaw'))
  file(join(legacy, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }))
  symlinkSync(join(home, 'ai-worker/node/node-v22.22.3-darwin-arm64'), join(home, 'ai-worker/node/current'))
  link = join(home, '.openclaw-qwen-current/extensions/aiworker-video-command/node_modules/openclaw')
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 })
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

describe('managed OpenClaw SDK binding', () => {
  it('resolves the actual Node24 CLI core independently of the business Node22 root', () => {
    expect(resolveManagedOpenClawSdk()).toMatchObject({ root: sdk, version: '2026.9.9',
      cliBinding: { kind: 'managed-cli', target: join(sdk, '.aiworker-cli-entry.sh') } })
  })
  it('only recognizes the exact old managed Node SDK for explicit migration inspection', () => {
    symlinkSync(legacy, link)
    expect(() => inspectManagedOpenClawSdkLink(link)).toThrow('SDK link target is invalid')
    expect(inspectManagedOpenClawSdkLink(link, '2026.9.9', { allowRecognizedLegacy: true })).toMatchObject({
      currentState: 'legacy-needed-update', evidence: { target: legacy, sdk: { version: '2026.9.2' } },
      expectedSdkIdentity: { root: sdk, version: '2026.9.9', packageSha256: expect.any(String) },
    })
  })
  it('rejects unknown SDK link roots even if their package name and old version are correct', () => {
    const other = join(home, 'other-sdk'); file(join(other, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }))
    symlinkSync(other, link)
    expect(() => inspectManagedOpenClawSdkLink(link, '2026.9.9', { allowRecognizedLegacy: true })).toThrow('SDK link target is invalid')
  })
  it.each(['name', 'version'])('rejects current package %s drift', key => {
    file(join(sdk, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.9', [key]: 'wrong' }))
    expect(() => resolveManagedOpenClawSdk()).toThrow('SDK package identity is invalid')
  })
  it('rejects writable package data and a CLI wrapper bound to another entry', () => {
    chmodSync(join(sdk, 'package.json'), 0o666)
    expect(() => resolveManagedOpenClawSdk()).toThrow('SDK package is unsafe')
    chmodSync(join(sdk, 'package.json'), 0o600)
    file(join(sdk, '.aiworker-cli-entry.sh'), '#!/bin/sh\nset -eu\nexec /bin/sh /tmp/wrong "$@"\n', 0o700)
    expect(() => resolveManagedOpenClawSdk()).toThrow('SDK CLI wrapper binding is invalid')
  })
  it('rebinds only the recognized old link and preserves original backup bytes in a separate receipt', () => {
    symlinkSync(legacy, link)
    const manifest = join(home, 'backup.MANIFEST'); file(manifest, `original-sdk-link:${legacy}\n`)
    const original = readFileSync(manifest)
    const receipt = rebindManagedOpenClawSdkLink(link, join(home, 'sdk-rebind.json'))
    expect(receipt).toMatchObject({ changed: true, before: { target: legacy, sdk: { version: '2026.9.2' } },
      after: { target: sdk, sdk: { version: '2026.9.9' } } })
    expect(readFileSync(manifest)).toEqual(original)
    expect(inspectManagedOpenClawSdkLink(link).currentState).toBe('current')
  })
  it('refuses an existing receipt before changing a recognized legacy SDK link', () => {
    symlinkSync(legacy, link)
    const receipt = join(home, 'existing-sdk-rebind.json')
    file(receipt, 'keep original receipt\n')
    expect(() => rebindManagedOpenClawSdkLink(link, receipt)).toThrow()
    expect(inspectManagedOpenClawSdkLink(link, '2026.9.9', { allowRecognizedLegacy: true }).evidence.target).toBe(legacy)
    expect(readFileSync(receipt, 'utf8')).toBe('keep original receipt\n')
  })
  it('binds current package bytes into the migration target identity', () => {
    symlinkSync(legacy, link)
    const before = inspectManagedOpenClawSdkLink(link, '2026.9.9', { allowRecognizedLegacy: true })
    file(join(sdk, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.9', changed: true }))
    const after = inspectManagedOpenClawSdkLink(link, '2026.9.9', { allowRecognizedLegacy: true })
    expect(after.expectedSdkIdentity.packageSha256).not.toBe(before.expectedSdkIdentity.packageSha256)
  })
})
