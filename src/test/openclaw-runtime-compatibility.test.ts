// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyOpenClawRuntimeCompatibility } from '../../scripts/verify-openclaw-runtime-compatibility.mjs'
import {
  isOpenClawConfigRevisionToken,
  openClawRuntimeCompatibilityDigest,
  validateOpenClawRuntimeCompatibility,
} from '../../scripts/lib/openclaw-runtime-contract.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('OpenClaw 9.2 stable runtime compatibility', () => {
  it('binds the public Gateway SDK, legacy installed peers, and strict user SecretRef', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'openclaw-compat-')))
    roots.push(root)
    const repository = join(root, 'repository')
    const contract = join(repository, 'scripts/lib/openclaw-runtime-contract.mjs')
    mkdirSync(dirname(contract), { recursive: true, mode: 0o700 })
    copyFileSync(resolve('scripts/lib/openclaw-runtime-contract.mjs'), contract)
    chmodSync(contract, 0o644)
    execFileSync('/usr/bin/git', ['init', '-q', repository])
    execFileSync('/usr/bin/git', ['-C', repository, 'add', '.'])
    execFileSync('/usr/bin/git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
    const sourceCommit = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const packageRoot = join(root, 'openclaw')
    mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: 'openclaw', version: '2026.9.2', type: 'module',
      exports: { './plugin-sdk/gateway-runtime': './dist/gateway-runtime.js' },
    })}\n`, { mode: 0o600 })
    writeFileSync(join(packageRoot, 'dist/gateway-runtime.js'),
      'export async function callGatewayFromCli() {}\n', { mode: 0o600 })
    const plugin = (name: string, version: string, peer: string) => {
      const target = join(root, name)
      mkdirSync(target, { mode: 0o700 })
      writeFileSync(join(target, 'package.json'), `${JSON.stringify({ version, peerDependencies: { openclaw: peer } })}\n`, { mode: 0o600 })
      writeFileSync(join(target, 'openclaw.plugin.json'), `${JSON.stringify({ id: name, version })}\n`, { mode: 0o600 })
      return target
    }
    const video = plugin('aiworker-video-command', '0.5.15', '>=2026.7.1-2')
    const director = plugin('aiworker-director-brain', '0.4.2', '2026.7.1-2')
    const previousHome = process.env.HOME
    process.env.HOME = join(root, 'home')
    const bin = join(process.env.HOME, 'ai-worker/bin')
    mkdirSync(bin, { recursive: true, mode: 0o700 })
    const wrapper = join(bin, 'aiworker-openclaw-keychain-secretref')
    copyFileSync(resolve('scripts/openclaw-keychain-secretref.sh'), wrapper)
    chmodSync(wrapper, 0o700)
    const config = join(root, 'openclaw.json')
    writeFileSync(config, `${JSON.stringify({
      gateway: { auth: { token: { source: 'exec', provider: 'keychain', id: 'gateway' } } },
      secrets: { providers: { keychain: {
        source: 'exec', command: wrapper,
        args: ['account-ref', 'service-ref', `${process.env.HOME}/Library/Keychains/login.keychain-db`],
        trustedDirs: [bin], passEnv: ['HOME'], jsonOnly: false,
      } } },
    })}\n`, { mode: 0o600 })
    try {
      const result = await verifyOpenClawRuntimeCompatibility({
        '--repository-root': repository, '--source-commit': sourceCommit,
        '--openclaw-package-root': packageRoot, '--profile-config': config,
        '--video-plugin-root': video, '--director-plugin-root': director,
      })
      expect(result).toMatchObject({
        schema: 'video-autoworker-openclaw-runtime-compatibility/v1',
        openclaw: { version: '2026.9.2', gatewayRuntimeExport: 'openclaw/plugin-sdk/gateway-runtime' },
        secretRef: { wrapperSourceCommit: '627208bb723ed7a040e02ab0adf89210ac3f0ee2', argumentCount: 3 },
      })
      expect(result.compatibilitySha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(validateOpenClawRuntimeCompatibility(result)).toEqual(result)
      const { compatibilitySha256: _digest, ...core } = result
      expect(openClawRuntimeCompatibilityDigest(core)).toBe(result.compatibilitySha256)
      expect(() => validateOpenClawRuntimeCompatibility({
        ...result,
        openclaw: { ...result.openclaw, gatewayRuntimeExport: true },
      })).toThrow('runtime compatibility DTO is invalid')
      expect(() => validateOpenClawRuntimeCompatibility({
        ...result,
        schema: 'video-autoworker-openclaw-runtime-compatibility/wrong',
      })).toThrow('runtime compatibility DTO is invalid')
      expect(isOpenClawConfigRevisionToken(`hmac-sha256:v1:${'A'.repeat(43)}`)).toBe(true)
      expect(isOpenClawConfigRevisionToken('a'.repeat(64))).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/pid|observedAt|sessionKey/iu)
    } finally { process.env.HOME = previousHome }
  })
})
