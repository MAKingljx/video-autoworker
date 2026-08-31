import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const script = join(repositoryRoot, 'scripts/legacy-media-orphan-runtime-guard.mjs')
const roots: string[] = []
const children: ChildProcess[] = []

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

function waitForJsonLine(
  child: ChildProcess,
  stderr: () => string,
  timeoutMilliseconds = 10_000,
): Promise<Record<string, string>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let source = ''
    const timer = setTimeout(() => finish(new Error(`timed out waiting for held receipt: ${stderr()}`)), timeoutMilliseconds)
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
      try {
        finish(undefined, JSON.parse(source.slice(0, newline)) as Record<string, string>)
      } catch (error) {
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

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orphan-runtime-guard-hold-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const tools = join(root, 'tools')
  const runRoot = join(root, 'run')
  const quarantineRoot = join(root, 'quarantine')
  const workspace = join(root, 'state', 'media-tasks', 'a'.repeat(64))
  const batchRoot = join(root, 'batches')
  const launchAgents = join(root, 'LaunchAgents')
  for (const pathname of [tools, runRoot, quarantineRoot, workspace, batchRoot, launchAgents]) {
    mkdirSync(pathname, { recursive: true, mode: 0o700 })
    chmodSync(pathname, 0o700)
  }
  mkdirSync(join(workspace, 'frames'), { mode: 0o700 })
  writeFileSync(join(workspace, 'metadata.json'), '{"kind":"prepared-video"}\n', { mode: 0o600 })
  writeFileSync(join(workspace, 'frames', 'frame.jpg'), Buffer.from('frame'), { mode: 0o600 })

  const plistPath = join(launchAgents, 'ai.aiworker.video-lane-supervisor.plist')
  writeFileSync(plistPath, 'test plist\n', { mode: 0o600 })
  const queueFile = join(root, 'queue.json')
  writeFileSync(queueFile, JSON.stringify({ counts: { waiting: 0, running: 0 }, queue: [] }), { mode: 0o600 })
  const statePath = join(root, 'state.json')
  const lockPath = join(batchRoot, '.global-video-worker.lock')
  writeFileSync(lockPath, `${JSON.stringify({
    pid: 3000,
    token: '12345678-1234-4123-8123-123456789abc',
    createdAt: '2026-08-31T00:00:00.000Z',
  })}\n`, { mode: 0o600 })
  writeFileSync(statePath, JSON.stringify({
    loaded: true,
    disabled: false,
    workers: [3000],
    workspace,
    plistPath,
    lockPath,
  }), { mode: 0o600 })

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
  service:{loaded:state.loaded,pid:state.loaded?3000:null},disabled:state.disabled,
  workers:state.workers,worker:phase==='active'?{pid:3000}:null,lock,
  projection:{runnable:0,journals:0,digest:'d'.repeat(64)}
}
process.stdout.write(JSON.stringify({
  protectedPids:{'3017':1101,'5678':2202,'5679':3303,'18091':4404,'18789':5505,'18889':6606,'18989':7707},
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
const path=process.env.GUARD_STATE
const state=JSON.parse(fs.readFileSync(path,'utf8'))
const args=process.argv.slice(2)
const save=()=>fs.writeFileSync(path,JSON.stringify(state),{mode:0o600})
if(args[0]==='print-disabled'){
  process.stdout.write('disabled services = { "ai.aiworker.video-lane-supervisor" => '+(state.disabled?'disabled':'enabled')+' }\\n')
  process.exit(0)
}
if(args[0]==='print'){
  if(state.loaded){process.stdout.write('state = running\\npid = 3000\\n');process.exit(0)}
  process.exit(1)
}
if(args[0]==='disable'){state.disabled=true;save();process.exit(0)}
if(args[0]==='bootout'){state.loaded=false;state.workers=[];save();process.exit(0)}
if(args[0]==='enable'){state.disabled=false;save();process.exit(0)}
if(args[0]==='bootstrap'){
  if(fs.existsSync(state.lockPath))process.exit(3)
  const handoff=require('node:path').join(require('node:path').dirname(state.lockPath),'.worker-launch.lock')
  if(fs.existsSync(handoff))fs.unlinkSync(handoff)
  fs.writeFileSync(state.lockPath,JSON.stringify({pid:3000,token:'87654321-4321-4321-8321-cba987654321',createdAt:new Date().toISOString()})+'\\n',{mode:0o600})
  state.loaded=true;state.workers=[3000];save();process.exit(0)
}
process.exit(2)
`)

  const ps = join(tools, 'ps')
  executable(ps, `#!${process.execPath}
const fs=require('node:fs')
const state=JSON.parse(fs.readFileSync(process.env.GUARD_STATE,'utf8'))
const args=process.argv.slice(2)
const pid=Number(args[args.indexOf('-p')+1])
const field=args.at(-1)
if(field!=='pid=')process.exit(2)
if(pid===3000){if(state.workers.includes(pid)){process.stdout.write(String(pid)+'\\n');process.exit(0)}process.exit(1)}
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
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_REAL_BATCH_PROJECTION: '1',
    AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_QUEUE_FILE: queueFile,
    GUARD_STATE: statePath,
  }
  return { root, runRoot, quarantineRoot, batchRoot, env }
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

describe('legacy media orphan runtime guard held preparation', () => {
  it('keeps one stable guardian alive through status and preserves it after SIGKILL', async () => {
    const fixture = createFixture()
    let stderr = ''
    const holder = spawn(process.execPath, [
      script,
      'prepare',
      '--run-root', fixture.runRoot,
      '--quarantine-root', fixture.quarantineRoot,
      '--minimum-age-seconds', '900',
      '--hold-guardian', 'yes',
    ], {
      env: fixture.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(holder)
    holder.stderr?.on('data', chunk => { stderr += String(chunk) })

    const prepared = await waitForJsonLine(holder, () => stderr)
    expect(prepared.mode).toBe('prepared-held')
    expect(holder.exitCode).toBeNull()
    expect(holder.signalCode).toBeNull()

    const guardianPath = join(fixture.batchRoot, '.worker-launch.lock')
    const beforeStat = statSync(guardianPath, { bigint: true })
    const beforeSource = readFileSync(guardianPath, 'utf8')
    const beforeValue = JSON.parse(readFileSync(guardianPath, 'utf8')) as {
      schema: string
      pid: number
      token: string
      createdAt: string
    }
    expect(beforeValue.pid).toBe(holder.pid)

    const refreshDeadline = Date.now() + 12_000
    let refreshedStat = beforeStat
    let refreshedSource = beforeSource
    while (Date.now() < refreshDeadline && refreshedStat.mtimeNs <= beforeStat.mtimeNs) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
      refreshedStat = statSync(guardianPath, { bigint: true })
      refreshedSource = readFileSync(guardianPath, 'utf8')
      expect(refreshedStat.ino).toBe(beforeStat.ino)
      expect(refreshedSource).toBe(beforeSource)
    }
    expect(refreshedStat.mtimeNs).toBeGreaterThan(beforeStat.mtimeNs)
    expect(refreshedSource).toBe(beforeSource)
    expect(holder.exitCode).toBeNull()

    const status = spawnSync(process.execPath, [script, 'status', '--receipt', prepared.receipt], {
      encoding: 'utf8',
      env: fixture.env,
    })
    expect(status.status, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ mode: 'prepared-held', receipt: prepared.receipt })
    expect(holder.exitCode).toBeNull()

    expect(holder.kill('SIGKILL')).toBe(true)
    const exited = await waitForExit(holder)
    expect(exited).toEqual({ code: null, signal: 'SIGKILL' })

    const afterStat = statSync(guardianPath, { bigint: true })
    const afterValue = JSON.parse(readFileSync(guardianPath, 'utf8')) as typeof beforeValue
    const afterOwner = JSON.parse(readFileSync(`${guardianPath}.owner`, 'utf8')) as { pid: number }
    expect(afterStat.ino).toBe(beforeStat.ino)
    expect(readFileSync(guardianPath, 'utf8')).toBe(beforeSource)
    expect(afterValue.token).toBe(beforeValue.token)
    expect(afterValue.pid).toBe(holder.pid)
    expect(afterOwner.pid).toBe(holder.pid)
    expect(() => process.kill(afterValue.pid, 0)).toThrow()
  }, 30_000)

  it('takes over a killed holder without rewriting or replacing its marker', async () => {
    const fixture = createFixture()
    let firstStderr = ''
    const first = spawn(process.execPath, [
      script,
      'prepare',
      '--run-root', fixture.runRoot,
      '--quarantine-root', fixture.quarantineRoot,
      '--minimum-age-seconds', '900',
      '--hold-guardian', 'yes',
    ], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(first)
    first.stderr?.on('data', chunk => { firstStderr += String(chunk) })
    const prepared = await waitForJsonLine(first, () => firstStderr)
    const guardianPath = join(fixture.batchRoot, '.worker-launch.lock')
    const marker = statSync(guardianPath, { bigint: true })
    const source = readFileSync(guardianPath, 'utf8')
    expect(first.kill('SIGKILL')).toBe(true)
    expect(await waitForExit(first)).toEqual({ code: null, signal: 'SIGKILL' })

    let recoveryStderr = ''
    const recovery = spawn(process.execPath, [
      script,
      'recover',
      '--intent', join(resolve(prepared.receipt, '..'), 'intent.json'),
    ], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(recovery)
    recovery.stderr?.on('data', chunk => { recoveryStderr += String(chunk) })
    const recovered = await waitForJsonLine(recovery, () => recoveryStderr)
    expect(recovered.mode).toBe('recovered-after-rename-held')
    expect(statSync(guardianPath, { bigint: true }).ino).toBe(marker.ino)
    expect(readFileSync(guardianPath, 'utf8')).toBe(source)
    expect(JSON.parse(readFileSync(`${guardianPath}.owner`, 'utf8'))).toMatchObject({ pid: recovery.pid })
    expect(recovery.kill('SIGKILL')).toBe(true)
    expect(await waitForExit(recovery)).toEqual({ code: null, signal: 'SIGKILL' })
  }, 30_000)

  it('fails closed when the unique marker body is truncated to empty JSON', async () => {
    const fixture = createFixture()
    let stderr = ''
    const holder = spawn(process.execPath, [
      script,
      'prepare',
      '--run-root', fixture.runRoot,
      '--quarantine-root', fixture.quarantineRoot,
      '--minimum-age-seconds', '900',
      '--hold-guardian', 'yes',
    ], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    holder.stderr?.on('data', chunk => { stderr += String(chunk) })
    await waitForJsonLine(holder, () => stderr)
    const guardianPath = join(fixture.batchRoot, '.worker-launch.lock')
    const before = statSync(guardianPath, { bigint: true })
    writeFileSync(guardianPath, '', { mode: 0o600 })

    const exited = await waitForExit(holder)
    expect(exited.code).not.toBe(0)
    expect(exited.signal).toBeNull()
    expect(statSync(guardianPath, { bigint: true }).ino).toBe(before.ino)
    expect(readFileSync(guardianPath, 'utf8')).toBe('')
    expect(stderr).toMatch(/size is invalid|body changed/u)
  }, 30_000)

  it('hands one live holder directly to restore without removing the marker early', async () => {
    const fixture = createFixture()
    const interlockProof = join(fixture.root, 'handoff-interlock-proof')
    const interlockProbe = join(fixture.root, 'handoff-interlock-probe')
    executable(interlockProbe, `#!${process.execPath}
const fs=require('node:fs')
try{const fd=fs.openSync(process.argv[2],'wx',0o600);fs.closeSync(fd);process.exit(2)}catch(error){if(error.code!=='EEXIST')throw error}
const entry=fs.statSync(process.argv[2]);if(Date.now()-entry.mtimeMs>=30000)process.exit(3)
const owner=JSON.parse(fs.readFileSync(process.argv[2]+'.owner','utf8'))
try{process.kill(owner.pid,0);process.exit(4)}catch(error){if(error.code!=='ESRCH')throw error}
fs.writeFileSync(${JSON.stringify(interlockProof)},'fresh-existing-marker\\n',{mode:0o600})
`)
    let stderr = ''
    const holder = spawn(process.execPath, [
      script,
      'prepare',
      '--run-root', fixture.runRoot,
      '--quarantine-root', fixture.quarantineRoot,
      '--minimum-age-seconds', '900',
      '--hold-guardian', 'yes',
    ], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    holder.stderr?.on('data', chunk => { stderr += String(chunk) })
    const prepared = await waitForJsonLine(holder, () => stderr)
    const guardianPath = join(fixture.batchRoot, '.worker-launch.lock')
    const original = statSync(guardianPath, { bigint: true })

    let restoreStdout = ''
    let restoreStderr = ''
    const restoreChild = spawn(process.execPath, [script, 'restore', '--receipt', prepared.receipt], {
      env: {
        ...fixture.env,
        AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_AFTER_HOLDER_EXIT_COMMAND: interlockProbe,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(restoreChild)
    restoreChild.stdout?.on('data', chunk => { restoreStdout += String(chunk) })
    restoreChild.stderr?.on('data', chunk => { restoreStderr += String(chunk) })
    const restoreExit = await waitForExit(restoreChild)
    expect(restoreExit, restoreStderr).toEqual({ code: 0, signal: null })
    expect(JSON.parse(restoreStdout)).toMatchObject({ mode: 'restored', receipt: prepared.receipt })
    expect(await waitForExit(holder)).toEqual({ code: 0, signal: null })
    expect(readFileSync(interlockProof, 'utf8')).toBe('fresh-existing-marker\n')
    expect(existsSync(guardianPath)).toBe(false)
    expect(existsSync(`${guardianPath}.owner`)).toBe(false)
    expect(original.ino).toBeGreaterThan(0)

    const status = spawnSync(process.execPath, [script, 'status', '--receipt', prepared.receipt], {
      encoding: 'utf8',
      env: fixture.env,
    })
    expect(status.status, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ mode: 'restored', receipt: prepared.receipt })
  }, 30_000)
})
