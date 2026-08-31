import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const script = join(repositoryRoot, 'scripts/legacy-media-orphan-runtime-guard.mjs')
const roots: string[] = []

function executable(pathname: string, source: string): void {
  writeFileSync(pathname, source, { mode: 0o700 })
  chmodSync(pathname, 0o700)
}

function makeWritable(pathname: string): void {
  if (!existsSync(pathname)) return
  const entry = statSync(pathname)
  if (!entry.isDirectory()) { chmodSync(pathname, 0o600); return }
  chmodSync(pathname, 0o700)
  for (const name of readdirSync(pathname)) makeWritable(join(pathname, name))
}

type State = {
  loaded: boolean
  disabled: boolean
  workers: number[]
  failDisable: boolean
  failBootout: boolean
  leaveWorker: boolean
  removeLock: boolean
  driftLock: boolean
  replaceLock: boolean
  lockOpen: boolean
  mutateWorkspace: boolean
  pidReuse: boolean
  workspace: string
  plistPath: string
  lockPath: string
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orphan-runtime-guard-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const tools = join(root, 'tools')
  const runRoot = join(root, 'run')
  const quarantineRoot = join(root, 'quarantine')
  const stateRoot = join(root, 'state')
  const workspaceParent = join(stateRoot, 'media-tasks')
  const workspace = join(workspaceParent, 'a'.repeat(64))
  const batchRoot = join(root, 'batches')
  const launchAgents = join(root, 'LaunchAgents')
  for (const pathname of [tools, runRoot, quarantineRoot, stateRoot, workspaceParent, workspace, batchRoot, launchAgents]) {
    mkdirSync(pathname, { recursive: true, mode: 0o700 })
    chmodSync(pathname, 0o700)
  }
  mkdirSync(join(workspace, 'frames'), { mode: 0o700 })
  writeFileSync(join(workspace, 'metadata.json'), '{"kind":"prepared-video"}\n', { mode: 0o600 })
  writeFileSync(join(workspace, 'frames', 'frame.jpg'), Buffer.from('frame'), { mode: 0o600 })
  const plistPath = join(launchAgents, 'ai.aiworker.video-lane-supervisor.plist')
  writeFileSync(plistPath, 'test plist\n', { mode: 0o600 })
  const queueFile = join(root, 'queue.json')
  writeFileSync(queueFile, JSON.stringify({ counts: { waiting: 0, running: 0, attention: 1 }, queue: [{}] }), { mode: 0o600 })
  const statePath = join(root, 'state.json')
  const eventLog = join(root, 'events.log')
  const lockPath = join(batchRoot, '.global-video-worker.lock')
  const lockValue = {
    pid: 3000,
    token: '12345678-1234-4123-8123-123456789abc',
    createdAt: '2026-08-31T00:00:00.000Z',
  }
  writeFileSync(lockPath, `${JSON.stringify(lockValue)}\n`, { mode: 0o600 })
  const state: State = {
    loaded: true,
    disabled: false,
    workers: [3000],
    failDisable: false,
    failBootout: false,
    leaveWorker: false,
    removeLock: false,
    driftLock: false,
    replaceLock: false,
    lockOpen: false,
    mutateWorkspace: false,
    pidReuse: false,
    workspace,
    plistPath,
    lockPath,
  }
  const writeState = (changes: Partial<State> = {}) => {
    Object.assign(state, changes)
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
  }
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as State
  writeState()

  const snapshot = join(tools, 'snapshot')
  executable(snapshot, `#!${process.execPath}
const fs=require('node:fs')
const crypto=require('node:crypto')
const state=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'))
const phase=process.argv[2]
let lock={present:false,path:state.lockPath}
if(fs.existsSync(state.lockPath)){
  const source=fs.readFileSync(state.lockPath,'utf8')
  const value=JSON.parse(source)
  const entry=fs.lstatSync(state.lockPath,{bigint:true})
  lock={present:true,path:state.lockPath,dev:String(entry.dev),ino:String(entry.ino),uid:Number(entry.uid),mode:Number(entry.mode&0o7777n),bytes:Buffer.byteLength(source),contentSha256:crypto.createHash('sha256').update(source).digest('hex'),ownerPid:value.pid,tokenSha256:crypto.createHash('sha256').update(value.token).digest('hex'),createdAt:value.createdAt}
}
const lane={
  service:{loaded:state.loaded,pid:state.loaded?3000:null}, disabled:state.disabled,
  workers:state.workers, worker:phase==='active'?{pid:3000}:null, lock,
  projection:{runnable:0,journals:0,digest:'d'.repeat(64)}
}
const protectedPids={'3017':1101,'5678':2202,'5679':3303,'18091':4404,'18789':5505,'18889':6606,'18989':7707}
if(state.pidReuse && phase==='quiesced') protectedPids['3017']=9999
process.stdout.write(JSON.stringify({
  protectedPids,
  legacy:{pid:1101,database:{path:'/test/mission',dev:'1',ino:'2'}},
  n8n:{pid:2202,database:{path:'/test/n8n',dev:'1',ino:'3'}},
  orphan:{workspace:state.workspace,child:{status:'running'},parent:{status:'failed'},execution:{status:'error'}},
  queue:{waiting:0,running:0,digest:'e'.repeat(64)},
  batchRoot:${JSON.stringify(batchRoot)},plistPath:state.plistPath,lane
}))
`)
  const launchctl = join(tools, 'launchctl')
  executable(launchctl, `#!${process.execPath}
const fs=require('node:fs')
const p=process.env.GUARD_STATE
const s=JSON.parse(fs.readFileSync(p,'utf8'))
const a=process.argv.slice(2)
const save=()=>fs.writeFileSync(p,JSON.stringify(s),{mode:0o600})
if(a[0]==='print-disabled'){process.stdout.write('disabled services = { "ai.aiworker.video-lane-supervisor" => '+s.disabled+' }\\n');process.exit(0)}
if(a[0]==='print'){
  if(s.loaded){process.stdout.write('state = running\\npid = 3000\\n');process.exit(0)}
  process.exit(1)
}
if(a[0]==='disable'){
  if(s.failDisable) process.exit(2)
  s.disabled=true;save();process.exit(0)
}
if(a[0]==='bootout'){
  if(s.failBootout) process.exit(2)
  s.loaded=false
  if(!s.leaveWorker)s.workers=[]
  if(s.removeLock&&fs.existsSync(s.lockPath))fs.unlinkSync(s.lockPath)
  if(s.driftLock&&fs.existsSync(s.lockPath)){
    const value=JSON.parse(fs.readFileSync(s.lockPath,'utf8'));value.token='abcdefab-cdef-4abc-8def-abcdefabcdef'
    fs.writeFileSync(s.lockPath,JSON.stringify(value)+'\\n',{mode:0o600});s.driftLock=false
  }
  if(s.replaceLock&&fs.existsSync(s.lockPath)){
    const replacement=s.lockPath+'.replacement'
    fs.writeFileSync(replacement,fs.readFileSync(s.lockPath),{mode:0o600});fs.renameSync(replacement,s.lockPath);s.replaceLock=false
  }
  if(s.mutateWorkspace)fs.writeFileSync(s.workspace+'/late-file','drift',{mode:0o600})
  save();process.exit(0)
}
if(a[0]==='enable'){s.disabled=false;save();process.exit(0)}
if(a[0]==='bootstrap'){
  if(fs.existsSync(s.lockPath))process.exit(3)
  fs.writeFileSync(s.lockPath,JSON.stringify({pid:3000,token:'87654321-4321-4321-8321-cba987654321',createdAt:new Date().toISOString()})+'\\n',{mode:0o600})
  s.loaded=true;s.workers=[3000];save();process.exit(0)
}
process.exit(2)
`)
  const ps = join(tools, 'ps')
  executable(ps, `#!${process.execPath}
const fs=require('node:fs')
const s=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'))
const args=process.argv.slice(2);const pid=Number(args[args.indexOf('-p')+1]);const field=args.at(-1)
if(field!=='pid=')process.exit(2)
if(pid===3000){if(s.workers.includes(pid)||s.pidReuse){process.stdout.write(String(pid)+'\\n');process.exit(0)}process.exit(1)}
try{process.kill(pid,0);process.stdout.write(String(pid)+'\\n');process.exit(0)}catch{process.exit(1)}
`)
  const lsof = join(tools, 'lsof')
  executable(lsof, `#!${process.execPath}
const fs=require('node:fs')
const s=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'))
if(s.lockOpen&&process.argv.includes(s.lockPath)){process.stdout.write('p9000\\n');process.exit(0)}
process.exit(1)
`)
  const conflict = join(tools, 'conflict')
  executable(conflict, `#!${process.execPath}
require('node:fs').mkdirSync(process.argv[3],{mode:0o700})
`)
  const replaceGuardian = join(tools, 'replace-guardian')
  executable(replaceGuardian, `#!${process.execPath}
const fs=require('node:fs')
const intent=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
const replacement=intent.launchGuardian.path+'.replacement'
fs.writeFileSync(replacement,'replacement guardian\\n',{mode:0o600})
fs.renameSync(replacement,intent.launchGuardian.path)
`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    NODE_ENV: 'test',
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD: '1',
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_SNAPSHOT_COMMAND: snapshot,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_LAUNCHCTL: launchctl,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_PS: ps,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_LSOF: lsof,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_EVENT_LOG: eventLog,
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_REAL_BATCH_PROJECTION: '1',
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_QUEUE_FILE: queueFile,
    GUARD_STATE: statePath,
  }
  const run = (args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(
    process.execPath,
    [script, ...args],
    { encoding: 'utf8', env: { ...env, ...extra } },
  )
  const prepare = (extra: Partial<NodeJS.ProcessEnv> = {}) => run([
    'prepare', '--run-root', runRoot, '--quarantine-root', quarantineRoot,
    '--minimum-age-seconds', '900',
  ], extra)
  return {
    root, runRoot, quarantineRoot, batchRoot, workspace, state, writeState, readState, run, prepare,
    env, eventLog, conflict, replaceGuardian, lockPath,
  }
}

function parseOutput(result: ReturnType<typeof spawnSync>): Record<string, string> {
  expect(result.status, String(result.stderr)).toBe(0)
  return JSON.parse(String(result.stdout)) as Record<string, string>
}

function onlyChild(pathname: string): string {
  const names = readdirSync(pathname)
  expect(names).toHaveLength(1)
  return join(pathname, names[0])
}

function writeTerminalBatchPair(
  batchRoot: string,
  directoryName = '2026-08-27-retest',
  status = 'succeeded',
): string {
  const directory = join(batchRoot, directoryName)
  mkdirSync(directory, { mode: 0o700 })
  const name = `${'b'.repeat(64)}.json`
  const value = { schemaVersion: 2, batchId: 'batch-retest', status, items: [{ taskId: 'task-retest', status }] }
  writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`, { mode: 0o600 })
  writeFileSync(join(directory, `${name}.bak`), `${JSON.stringify(value)}\n`, { mode: 0o600 })
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy media orphan runtime guard', () => {
  it('accepts and binds one physical directory of paired terminal batch states', () => {
    const fixture = createFixture()
    const directory = writeTerminalBatchPair(fixture.batchRoot)
    const prepared = parseOutput(fixture.prepare())
    expect(prepared.mode).toBe('prepared')
    const receipt = JSON.parse(readFileSync(prepared.receipt, 'utf8')) as {
      runtimeBefore: { lane: { projection: { digest: string } } }
      runtimeQuiesced: { lane: { projection: { digest: string } } }
    }
    expect(receipt.runtimeBefore.lane.projection.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.runtimeQuiesced.lane.projection.digest).toBe(receipt.runtimeBefore.lane.projection.digest)

    const primary = join(directory, `${'b'.repeat(64)}.json`)
    chmodSync(primary, 0o600)
    const value = JSON.parse(readFileSync(primary, 'utf8')) as { items: Array<{ status: string }> }
    value.items[0].status = 'attention'
    writeFileSync(primary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    expect(fixture.run(['status', '--receipt', prepared.receipt]).status).not.toBe(0)
  })

  it('rejects active state inside a retained terminal directory', () => {
    const fixture = createFixture()
    writeTerminalBatchPair(fixture.batchRoot, '2026-08-27-retest', 'running')
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('active snapshot lane is invalid')
    expect(existsSync(fixture.workspace)).toBe(true)
  })

  it.each(['unknown', 'symlink'])('rejects a %s member inside a retained terminal directory', kind => {
    const fixture = createFixture()
    const directory = writeTerminalBatchPair(fixture.batchRoot)
    if (kind === 'unknown') writeFileSync(join(directory, 'notes.txt'), 'not controlled\n', { mode: 0o600 })
    else symlinkSync(join(directory, `${'b'.repeat(64)}.json`), join(directory, `${'c'.repeat(64)}.json`))
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unknown member|non-file member/u)
    expect(existsSync(fixture.workspace)).toBe(true)
  })

  it('prepares, reports, restores, and restores idempotently', () => {
    const fixture = createFixture()
    const prepared = parseOutput(fixture.prepare())
    expect(prepared.mode).toBe('prepared')
    expect(existsSync(fixture.workspace)).toBe(false)
    expect(statSync(prepared.receipt).mode & 0o777).toBe(0o400)
    expect(statSync(join(dirname(prepared.receipt), 'receipt.anchor.json')).mode & 0o777).toBe(0o400)
    expect(statSync(dirname(prepared.receipt)).mode & 0o777).toBe(0o500)
    const deadLock = join(dirname(prepared.receipt), 'dead-video-worker.lock')
    expect(statSync(deadLock).mode & 0o777).toBe(0o400)
    expect(existsSync(fixture.lockPath)).toBe(false)

    expect(parseOutput(fixture.run(['status', '--receipt', prepared.receipt])).mode).toBe('prepared')
    expect(parseOutput(fixture.run(['restore', '--receipt', prepared.receipt])).mode).toBe('restored')
    expect(existsSync(fixture.workspace)).toBe(true)
    expect(parseOutput(fixture.run(['restore', '--receipt', prepared.receipt])).mode).toBe('restored')
  })

  it.each([
    ['disable failure', { failDisable: true }],
    ['bootout failure', { failBootout: true }],
  ])('rolls the lane back after %s', (_name, state) => {
    const fixture = createFixture()
    fixture.writeState(state)
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(existsSync(fixture.workspace)).toBe(true)
    expect(fixture.readState()).toMatchObject({ loaded: true, disabled: false, workers: [3000] })
    expect(existsSync(fixture.lockPath)).toBe(true)
  })

  it('fails closed without starting a second worker when the old worker does not exit', () => {
    const fixture = createFixture()
    fixture.writeState({ leaveWorker: true })
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('stopped snapshot lane is invalid')
    expect(fixture.readState()).toMatchObject({ loaded: false, disabled: true, workers: [3000] })
  })

  it('fails closed when the captured global lock disappears during stop', () => {
    const fixture = createFixture()
    fixture.writeState({ removeLock: true })
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('stopped snapshot lane is invalid')
    expect(existsSync(fixture.workspace)).toBe(true)
  })

  it.each([
    ['content', { driftLock: true }],
    ['inode', { replaceLock: true }],
  ])('fails closed when the dead-owner lock %s drifts', (_name, state) => {
    const fixture = createFixture()
    fixture.writeState(state)
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('dead-owner lock drifted')
    expect(fixture.readState()).toMatchObject({ loaded: false, disabled: true, workers: [] })
    expect(existsSync(join(fixture.root, 'batches', '.worker-launch.lock'))).toBe(true)
  })

  it('fails closed while another process still has the dead-owner lock open', () => {
    const fixture = createFixture()
    fixture.writeState({ lockOpen: true })
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('still has the dead-owner lock open')
    expect(existsSync(fixture.workspace)).toBe(true)
    expect(existsSync(fixture.lockPath)).toBe(true)
  })

  it('fails closed when the workspace drifts and restores the lane', () => {
    const fixture = createFixture()
    fixture.writeState({ mutateWorkspace: true })
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('workspace tree changed')
    expect(existsSync(fixture.workspace)).toBe(true)
    expect(fixture.readState().loaded).toBe(true)
  })

  it('fails closed on a quarantine target conflict without moving the workspace', () => {
    const fixture = createFixture()
    const result = fixture.prepare({
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_AFTER_INTENT_COMMAND: fixture.conflict,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('quarantine target already exists')
    expect(existsSync(fixture.workspace)).toBe(true)
  })

  it('automatically reverses the rename when receipt publication fails', () => {
    const fixture = createFixture()
    const result = fixture.prepare({
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_OUTPUT_BASENAME: 'receipt.json',
    })
    expect(result.status).not.toBe(0)
    expect(existsSync(fixture.workspace)).toBe(true)
    expect(fixture.readState()).toMatchObject({ loaded: true, disabled: false, workers: [3000] })
    expect(existsSync(fixture.lockPath)).toBe(true)
    expect(existsSync(join(onlyChild(fixture.runRoot), 'dead-video-worker.lock'))).toBe(true)
  })

  it('rejects protected PID reuse during the pause window', () => {
    const fixture = createFixture()
    fixture.writeState({ pidReuse: true })
    const result = fixture.prepare()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('old video worker PID still exists or was reused')
    expect(existsSync(fixture.workspace)).toBe(true)
  })

  it('rejects forged content and inode replacement of the prepared receipt', () => {
    const fixture = createFixture()
    const prepared = parseOutput(fixture.prepare())
    const attempt = dirname(prepared.receipt)
    chmodSync(attempt, 0o700)
    chmodSync(prepared.receipt, 0o600)
    const value = JSON.parse(readFileSync(prepared.receipt, 'utf8')) as Record<string, unknown>
    value.target = { path: '/tmp/forged' }
    writeFileSync(prepared.receipt, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    chmodSync(prepared.receipt, 0o400)
    chmodSync(attempt, 0o500)
    expect(fixture.run(['status', '--receipt', prepared.receipt]).status).not.toBe(0)

    chmodSync(attempt, 0o700)
    const replacement = join(attempt, 'replacement')
    copyFileSync(join(attempt, 'intent.json'), replacement)
    chmodSync(replacement, 0o400)
    renameSync(replacement, prepared.receipt)
    chmodSync(attempt, 0o500)
    const replaced = fixture.run(['status', '--receipt', prepared.receipt])
    expect(replaced.status).not.toBe(0)
  })

  it('rejects drift of the quarantined dead-lock evidence', () => {
    const fixture = createFixture()
    const prepared = parseOutput(fixture.prepare())
    const attempt = dirname(prepared.receipt)
    const evidence = join(attempt, 'dead-video-worker.lock')
    chmodSync(attempt, 0o700)
    chmodSync(evidence, 0o600)
    writeFileSync(evidence, 'forged evidence\n', { mode: 0o600 })
    chmodSync(evidence, 0o400)
    chmodSync(attempt, 0o500)
    const result = fixture.run(['status', '--receipt', prepared.receipt])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('dead-owner lock evidence content changed')
  })

  it('never unlinks a replacement launch guardian', () => {
    const fixture = createFixture()
    const result = fixture.prepare({
      AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_AFTER_INTENT_COMMAND: fixture.replaceGuardian,
    })
    expect(result.status).not.toBe(0)
    const guardian = join(fixture.root, 'batches', '.worker-launch.lock')
    expect(readFileSync(guardian, 'utf8')).toBe('replacement guardian\n')
  })

  it('orders durable rename and receipt fsync operations', () => {
    const fixture = createFixture()
    parseOutput(fixture.prepare())
    const events = readFileSync(fixture.eventLog, 'utf8').trim().split('\n')
    const rename = events.indexOf('rename:workspace-to-quarantine')
    const deadLockRename = events.indexOf('rename:dead-lock-to-evidence')
    const deadLockFsync = events.indexOf('fsync-file:dead-video-worker.lock')
    const guardianCreate = events.indexOf('guardian:create')
    const guardianRelease = events.indexOf('guardian:release')
    const destinationFsync = events.indexOf('fsync-directory:quarantine')
    const sourceFsync = events.indexOf('fsync-directory:media-tasks')
    const publishReceipt = events.indexOf('publish:receipt.json')
    const receiptFsync = events.indexOf('fsync-file:receipt.json')
    expect(rename).toBeGreaterThan(-1)
    expect(deadLockRename).toBeGreaterThan(-1)
    expect(guardianCreate).toBeGreaterThan(-1)
    expect(deadLockRename).toBeGreaterThan(guardianCreate)
    expect(deadLockFsync).toBeGreaterThan(deadLockRename)
    expect(rename).toBeGreaterThan(deadLockFsync)
    expect(destinationFsync).toBeGreaterThan(rename)
    expect(sourceFsync).toBeGreaterThan(rename)
    expect(receiptFsync).toBeGreaterThan(publishReceipt)
    expect(guardianRelease).toBeGreaterThan(receiptFsync)
    expect(events.filter(event => event === 'guardian:refresh').length).toBeGreaterThanOrEqual(5)
  })

  it('continues safely from a SIGKILL after the same-device rename', () => {
    const fixture = createFixture()
    const killed = fixture.prepare({ AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_RENAME: '1' })
    expect(killed.signal).toBe('SIGKILL')
    expect(existsSync(fixture.workspace)).toBe(false)
    const attempt = onlyChild(fixture.runRoot)
    const intent = join(attempt, 'intent.json')
    const recovered = parseOutput(fixture.run(['recover', '--intent', intent]))
    expect(recovered.mode).toBe('recovered-after-rename')
    expect(readFileSync(fixture.eventLog, 'utf8')).toContain('guardian:takeover')
    expect(parseOutput(fixture.run(['status', '--receipt', recovered.receipt])).mode).toBe('prepared')
  })

  it('recovers from SIGKILL after stop by quarantining the original dead lock before restart', () => {
    const fixture = createFixture()
    const killed = fixture.prepare({ AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_STOP: '1' })
    expect(killed.signal).toBe('SIGKILL')
    expect(existsSync(fixture.workspace)).toBe(true)
    expect(existsSync(fixture.lockPath)).toBe(true)
    const attempt = onlyChild(fixture.runRoot)
    const recovered = parseOutput(fixture.run(['recover', '--intent', join(attempt, 'intent.json')]))
    expect(recovered.mode).toBe('recovered-before-rename')
    expect(existsSync(join(attempt, 'dead-video-worker.lock'))).toBe(true)
    expect(fixture.readState()).toMatchObject({ loaded: true, disabled: false, workers: [3000] })
  })
})
