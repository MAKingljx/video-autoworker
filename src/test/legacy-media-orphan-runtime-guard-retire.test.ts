import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const script = join(repositoryRoot, 'scripts/legacy-media-orphan-runtime-guard.mjs')
const retirablePredecessor = '61eb99581f2c0123634790e7667e04166f61b8115de16de282c9657208a84391'
const reconciledError = '[LEGACY_MEDIA_ORPHAN_RECONCILED] 历史媒体子记录已在父任务和对应执行终态、无运行资源时受管收敛'
const roots: string[] = []
const children: ChildProcess[] = []

type State = {
  loaded: boolean
  disabled: boolean
  workers: number[]
  workerPid: number
  workspace: string
  plistPath: string
  lockPath: string
  childStatus: string
  childError: string
  childCompletedAt: number
  childUpdatedAt: number
  parentDigest: string
  executionDigest: string
  mediaActive: number
  n8nActive: number
  queueWaiting: number
  queueRunning: number
  protected3017: number
  protected5678: number
  protected5679: number
  protected18091: number
  protected18789: number
  protected18889: number
  protected18989: number
  drift18889OnSecond: boolean
  retireSnapshotCalls: number
}

function executable(pathname: string, source: string): void {
  writeFileSync(pathname, source, { mode: 0o700 })
  chmodSync(pathname, 0o700)
}

function makeWritable(pathname: string): void {
  if (!existsSync(pathname)) return
  const entry = statSync(pathname)
  if (!entry.isDirectory()) {
    chmodSync(pathname, 0o600)
    return
  }
  chmodSync(pathname, 0o700)
  for (const name of readdirSync(pathname)) makeWritable(join(pathname, name))
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
}

function waitForJsonLine(child: ChildProcess, stderr: () => string): Promise<Record<string, string>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let source = ''
    const timer = setTimeout(() => finish(new Error(`timed out waiting for held receipt: ${stderr()}`)), 15_000)
    const finish = (error?: Error, value?: Record<string, string>) => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
      if (error) rejectPromise(error)
      else resolvePromise(value as Record<string, string>)
    }
    const onData = (chunk: Buffer | string) => {
      source += String(chunk)
      const newline = source.indexOf('\n')
      if (newline === -1) return
      try { finish(undefined, JSON.parse(source.slice(0, newline)) as Record<string, string>) } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`holder exited before readiness (${String(code)}/${String(signal)}): ${stderr()}`))
    }
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
  })
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function rewriteJson(pathname: string, value: unknown): string {
  const source = `${JSON.stringify(value)}\n`
  chmodSync(pathname, 0o600)
  writeFileSync(pathname, source, { mode: 0o600 })
  chmodSync(pathname, 0o400)
  return sha256(source)
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orphan-runtime-retire-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const tools = join(root, 'tools')
  const runRoot = join(root, 'run')
  const quarantineRoot = join(root, 'quarantine')
  const workspace = join(root, 'state', 'media-tasks', 'a'.repeat(64))
  const batchRoot = join(root, 'batches')
  const launchAgents = join(root, 'LaunchAgents')
  const deploymentRun = join(root, 'blue-green-run')
  const eventLog = join(root, 'events.log')
  for (const pathname of [tools, runRoot, quarantineRoot, workspace, batchRoot, launchAgents]) {
    mkdirSync(pathname, { recursive: true, mode: 0o700 })
    chmodSync(pathname, 0o700)
  }
  mkdirSync(join(workspace, 'frames'), { mode: 0o700 })
  writeFileSync(join(workspace, 'metadata.json'), '{"kind":"prepared-video"}\n', { mode: 0o600 })
  writeFileSync(join(workspace, 'frames', 'frame.jpg'), 'frame', { mode: 0o600 })
  const plistPath = join(launchAgents, 'ai.aiworker.video-lane-supervisor.plist')
  writeFileSync(plistPath, 'test plist\n', { mode: 0o600 })
  const queueFile = join(root, 'queue.json')
  writeFileSync(queueFile, JSON.stringify({ counts: { waiting: 0, running: 0 }, queue: [] }), { mode: 0o600 })
  const lockPath = join(batchRoot, '.global-video-worker.lock')
  writeFileSync(lockPath, `${JSON.stringify({
    pid: 3000,
    token: '12345678-1234-4123-8123-123456789abc',
    createdAt: '2026-08-31T00:00:00.000Z',
  })}\n`, { mode: 0o600 })
  const statePath = join(root, 'state.json')
  const state: State = {
    loaded: true,
    disabled: false,
    workers: [3000],
    workerPid: 3000,
    workspace,
    plistPath,
    lockPath,
    childStatus: 'failed',
    childError: reconciledError,
    childCompletedAt: 2000,
    childUpdatedAt: 2000,
    parentDigest: 'a'.repeat(64),
    executionDigest: 'b'.repeat(64),
    mediaActive: 0,
    n8nActive: 0,
    queueWaiting: 0,
    queueRunning: 0,
    protected3017: 9101,
    protected5678: 9202,
    protected5679: 9202,
    protected18091: 4404,
    protected18789: 5505,
    protected18889: 9606,
    protected18989: 7707,
    drift18889OnSecond: false,
    retireSnapshotCalls: 0,
  }
  const writeState = (changes: Partial<State> = {}) => {
    if (existsSync(statePath)) Object.assign(state, JSON.parse(readFileSync(statePath, 'utf8')) as State)
    Object.assign(state, changes)
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
  }
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as State
  writeState()

  const snapshot = join(tools, 'snapshot')
  executable(snapshot, `#!${process.execPath}
const fs=require('node:fs');const crypto=require('node:crypto')
const state=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'));const phase=process.argv[2]
let lock={present:false,path:state.lockPath}
if(fs.existsSync(state.lockPath)){const source=fs.readFileSync(state.lockPath,'utf8');const value=JSON.parse(source);const entry=fs.lstatSync(state.lockPath,{bigint:true});lock={present:true,path:state.lockPath,dev:String(entry.dev),ino:String(entry.ino),uid:Number(entry.uid),mode:Number(entry.mode&0o7777n),bytes:Buffer.byteLength(source),contentSha256:crypto.createHash('sha256').update(source).digest('hex'),ownerPid:value.pid,tokenSha256:crypto.createHash('sha256').update(value.token).digest('hex'),createdAt:value.createdAt}}
const plistEntry=fs.lstatSync(state.plistPath,{bigint:true})
process.stdout.write(JSON.stringify({
 protectedPids:{'3017':1101,'5678':2202,'5679':3303,'18091':4404,'18789':5505,'18889':6606,'18989':7707},
 legacy:{pid:1101,database:{path:'/test/mission',dev:'1',ino:'2'}},n8n:{pid:2202,database:{path:'/test/n8n',dev:'1',ino:'3'}},
 mission:{path:'/test/mission',dev:'1',ino:'2'},n8nDatabase:{path:'/test/n8n',dev:'1',ino:'3'},
 orphan:{workspace:state.workspace,child:{id:51,taskId:'media-child',status:'running',updatedAt:1000,stage:'vision'},parent:{id:50,taskId:'parent-task',status:'failed',digest:'a'.repeat(64)},execution:{id:'101',status:'error',digest:'b'.repeat(64)}},
 queue:{waiting:0,running:0,digest:'e'.repeat(64)},batchRoot:${JSON.stringify(batchRoot)},plistPath:state.plistPath,
 lane:{service:{loaded:state.loaded,pid:state.loaded?state.workerPid:null},disabled:state.disabled,workers:state.workers,worker:phase==='active'?{pid:state.workerPid}:null,lock,plist:{path:state.plistPath,dev:String(plistEntry.dev),ino:String(plistEntry.ino),uid:Number(plistEntry.uid),mode:Number(plistEntry.mode&0o7777n)},projection:{runnable:0,journals:0,digest:'d'.repeat(64)}}
}))
`)

  const retireSnapshot = join(tools, 'retire-snapshot')
  executable(retireSnapshot, `#!${process.execPath}
const fs=require('node:fs');const crypto=require('node:crypto')
const state=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'));const phase=process.argv[2];const call=state.retireSnapshotCalls||0;state.retireSnapshotCalls=call+1;fs.writeFileSync(process.env.GUARD_STATE,JSON.stringify(state),{mode:0o600})
let lock={present:false,path:state.lockPath}
if(fs.existsSync(state.lockPath)){const source=fs.readFileSync(state.lockPath,'utf8');const value=JSON.parse(source);const entry=fs.lstatSync(state.lockPath,{bigint:true});lock={present:true,path:state.lockPath,dev:String(entry.dev),ino:String(entry.ino),uid:Number(entry.uid),mode:Number(entry.mode&0o7777n),bytes:Buffer.byteLength(source),contentSha256:crypto.createHash('sha256').update(source).digest('hex'),ownerPid:value.pid,tokenSha256:crypto.createHash('sha256').update(value.token).digest('hex'),createdAt:value.createdAt}}
const plistEntry=fs.lstatSync(state.plistPath,{bigint:true})
process.stdout.write(JSON.stringify({
 protectedPids:{'3017':state.protected3017,'5678':state.protected5678,'5679':state.protected5679,'18091':state.protected18091,'18789':state.protected18789,'18889':state.protected18889+(state.drift18889OnSecond&&call>0?1:0),'18989':state.protected18989},
 mission:{path:'/test/mission',dev:'1',ino:'2'},n8nDatabase:{path:'/test/n8n',dev:'1',ino:'3'},
 queue:{waiting:state.queueWaiting,running:state.queueRunning,digest:'post-cas-queue'},batchRoot:${JSON.stringify(batchRoot)},plistPath:state.plistPath,
 lane:{service:{loaded:state.loaded,pid:state.loaded?state.workerPid:null},disabled:state.disabled,workers:state.workers,worker:phase==='active'?{pid:state.workerPid}:null,lock,plist:{path:state.plistPath,dev:String(plistEntry.dev),ino:String(plistEntry.ino),uid:Number(plistEntry.uid),mode:Number(plistEntry.mode&0o7777n)},projection:{runnable:0,journals:0,digest:'d'.repeat(64)}},
 postCas:{child:{id:51,taskId:'media-child',source:'n8n-media-node',stage:'vision',status:state.childStatus,error:state.childError,completedAt:state.childCompletedAt,updatedAt:state.childUpdatedAt},parent:{id:50,taskId:'parent-task',status:'failed',digest:state.parentDigest},execution:{id:'101',status:'error',digest:state.executionDigest},mediaActive:state.mediaActive,n8nActive:state.n8nActive}
}))
`)

  const launchctl = join(tools, 'launchctl')
  executable(launchctl, `#!${process.execPath}
const fs=require('node:fs');const p=process.env.GUARD_STATE;const s=JSON.parse(fs.readFileSync(p,'utf8'));const a=process.argv.slice(2);const save=()=>fs.writeFileSync(p,JSON.stringify(s),{mode:0o600})
if(a[0]==='print-disabled'){process.stdout.write('disabled services = { "ai.aiworker.video-lane-supervisor" => '+(s.disabled?'disabled':'enabled')+' }\\n');process.exit(0)}
if(a[0]==='print'){if(s.loaded){process.stdout.write('state = running\\npid = '+s.workerPid+'\\n');process.exit(0)}process.exit(1)}
if(a[0]==='disable'){s.disabled=true;save();process.exit(0)}
if(a[0]==='bootout'){s.loaded=false;s.workers=[];save();process.exit(0)}
if(a[0]==='enable'){s.disabled=false;save();process.exit(0)}
if(a[0]==='bootstrap'){
 if(fs.existsSync(s.lockPath))process.exit(3)
 fs.writeFileSync(s.lockPath,JSON.stringify({pid:s.workerPid,token:'87654321-4321-4321-8321-cba987654321',createdAt:new Date().toISOString()})+'\\n',{mode:0o600})
 s.loaded=true;s.workers=[s.workerPid];save();process.exit(0)
}
process.exit(2)
`)
  const ps = join(tools, 'ps')
  executable(ps, `#!${process.execPath}
const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'));const a=process.argv.slice(2);const pid=Number(a[a.indexOf('-p')+1]);if(a.at(-1)!=='pid=')process.exit(2)
if(s.workers.includes(pid)){process.stdout.write(String(pid)+'\\n');process.exit(0)}
if(process.env.GUARD_EVENT_LOG&&fs.existsSync(process.env.GUARD_EVENT_LOG)&&fs.readFileSync(process.env.GUARD_EVENT_LOG,'utf8').includes('guardian:handoff'))process.exit(1)
try{process.kill(pid,0);process.stdout.write(String(pid)+'\\n');process.exit(0)}catch{process.exit(1)}
`)
  const lsof = join(tools, 'lsof')
  executable(lsof, `#!${process.execPath}
process.exit(1)
`)

  const finalVerifier = join(tools, 'final-readiness-verifier')
  executable(finalVerifier, `#!${process.execPath}
const fs=require('node:fs');const crypto=require('node:crypto');const args=process.argv.slice(2)
if(args[0]!=='verify-live')process.exit(2)
const reportPath=args[args.indexOf('--report')+1];const prepared=args[args.indexOf('--prepared-receipt')+1]
const source=fs.readFileSync(reportPath,'utf8');const report=JSON.parse(source);const state=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'))
const snapshot={gatewayPid:state.protected18889+(state.drift18889OnSecond&&state.retireSnapshotCalls>0?1:0),n8nPids:[state.protected5678,state.protected5679],releaseId:'final-runtime',routerGeneration:7,routerPid:state.protected3017,unchangedPids:{'18091':state.protected18091,'18789':state.protected18789,'18989':state.protected18989}}
if(report.preparedReceipt!==prepared||JSON.stringify(report.snapshot)!==JSON.stringify(snapshot))process.exit(3)
const entry=fs.lstatSync(reportPath,{bigint:true});const snapshotSource=JSON.stringify(snapshot)
process.stdout.write(JSON.stringify({schema:'video-autoworker-legacy-retire-final-readiness-verification/v1',ok:true,report:{path:reportPath,dev:String(entry.dev),ino:String(entry.ino),uid:Number(entry.uid),mode:Number(entry.mode&0o7777n),nlink:Number(entry.nlink),size:Number(entry.size),sha256:crypto.createHash('sha256').update(source).digest('hex')},snapshot,snapshotSha256:crypto.createHash('sha256').update(snapshotSource).digest('hex')}))
`)

  const consumeAuthorization = join(tools, 'consume-authorization')
  executable(consumeAuthorization, `#!${process.execPath}
const {spawnSync}=require('node:child_process');const fs=require('node:fs')
const moduleUrl=${JSON.stringify(pathToFileURL(join(repositoryRoot, 'openclaw-skills/aiworker-task-flow/lib/worker-launch-authorization.mjs')).href)}
const source='import('+JSON.stringify(moduleUrl)+').then(module=>module.consumeWorkerLaunchAuthorizationSync({batchRoot:process.argv[1],workerPid:Number(process.argv[2])}))'
const child=spawnSync(process.execPath,['--input-type=module','-e',source,process.argv[2],process.argv[3]],{env:process.env,encoding:'utf8'})
if(child.signal){const p=process.env.GUARD_STATE;const s=JSON.parse(fs.readFileSync(p,'utf8'));try{fs.unlinkSync(s.lockPath)}catch{};s.workerPid+=1;s.loaded=true;s.workers=[s.workerPid];fs.writeFileSync(s.lockPath,JSON.stringify({pid:s.workerPid,token:'abcdefab-cdef-4abc-8def-abcdefabcdef',createdAt:new Date().toISOString()})+'\\n',{mode:0o600});fs.writeFileSync(p,JSON.stringify(s),{mode:0o600});process.exit(1)}
if(child.status!==0){process.stderr.write(child.stderr||'consume failed\\n');process.exit(1)}
`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    NODE_ENV: 'test',
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD: '1',
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_SNAPSHOT_COMMAND: snapshot,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_RETIRE_SNAPSHOT_COMMAND: retireSnapshot,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_LAUNCHCTL: launchctl,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_PS: ps,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_LSOF: lsof,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_REAL_BATCH_PROJECTION: '1',
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_EVENT_LOG: eventLog,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_QUEUE_FILE: queueFile,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FINAL_READINESS_VERIFIER: finalVerifier,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_CONSUME_AUTHORIZATION_COMMAND: consumeAuthorization,
    AIWORKER_BG_RUN_DIR: deploymentRun,
    GUARD_STATE: statePath,
    GUARD_EVENT_LOG: eventLog,
  }
  const run = (args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(
    process.execPath,
    [script, ...args],
    { encoding: 'utf8', env: { ...env, ...extra } },
  )
  const startHeld = async () => {
    let stderr = ''
    const holder = spawn(process.execPath, [
      script, 'prepare', '--run-root', runRoot, '--quarantine-root', quarantineRoot,
      '--minimum-age-seconds', '900', '--hold-guardian', 'yes',
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    holder.stderr?.on('data', chunk => { stderr += String(chunk) })
    const prepared = await waitForJsonLine(holder, () => stderr)
    const current = readState()
    const finalReadiness = join(root, 'final-readiness.json')
    writeFileSync(finalReadiness, `${JSON.stringify({
      schema: 'video-autoworker-legacy-retire-final-readiness/v1',
      preparedReceipt: prepared.receipt,
      snapshot: {
        gatewayPid: current.protected18889,
        n8nPids: [current.protected5678, current.protected5679],
        releaseId: 'final-runtime',
        routerGeneration: 7,
        routerPid: current.protected3017,
        unchangedPids: {
          '18091': current.protected18091,
          '18789': current.protected18789,
          '18989': current.protected18989,
        },
      },
    })}\n`, { mode: 0o400 })
    chmodSync(finalReadiness, 0o400)
    prepared.finalReadiness = finalReadiness
    return { holder, prepared, stderr: () => stderr }
  }
  return {
    root,
    runRoot,
    batchRoot,
    deploymentRun,
    eventLog,
    state,
    writeState,
    readState,
    run,
    retire: (prepared: Record<string, string>, extra: Partial<NodeJS.ProcessEnv> = {}) => run([
      'retire', '--receipt', prepared.receipt,
      '--final-readiness', prepared.finalReadiness,
    ], extra),
    startHeld,
  }
}

function parseOutput(result: ReturnType<typeof spawnSync>): Record<string, string> {
  expect(result.status, String(result.stderr)).toBe(0)
  return JSON.parse(String(result.stdout)) as Record<string, string>
}

function rewritePreparedTool(receiptPath: string, toolSha256: string): void {
  const attempt = dirname(receiptPath)
  chmodSync(attempt, 0o700)
  const intentPath = join(attempt, 'intent.json')
  const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as { toolSha256: string }
  intent.toolSha256 = toolSha256
  const intentSha256 = rewriteJson(intentPath, intent)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    toolSha256: string
    intent: { sha256: string }
  }
  receipt.toolSha256 = toolSha256
  receipt.intent.sha256 = intentSha256
  const receiptSha256 = rewriteJson(receiptPath, receipt)
  const anchorPath = join(attempt, 'receipt.anchor.json')
  const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as {
    intentSha256: string
    reference: { sha256: string }
  }
  anchor.intentSha256 = intentSha256
  anchor.reference.sha256 = receiptSha256
  rewriteJson(anchorPath, anchor)
  chmodSync(attempt, 0o500)
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child).catch(() => undefined)
    }
  }
  for (const root of roots.splice(0)) {
    makeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy media orphan post-CAS guardian retire', () => {
  it('hands a live holder to one global-lock worker and retires idempotently', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const retired = parseOutput(fixture.retire(prepared))
    expect(retired).toMatchObject({ mode: 'retired', receipt: prepared.receipt })
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(fixture.readState()).toMatchObject({ loaded: true, disabled: false, workers: [3000] })
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
    expect(existsSync(join(fixture.deploymentRun, '.deployment.lock'))).toBe(false)
    expect(parseOutput(fixture.retire(prepared))).toEqual(retired)
  }, 30_000)

  it('takes over a dead holder and still completes the continuous handoff', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    expect(holder.kill('SIGKILL')).toBe(true)
    expect(await waitForExit(holder)).toEqual({ code: null, signal: 'SIGKILL' })
    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(fixture.readState()).toMatchObject({ loaded: true, disabled: false, workers: [3000] })
  }, 30_000)

  it('accepts the attested router, n8n pair, and qwen-current replacements', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
  }, 30_000)

  it('rejects a second qwen-current 18889 PID drift across initial retire samples', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    fixture.writeState({ protected18889: 8808, drift18889OnSecond: true })
    const result = fixture.retire(prepared)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('final-readiness verification failed')
    expect(holder.exitCode).toBeNull()
  }, 30_000)

  it.each([
    ['child CAS', { childError: '[LEGACY_MEDIA_ORPHAN_RECONCILED] drift' }],
    ['parent', { parentDigest: 'c'.repeat(64) }],
    ['execution', { executionDigest: 'c'.repeat(64) }],
    ['active media', { mediaActive: 1 }],
    ['active n8n', { n8nActive: 1 }],
    ['queue', { queueWaiting: 1 }],
    ['attested router', { protected3017: 9999 }],
    ['attested n8n', { protected5678: 9998 }],
    ['attested n8n webhook', { protected5679: 9997 }],
    ['attested Gateway', { protected18889: 9996 }],
    ['unchanged 18091', { protected18091: 9995 }],
    ['unchanged 18789', { protected18789: 9994 }],
    ['unchanged 18989', { protected18989: 9993 }],
  ])('fails closed when post-CAS %s evidence drifts', async (_label, change) => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    fixture.writeState(change)
    const result = fixture.retire(prepared)
    expect(result.status).not.toBe(0)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(true)
    expect(fixture.readState()).toMatchObject({ loaded: false, disabled: true, workers: [] })
    expect(existsSync(join(fixture.deploymentRun, '.deployment.lock'))).toBe(false)
    expect(holder.exitCode).toBeNull()
  }, 30_000)

  it('fails closed when the quarantined tree drifts', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const receipt = JSON.parse(readFileSync(prepared.receipt, 'utf8')) as { target: { path: string } }
    chmodSync(receipt.target.path, 0o700)
    writeFileSync(join(receipt.target.path, 'drift'), 'drift\n', { mode: 0o600 })
    const result = fixture.retire(prepared)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('tree changed')
    expect(holder.exitCode).toBeNull()
  }, 30_000)

  it('recovers after the worker consumed the marker but the owner remained', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const failed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_AFTER_RETIRE_MARKER_CONSUMED_BEFORE_OWNER_CLEANUP: '1',
    })
    expect(failed.status).not.toBe(0)
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(true)
    expect(existsSync(join(fixture.deploymentRun, '.deployment.lock'))).toBe(false)
    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
  }, 30_000)

  it('recovers after SIGKILL with an active successor before authorization publication', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const killed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_RETIRE_SUCCESSOR_ACTIVE_BEFORE_AUTHORIZATION: '1',
    })
    expect(killed.signal).toBe('SIGKILL')
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(fixture.readState()).toMatchObject({ loaded: true, disabled: false, workers: [3000] })
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(true)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization'))).toBe(false)
    expect(existsSync(join(fixture.deploymentRun, '.deployment.lock'))).toBe(true)

    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
    expect(existsSync(join(fixture.deploymentRun, '.deployment.lock'))).toBe(false)
  }, 30_000)

  it('recovers after SIGKILL with a strictly validated pending worker authorization', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const killed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_RETIRE_WORKER_AUTHORIZATION: '1',
    })
    expect(killed.signal).toBe('SIGKILL')
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(true)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization'))).toBe(true)

    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
  }, 30_000)

  it.each([
    ['pending fsync', 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_PENDING_FSYNC'],
    ['authorization publish', 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_PUBLISH'],
  ])('recovers a controller killed after %s', async (_label, checkpoint) => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const killed = fixture.retire(prepared, { [checkpoint]: '1' })
    expect(killed.signal).toBe('SIGKILL')
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(true)

    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization.pending'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization.claim'))).toBe(false)
  }, 30_000)

  it.each([
    ['before claim publication', 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_BEFORE_CLAIM'],
    ['after claim publication', 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_CLAIM_PUBLISHED'],
    ['after authorization removal', 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_CLAIM'],
    ['after marker removal', 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_MARKER_REMOVED'],
    ['after claim removal', 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_CLAIM_REMOVED'],
  ])('reconciles a worker killed %s', async (_label, checkpoint) => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const failed = fixture.retire(prepared, { [checkpoint]: '1' })
    expect(failed.status).not.toBe(0)
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    const retriesBeforeRecovery = readFileSync(fixture.eventLog, 'utf8')
      .split('\n')
      .filter(event => event === 'guardian:refresh-retry')
      .length
    const retryEnvironment = checkpoint === 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_BEFORE_CLAIM'
      ? { AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_MTIME_STALLS: '1' }
      : {}
    expect(parseOutput(fixture.retire(prepared, retryEnvironment)).mode).toBe('retired')
    if (checkpoint === 'AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_BEFORE_CLAIM') {
      const retriesAfterRecovery = readFileSync(fixture.eventLog, 'utf8')
        .split('\n')
        .filter(event => event === 'guardian:refresh-retry')
        .length
      expect(retriesAfterRecovery - retriesBeforeRecovery).toBe(1)
    }
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization.pending'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.authorization.claim'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
  }, 30_000)

  it('fails closed after the bounded guardian mtime refresh retries are exhausted', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const failed = fixture.retire(prepared, {
      AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_BEFORE_CLAIM: '1',
    })
    expect(failed.status).not.toBe(0)
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })

    const countRefreshRetries = () => readFileSync(fixture.eventLog, 'utf8')
      .split('\n')
      .filter(event => event === 'guardian:refresh-retry')
      .length
    const retriesBeforeStall = countRefreshRetries()
    const stalled = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_MTIME_STALLS: '2',
    })
    expect(stalled.status).not.toBe(0)
    expect(stalled.stderr).toContain('mtime refresh was not durable and monotonic')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(true)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(true)
    expect(countRefreshRetries() - retriesBeforeStall).toBe(1)

    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
  }, 30_000)

  it('rejects a drifted pending authorization instead of ignoring the transitional file', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const killed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_RETIRE_WORKER_AUTHORIZATION: '1',
    })
    expect(killed.signal).toBe('SIGKILL')
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    const authorizationPath = join(fixture.batchRoot, '.worker-launch.lock.authorization')
    const authorization = JSON.parse(readFileSync(authorizationPath, 'utf8')) as { workerPid: number }
    authorization.workerPid += 1
    writeFileSync(authorizationPath, `${JSON.stringify(authorization)}\n`, { mode: 0o600 })
    chmodSync(authorizationPath, 0o600)

    const rejected = fixture.retire(prepared)
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('authorization')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(true)
  }, 30_000)

  it('recovers a sealed deployment lock only after the killed owner is gone', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const killed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_DEPLOYMENT_LOCK_SEALED: '1',
    })
    expect(killed.signal).toBe('SIGKILL')
    expect(existsSync(join(fixture.deploymentRun, '.deployment.lock'))).toBe(true)
    expect(holder.exitCode).toBeNull()

    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(existsSync(join(fixture.deploymentRun, '.deployment.lock'))).toBe(false)
  }, 30_000)

  it('rejects same-content final-readiness inode replacement after retire intent', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const failed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_AFTER_RETIRE_INTENT: '1',
    })
    expect(failed.status).not.toBe(0)
    expect(existsSync(join(dirname(prepared.receipt), 'retire-intent.json'))).toBe(true)
    const source = readFileSync(prepared.finalReadiness, 'utf8')
    const replacement = `${prepared.finalReadiness}.replacement`
    writeFileSync(replacement, source, { mode: 0o400 })
    chmodSync(replacement, 0o400)
    renameSync(replacement, prepared.finalReadiness)

    const rejected = fixture.retire(prepared)
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('retire intent final-readiness identity')
    expect(holder.exitCode).toBeNull()
  }, 30_000)

  it('recovers when owner cleanup completed but retire receipt publication failed', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const failed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_OUTPUT_BASENAME: 'retire.json',
    })
    expect(failed.status).not.toBe(0)
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(existsSync(join(dirname(prepared.receipt), 'retire.json'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
  }, 30_000)

  it('recovers when retire receipt exists but its anchor publication failed', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    const failed = fixture.retire(prepared, {
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_OUTPUT_BASENAME: 'retire.anchor.json',
    })
    expect(failed.status).not.toBe(0)
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(existsSync(join(dirname(prepared.receipt), 'retire.json'))).toBe(true)
    expect(existsSync(join(dirname(prepared.receipt), 'retire.anchor.json'))).toBe(false)
    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
  }, 30_000)

  it('accepts the exact predecessor only for retire and blocks restore/recover/status afterward', async () => {
    const fixture = createFixture()
    const { holder, prepared } = await fixture.startHeld()
    rewritePreparedTool(prepared.receipt, retirablePredecessor)
    for (const args of [
      ['status', '--receipt', prepared.receipt],
      ['restore', '--receipt', prepared.receipt],
      ['recover', '--intent', join(dirname(prepared.receipt), 'intent.json')],
    ]) {
      const rejected = fixture.run(args)
      expect(rejected.status).not.toBe(0)
    }
    expect(parseOutput(fixture.retire(prepared)).mode).toBe('retired')
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(fixture.run(['restore', '--receipt', prepared.receipt]).stderr).toContain('retire artifacts')
    expect(fixture.run(['recover', '--intent', join(dirname(prepared.receipt), 'intent.json')]).stderr)
      .toContain('retire artifacts')
  }, 30_000)
})
