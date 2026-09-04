import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = join(import.meta.dirname, '../..')
const orchestrator = join(repositoryRoot, 'scripts/legacy-preinstall-orchestrator.mjs')
const commit = 'a'.repeat(40)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const roots: string[] = []

function executable(pathname: string, source: string) {
  writeFileSync(pathname, source, { mode: 0o700 })
  chmodSync(pathname, 0o700)
}

const controllerSource = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path')
const args=process.argv.slice(2),command=args.shift(),value=name=>args[args.indexOf(name)+1]
const attempt=value('--attempt-dir'),statePath=path.join(attempt,'fake-controller.json')
const log=event=>fs.appendFileSync(process.env.FAKE_LOG,event+'\n')
const read=()=>JSON.parse(fs.readFileSync(statePath,'utf8'))
const write=state=>fs.writeFileSync(statePath,JSON.stringify(state),{mode:0o600})
if(command==='prepare'){
  fs.mkdirSync(path.join(attempt,'preinstall'),{recursive:true,mode:0o700})
  const preparedPath=path.join(attempt,'preinstall','install-prepared.r000001.receipt.json')
  if(!fs.existsSync(preparedPath))fs.writeFileSync(preparedPath,'{}\n',{mode:0o400})
  const initialScenario=fs.existsSync(process.env.FAKE_SCENARIO)?fs.readFileSync(process.env.FAKE_SCENARIO,'utf8').trim():''
  if(!fs.existsSync(statePath))write({phase:'INSTALL_PREPARED',installAttemptId:'12345678-1234-4123-8123-123456789abc',revision:1,expiresAt:initialScenario==='lease-expired'?1:9999999999,verification:null,terminal:null,finalize:null,components:{installed:[],rolledBack:[],journalHead:null},bindings:{sourceCommit:'${commit}',target:{releaseId:'${commit}-runtime'},databases:{mission:{path:path.join(attempt,'mission.db')},n8n:{path:path.join(attempt,'n8n.db')}}}})
  log('controller:prepare');console.log(JSON.stringify({phase:'INSTALL_PREPARED'}));process.exit(0)
}
const state=read()
if(command==='status'){console.log(JSON.stringify(state));process.exit(0)}
if(command==='record-component'){
  const operation=value('--operation'),component=value('--component'),result=value('--raw-result')
  const receipt=JSON.parse(fs.readFileSync(result,'utf8'))
  if((fs.statSync(result).mode&0o777)!==0o600)throw Error('result mode')
  if(receipt.component!==component||receipt.operation!==(operation==='install'?'apply':'rollback'))throw Error('result binding')
  if(operation==='install'){
    const order=['task-flow','video-command','director-brain']
    if(component!==order[state.components.installed.length])throw Error('install order')
    state.components.installed.push(component)
  }else{
    const pending=state.components.installed.filter(x=>!state.components.rolledBack.includes(x))
    if(component!==pending.at(-1))throw Error('rollback order')
    state.phase='INSTALL_ROLLBACK_PENDING';state.components.rolledBack.push(component)
  }
  write(state);log('controller:record:'+operation+':'+component)
  console.log(JSON.stringify({phase:operation==='install'?'COMPONENT_INSTALLED':'COMPONENT_ROLLED_BACK'}));process.exit(0)
}
const scenario=fs.existsSync(process.env.FAKE_SCENARIO)?fs.readFileSync(process.env.FAKE_SCENARIO,'utf8').trim():''
if(command==='verify'){
  log('controller:verify')
  if(scenario==='verify-fail'){console.error('injected verify failure');process.exit(7)}
  state.phase='INSTALL_VERIFIED';state.verification={path:'verified'};write(state)
  console.log(JSON.stringify({phase:'INSTALL_VERIFIED'}));process.exit(0)
}
if(command==='handoff'){
  log('controller:handoff')
  if(scenario==='handoff-fail'){console.error('injected handoff failure');process.exit(8)}
  if(scenario==='handoff-finalizing-fail'&&state.phase!=='BOOTSTRAP_HANDOFF_FINALIZING'){
    state.phase='BOOTSTRAP_HANDOFF_FINALIZING';state.finalize={path:'finalize'};state.expiresAt=1;write(state)
    console.error('injected post-finalize failure');process.exit(9)
  }
  state.phase='BOOTSTRAP_HANDOFF';state.terminal={path:'terminal'};write(state)
  console.log(JSON.stringify({phase:'BOOTSTRAP_HANDOFF'}));process.exit(0)
}
if(command==='abandon'){
  if(state.components.installed.length!==state.components.rolledBack.length)throw Error('incomplete rollback')
  state.phase='INSTALL_ABANDONED';state.terminal={path:'abandoned'};write(state);log('controller:abandon')
  console.log(JSON.stringify({phase:'INSTALL_ABANDONED'}));process.exit(0)
}
throw Error('unknown controller command '+command)
`

const lsofSource = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),arg=process.argv.find(x=>x.startsWith('-iTCP:')),port=arg.split(':')[1]
const state=JSON.parse(fs.readFileSync(process.env.FAKE_PIDS,'utf8'))
process.stdout.write(String(state[port])+'\n')
`

const pgrepSource = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),state=JSON.parse(fs.readFileSync(process.env.FAKE_PIDS,'utf8'))
const workers=Array.isArray(state.workers)?state.workers:[]
if(workers.length===0)process.exit(1)
process.stdout.write(workers.join('\n')+'\n')
`

const openclawSource = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),state=JSON.parse(fs.readFileSync(process.env.FAKE_PIDS,'utf8'))
fs.appendFileSync(process.env.FAKE_LOG,'openclaw:fresh-restart\n')
state['18889']+=1;fs.writeFileSync(process.env.FAKE_PIDS,JSON.stringify(state),{mode:0o600})
console.log('{}')
`

const installerSource = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const args=process.argv.slice(2),has=x=>args.includes(x),value=x=>args[args.indexOf(x)+1]
const name=path.basename(process.argv[1]),scenario=fs.existsSync(process.env.FAKE_SCENARIO)?fs.readFileSync(process.env.FAKE_SCENARIO,'utf8').trim():''
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),mode=p=>(fs.statSync(p).mode&0o7777).toString(8)
const entries=(root,excluded)=>{
  const out=[];function walk(dir,prefix){for(const item of fs.readdirSync(dir).sort()){const rel=prefix?prefix+'/'+item:item;if(excluded.includes(rel))continue;const p=path.join(dir,item),s=fs.lstatSync(p);out.push({rel,p,s});if(s.isDirectory())walk(p,rel)}}walk(root,'');return out
}
const shellManifest=(root,excluded=[],dot=true)=>{
  const lines=dot?['.\tdirectory\t'+mode(root)+'\t-']:[]
  for(const {rel,p,s} of entries(root,excluded)){const n=dot?'./'+rel:rel,suffix=dot?'':'\t-';if(s.isDirectory())lines.push(n+'\tdirectory\t'+mode(p)+'\t-'+suffix);else lines.push(n+'\tfile\t'+mode(p)+'\t'+sha(fs.readFileSync(p))+suffix)}return lines.join('\n')+'\n'
}
const log=x=>fs.appendFileSync(process.env.FAKE_LOG,x+'\n')
if(name.includes('task')){
  const operation=has('--apply')?'apply':has('--rollback')?'rollback':'dry-run',backup=operation==='apply'?path.join(process.env.AIWORKER_SKILL_BACKUP_ROOT,'20260905-120000.Ab12Cd'):value('--backup')
  log('task:'+operation)
  if(operation==='dry-run'){console.log('dry-run');process.exit(0)}
  if(operation==='apply'&&scenario==='task-fail'){console.error('task fail');process.exit(11)}
  if(operation==='apply'){
    fs.mkdirSync(backup,{mode:0o700});fs.writeFileSync(path.join(backup,'aiworker-task-flow.absent'),'',{mode:0o600})
    for(const n of ['APPLIED.skill.manifest','APPLIED.AGENTS.manifest','APPLIED.MEMORY.manifest'])fs.writeFileSync(path.join(backup,n),n+'\n',{mode:0o600})
    fs.writeFileSync(path.join(backup,'AGENTS.md.absent'),'',{mode:0o600});fs.writeFileSync(path.join(backup,'MEMORY.md.absent'),'',{mode:0o600})
    const workspaceSha=sha(process.env.AIWORKER_QWEN_WORKSPACE)
    fs.writeFileSync(path.join(backup,'STATE'),'version=2\nworkspace_sha256='+workspaceSha+'\nsource_commit=${commit}\nrelease_id=${commit}-runtime\nskill_present=0\nagents_present=0\nmemory_present=0\n',{mode:0o600})
    fs.writeFileSync(path.join(backup,'MANIFEST.sha256'),shellManifest(backup,['MANIFEST.sha256'],true),{mode:0o600})
  }
  const before=sha('task-flow:before'),after=sha('task-flow:after'),manifest=fs.readFileSync(path.join(backup,'MANIFEST.sha256'))
  fs.writeFileSync(value('--result-output'),JSON.stringify({schema:'video-autoworker-installer-result/v1',component:'task-flow',operation,status:operation==='apply'?'applied':'restored',sourceCommit:'${commit}',targetReleaseId:'${commit}-runtime',beforeManifestSha256:operation==='apply'?before:after,afterManifestSha256:operation==='apply'?after:before,backup:{path:backup,manifestSha256:sha(manifest)},requiresFreshRestart:false,completedAt:100})+'\n',{flag:'wx',mode:0o600})
  console.log('TASK_FLOW_INSTALL_RESULT mode='+operation+' status='+(operation==='apply'?'installed':'restored')+' backup='+backup)
  console.log('sanitized ordinary installer message');process.exit(0)
}
const component=name.includes('video')?'video-command':'director-brain',operation=has('--apply')?'apply':has('--rollback')?'rollback':'dry-run'
log(component+':'+operation)
if(operation==='dry-run'){console.log('dry-run');process.exit(0)}
if(operation==='apply'&&scenario===component+'-fail'){console.error(component+' fail');process.exit(12)}
let backup
if(operation==='rollback')backup=value('--backup')
else if(component==='video-command')backup=path.join(process.env.HOME,'ai-worker/backups/aiworker-video-command/current-release-20260905-120000.Ab12')
else backup=path.join(value('--backup-root'),'20260905-120000.Ab12Cd')
if(operation==='apply'){
  fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.chmodSync(backup,0o700)
  fs.writeFileSync(path.join(backup,'STATE'),'backup\n',{mode:0o600})
  if(component==='video-command'){
    fs.writeFileSync(path.join(backup,'metadata.json'),'{}\n',{mode:0o600});fs.mkdirSync(path.join(backup,'previous-plugin'),{mode:0o700});fs.writeFileSync(path.join(backup,'openclaw.json'),'{}\n',{mode:0o600})
    const manifest=shellManifest(backup,['MANIFEST.sha256','.verified'],false);fs.writeFileSync(path.join(backup,'MANIFEST.sha256'),manifest,{mode:0o600});fs.writeFileSync(path.join(backup,'.verified'),sha(manifest)+'\n',{mode:0o600})
  }else{
    fs.writeFileSync(path.join(backup,'openclaw.json'),'{}\n',{mode:0o600});fs.writeFileSync(path.join(backup,'MANIFEST.sha256'),shellManifest(backup,['MANIFEST.sha256'],true),{mode:0o600})
  }
}
const manifest=fs.readFileSync(path.join(backup,'MANIFEST.sha256')),before=sha(component+':before'),after=sha(component+':after')
const raw={schema:'video-autoworker-installer-result/v1',component,operation,status:operation==='apply'?'applied':'restored',sourceCommit:'${commit}',targetReleaseId:'${commit}-runtime',beforeManifestSha256:operation==='apply'?before:after,afterManifestSha256:operation==='apply'?after:before,backup:{path:backup,manifestSha256:sha(manifest)},requiresFreshRestart:operation==='apply',completedAt:100}
const output=value('--result-output');fs.writeFileSync(output,JSON.stringify(raw)+'\n',{flag:'wx',mode:0o600})
if(operation==='apply'&&scenario==='video-tamper'){raw.backup.manifestSha256='0'.repeat(64);fs.writeFileSync(output,JSON.stringify(raw)+'\n',{mode:0o600})}
if(operation==='apply'&&scenario==='protected-pid-drift'){const p=JSON.parse(fs.readFileSync(process.env.FAKE_PIDS,'utf8'));p['3017']+=1;fs.writeFileSync(process.env.FAKE_PIDS,JSON.stringify(p),{mode:0o600})}
const protectedDrift=scenario.match(/^protected-pid-drift-([0-9]+)$/)
if(operation==='apply'&&protectedDrift){const p=JSON.parse(fs.readFileSync(process.env.FAKE_PIDS,'utf8'));p[protectedDrift[1]]+=1;fs.writeFileSync(process.env.FAKE_PIDS,JSON.stringify(p),{mode:0o600})}
if(operation==='apply'&&scenario==='protected-worker-drift'){const p=JSON.parse(fs.readFileSync(process.env.FAKE_PIDS,'utf8'));p.workers=[98765];fs.writeFileSync(process.env.FAKE_PIDS,JSON.stringify(p),{mode:0o600})}
if(operation==='apply'&&component==='director-brain'&&scenario==='crash-after-director'){process.kill(process.ppid,'SIGKILL')}
`

const convergenceSource = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),args=process.argv.slice(2)
const operation=args.includes('--rollback')?'rollback':'apply',scenario=fs.existsSync(process.env.FAKE_SCENARIO)?fs.readFileSync(process.env.FAKE_SCENARIO,'utf8').trim():''
fs.appendFileSync(process.env.FAKE_LOG,'convergence:'+operation+'\n')
if(operation==='rollback'){console.log('rolled back');process.exit(0)}
if(scenario==='convergence-fail'){console.error('convergence fail');process.exit(13)}
const root=process.env.AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT,proof=path.join(root,'qwen-current-runtime-convergence-proof.Ab12Cd'),backup=path.join(root,'qwen-current-before-runtime-convergence.Ab12Cd')
fs.writeFileSync(proof,JSON.stringify({schema:'proof'})+'\n',{flag:'wx',mode:0o600});fs.writeFileSync(backup,'{}\n',{flag:'wx',mode:0o600})
console.log('Verified 0600 rollback backup: '+backup);console.log('Verified session-scoped runtime convergence proof: '+proof)
`

type Fixture = ReturnType<typeof fixture>
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'legacy-preinstall-orchestrator-'))
  roots.push(root)
  chmodSync(root, 0o700)
  const attempt = join(root, 'attempt'); mkdirSync(attempt, { mode: 0o700 })
  const home = join(root, 'home'); mkdirSync(home, { mode: 0o700 })
  const profile = join(home, '.openclaw-qwen-current'); mkdirSync(profile, { mode: 0o700 })
  const workspace = join(root, 'workspace'); mkdirSync(workspace, { mode: 0o700 })
  const dirs = ['releases', 'task-backups', 'director-backups', 'runtime-backups', 'run', 'batches', 'transition-journal']
  for (const name of dirs) mkdirSync(join(root, name), { mode: 0o700 })
  const videoBackups = join(home, 'ai-worker/backups/aiworker-video-command')
  mkdirSync(videoBackups, { recursive: true, mode: 0o700 }); chmodSync(videoBackups, 0o700)
  const files = ['evidence', 'proof', 'intent', 'confirmation', 'attestation', 'claim', 'tool-baseline']
  for (const name of files) writeFileSync(join(root, name), '{}\n', { mode: 0o600 })
  const bin = join(root, 'bin'); mkdirSync(bin, { mode: 0o700 })
  const controller = join(bin, 'controller.cjs'), task = join(bin, 'task.cjs')
  const video = join(bin, 'video.cjs'), director = join(bin, 'director.cjs')
  const convergence = join(bin, 'convergence.cjs'), openclaw = join(bin, 'openclaw.cjs')
  const lsof = join(bin, 'lsof.cjs'), pgrep = join(bin, 'pgrep.cjs')
  executable(controller, controllerSource); executable(task, installerSource)
  executable(video, installerSource); executable(director, installerSource)
  executable(convergence, convergenceSource); executable(openclaw, openclawSource); executable(lsof, lsofSource)
  executable(pgrep, pgrepSource)
  const log = join(root, 'events.log'); writeFileSync(log, '')
  const scenario = join(root, 'scenario'); writeFileSync(scenario, '')
  const pids = join(root, 'pids.json')
  writeFileSync(pids, JSON.stringify({
    3017: 30170, 5678: 56780, 5679: 56790,
    18789: 187890, 18889: 188890, 18989: 189890,
    18091: 180910, 18092: 180920, 18094: 180940, 11434: 114340,
    workers: [],
  }), { mode: 0o600 })
  const args = [
    '--attempt-dir', attempt, '--evidence', join(root, 'evidence'), '--proof', join(root, 'proof'),
    '--source-commit', commit, '--transition-intent', join(root, 'intent'),
    '--transition-confirmation', join(root, 'confirmation'), '--transition-journal', join(root, 'transition-journal'),
    '--transition-attestation', join(root, 'attestation'), '--transition-claim', join(root, 'claim'),
    '--releases-root', join(root, 'releases'), '--profile', 'qwen-current', '--profile-state-root', profile,
    '--workspace-root', workspace, '--agent-id', 'second-original', '--tool-baseline', join(root, 'tool-baseline'),
    '--task-flow-backup-root', join(root, 'task-backups'), '--video-command-backup-root', videoBackups,
    '--director-brain-backup-root', join(root, 'director-backups'), '--runtime-backup-root', join(root, 'runtime-backups'),
    '--deployment-run-dir', join(root, 'run'), '--video-batch-root', join(root, 'batches'),
  ]
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: 'test', AIWORKER_TEST_LEGACY_PREINSTALL_ORCHESTRATOR: '1',
    AIWORKER_TEST_LEGACY_PREINSTALL_CONTROLLER: controller,
    AIWORKER_TEST_LEGACY_PREINSTALL_TASK_INSTALLER: task,
    AIWORKER_TEST_LEGACY_PREINSTALL_VIDEO_INSTALLER: video,
    AIWORKER_TEST_LEGACY_PREINSTALL_DIRECTOR_INSTALLER: director,
    AIWORKER_TEST_LEGACY_PREINSTALL_CONVERGENCE: convergence,
    AIWORKER_TEST_LEGACY_PREINSTALL_OPENCLAW: openclaw,
    AIWORKER_TEST_LEGACY_PREINSTALL_LSOF: lsof,
    AIWORKER_TEST_LEGACY_PREINSTALL_PGREP: pgrep,
    AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY: 'private-test-session',
    FAKE_LOG: log, FAKE_SCENARIO: scenario, FAKE_PIDS: pids,
  }
  return { root, attempt, args, env, log, scenario, pids }
}

function run(entry: Fixture) {
  return spawnSync(process.execPath, [orchestrator, ...entry.args], {
    cwd: repositoryRoot, env: entry.env, encoding: 'utf8', timeout: 30_000,
  })
}
function events(entry: Fixture) { return readFileSync(entry.log, 'utf8').trim().split('\n').filter(Boolean) }
function setScenario(entry: Fixture, scenario: string) { writeFileSync(entry.scenario, scenario) }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('legacy preinstall orchestrator', () => {
  it('starts a brand-new attempt before any controller status exists', () => {
    const entry = fixture()
    expect(readdirSync(entry.attempt)).toEqual([])

    const result = run(entry)

    expect(result.status, result.stderr).toBe(0)
    expect(events(entry).slice(0, 4)).toEqual([
      'task:dry-run', 'video-command:dry-run', 'director-brain:dry-run', 'controller:prepare',
    ])
    expect(statSync(join(entry.attempt, 'preinstall', 'orchestrator',
      'protected-pids.before.json')).mode & 0o777).toBe(0o600)
    const baseline = JSON.parse(readFileSync(join(entry.attempt, 'preinstall', 'orchestrator',
      'protected-pids.before.json'), 'utf8'))
    expect(Object.keys(baseline.pids).sort()).toEqual([
      'application', 'gptMain', 'n8n', 'ollama', 'qwen36', 'qwen38Text', 'qwen38Vision',
      'qwenCurrent', 'qwenWeixin', 'taskBroker',
    ])
    expect(baseline.videoWorkerPids).toEqual([])
  })

  it('runs one ordered install, one qwen restart, convergence, verify, and handoff', () => {
    const entry = fixture()
    const result = run(entry)
    expect(result.status, result.stderr).toBe(0)
    const ordered = events(entry).filter(event => !event.startsWith('controller:prepare'))
    expect(ordered).toEqual([
      'task:dry-run', 'video-command:dry-run', 'director-brain:dry-run',
      'task:apply', 'controller:record:install:task-flow',
      'video-command:apply', 'controller:record:install:video-command',
      'director-brain:apply', 'controller:record:install:director-brain',
      'openclaw:fresh-restart', 'convergence:apply', 'controller:verify', 'controller:handoff',
    ])
    const artifacts = readdirSync(join(entry.attempt, 'preinstall', 'orchestrator'))
    expect(artifacts).toContain('director-brain.apply.raw.json')
    expect(artifacts).toContain('runtime-convergence.apply.raw.json')
    for (const name of artifacts.filter(name => name.endsWith('.result.json')
      || name.endsWith('.backup-summary.json') || name.endsWith('.claim.json'))
      .filter(name => !name.startsWith('qwen-current-'))) {
      expect(statSync(join(entry.attempt, 'preinstall', 'orchestrator', name)).mode & 0o777).toBe(0o400)
    }
    expect(statSync(join(entry.attempt, 'preinstall', 'orchestrator',
      'qwen-current-fresh-restart.result.json')).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['task-fail', []],
    ['video-command-fail', ['task:rollback', 'controller:record:rollback:task-flow']],
    ['director-brain-fail', ['video-command:rollback', 'controller:record:rollback:video-command', 'task:rollback', 'controller:record:rollback:task-flow']],
    ['convergence-fail', ['director-brain:rollback', 'controller:record:rollback:director-brain', 'video-command:rollback', 'controller:record:rollback:video-command', 'task:rollback', 'controller:record:rollback:task-flow']],
    ['verify-fail', ['convergence:rollback', 'director-brain:rollback', 'controller:record:rollback:director-brain', 'video-command:rollback', 'controller:record:rollback:video-command', 'task:rollback', 'controller:record:rollback:task-flow']],
    ['handoff-fail', ['convergence:rollback', 'director-brain:rollback', 'controller:record:rollback:director-brain', 'video-command:rollback', 'controller:record:rollback:video-command', 'task:rollback', 'controller:record:rollback:task-flow']],
  ])('compensates %s in strict reverse order', (scenario, expectedRollback) => {
    const entry = fixture(); setScenario(entry, scenario)
    const result = run(entry)
    expect(result.status).not.toBe(0)
    const actual = events(entry).filter(event => event.includes(':rollback'))
    expect(actual).toEqual(expectedRollback)
    expect(events(entry).at(-1)).toBe('controller:abandon')
    if (['convergence-fail', 'verify-fail', 'handoff-fail'].includes(scenario)) {
      expect(events(entry).filter(event => event === 'openclaw:fresh-restart')).toHaveLength(2)
    }
  })

  it('resumes after a crash from controller journal without repeating completed components', () => {
    const entry = fixture(); setScenario(entry, 'crash-after-director')
    const first = run(entry)
    expect(first.signal).toBe('SIGKILL')
    setScenario(entry, '')
    const second = run(entry)
    expect(second.status, second.stderr).toBe(0)
    expect(events(entry).filter(event => event === 'task:apply')).toHaveLength(1)
    expect(events(entry).filter(event => event === 'video-command:apply')).toHaveLength(1)
    expect(events(entry).filter(event => event === 'director-brain:apply')).toHaveLength(1)
    expect(events(entry).filter(event => event === 'openclaw:fresh-restart')).toHaveLength(1)
  })

  it('detects a tampered raw result and rolls back only the recorded predecessor', () => {
    const entry = fixture(); setScenario(entry, 'video-tamper')
    const result = run(entry)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('backup manifest digest changed')
    expect(events(entry).filter(event => event.includes(':rollback'))).toEqual([
      'task:rollback', 'controller:record:rollback:task-flow',
    ])
    expect(events(entry)).not.toContain('controller:abandon')
  })

  it('does not roll back or restart after a committed handoff on re-entry', () => {
    const entry = fixture()
    expect(run(entry).status).toBe(0)
    const before = events(entry)
    const again = run(entry)
    expect(again.status, again.stderr).toBe(0)
    expect(events(entry)).toEqual(before)
    expect(again.stdout).toContain('"resumed":true')
  })

  it('resumes a finalized handoff forward-only even after the lease expires', () => {
    const entry = fixture(); setScenario(entry, 'handoff-finalizing-fail')
    const first = run(entry)
    expect(first.status).not.toBe(0)
    expect(first.stderr).toContain('post-finalize failure')
    expect(events(entry)).not.toContain('controller:abandon')
    expect(events(entry).filter(event => event.includes(':rollback'))).toEqual([])
    const before = events(entry)

    const second = run(entry)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('"resumed":true')
    expect(events(entry).slice(0, before.length)).toEqual(before)
    expect(events(entry).slice(before.length)).toEqual(['controller:handoff'])
    expect(events(entry).filter(event => event === 'openclaw:fresh-restart')).toHaveLength(1)
  })

  it('keeps an abandoned attempt readable and terminal on re-entry', () => {
    const entry = fixture(); setScenario(entry, 'task-fail')
    expect(run(entry).status).not.toBe(0)
    const before = events(entry)
    const again = run(entry)
    expect(again.status).not.toBe(0)
    expect(again.stderr).toContain('already abandoned')
    expect(events(entry)).toEqual(before)
  })

  it('preflights before prepare and compensates instead of advancing an expired lease', () => {
    const entry = fixture(); setScenario(entry, 'lease-expired')
    const result = run(entry)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('too close to expiry')
    expect(events(entry)).toEqual([
      'task:dry-run', 'video-command:dry-run', 'director-brain:dry-run',
      'controller:prepare', 'controller:abandon',
    ])
  })

  it('rejects protected application PID drift and never reaches handoff', () => {
    const entry = fixture(); setScenario(entry, 'protected-pid-drift')
    const result = run(entry)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('protected application PID drifted')
    expect(events(entry)).not.toContain('controller:handoff')
    expect(events(entry)).not.toContain('openclaw:fresh-restart')
  })

  it.each([
    [5679, 'taskBroker'],
    [18091, 'qwen36'],
    [18092, 'qwen38Text'],
    [18094, 'qwen38Vision'],
    [11434, 'ollama'],
  ])('rejects protected %s listener drift', (port, name) => {
    const entry = fixture(); setScenario(entry, `protected-pid-drift-${port}`)
    const result = run(entry)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`protected ${name} PID drifted`)
    expect(events(entry)).not.toContain('controller:handoff')
  })

  it('rejects a video worker that already exists at the baseline', () => {
    const entry = fixture()
    const pids = JSON.parse(readFileSync(entry.pids, 'utf8'))
    pids.workers = [98764]
    writeFileSync(entry.pids, JSON.stringify(pids), { mode: 0o600 })
    const result = run(entry)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('video worker is running during protected preinstall')
    expect(events(entry)).not.toContain('controller:prepare')
  })

  it('rejects video-worker PID drift and never reaches handoff', () => {
    const entry = fixture(); setScenario(entry, 'protected-worker-drift')
    const result = run(entry)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('video worker is running during protected preinstall')
    expect(events(entry)).not.toContain('controller:handoff')
    expect(events(entry)).not.toContain('openclaw:fresh-restart')
  })

  it('requires every explicit binding and rejects environment-only path injection', () => {
    const entry = fixture()
    const injected: NodeJS.ProcessEnv = {
      ...entry.env, AIWORKER_VIDEO_BATCH_DIR: join(entry.root, 'elsewhere'),
    }
    const result = spawnSync(process.execPath, [orchestrator, ...entry.args.slice(0, -2)], {
      cwd: repositoryRoot, env: injected,
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('arguments are incomplete')
  })
})
