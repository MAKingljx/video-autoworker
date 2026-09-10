import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const script = join(repositoryRoot, 'scripts/legacy-media-orphan-runtime-guard.mjs')
const predecessorSha256 = '95a873283b6f0c7c473354791eb9d57807735556de81fe27c1abb1aa035b6384'
const roots: string[] = []

type State = {
  loaded: boolean
  disabled: boolean
  workers: number[]
  workspace: string
  plistPath: string
  lockPath: string
}

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orphan-runtime-recovery-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const tools = join(root, 'tools')
  const runRoot = join(root, 'run')
  const quarantineRoot = join(root, 'quarantine')
  const workspaceParent = join(root, 'state', 'media-tasks')
  const workspace = join(workspaceParent, 'a'.repeat(64))
  const batchRoot = join(root, 'batches')
  const launchAgents = join(root, 'LaunchAgents')
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
  writeFileSync(queueFile, JSON.stringify({ counts: { waiting: 0, running: 0, attention: 1 }, queue: [{}] }), { mode: 0o600 })
  const lockPath = join(batchRoot, '.global-video-worker.lock')
  writeFileSync(lockPath, `${JSON.stringify({
    pid: 3000,
    token: '12345678-1234-4123-8123-123456789abc',
    createdAt: '2026-08-31T00:00:00.000Z',
  })}\n`, { mode: 0o600 })
  const statePath = join(root, 'state.json')
  const state: State = { loaded: true, disabled: false, workers: [3000], workspace, plistPath, lockPath }
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as State

  const snapshot = join(tools, 'snapshot')
  executable(snapshot, `#!${process.execPath}
const fs=require('node:fs');const crypto=require('node:crypto')
const state=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'));const phase=process.argv[2]
let lock={present:false,path:state.lockPath}
if(fs.existsSync(state.lockPath)){
  const source=fs.readFileSync(state.lockPath,'utf8');const value=JSON.parse(source);const entry=fs.lstatSync(state.lockPath,{bigint:true})
  lock={present:true,path:state.lockPath,dev:String(entry.dev),ino:String(entry.ino),uid:Number(entry.uid),mode:Number(entry.mode&0o7777n),bytes:Buffer.byteLength(source),contentSha256:crypto.createHash('sha256').update(source).digest('hex'),ownerPid:value.pid,tokenSha256:crypto.createHash('sha256').update(value.token).digest('hex'),createdAt:value.createdAt}
}
process.stdout.write(JSON.stringify({
  protectedPids:{'3017':1101,'5678':2202,'5679':3303,'18091':4404,'18789':5505,'18889':6606,'18989':7707},
  legacy:{pid:1101,database:{path:'/test/mission',dev:'1',ino:'2'}},n8n:{pid:2202,database:{path:'/test/n8n',dev:'1',ino:'3'}},
  orphan:{workspace:state.workspace,child:{status:'running'},parent:{status:'failed'},execution:{status:'error'}},queue:{waiting:0,running:0,digest:'e'.repeat(64)},
  batchRoot:${JSON.stringify(batchRoot)},plistPath:state.plistPath,
  lane:{service:{loaded:state.loaded,pid:state.loaded?3000:null},disabled:state.disabled,workers:state.workers,worker:phase==='active'?{pid:3000}:null,lock,projection:{runnable:0,journals:0,digest:'d'.repeat(64)}}
}))
`)
  const launchctl = join(tools, 'launchctl')
  executable(launchctl, `#!${process.execPath}
const fs=require('node:fs');const p=process.env.GUARD_STATE;const s=JSON.parse(fs.readFileSync(p,'utf8'));const a=process.argv.slice(2)
const save=()=>fs.writeFileSync(p,JSON.stringify(s),{mode:0o600})
if(a[0]==='print-disabled'){process.stdout.write('disabled services = { "ai.aiworker.video-lane-supervisor" => '+(s.disabled?'disabled':'enabled')+' }\\n');process.exit(0)}
if(a[0]==='print'){if(s.loaded){process.stdout.write('state = running\\npid = 3000\\n');process.exit(0)}process.exit(1)}
if(a[0]==='disable'){s.disabled=true;save();process.exit(0)}
if(a[0]==='bootout'){s.loaded=false;s.workers=[];save();process.exit(0)}
if(a[0]==='enable'){s.disabled=false;save();process.exit(0)}
if(a[0]==='bootstrap'){
  if(fs.existsSync(s.lockPath))process.exit(3)
  const handoff=require('node:path').join(require('node:path').dirname(s.lockPath),'.worker-launch.lock')
  if(fs.existsSync(handoff))fs.unlinkSync(handoff)
  fs.writeFileSync(s.lockPath,JSON.stringify({pid:3000,token:'87654321-4321-4321-8321-cba987654321',createdAt:new Date().toISOString()})+'\\n',{mode:0o600})
  s.loaded=true;s.workers=[3000];save();process.exit(0)
}
process.exit(2)
`)
  const ps = join(tools, 'ps')
  executable(ps, `#!${process.execPath}
const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'));const args=process.argv.slice(2);const pid=Number(args[args.indexOf('-p')+1])
if(args.at(-1)!=='pid=')process.exit(2)
if(pid===3000){if(s.workers.includes(pid)){process.stdout.write('3000\\n');process.exit(0)}process.exit(1)}
try{process.kill(pid,0);process.stdout.write(String(pid)+'\\n');process.exit(0)}catch{process.exit(1)}
`)
  const lsof = join(tools, 'lsof')
  executable(lsof, `#!${process.execPath}
process.exit(1)
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
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_QUEUE_FILE: queueFile,
    GUARD_STATE: statePath,
  }
  const run = (args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(
    process.execPath,
    [script, ...args],
    { encoding: 'utf8', env: { ...env, ...extra } },
  )
  const prepare = (extra: Partial<NodeJS.ProcessEnv> = {}) => run([
    'prepare', '--run-root', runRoot, '--quarantine-root', quarantineRoot, '--minimum-age-seconds', '900',
  ], extra)
  return { root, runRoot, batchRoot, workspace, readState, run, prepare }
}

function onlyChild(pathname: string): string {
  const names = readdirSync(pathname)
  expect(names).toHaveLength(1)
  return join(pathname, names[0])
}

function parseOutput(result: ReturnType<typeof spawnSync>): Record<string, string> {
  expect(result.status, String(result.stderr)).toBe(0)
  return JSON.parse(String(result.stdout)) as Record<string, string>
}

function setIntentToolSha(intentPath: string, toolSha256: string): string {
  const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as { toolSha256: string }
  intent.toolSha256 = toolSha256
  return rewriteJson(intentPath, intent)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy media orphan runtime guard recovery boundaries', () => {
  it.each(['OWNER_TEMP_BEFORE_RENAME', 'OWNER_TEMP_AFTER_RENAME'])(
    'converges after SIGKILL at %s without leaving an unknown batch-root member', checkpoint => {
      const fixture = createFixture()
      const killed = fixture.prepare({
        [`AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_${checkpoint}`]: '1',
      })
      expect(killed.signal).toBe('SIGKILL')
      expect(readdirSync(fixture.batchRoot)).not.toContain('.worker-launch.lock.owner.pending')

      const resumed = parseOutput(fixture.prepare())
      expect(resumed.mode).toBe('prepared')
      expect(readdirSync(fixture.batchRoot)).not.toContain('.worker-launch.lock.owner.pending')
    },
  )

  it.each([
    'OWNER_REMOVED_BEFORE_MARKER_UNLINK',
    'MARKER_REMOVED_BEFORE_OWNER_CLEANUP',
  ])('restores after SIGKILL at %s', checkpoint => {
    const fixture = createFixture()
    const killed = fixture.prepare({
      [`AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_${checkpoint}`]: '1',
    })
    expect(killed.signal).toBe('SIGKILL')
    const attempt = onlyChild(fixture.runRoot)
    const receipt = join(attempt, 'receipt.json')
    expect(existsSync(receipt)).toBe(true)

    const restored = parseOutput(fixture.run(['restore', '--receipt', receipt]))
    expect(restored.mode).toBe('restored')
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock'))).toBe(false)
    expect(existsSync(join(fixture.batchRoot, '.worker-launch.lock.owner'))).toBe(false)
  })

  it('keeps a receipt-publication failure quarantined and recover converges', () => {
    const fixture = createFixture()
    const failed = fixture.prepare({ AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_OUTPUT_BASENAME: 'receipt.json' })
    expect(failed.status).not.toBe(0)
    expect(existsSync(fixture.workspace)).toBe(false)
    expect(fixture.readState()).toMatchObject({ loaded: false, disabled: true, workers: [] })
    const attempt = onlyChild(fixture.runRoot)
    expect(existsSync(join(attempt, 'receipt.json'))).toBe(false)

    const recovered = parseOutput(fixture.run(['recover', '--intent', join(attempt, 'intent.json')]))
    expect(recovered.mode).toMatch(/^recovered-after-rename/u)
    expect(parseOutput(fixture.run(['status', '--receipt', recovered.receipt])).mode).toMatch(/^prepared/u)
  })

  it('finishes a missing receipt anchor during recover', () => {
    const fixture = createFixture()
    const failed = fixture.prepare({ AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_OUTPUT_BASENAME: 'receipt.anchor.json' })
    expect(failed.status).not.toBe(0)
    expect(existsSync(fixture.workspace)).toBe(false)
    const attempt = onlyChild(fixture.runRoot)
    expect(existsSync(join(attempt, 'receipt.json'))).toBe(true)
    expect(existsSync(join(attempt, 'receipt.anchor.json'))).toBe(false)

    const recovered = parseOutput(fixture.run(['recover', '--intent', join(attempt, 'intent.json')]))
    expect(existsSync(join(attempt, 'receipt.anchor.json'))).toBe(true)
    expect(parseOutput(fixture.run(['status', '--receipt', recovered.receipt])).mode).toMatch(/^prepared/u)
  })

  it('accepts the allowlisted predecessor only before the workspace rename', () => {
    const before = createFixture()
    const stopped = before.prepare({ AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_STOP: '1' })
    expect(stopped.signal).toBe('SIGKILL')
    const beforeAttempt = onlyChild(before.runRoot)
    const beforeIntent = join(beforeAttempt, 'intent.json')
    setIntentToolSha(beforeIntent, predecessorSha256)
    expect(parseOutput(before.run(['recover', '--intent', beforeIntent])).mode).toBe('recovered-before-rename')

    const after = createFixture()
    const renamed = after.prepare({ AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_RENAME: '1' })
    expect(renamed.signal).toBe('SIGKILL')
    const afterIntent = join(onlyChild(after.runRoot), 'intent.json')
    setIntentToolSha(afterIntent, predecessorSha256)
    const rejected = after.run(['recover', '--intent', afterIntent])
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('recoverable only before the workspace rename')
  })

  it('never accepts an allowlisted predecessor hash through receipt status', () => {
    const fixture = createFixture()
    const prepared = parseOutput(fixture.prepare())
    const attempt = dirname(prepared.receipt)
    chmodSync(attempt, 0o700)
    const intentPath = join(attempt, 'intent.json')
    const intentSha256 = setIntentToolSha(intentPath, predecessorSha256)

    const receipt = JSON.parse(readFileSync(prepared.receipt, 'utf8')) as {
      toolSha256: string
      intent: { sha256: string }
    }
    receipt.toolSha256 = predecessorSha256
    receipt.intent.sha256 = intentSha256
    const receiptSha256 = rewriteJson(prepared.receipt, receipt)

    const anchorPath = join(attempt, 'receipt.anchor.json')
    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as {
      intentSha256: string
      reference: { sha256: string }
    }
    anchor.intentSha256 = intentSha256
    anchor.reference.sha256 = receiptSha256
    rewriteJson(anchorPath, anchor)
    chmodSync(attempt, 0o500)

    const result = fixture.run(['status', '--receipt', prepared.receipt])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('runtime guard tool changed after prepare')
  })
})
