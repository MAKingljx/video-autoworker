// @vitest-environment node
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { captureMediaProviderObservation, isObservedMediaProviderObservation, mediaProviderRequestFinished,
  mediaProviderRequestStarted, mediaProviderRequestSignal, rethrowMediaExecutionInterruption,
  runOwnedMediaCommand, writeControlledMediaJson, type N8nMediaExecutionControl } from '@/lib/n8n-media-control'

const roots: string[] = []
const makeControl = () => {
  const controller = new AbortController()
  const reason = Object.assign(new Error('requested stop'), { code: 'N8N_VIDEO_STOP_REQUESTED', providerCancellation: 'not_started' })
  const control: N8nMediaExecutionControl = { signal: controller.signal, assertActive: () => controller.signal.throwIfAborted(),
    commitIfActive: publish => { controller.signal.throwIfAborted(); return publish() } }
  return { controller, reason, control }
}
async function directory() { const root = await mkdtemp(join(tmpdir(), 'media-control-')); roots.push(root); return root }
async function waitForFile(pathname: string) {
  for (let n = 0; n < 200; n++) { if (existsSync(pathname)) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('owned test command did not become ready')
}
const alive = (pid: number) => {
  try { return !execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().startsWith('Z') }
  catch { return false }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('owned media cancellation', () => {
  it('brands immutable provider observations and retains a prior uncertain request after a successful fallback', () => {
    const { control } = makeControl()
    expect(captureMediaProviderObservation()).toMatchObject({ status: 'unconfirmed' })
    expect(captureMediaProviderObservation(control)).toMatchObject({ status: 'not_started' })
    mediaProviderRequestStarted(control)
    mediaProviderRequestStarted(control); mediaProviderRequestFinished(control)
    const observed = captureMediaProviderObservation(control)
    expect(observed.status).toBe('unconfirmed')
    expect(isObservedMediaProviderObservation(observed)).toBe(true)
    expect(Object.isFrozen(observed)).toBe(true)
    expect(isObservedMediaProviderObservation({ ...observed })).toBe(false)
    expect(isObservedMediaProviderObservation(JSON.parse(JSON.stringify(observed)))).toBe(false)
    const circular: any = {}; circular.self = circular
    expect(isObservedMediaProviderObservation(circular)).toBe(false)
    mediaProviderRequestFinished(control)
    expect(captureMediaProviderObservation(control)).toMatchObject({ status: 'confirmed' })
  })
  it('removes every completed provider listener and drains only a user stop', () => {
    const { controller, reason, control } = makeControl()
    for (let n = 0; n < 30; n++) {
      const request = mediaProviderRequestSignal(control, 1000, { drainOnUserStop: true })
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
      request.dispose()
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    }
    const request = mediaProviderRequestSignal(control, 1000, { drainOnUserStop: true })
    controller.abort(reason)
    expect(request.signal.aborted).toBe(false)
    request.dispose()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    const lost = new AbortController(), leaseReason = Object.assign(new Error('lost'), { code: 'N8N_CHILD_LEASE_LOST' })
    const leaseRequest = mediaProviderRequestSignal({ signal: lost.signal, assertActive: () => lost.signal.throwIfAborted() }, 1000)
    lost.abort(leaseReason)
    expect(leaseRequest.signal.reason).toBe(leaseReason)
    leaseRequest.dispose()
    const cloud = makeControl(), cloudRequest = mediaProviderRequestSignal(cloud.control, 1000)
    cloud.controller.abort(cloud.reason)
    expect(cloudRequest.signal.reason).toBe(cloud.reason)
    cloudRequest.dispose()
  })
  it('preserves an unconfirmed process exit instead of converting it to an acknowledged stop', () => {
    const { controller, reason, control } = makeControl(); controller.abort(reason)
    const unknown = Object.assign(new Error('unconfirmed'), { code: 'N8N_MEDIA_TERMINATION_UNCONFIRMED' })
    expect(() => rethrowMediaExecutionInterruption(unknown, control)).toThrow(unknown)
  })
  it('refuses an already stopped command before spawning or writing output', async () => {
    const root = await directory(), marker = join(root, 'not-created')
    const { controller, reason, control } = makeControl(); controller.abort(reason)
    await expect(runOwnedMediaCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`], { control })).rejects.toBe(reason)
    expect(existsSync(marker)).toBe(false)
  })
  it('preserves UTF-8 and confirms a normally completed command', async () => {
    const { control } = makeControl()
    const result = await runOwnedMediaCommand(process.execPath, ['-e', "const b=Buffer.from('已完成');for(const byte of b)process.stdout.write(Buffer.from([byte]));process.stderr.write('ok')"], { control })
    expect(result).toMatchObject({ stdout: '已完成', stderr: 'ok', code: 0 })
  })
  it('terminates only its own attempt process group including a grandchild', async () => {
    const root = await directory(), marker = join(root, 'owned-pids.json')
    const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
    const { controller, reason, control } = makeControl()
    const script = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,grandchild:c.pid}));setInterval(()=>{},1000)`
    const running = runOwnedMediaCommand(process.execPath, ['-e', script], { control })
    const settled = running.catch(error => error)
    try {
      await waitForFile(marker)
      const owned = JSON.parse(readFileSync(marker, 'utf8'))
      controller.abort(reason)
      expect(await settled).toBe(reason)
      expect(reason.providerCancellation).toBe('confirmed')
      expect(alive(owned.pid)).toBe(false); expect(alive(owned.grandchild)).toBe(false)
      expect(alive(sibling.pid!)).toBe(true)
    } finally {
      if (!controller.signal.aborted) controller.abort(reason)
      await settled
      if (sibling.exitCode === null) sibling.kill('SIGKILL')
      await new Promise<void>(resolve => { if (sibling.exitCode !== null || sibling.signalCode) resolve(); else sibling.once('exit', () => resolve()) })
    }
  }, 10_000)
  it('fences a prepared checkpoint before publication and preserves the original file', async () => {
    const root = await directory(), output = join(root, 'checkpoint.json')
    await writeFile(output, '{"accepted":"earlier"}\n', { mode: 0o600 })
    const before = readFileSync(output)
    const { controller, reason, control } = makeControl()
    control.assertActive = () => {
      if (readdirSync(root).some(name => name.startsWith('checkpoint.json.tmp-'))) controller.abort(reason)
      controller.signal.throwIfAborted()
    }
    await expect(writeControlledMediaJson(output, { late: true }, control)).rejects.toBe(reason)
    expect(readFileSync(output)).toEqual(before)
    expect(readdirSync(root)).toEqual(['checkpoint.json'])
  })
  it('rejects checkpoint publication without a durable fence even while its signal is active', async () => {
    const root = await directory(), output = join(root, 'checkpoint.json'), { control } = makeControl()
    await writeFile(output, '{"accepted":"earlier"}\n', { mode: 0o600 })
    const before = readFileSync(output)
    delete control.commitIfActive
    await expect(writeControlledMediaJson(output, { late: true }, control)).rejects.toMatchObject({ code: 'N8N_MEDIA_PUBLICATION_FENCE_REQUIRED' })
    expect(readFileSync(output)).toEqual(before)
    expect(readdirSync(root)).toEqual(['checkpoint.json'])
  })
  it('preserves original checkpoint bytes when stop wins the final publication fence after the outer check', async () => {
    const root = await directory(), output = join(root, 'checkpoint.json'), { controller, reason, control } = makeControl()
    await writeFile(output, '{"accepted":"earlier"}\n', { mode: 0o600 })
    const before = readFileSync(output)
    control.commitIfActive = publish => { controller.abort(reason); controller.signal.throwIfAborted(); return publish() }
    await expect(writeControlledMediaJson(output, { late: true }, control)).rejects.toBe(reason)
    expect(readFileSync(output)).toEqual(before)
    expect(readdirSync(root)).toEqual(['checkpoint.json'])
  })
  it('retains a checkpoint committed synchronously before the stop transaction wins', async () => {
    const root = await directory(), output = join(root, 'checkpoint.json'), { controller, reason, control } = makeControl()
    const events: string[] = []
    control.commitIfActive = publish => {
      controller.signal.throwIfAborted(); const value = publish(); events.push('published')
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ accepted: true })
      controller.abort(reason); events.push('stop'); return value
    }
    await expect(writeControlledMediaJson(output, { accepted: true }, control)).rejects.toBe(reason)
    expect(events).toEqual(['published', 'stop'])
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ accepted: true })
    expect(readdirSync(root)).toEqual(['checkpoint.json'])
  })
})
