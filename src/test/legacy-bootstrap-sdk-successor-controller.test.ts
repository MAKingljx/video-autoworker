// @vitest-environment node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adaptedProgramArguments } from '../../ops/recovery/install-blue-green-execve-adapter.mjs'
import { blueGreenExecveSourceSha256 } from '../../scripts/lib/blue-green-execve-contract.mjs'

const cleanup: string[] = []
const sourceController = resolve(process.cwd(), 'scripts/legacy-bootstrap-sdk-successor-controller.mjs')
const sourceRuntimeContract = resolve(process.cwd(), 'scripts/lib/openclaw-runtime-contract.mjs')
const sourceExecveAdapter = resolve(process.cwd(), 'ops/recovery/install-blue-green-execve-adapter.mjs')
const sourceExecveContract = resolve(process.cwd(), 'scripts/lib/blue-green-execve-contract.mjs')
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const stable = (value: any): any => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value
const canonical = (value: any) => JSON.stringify(stable(value))

afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true })
})

function reference(pathname: string) {
  const entry = statSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    sha256: sha256(readFileSync(pathname)),
  }
}

function writeJson(pathname: string, value: any, mode: number) {
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 })
  writeFileSync(pathname, `${canonical(value)}\n`, { mode })
  chmodSync(pathname, mode)
}

function plist(label: string, args: string[], workingDirectory: string) {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${escape(label)}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${escape(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escape(workingDirectory)}</string></dict></plist>\n`
}

function commitRepository(root: string) {
  execFileSync('/usr/bin/git', ['init', '-q', root])
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.'])
  execFileSync('/usr/bin/git', ['-C', root, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  return execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function fixture(options: { historicalControllerMode?: number } = {}) {
  const root = mkdtempSync('/private/tmp/legacy-sdk-successor-')
  cleanup.push(root)
  chmodSync(root, 0o700)
  const historical = join(root, 'historical')
  const control = join(root, 'control')
  const bootstrapAttempt = join(root, 'bootstrap', 'attempt')
  const resumeAttempt = join(bootstrapAttempt, 'disaster-recovery-attempts',
    'f78bdc85-6f71-42c8-bf7f-4a916a2cd495')
  const successorAttempt = join(bootstrapAttempt, 'sdk-successor-attempts', 'successor')
  const runtimeRelease = join(root, 'n8n-runtime')
  for (const directory of [historical, control, bootstrapAttempt, resumeAttempt, successorAttempt, runtimeRelease]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const controlPath = join(control, 'scripts/legacy-bootstrap-sdk-successor-controller.mjs')
  mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 })
  copyFileSync(sourceController, controlPath)
  chmodSync(controlPath, 0o755)
  const runtimeContractPath = join(control, 'scripts/lib/openclaw-runtime-contract.mjs')
  mkdirSync(dirname(runtimeContractPath), { recursive: true, mode: 0o700 })
  copyFileSync(sourceRuntimeContract, runtimeContractPath)
  chmodSync(runtimeContractPath, 0o644)
  const execveAdapterPath = join(control, 'ops/recovery/install-blue-green-execve-adapter.mjs')
  mkdirSync(dirname(execveAdapterPath), { recursive: true, mode: 0o700 })
  copyFileSync(sourceExecveAdapter, execveAdapterPath)
  chmodSync(execveAdapterPath, 0o755)
  const execveContractPath = join(control, 'scripts/lib/blue-green-execve-contract.mjs')
  copyFileSync(sourceExecveContract, execveContractPath)
  chmodSync(execveContractPath, 0o644)
  for (const [relativePath, mode] of [
    ['scripts/start-standalone-slot.sh', 0o755],
    ['scripts/check-standalone-artifact.mjs', 0o644],
    ['scripts/check-sensitive-content.mjs', 0o644],
    ['scripts/lib/sensitive-value-scanner.mjs', 0o644],
    ['scripts/lib/director-extraction-release-provenance.mjs', 0o644],
    ['scripts/lib/application-release-manifest-contract.mjs', 0o644],
  ] as const) {
    const destination = join(control, relativePath)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(resolve(process.cwd(), relativePath), destination)
    chmodSync(destination, mode)
  }
  writeFileSync(join(control, 'scripts/verify-openclaw-runtime-compatibility.mjs'), '#!/usr/bin/env node\n', { mode: 0o644 })
  chmodSync(join(control, 'scripts/verify-openclaw-runtime-compatibility.mjs'), 0o644)
  writeFileSync(join(control, 'scripts/verify-director-video-release-readiness.mjs'), '// fixture\n', { mode: 0o644 })
  chmodSync(join(control, 'scripts/verify-director-video-release-readiness.mjs'), 0o644)

  const attemptId = '11111111-1111-4111-8111-111111111111'
  const recoveryAttemptId = 'f78bdc85-6f71-42c8-bf7f-4a916a2cd495'
  const historicalTarget = {
    slot: 'blue',
    releaseId: `${'3'.repeat(40)}-runtime`,
    releaseRoot: join(root, 'releases', `${'3'.repeat(40)}-runtime`, 'standalone'),
    manifest: { sha256: 'a'.repeat(64) },
  }
  const guardValue = {
    mode: 'recovery-hold', pid: process.pid, startedAt: 'now',
    database: { path: '/mission' }, n8nDatabase: { path: '/n8n' }, socket: { path: '/guard.sock' },
    guardNonceSha256: '2'.repeat(64), legacyBindingSha256: '3'.repeat(64),
  }
  const historicalController = join(historical, 'scripts/legacy-bootstrap-controller.mjs')
  mkdirSync(dirname(historicalController), { recursive: true, mode: 0o700 })
  writeFileSync(historicalController, `
import fs from 'node:fs';import crypto from 'node:crypto';
const a=process.argv.slice(2),v=n=>a[a.indexOf(n)+1],p=v('--recovery-attempt-dir')+'/resume.receipt.json';
const e=fs.statSync(p,{bigint:true}),s=fs.readFileSync(p),ref={path:p,dev:e.dev.toString(),ino:e.ino.toString(),size:Number(e.size),sha256:crypto.createHash('sha256').update(s).digest('hex')};
process.stdout.write(JSON.stringify({alreadyConsumed:true,recoveryAttemptId:${JSON.stringify(recoveryAttemptId)},receipt:ref})+'\\n');
`, { mode: options.historicalControllerMode ?? 0o755 })
  chmodSync(historicalController, options.historicalControllerMode ?? 0o755)
  const guardController = join(historical, 'scripts/legacy-freeze-guard.mjs')
  writeFileSync(guardController,
    `process.stdout.write(${JSON.stringify(JSON.stringify(guardValue))}+'\\n')\n`, { mode: 0o644 })
  chmodSync(guardController, 0o644)
  const historicalRouter = join(historical, 'scripts/standalone-router.mjs')
  const historicalSlot = join(historical, 'scripts/start-standalone-slot.sh')
  copyFileSync(resolve(process.cwd(), 'scripts/standalone-router.mjs'), historicalRouter)
  copyFileSync(resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), historicalSlot)
  chmodSync(historicalRouter, 0o755)
  chmodSync(historicalSlot, 0o755)
  const historicalCommit = commitRepository(historical)
  const controlCommit = commitRepository(control)

  const runDir = join(root, 'run')
  const supervisor = join(runDir, 'supervisor')
  const launchAgents = join(root, 'LaunchAgents')
  for (const directory of [runDir, supervisor, join(supervisor, 'enabled'), launchAgents]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const routerTarget = { path: historicalRouter, sha256: sha256(readFileSync(historicalRouter)), mode: 0o755 }
  const slotTarget = { path: historicalSlot, sha256: sha256(readFileSync(historicalSlot)), mode: 0o755 }
  const slotRuntime = {
    sourceCommit: controlCommit,
    launcher: reference(join(control, 'scripts/start-standalone-slot.sh')),
    auditor: reference(join(control, 'scripts/check-standalone-artifact.mjs')),
    dependencies: Object.fromEntries([
      ['sensitiveContent', 'scripts/check-sensitive-content.mjs'],
      ['sensitiveValueScanner', 'scripts/lib/sensitive-value-scanner.mjs'],
      ['directorExtractionProvenance', 'scripts/lib/director-extraction-release-provenance.mjs'],
      ['applicationReleaseManifestContract', 'scripts/lib/application-release-manifest-contract.mjs'],
    ].map(([name, relativePath]) => [name, reference(join(control, relativePath))])),
  }
  for (const binding of [slotRuntime.launcher, slotRuntime.auditor, ...Object.values(slotRuntime.dependencies)]) {
    delete (binding as Record<string, unknown>).dev
    delete (binding as Record<string, unknown>).ino
    delete (binding as Record<string, unknown>).size
    ;(binding as Record<string, unknown>).mode = binding.path === slotRuntime.launcher.path ? 0o755 : 0o644
  }
  const services: Record<string, Record<string, any>> = {}
  const ports = { router: 43017, blue: 43317, green: 43417 }
  for (const name of ['router', 'blue', 'green']) {
    const label = `com.video-autoworker.blue-green.${name}`
    const pathname = join(launchAgents, `${label}.plist`)
    const args = name === 'router'
      ? adaptedProgramArguments({
        nodeBin: process.execPath, kind: 'router', target: routerTarget.path,
        targetSha256: routerTarget.sha256, workingDirectory: supervisor,
        args: ['--state-file', join(runDir, 'router-state.json'), '--host', '127.0.0.1',
          '--port', String(ports.router), '--attestation-file', join(runDir, 'router.runtime.json')],
      })
      : adaptedProgramArguments({
        nodeBin: process.execPath, kind: 'slot', target: slotRuntime.launcher.path,
        targetSha256: slotRuntime.launcher.sha256, workingDirectory: supervisor, args: [name, 'active'],
      })
    writeFileSync(pathname, plist(label, args, supervisor), { mode: 0o600 })
    chmodSync(pathname, 0o600)
    services[name] = {
      label, plist: pathname, enabledMarker: join(supervisor, 'enabled', `${name}.enabled`),
      port: ports[name as keyof typeof ports], sha256: sha256(readFileSync(pathname)),
    }
  }
  const contractRef = { path: execveContractPath, sha256: sha256(readFileSync(execveContractPath)), mode: 0o644 }
  const targetBinding = { router: routerTarget, slot: slotRuntime.launcher }
  const installationPath = join(supervisor, 'installation.json')
  writeJson(installationPath, {
    schema: 'video-autoworker-blue-green-launchd/v2', projectRoot: historical, runDir,
    releasesDir: join(root, 'releases'), launchAgentsDir: launchAgents, nodeBin: process.execPath,
    execve: {
      schema: 'video-autoworker-blue-green-execve/v1', contract: contractRef,
      sourceSha256: blueGreenExecveSourceSha256(),
      workingDirectory: supervisor,
    },
    executables: { routerScript: routerTarget, slotStartScript: slotTarget }, services,
    recoveryCompatibility: {
      schema: 'video-autoworker-blue-green-execve-adapter/v2', sourceCommit: historicalCommit,
      adapterCommit: controlCommit, installedAt: 1,
      installerSha256: sha256(readFileSync(execveAdapterPath)),
      launcherSourceSha256: blueGreenExecveSourceSha256(),
      execveContract: contractRef, workingDirectory: supervisor, targets: targetBinding,
      historicalTargets: { router: routerTarget, slot: slotTarget }, slotRuntime,
    },
  }, 0o600)
  const execveProofPath = join(successorAttempt, 'execve-adapter.json')
  const verifiedExecve = execFileSync(process.execPath, [execveAdapterPath, '--verify-installed',
    '--source-root', historical, '--expected-commit', historicalCommit,
    '--adapter-source-root', control, '--expected-adapter-commit', controlCommit,
    '--installation', installationPath, '--launch-agents-dir', launchAgents,
  ], { encoding: 'utf8' })
  writeJson(execveProofPath, JSON.parse(verifiedExecve), 0o600)

  const pendingPath = join(root, 'bootstrap.pending.json')
  writeJson(pendingPath, {
    schema: 'video-autoworker-blue-green-bootstrap-pending/v4',
    attemptId,
    slot: historicalTarget.slot,
    releaseId: historicalTarget.releaseId,
    releaseRoot: historicalTarget.releaseRoot,
    manifestSha256: historicalTarget.manifest.sha256,
    baselineSourceCommit: historicalCommit,
    n8n: { workflowSourceCommit: historicalCommit },
  }, 0o400)
  const pendingRef = reference(pendingPath)

  const resumePath = join(resumeAttempt, 'resume.receipt.json')
  const resume = {
    schema: 'video-autoworker-legacy-bootstrap-resume-authorization/v1',
    recoveryAttemptId,
    target: historicalTarget,
    databases: { mission: { path: '/mission', dev: '1', ino: '2' }, n8n: { path: '/n8n', dev: '1', ino: '3' } },
    routing: { port: 3017, runDirectory: { path: '/run', dev: '1', ino: '4' }, statePath: '/run/router-state.json' },
    runtime: { observedAt: 1, n8nPid: process.pid, runtimeRelease: { path: runtimeRelease, dev: '1', ino: '5' }, workflow: { sourceCommit: historicalCommit }, counts: {}, previousQueueDigestSha256: 'b'.repeat(64), queueDigestSha256: 'c'.repeat(64) },
    authorization: { attemptId, pending: pendingRef },
  }
  writeJson(resumePath, resume, 0o400)
  const consumedPath = join(resumeAttempt, 'resume.consumed.json')
  writeJson(consumedPath, {
    schema: 'video-autoworker-legacy-bootstrap-resume-consumed/v1',
    attemptId,
    recoveryAttemptId,
    resume: reference(resumePath),
    runtimeSnapshotSha256: 'd'.repeat(64),
  }, 0o400)

  const compatibilityPath = join(successorAttempt, 'openclaw-runtime-compatibility.json')
  const compatibilityCore = {
    schema: 'video-autoworker-openclaw-runtime-compatibility/v1',
    openclaw: { name: 'openclaw', version: '2026.9.2', packageJsonSha256: 'e'.repeat(64), gatewayRuntimeExport: 'openclaw/plugin-sdk/gateway-runtime' },
    rpc: { methods: ['tools.catalog', 'tools.effective', 'health', 'logs.tail', 'config.get', 'config.patch'], sharedStateMode: 'read-only' },
    plugins: { video: { id: 'aiworker-video-command', version: '0.5.14', peerPolicy: '>=2026.9.2' }, director: { id: 'aiworker-director-brain', version: '0.4.0', peerPolicy: '>=2026.9.2' } },
    secretRef: { wrapperSourceCommit: '627208bb723ed7a040e02ab0adf89210ac3f0ee2', wrapperSha256: 'f545f740273bd520e4c3ddcd755c180ae0f955c84a81ed4de2b5ae7c0f4172a7', commandRelativePath: 'ai-worker/bin/aiworker-openclaw-keychain-secretref', passEnv: ['HOME'], argumentCount: 3 },
    source: { commit: controlCommit, contractSha256: sha256(readFileSync(runtimeContractPath)) },
  }
  writeJson(compatibilityPath, {
    ...compatibilityCore,
    compatibilitySha256: sha256(canonical(compatibilityCore)),
  }, 0o600)
  const guardPath = join(successorAttempt, 'guard.json')
  writeJson(guardPath, guardValue, 0o600)
  const requestedTarget = {
    sourceCommit: '7'.repeat(40),
    releaseId: `${'7'.repeat(40)}-runtime`,
    releaseRoot: join(root, 'releases', `${'7'.repeat(40)}-runtime`, 'standalone'),
    manifestSha256: '6'.repeat(64),
  }
  const readinessPath = join(successorAttempt, 'readiness.json')
  writeJson(readinessPath, {
    schema: 'video-autoworker-director-video-preflight/v1', phase: 'pre-bootstrap', ok: true,
    commit: requestedTarget.sourceCommit,
    app: { releaseId: requestedTarget.releaseId, root: requestedTarget.releaseRoot, manifestSha256: requestedTarget.manifestSha256 },
    provenance: { gitCommit: requestedTarget.sourceCommit, sha256: '8'.repeat(64) },
    runtimeConvergence: {
      schema: 'video-autoworker-openclaw-runtime-convergence-proof/v1',
      sha256: '9'.repeat(64),
      createdAt: new Date().toISOString(),
      sessionKeySha256: '5'.repeat(64),
      catalogSha256: 'a'.repeat(64),
      effectiveSha256: 'b'.repeat(64),
      pluginTreesSha256: 'c'.repeat(64),
      gatewayPid: process.pid,
    },
    payloads: { projectionContract: { currentDigest: '4'.repeat(64) } },
    contracts: {
      directorWork: true,
      extractionSourceProvenance: true,
      outboxClosure: true,
      sessionScopedRuntimeConvergence: true,
      standaloneArtifactContentBound: true,
    },
  }, 0o600)
  return {
    root, historical, historicalCommit, control, controlCommit, controlPath,
    bootstrapAttempt, resumeAttempt, successorAttempt, pendingPath, runtimeRelease,
    compatibilityPath, guardPath, readinessPath, historicalTarget, requestedTarget,
    execveProofPath, services,
  }
}

function run(entry: ReturnType<typeof fixture>, command: string, extra: string[]) {
  return spawnSync(process.execPath, [entry.controlPath, command, ...extra], { encoding: 'utf8' })
}

function authorize(entry: ReturnType<typeof fixture>) {
  return run(entry, 'authorize', [
    '--successor-attempt', entry.successorAttempt,
    '--historical-repository', entry.historical, '--historical-commit', entry.historicalCommit,
    '--historical-bootstrap-attempt', entry.bootstrapAttempt,
    '--pending', entry.pendingPath, '--resume-attempt', entry.resumeAttempt,
    '--runtime-release', entry.runtimeRelease, '--n8n-pid', String(process.pid),
    '--control-repository', entry.control, '--control-commit', entry.controlCommit,
    '--compatibility', entry.compatibilityPath, '--execve-adapter', entry.execveProofPath,
    '--guard-status', entry.guardPath,
    '--requested-readiness', entry.readinessPath,
  ])
}

describe('legacy bootstrap SDK successor controller', () => {
  it('matches every controller-bound fixture file to its real Git tree mode', () => {
    const entry = fixture()
    const expected = [
      [entry.historical, entry.historicalCommit, 'scripts/legacy-bootstrap-controller.mjs', '100755'],
      [entry.historical, entry.historicalCommit, 'scripts/legacy-freeze-guard.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/legacy-bootstrap-sdk-successor-controller.mjs', '100755'],
      [entry.control, entry.controlCommit, 'scripts/verify-openclaw-runtime-compatibility.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/verify-director-video-release-readiness.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/lib/openclaw-runtime-contract.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/start-standalone-slot.sh', '100755'],
      [entry.control, entry.controlCommit, 'scripts/check-standalone-artifact.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/check-sensitive-content.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/lib/sensitive-value-scanner.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/lib/director-extraction-release-provenance.mjs', '100644'],
      [entry.control, entry.controlCommit, 'scripts/lib/application-release-manifest-contract.mjs', '100644'],
    ] as const

    for (const [repository, commit, relativePath, mode] of expected) {
      const treeEntry = execFileSync('/usr/bin/git', [
        '-C', repository, 'ls-tree', commit, '--', relativePath,
      ], { encoding: 'utf8' })
      expect(treeEntry, relativePath).toMatch(new RegExp(`^${mode} blob [a-f0-9]{40}\\t`))
    }
  })

  it('rejects a clean historical Git source that records the resume controller as 100644', () => {
    const entry = fixture({ historicalControllerMode: 0o644 })
    const treeEntry = execFileSync('/usr/bin/git', [
      '-C', entry.historical, 'ls-tree', entry.historicalCommit, '--',
      'scripts/legacy-bootstrap-controller.mjs',
    ], { encoding: 'utf8' })
    expect(treeEntry).toMatch(/^100644 blob [a-f0-9]{40}\t/u)

    const result = authorize(entry)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('scripts/legacy-bootstrap-controller.mjs is unsafe')
    expect(existsSync(join(entry.successorAttempt, 'sdk-successor.receipt.json'))).toBe(false)
    expect(existsSync(join(entry.successorAttempt, 'sdk-successor.token.json'))).toBe(false)
  })

  it('references one consumed historical resume and permits refreshed live readiness after consume', () => {
    const entry = fixture()
    const authorized = authorize(entry)
    expect(authorized.status, authorized.stderr).toBe(0)
    expect(authorized.stdout, JSON.stringify(authorized)).not.toBe('')
    const auth = JSON.parse(authorized.stdout)
    const consumed = run(entry, 'consume', [
      '--receipt', auth.receipt.path, '--token', auth.token,
      '--compatibility', entry.compatibilityPath, '--execve-adapter', entry.execveProofPath,
      '--readiness', entry.readinessPath,
      '--guard-status', entry.guardPath,
    ])
    expect(consumed.status, consumed.stderr).toBe(0)
    const consumedOutput = JSON.parse(consumed.stdout)
    const readiness = JSON.parse(readFileSync(entry.readinessPath, 'utf8'))
    readiness.runtimeConvergence.sha256 = 'd'.repeat(64)
    readiness.runtimeConvergence.gatewayPid = process.pid + 1
    writeJson(entry.readinessPath, readiness, 0o600)
    const verified = run(entry, 'verify-consumed', [
      '--receipt', auth.receipt.path, '--consumed', consumedOutput.consumed.path,
      '--compatibility', entry.compatibilityPath, '--execve-adapter', entry.execveProofPath,
      '--readiness', entry.readinessPath,
      '--guard-status', entry.guardPath,
    ])
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({
      mode: 'verify-consumed', ok: true, historicalSourceCommit: entry.historicalCommit,
      controlSourceCommit: entry.controlCommit,
      n8nWorkflowSourceCommit: entry.historicalCommit,
      historicalTarget: entry.historicalTarget,
      requestedTarget: entry.requestedTarget,
    })
  })

  it('uses the shared compatibility DTO and rejects a boolean Gateway export even with a new digest', () => {
    const entry = fixture()
    const compatibility = JSON.parse(readFileSync(entry.compatibilityPath, 'utf8'))
    compatibility.openclaw.gatewayRuntimeExport = true
    const { compatibilitySha256: _oldDigest, ...core } = compatibility
    compatibility.compatibilitySha256 = sha256(canonical(core))
    writeJson(entry.compatibilityPath, compatibility, 0o600)

    const result = authorize(entry)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OpenClaw compatibility is invalid')
  })

  it('rejects a missing or drifted installed execve adapter before authorization', () => {
    const missing = fixture()
    rmSync(missing.execveProofPath)
    const absent = authorize(missing)
    expect(absent.status).toBe(1)
    expect(absent.stderr).toContain('execve adapter proof')

    const drifted = fixture()
    writeFileSync(drifted.services.router.plist, readFileSync(drifted.services.router.plist, 'utf8').replace(
      '<string>--state-file</string>', '<string>--changed-state-file</string>',
    ), { mode: 0o600 })
    chmodSync(drifted.services.router.plist, 0o600)
    const rejected = authorize(drifted)
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('router installed execve service binding is invalid')
  })

  it('rejects a successor that reuses the immutable historical application target', () => {
    const entry = fixture()
    const readiness = JSON.parse(readFileSync(entry.readinessPath, 'utf8'))
    readiness.commit = entry.historicalCommit
    readiness.app.releaseId = entry.historicalTarget.releaseId
    readiness.app.root = entry.historicalTarget.releaseRoot
    readiness.app.manifestSha256 = entry.historicalTarget.manifest.sha256
    readiness.provenance.gitCommit = entry.historicalCommit
    writeJson(entry.readinessPath, readiness, 0o600)

    const result = authorize(entry)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('successor target must differ from the historical application')
  })

  it('durably recovers authorization and consumption crash windows', () => {
    const orphaned = fixture()
    writeJson(join(orphaned.successorAttempt, 'sdk-successor.token.json'), {
      schema: 'video-autoworker-legacy-bootstrap-sdk-successor-capability/v1',
      authorizationId: '22222222-2222-4222-8222-222222222222',
      issuedAt: 1,
      expiresAt: 2,
      capability: 'a'.repeat(64),
      receiptSha256: 'b'.repeat(64),
    }, 0o600)
    const recreated = authorize(orphaned)
    expect(recreated.status, recreated.stderr).toBe(0)

    const entry = fixture()
    const authorized = authorize(entry)
    expect(authorized.status, authorized.stderr).toBe(0)
    const auth = JSON.parse(authorized.stdout)
    const tokenPath = auth.token
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'))
    const consumedPath = join(entry.successorAttempt, 'sdk-successor.consumed.json')
    writeJson(consumedPath, {
      schema: 'video-autoworker-legacy-bootstrap-sdk-successor-consumed/v1',
      authorizationId: token.authorizationId,
      consumedAt: Math.floor(Date.now() / 1000),
      receipt: auth.receipt,
      tokenSha256: reference(tokenPath).sha256,
      initialReadinessSha256: reference(entry.readinessPath).sha256,
      compatibilitySha256: JSON.parse(readFileSync(entry.compatibilityPath, 'utf8')).compatibilitySha256,
    }, 0o400)
    const recovered = run(entry, 'consume', [
      '--receipt', auth.receipt.path, '--token', tokenPath,
      '--compatibility', entry.compatibilityPath, '--execve-adapter', entry.execveProofPath,
      '--readiness', entry.readinessPath,
      '--guard-status', entry.guardPath,
    ])
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({ mode: 'consume', ok: true })
    expect(existsSync(tokenPath)).toBe(false)
    expect(existsSync(consumedPath)).toBe(true)
  })

  it('preserves expired immutable authorization and requires a new attempt', () => {
    const entry = fixture()
    const authorized = authorize(entry)
    expect(authorized.status, authorized.stderr).toBe(0)
    const auth = JSON.parse(authorized.stdout)
    const receipt = JSON.parse(readFileSync(auth.receipt.path, 'utf8'))
    const token = JSON.parse(readFileSync(auth.token, 'utf8'))
    receipt.expiresAt = 1
    token.expiresAt = 1
    chmodSync(auth.receipt.path, 0o600)
    writeJson(auth.receipt.path, receipt, 0o400)
    token.receiptSha256 = reference(auth.receipt.path).sha256
    writeJson(auth.token, token, 0o600)

    const expired = run(entry, 'verify', [
      '--receipt', auth.receipt.path, '--token', auth.token,
      '--compatibility', entry.compatibilityPath, '--execve-adapter', entry.execveProofPath,
      '--readiness', entry.readinessPath, '--guard-status', entry.guardPath,
    ])
    expect(expired.status).toBe(1)
    expect(expired.stderr).toContain('preserve immutable artifacts and create a new successor attempt directory and plan')
    expect(existsSync(auth.receipt.path)).toBe(true)
    expect(existsSync(auth.token)).toBe(true)

    const repeated = authorize(entry)
    expect(repeated.status).toBe(1)
    expect(repeated.stderr).toContain('create a new successor attempt directory and plan')
  })
})
