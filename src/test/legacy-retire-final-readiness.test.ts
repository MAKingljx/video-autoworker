import { spawnSync } from 'node:child_process'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const script = join(repositoryRoot, 'scripts/verify-legacy-retire-final-readiness.mjs')
const roots: string[] = []

function executable(pathname: string, source: string): void {
  writeFileSync(pathname, source, { mode: 0o700 })
  chmodSync(pathname, 0o700)
}

function identity(pathname: string) {
  const entry = lstatSync(pathname, { bigint: true })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & BigInt(0o7777)),
  }
}

function makeWritable(pathname: string): void {
  let entry
  try { entry = lstatSync(pathname) } catch { return }
  if (entry.isSymbolicLink()) return
  chmodSync(pathname, entry.isDirectory() ? 0o700 : 0o600)
  if (entry.isDirectory()) {
    for (const name of readdirSync(pathname)) makeWritable(join(pathname, name))
  }
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-final-readiness-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const journal = join(root, 'journal')
  for (const pathname of [profile, workspace, journal]) mkdirSync(pathname, { mode: 0o700 })
  const mission = join(root, 'mission-control.db')
  const n8n = join(root, 'database.sqlite')
  writeFileSync(mission, 'mission\n', { mode: 0o600 })
  writeFileSync(n8n, 'n8n\n', { mode: 0o600 })
  const transitionIntent = join(root, 'transition-intent.json')
  const transitionConfirmation = join(root, 'transition-confirmation.json')
  const transitionAttestation = join(root, 'transition-attestation.json')
  for (const pathname of [transitionIntent, transitionConfirmation, transitionAttestation]) {
    writeFileSync(pathname, '{}\n', { mode: 0o400 })
    chmodSync(pathname, 0o400)
  }
  const prepared = join(root, 'receipt.json')
  writeFileSync(prepared, `${JSON.stringify({
    schema: 'video-autoworker-legacy-media-orphan-runtime-receipt/v1',
    nonce: 'prepared-nonce',
    intent: { sha256: 'a'.repeat(64) },
    runtimeBefore: {
      protectedPids: {
        '3017': 1,
        '5678': 2,
        '5679': 3,
        '18091': 4,
        '18789': 5,
        '18889': 6,
        '18989': 7,
      },
      mission: identity(mission),
      n8nDatabase: identity(n8n),
      orphan: { child: { id: 1 }, parent: { id: 2 }, execution: { id: '3' } },
    },
  })}\n`, { mode: 0o400 })
  chmodSync(prepared, 0o400)
  const state = join(root, 'capture-state.json')
  writeFileSync(state, JSON.stringify({ generation: 9, routerPid: 101, n8nPid: 102, gatewayPid: 103 }), { mode: 0o600 })
  const capture = join(root, 'capture')
  executable(capture, `#!${process.execPath}
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CAPTURE_STATE,'utf8'))
process.stdout.write(JSON.stringify({blueGreen:{generation:value.generation,releaseId:'${'b'.repeat(40)}-runtime'},n8n:{pid:value.n8nPid,listeners:[value.n8nPid,value.n8nPid]},director:{pid:value.gatewayPid,health:true},router:{pid:value.routerPid},unchangedServices:{'18091':4,'18789':5,'18989':7},zeroWork:{active:0,queueWaiting:0,queueRunning:0}}))
`)
  const openclaw = join(root, 'openclaw')
  executable(openclaw, `#!${process.execPath}\nprocess.exit(0)\n`)
  const report = join(root, 'final-readiness.json')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test' as const,
    AIWORKER_TEST_LEGACY_FINAL_READINESS: '1',
    AIWORKER_TEST_LEGACY_FINAL_READINESS_CAPTURE: capture,
    CAPTURE_STATE: state,
  }
  const createArgs = [
    'create', '--output', report, '--prepared-receipt', prepared,
    '--transition-intent', transitionIntent,
    '--transition-confirmation', transitionConfirmation,
    '--transition-journal', journal,
    '--transition-attestation', transitionAttestation,
    '--n8n-database', n8n,
    '--expected-commit', 'b'.repeat(40),
    '--profile-state-root', profile,
    '--workspace-root', workspace,
    '--agent-id', 'second-original',
    '--openclaw-bin', openclaw,
  ]
  const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env,
  })
  return {
    root, profile, report, prepared, state, capture, transitionAttestation, openclaw, createArgs, run,
    verify: () => run(['verify-live', '--report', report, '--prepared-receipt', prepared]),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy retire final-readiness report', () => {
  it('passes the resolved Gateway token only in Gateway child env and never in argv', async () => {
    const fixture = createFixture()
    const commandLog = join(fixture.root, 'commands.jsonl')
    const provider = join(fixture.root, 'secret-provider')
    const resolvedToken = 'f'.repeat(64)
    executable(provider, `#!${process.execPath}\nprocess.stdout.write('${resolvedToken}\\n')\n`)
    writeFileSync(join(fixture.profile, 'openclaw.json'), `${JSON.stringify({
      gateway: { auth: { token: { source: 'exec', provider: 'keychain', id: 'gateway-token' } } },
      secrets: { providers: { keychain: { source: 'exec', command: provider, args: [] } } },
    })}\n`, { mode: 0o600 })
    const runtimeScripts = join(
      fixture.profile, 'extensions', 'aiworker-director-brain', 'runtime', 'scripts',
    )
    mkdirSync(runtimeScripts, { recursive: true, mode: 0o700 })
    const recorder = `const fs=require('node:fs');const keys=['OPENCLAW_GATEWAY_TOKEN','GATEWAY_TOKEN','OPENCLAW_GATEWAY_PASSWORD','GATEWAY_PASSWORD'];fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({argv:process.argv.slice(2),env:Object.fromEntries(keys.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))})+'\\n')`
    const esmRecorder = `import fs from 'node:fs';const keys=['OPENCLAW_GATEWAY_TOKEN','GATEWAY_TOKEN','OPENCLAW_GATEWAY_PASSWORD','GATEWAY_PASSWORD'];fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({argv:process.argv.slice(2),env:Object.fromEntries(keys.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))})+'\\n')`
    executable(fixture.openclaw, `#!${process.execPath}
${recorder}
const a=process.argv.slice(2);if(a.includes('plugins'))process.stdout.write(JSON.stringify({plugin:{id:'aiworker-director-brain',status:'loaded',version:'0.3.1'},tools:[{names:['aiworker_director_brain']}],diagnostics:[],typedHooks:[]}));else if(a.includes('tools.catalog'))process.stdout.write(JSON.stringify({agentId:'second-original',groups:[{pluginId:'aiworker-director-brain',source:'plugin',tools:[{id:'aiworker_director_brain',pluginId:'aiworker-director-brain',source:'plugin',optional:true}]}]}));else process.stdout.write('{}')
`)
    executable(join(runtimeScripts, 'feishu-director-brain.mjs'), `#!${process.execPath}
${esmRecorder}
process.stdout.write(JSON.stringify({ok:true,action:'health',tableCount:11,remoteContractVerified:true,brainName:'director',projectId:'PROJ-VIDEO-AUTOWORKER',environment:'test',schemaFingerprint:'${'a'.repeat(64)}'}))
`)
    const previous = Object.fromEntries(['COMMAND_LOG', 'OPENCLAW_GATEWAY_TOKEN', 'GATEWAY_TOKEN',
      'OPENCLAW_GATEWAY_PASSWORD', 'GATEWAY_PASSWORD'].map(key => [key, process.env[key]]))
    try {
      process.env.COMMAND_LOG = commandLog
      process.env.OPENCLAW_GATEWAY_TOKEN = 'parent-token-must-not-leak'
      process.env.GATEWAY_TOKEN = 'parent-alias-must-not-leak'
      process.env.OPENCLAW_GATEWAY_PASSWORD = 'parent-password-must-not-leak'
      process.env.GATEWAY_PASSWORD = 'parent-password-alias-must-not-leak'
      const readinessModule = await import(pathToFileURL(script).href)
      readinessModule.captureDirectorControlPlane({
        profileStateRoot: { path: fixture.profile },
        openclawBin: { path: fixture.openclaw },
        agentId: 'second-original',
      })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const calls = readFileSync(commandLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{
      argv: string[]
      env: Record<string, string>
    }>
    expect(calls).toHaveLength(4)
    for (const call of calls) expect(JSON.stringify(call.argv)).not.toContain(resolvedToken)
    const gatewayCalls = calls.filter(call => call.argv.includes('gateway'))
    expect(gatewayCalls).toHaveLength(2)
    for (const call of gatewayCalls) expect(call.env).toEqual({ OPENCLAW_GATEWAY_TOKEN: resolvedToken })
    const nonGatewayCalls = calls.filter(call => !call.argv.includes('gateway'))
    expect(nonGatewayCalls).toHaveLength(2)
    for (const call of nonGatewayCalls) expect(call.env).toEqual({})
  })

  it('creates one immutable report, verifies live twice, and resumes identically', () => {
    const fixture = createFixture()
    const created = fixture.run(fixture.createArgs)
    expect(created.status, created.stderr).toBe(0)
    expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, resumed: false })
    expect(statSync(fixture.report).mode & 0o777).toBe(0o400)
    const verified = fixture.verify()
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true })
    const resumed = fixture.run(fixture.createArgs)
    expect(resumed.status, resumed.stderr).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, resumed: true })
  })

  it('fails closed when the final runtime changes after the report', () => {
    const fixture = createFixture()
    expect(fixture.run(fixture.createArgs).status).toBe(0)
    writeFileSync(fixture.state, JSON.stringify({
      generation: 10, routerPid: 101, n8nPid: 102, gatewayPid: 103,
    }), { mode: 0o600 })
    const result = fixture.verify()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('differs from the immutable readiness report')
  })

  it('revalidates bound inputs after runtime capture and rejects same-content inode drift', () => {
    const fixture = createFixture()
    const marker = join(fixture.root, 'capture-mutated')
    executable(fixture.capture, `#!${process.execPath}
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CAPTURE_STATE,'utf8'))
process.stdout.write(JSON.stringify({blueGreen:{generation:value.generation,releaseId:'${'b'.repeat(40)}-runtime'},n8n:{pid:value.n8nPid,listeners:[value.n8nPid,value.n8nPid]},director:{pid:value.gatewayPid,health:true},router:{pid:value.routerPid},unchangedServices:{'18091':4,'18789':5,'18989':7},zeroWork:{active:0,queueWaiting:0,queueRunning:0}}))
if(!fs.existsSync(${JSON.stringify(marker)})){const target=${JSON.stringify(fixture.transitionAttestation)};const replacement=target+'.capture-replacement';fs.writeFileSync(replacement,fs.readFileSync(target),{mode:0o400});fs.renameSync(replacement,target);fs.writeFileSync(${JSON.stringify(marker)},'done\\n',{mode:0o600})}
`)
    const result = fixture.run(fixture.createArgs)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('transition attestation reference changed')
  })

  it('rejects report replacement, extra links, unsafe mode, and symlinks', () => {
    for (const kind of ['replace', 'link', 'mode', 'symlink']) {
      const fixture = createFixture()
      expect(fixture.run(fixture.createArgs).status).toBe(0)
      if (kind === 'replace') {
        chmodSync(fixture.report, 0o600)
        const replacement = `${fixture.report}.replacement`
        const value = JSON.parse(readFileSync(fixture.report, 'utf8')) as {
          snapshot: { router: { pid: number } }
        }
        value.snapshot.router.pid += 1
        writeFileSync(replacement, `${JSON.stringify(value)}\n`, { mode: 0o400 })
        renameSync(replacement, fixture.report)
      } else if (kind === 'link') {
        linkSync(fixture.report, `${fixture.report}.link`)
      } else if (kind === 'mode') {
        chmodSync(fixture.report, 0o600)
      } else {
        const target = `${fixture.report}.target`
        renameSync(fixture.report, target)
        symlinkSync(target, fixture.report)
      }
      expect(fixture.verify().status, kind).not.toBe(0)
    }
  })

  it('rejects a replaced transition reference and another prepared receipt', () => {
    const fixture = createFixture()
    expect(fixture.run(fixture.createArgs).status).toBe(0)
    chmodSync(fixture.transitionAttestation, 0o600)
    const replacement = `${fixture.transitionAttestation}.replacement`
    writeFileSync(replacement, '{}\n', { mode: 0o400 })
    renameSync(replacement, fixture.transitionAttestation)
    expect(fixture.verify().status).not.toBe(0)

    const secondPrepared = join(fixture.root, 'other-receipt.json')
    writeFileSync(secondPrepared, readFileSync(fixture.prepared), { mode: 0o400 })
    chmodSync(secondPrepared, 0o400)
    const other = fixture.run([
      'verify-live', '--report', fixture.report, '--prepared-receipt', secondPrepared,
    ])
    expect(other.status).not.toBe(0)
  })

  it('binds the exact managed OpenClaw executable instead of resolving PATH again', () => {
    const fixture = createFixture()
    expect(fixture.run(fixture.createArgs).status).toBe(0)
    const source = readFileSync(fixture.openclaw, 'utf8')
    const replacement = `${fixture.openclaw}.replacement`
    writeFileSync(replacement, source, { mode: 0o700 })
    chmodSync(replacement, 0o700)
    renameSync(replacement, fixture.openclaw)
    const result = fixture.verify()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('managed OpenClaw executable reference changed')
  })
})
