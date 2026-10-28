export class PlatformRequestError extends Error {
  constructor(message, { status = 0, body = null, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'PlatformRequestError'
    this.status = status
    this.body = body
  }
}

export const N8N_INTAKE_DRAINING_CODE = 'N8N_INTAKE_DRAINING'
export const N8N_VIDEO_STOP_CONTROL_UNCONFIRMED = 'N8N_VIDEO_STOP_CONTROL_UNCONFIRMED'

function unconfirmedVideoStop(status = 0) {
  const error = new PlatformRequestError('视频停止控制状态尚未确认，已保留原任务等待复核', { status })
  error.code = N8N_VIDEO_STOP_CONTROL_UNCONFIRMED
  return error
}

export function isN8nIntakeDrainingError(error) {
  return error instanceof PlatformRequestError
    && error.status === 423
    && error.body?.code === N8N_INTAKE_DRAINING_CODE
}

export function isRetryablePlatformError(error) {
  return isN8nIntakeDrainingError(error)
    || (error instanceof PlatformRequestError
      && (error.code === N8N_VIDEO_STOP_CONTROL_UNCONFIRMED
      || error.status === 0
      || [401, 403, 408, 425, 429].includes(error.status)
      || error.status >= 500))
}

const stopKeys = ['taskId', 'requestId', 'currentState', 'errorCode', 'targetKind', 'bindingId', 'targetSha256',
  'requestedAt', 'updatedAt', 'completedAt', 'revision', 'nextAction']
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const taskIdentity = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,120}$/u.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveInteger = value => Number.isSafeInteger(value) && value > 0
const timestamp = value => Number.isSafeInteger(value) && value >= 0

function validatedVideoStop(value, { taskId, bindingId = null, requestId = null, batchOnly = false }) {
  if (!object(value) || Object.keys(value).length !== stopKeys.length || !stopKeys.every(key => Object.hasOwn(value, key))
    || value.taskId !== taskId || !sha256(value.requestId) || requestId !== null && value.requestId !== requestId
    || !positiveInteger(value.bindingId) || bindingId !== null && value.bindingId !== bindingId
    || !['runtime', 'batch_item'].includes(value.targetKind) || batchOnly && value.targetKind !== 'batch_item'
    || !sha256(value.targetSha256) || !['requested', 'stopping', 'blocked', 'stopped'].includes(value.currentState)
    || !(value.errorCode === null || typeof value.errorCode === 'string' && /^stop_[a-z0-9_]{1,90}$/u.test(value.errorCode))
    || !timestamp(value.requestedAt) || !timestamp(value.updatedAt) || value.updatedAt < value.requestedAt
    || !(value.completedAt === null || timestamp(value.completedAt)) || !positiveInteger(value.revision)
    || !['wait_for_stop_executor', 'wait_for_original_batch_owner', 'inspect_stop_evidence', 'stopped_relearn_as_new_task'].includes(value.nextAction)
    || value.currentState === 'stopped' && (value.completedAt === null || value.nextAction !== 'stopped_relearn_as_new_task')
    || value.currentState !== 'stopped' && value.completedAt !== null) throw unconfirmedVideoStop(502)
  // Return only the documented projection; never forward runtime credentials.
  return Object.fromEntries(stopKeys.map(key => [key, value[key]]))
}

export function normalizeLoopbackBaseUrl(raw) {
  const value = String(raw || 'http://127.0.0.1:3017').replace(/\/+$/, '')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('AI-worker 提交地址无效')
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash) {
    throw new Error('AI-worker 提交地址必须是本机回环 HTTP 地址')
  }
  return value
}

async function readJson(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return { error: text || `HTTP ${response.status}` }
  }
}

export function createPlatformClient(rawBaseUrl) {
  const baseUrl = normalizeLoopbackBaseUrl(rawBaseUrl)

  async function request(path, init = {}, timeoutMs = 15_000, stopStatuses = null) {
    let response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (stopStatuses) throw unconfirmedVideoStop()
      throw new PlatformRequestError('AI-worker 本机服务暂时不可用', { cause: error })
    }
    let body
    try { body = await readJson(response) }
    catch (error) {
      if (stopStatuses) throw unconfirmedVideoStop(response.status)
      throw error
    }
    if (stopStatuses && !stopStatuses.includes(response.status)) throw unconfirmedVideoStop(response.status)
    if (!response.ok) {
      throw new PlatformRequestError(body?.error || `AI-worker 请求失败：HTTP ${response.status}`, {
        status: response.status,
        body,
      })
    }
    return body
  }

  async function getRun(taskId) {
    const body = await request(`/api/n8n/runs?taskId=${encodeURIComponent(taskId)}`)
    return Array.isArray(body?.runs)
      ? body.runs.find(item => item?.taskId === taskId) || null
      : null
  }

  async function getIntakeControl() {
    const body = await request('/api/n8n/intake-control')
    const control = body?.control
    if (
      !body
      || typeof body !== 'object'
      || Array.isArray(body)
      || !control
      || typeof control !== 'object'
      || Array.isArray(control)
      || typeof control.accepting !== 'boolean'
    ) {
      throw new PlatformRequestError('AI-worker 接收状态无效', { status: 502, body })
    }
    return { accepting: control.accepting }
  }

  async function getVideoStopRequest(taskId, bindingId) {
    if (!taskIdentity(taskId) || !positiveInteger(bindingId)) throw unconfirmedVideoStop(400)
    const body = await request(`/api/n8n/runs/stop?taskId=${encodeURIComponent(taskId)}&view=request&bindingId=${bindingId}`,
      { redirect: 'error' }, 15_000, [200])
    const inspection = body?.inspection
    if (!object(inspection) || inspection.taskId !== taskId || inspection.bindingId !== bindingId
      || !Object.hasOwn(inspection, 'stop')) throw unconfirmedVideoStop(502)
    return inspection.stop === null ? null : validatedVideoStop(inspection.stop, { taskId, bindingId })
  }

  async function ackVideoBatchStop(payload) {
    if (!object(payload) || Object.keys(payload).sort().join(',') !== 'requestId,taskId,workerLease'
      || !taskIdentity(payload.taskId) || !sha256(payload.requestId) || !object(payload.workerLease)
      || Object.keys(payload.workerLease).sort().join(',') !== 'pid,token'
      || !positiveInteger(payload.workerLease.pid) || typeof payload.workerLease.token !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(payload.workerLease.token)) {
      throw unconfirmedVideoStop(400)
    }
    const body = await request('/api/n8n/runs/stop/batch-ack', {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }, 15_000, [200, 202])
    if (!object(body) || body.taskId !== payload.taskId) throw unconfirmedVideoStop(502)
    return validatedVideoStop(body.stop, { taskId: payload.taskId, requestId: payload.requestId, batchOnly: true })
  }

  return {
    baseUrl,
    request,
    getRun,
    getIntakeControl,
    getVideoStopRequest,
    ackVideoBatchStop,
    assertIntakeAccepting: async () => {
      const control = await getIntakeControl()
      if (!control.accepting) {
        throw new PlatformRequestError('视频学习服务正在发布维护，请稍后再试。', {
          status: 423,
          body: { code: N8N_INTAKE_DRAINING_CODE },
        })
      }
      return control
    },
    listBindings: async () => {
      const body = await request('/api/n8n/workflows')
      return Array.isArray(body?.bindings) ? body.bindings : []
    },
    trigger: payload => request('/api/n8n/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 135_000),
    dispatchLearningRepair: payload => request('/api/n8n/runs/recovery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dispatch-repair', ...payload }),
    }, 135_000),
  }
}
