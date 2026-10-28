import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, renameSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'

export interface N8nMediaExecutionControl {
  signal: AbortSignal
  assertActive: () => void
  /** Production supplies a synchronous SQLite IMMEDIATE authority fence. */
  commitIfActive?: <T>(publish: () => T) => T
}
const providerRequests = new WeakMap<N8nMediaExecutionControl, { pending: number; completed: boolean }>()
export type N8nMediaProviderObservation = Readonly<{
  status: 'confirmed' | 'not_started' | 'unconfirmed'
  evidenceSha256: string
}>
const observedProviderStates = new WeakMap<object, string>()
const observationDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Only executor-owned request state may mint a settlement observation. Failed
 * earlier requests remain pending even when a later fallback succeeds. */
export function captureMediaProviderObservation(control?: N8nMediaExecutionControl): N8nMediaProviderObservation {
  const state = control ? providerRequests.get(control) : undefined
  const status = !control || state?.pending ? 'unconfirmed' : state?.completed ? 'confirmed' : 'not_started'
  const value = Object.freeze({ status, evidenceSha256: observationDigest({ schema: 'aiworker-media-provider-observation/v1',
    status, pending: state?.pending ?? null, completed: state?.completed ?? null, nonce: randomUUID() }) })
  observedProviderStates.set(value, observationDigest(value))
  return value
}
export function isObservedMediaProviderObservation(value: unknown): value is N8nMediaProviderObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const observed = observedProviderStates.get(value)
  return observed !== undefined && observed === observationDigest(value)
}
function annotateProviderState(control: N8nMediaExecutionControl | undefined, reason: unknown) {
  if (!control || !reason || typeof reason !== 'object' || !Object.isExtensible(reason)) return
  const state = providerRequests.get(control)
  const value = reason as { providerCancellation?: string }
  if (state?.pending) value.providerCancellation = 'provider_unconfirmed'
  else if (state?.completed && value.providerCancellation !== 'provider_unconfirmed') value.providerCancellation = 'confirmed'
}

export function assertMediaExecutionActive(control?: N8nMediaExecutionControl): void {
  try {
    control?.signal.throwIfAborted()
    control?.assertActive()
    control?.signal.throwIfAborted()
  } catch (error) { annotateProviderState(control, error); throw error }
}

export function mediaProviderRequestStarted(control?: N8nMediaExecutionControl) {
  if (!control) return
  const old = providerRequests.get(control)
  providerRequests.set(control, { pending: (old?.pending || 0) + 1, completed: old?.completed || false })
}
export function mediaProviderRequestFinished(control?: N8nMediaExecutionControl) {
  if (!control) return
  const old = providerRequests.get(control)
  // A complete response proves this owned request finished. This says nothing
  // about other requests or global GPU idleness in the shared provider.
  providerRequests.set(control, { pending: Math.max(0, (old?.pending || 1) - 1), completed: true })
}

export function rethrowMediaExecutionInterruption(error: unknown, control?: N8nMediaExecutionControl): void {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'N8N_MEDIA_TERMINATION_UNCONFIRMED') throw error
  assertMediaExecutionActive(control)
  if (error && typeof error === 'object' && 'code' in error
    && ['N8N_VIDEO_STOP_REQUESTED', 'N8N_CHILD_LEASE_LOST', 'N8N_MEDIA_TERMINATION_UNCONFIRMED'].includes(String(error.code))) throw error
}

/** A user stop drains the one already-started request. HTTP disconnect cannot
 * prove that the shared provider's inference thread stopped. Lease loss still
 * aborts transport immediately; callers retain an unconfirmed provider state. */
export function mediaProviderRequestSignal(control: N8nMediaExecutionControl | undefined, timeoutMs: number,
  options: { drainOnUserStop?: boolean } = {}): {
  signal: AbortSignal
  dispose: () => void
} {
  assertMediaExecutionActive(control)
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!control) return { signal: timeout, dispose: () => undefined }
  const transport = new AbortController()
  const onAbort = () => {
    const reason = control.signal.reason
    if (!(options.drainOnUserStop && reason && typeof reason === 'object' && reason.code === 'N8N_VIDEO_STOP_REQUESTED')) transport.abort(reason)
  }
  control.signal.addEventListener('abort', onAbort, { once: true })
  if (control.signal.aborted) onAbort()
  return { signal: AbortSignal.any([transport.signal, timeout]),
    dispose: () => control.signal.removeEventListener('abort', onAbort) }
}

export function noteUnconfirmedProviderCancellation(control?: N8nMediaExecutionControl): void {
  if (!control?.signal.aborted) return
  const reason = control.signal.reason
  if (reason && typeof reason === 'object' && Object.isExtensible(reason)) {
    reason.providerCancellation = 'provider_unconfirmed'
  }
}

/** Final file mutations are synchronous inside the durable authority fence.
 * A control missing that fence must never silently fall back to a TOCTOU check. */
export function commitMediaExecutionIfActive<T>(control: N8nMediaExecutionControl | undefined, publish: () => T): T {
  assertMediaExecutionActive(control)
  if (!control) return publish()
  if (!control.commitIfActive) throw Object.assign(new Error('媒体发布缺少持久执行权围栏'), { code: 'N8N_MEDIA_PUBLICATION_FENCE_REQUIRED' })
  return control.commitIfActive(() => { assertMediaExecutionActive(control); return publish() })
}

export function publishControlledMediaFile(temporary: string, pathname: string, control?: N8nMediaExecutionControl): void {
  commitMediaExecutionIfActive(control, () => { renameSync(temporary, pathname); chmodSync(pathname, 0o600) })
}

/** Prepare bytes outside the transaction, then serialize publication with the
 * stop-intent transaction. Only the winner may publish a new checkpoint. */
export async function writeControlledMediaJson(pathname: string, value: unknown, control?: N8nMediaExecutionControl): Promise<void> {
  assertMediaExecutionActive(control)
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 })
    publishControlledMediaFile(temporary, pathname, control)
    assertMediaExecutionActive(control)
  } finally { await unlink(temporary).catch(() => undefined) }
}

type ProcessRow = { pid: number; ppid: number; pgid: number; uid: number; state: string; started: string }
function processRows(): ProcessRow[] {
  let raw: string
  try { raw = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,stat=,lstart='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) }
  catch { throw terminationUnconfirmed() }
  return raw.trim().split(/\r?\n/u).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), state: match[5], started: match[6] }] : []
  })
}
function terminationUnconfirmed() {
  const error = new Error('无法确认本次媒体子进程组已经退出') as Error & { code: string }
  error.code = 'N8N_MEDIA_TERMINATION_UNCONFIRMED'
  return error
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A media command owns a new POSIX process group. Cancellation never targets
 * the web service, model server or another task's process group. */
export async function runOwnedMediaCommand(command: string, args: string[], options: {
  control: N8nMediaExecutionControl
  timeoutMs?: number
  maxBuffer?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { control } = options
  assertMediaExecutionActive(control)
  if (process.platform === 'win32' || typeof process.getuid !== 'function') throw terminationUnconfirmed()
  const uid = process.getuid()
  const nonce = randomUUID()
  const child = spawn(command, args, { detached: true, shell: false, cwd: options.cwd,
    env: { ...process.env, ...options.env, AIWORKER_MEDIA_ATTEMPT_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe'] })
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || !pid) {
    // Spawn errors still need an error listener so a failed executable cannot
    // escape as an unhandled process event.
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()) })
    throw terminationUnconfirmed()
  }
  let stdout = '', stderr = ''
  const streamBytes = { stdout: 0, stderr: 0 }
  let commandError: Error | null = null
  let wakeOutcome: ((value: { code: number | null; error?: Error }) => void) | undefined
  let exited = false
  let stopPromise: Promise<void> | null = null
  const maximum = options.maxBuffer ?? 2 * 1024 * 1024
  let groupProved = false
  let leaderStarted: string | null = null
  const escaped = new Map<number, string>()
  const snapshot = () => {
    const rows = processRows()
    const root = rows.find(row => row.pid === pid)
    if (root) {
      if (root.uid !== uid || root.pgid !== pid) throw terminationUnconfirmed()
      if (leaderStarted !== null && root.started !== leaderStarted) throw terminationUnconfirmed()
      leaderStarted = root.started
      groupProved = true
      const descendants = new Set([pid])
      for (let n = 0; n < rows.length; n++) {
        let changed = false
        for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid); changed = true
        }
        if (!changed) break
      }
      for (const row of rows) if (descendants.has(row.pid) && row.pgid !== pid && !row.state.startsWith('Z')) escaped.set(row.pid, row.started)
    }
    const members = rows.filter(row => row.pgid === pid && !row.state.startsWith('Z'))
    if (members.some(row => row.uid !== uid) || (members.length > 0 && !groupProved)) throw terminationUnconfirmed()
    if (rows.some(row => escaped.get(row.pid) === row.started && !row.state.startsWith('Z'))) throw terminationUnconfirmed()
    return members
  }
  const stopGroup = () => {
    stopPromise ??= (async () => {
      if (snapshot().length === 0) return
      try { process.kill(-pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw terminationUnconfirmed() }
      for (let n = 0; n < 20; n++) { if (snapshot().length === 0) return; await delay(50) }
      if (snapshot().length > 0) {
        try { process.kill(-pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw terminationUnconfirmed() }
      }
      for (let n = 0; n < 40; n++) { if (snapshot().length === 0) return; await delay(50) }
      throw terminationUnconfirmed()
    })()
    return stopPromise
  }
  const requestStop = () => { void stopGroup().catch(error => {
    commandError = error
    child.stdout.destroy(); child.stderr.destroy()
    wakeOutcome?.({ code: null, error })
  }) }
  child.once('spawn', () => {
    try { snapshot(); if (control.signal.aborted) requestStop() }
    catch (error) { commandError = error as Error; requestStop() }
  })
  child.once('exit', () => { exited = true; requestStop() })
  const collect = (part: string, stream: 'stdout' | 'stderr') => {
    streamBytes[stream] += Buffer.byteLength(part)
    if (streamBytes[stream] > maximum) {
      commandError ||= Object.assign(new Error('媒体子进程输出超过边界'), { code: 'ENOBUFS' })
      requestStop(); return
    }
    if (stream === 'stdout') stdout += part; else stderr += part
  }
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', part => collect(part, 'stdout'))
  child.stderr.on('data', part => collect(part, 'stderr'))
  control.signal.addEventListener('abort', requestStop, { once: true })
  const timeout = options.timeoutMs === undefined ? null : setTimeout(() => {
    commandError ||= Object.assign(new Error('媒体子进程超过本阶段命令时间边界'), { code: 'ETIMEDOUT' }); requestStop()
  }, options.timeoutMs)
  try {
    const outcome = await new Promise<{ code: number | null; error?: Error }>(resolve => {
      wakeOutcome = resolve
      child.once('error', error => resolve({ code: null, error }))
      child.once('close', code => resolve({ code }))
    })
    if (!exited || control.signal.aborted || stopPromise) await stopGroup()
    if (commandError) throw commandError
    if (control.signal.aborted && control.signal.reason && typeof control.signal.reason === 'object'
      && Object.isExtensible(control.signal.reason) && control.signal.reason.providerCancellation !== 'provider_unconfirmed') {
      control.signal.reason.providerCancellation = 'confirmed'
    }
    assertMediaExecutionActive(control)
    if (outcome.error) throw outcome.error
    if (outcome.code !== 0) throw Object.assign(new Error('媒体子进程执行失败'), { code: outcome.code, stdout, stderr })
    return { stdout, stderr, code: outcome.code }
  } finally {
    control.signal.removeEventListener('abort', requestStop)
    if (timeout) clearTimeout(timeout)
  }
}
