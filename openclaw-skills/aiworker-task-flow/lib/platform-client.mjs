export class PlatformRequestError extends Error {
  constructor(message, { status = 0, body = null, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'PlatformRequestError'
    this.status = status
    this.body = body
  }
}

export const N8N_INTAKE_DRAINING_CODE = 'N8N_INTAKE_DRAINING'

export function isN8nIntakeDrainingError(error) {
  return error instanceof PlatformRequestError
    && error.status === 423
    && error.body?.code === N8N_INTAKE_DRAINING_CODE
}

export function isRetryablePlatformError(error) {
  return isN8nIntakeDrainingError(error)
    || (error instanceof PlatformRequestError
      && (error.status === 0
      || [401, 403, 408, 425, 429].includes(error.status)
      || error.status >= 500))
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

  async function request(path, init = {}, timeoutMs = 15_000) {
    let response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new PlatformRequestError('AI-worker 本机服务暂时不可用', { cause: error })
    }
    const body = await readJson(response)
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

  return {
    baseUrl,
    request,
    getRun,
    getIntakeControl,
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
  }
}
