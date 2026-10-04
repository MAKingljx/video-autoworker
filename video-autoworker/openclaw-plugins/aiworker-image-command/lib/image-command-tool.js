import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import { createImageJobClient, ImageServiceError } from './image-job-client.js'

export const IMAGE_COMMAND_TOOL_NAME = 'aiworker_generate_image'
export const IMAGE_AGENT_ID = 'image-studio'
const JOB_ID = /^[0-9a-f]{32}$/u
const STATES = new Set(['QUEUED', 'RUNNING', 'GENERATED_PENDING_REVIEW', 'FAILED', 'CANCELLED', 'CANCEL_REQUESTED', 'RECONCILE_REQUIRED'])
const SUBMIT_KEYS = new Set(['action', 'prompt', 'design', 'images', 'width', 'height', 'steps', 'guidance', 'seed'])
const TEXT_FIELDS = ['kicker', 'title', 'subtitle', 'caption']

const PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['submit', 'status', 'result', 'cancel'] },
    jobId: { type: 'string', pattern: '^[0-9a-f]{32}$', description: '由本工具返回的图片任务编号；status 可省略，列出本会话最近任务。' },
    prompt: { type: 'string', minLength: 1, maxLength: 8192,
      description: '完整出图要求。中文文字也由 H1 模型生成；与 design 二选一。' },
    design: {
      type: 'object', additionalProperties: false, required: ['schema', 'profile', 'text'],
      properties: {
        schema: { type: 'string', const: 'aiworker-qwen-cover-design/v1' },
        profile: { type: 'string', minLength: 1, maxLength: 128 },
        text: { type: 'object', additionalProperties: false, required: TEXT_FIELDS,
          properties: Object.fromEntries(TEXT_FIELDS.map(key => [key, { type: 'string', minLength: 1, maxLength: 128 }])) },
        scene: { type: 'string', maxLength: 1000 },
      },
      description: '使用已部署的封面设计方案；四组准确中文文字填写在 text 中。',
    },
    images: { type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 4096 },
      description: '用户提供图片或获准素材帧的规范绝对路径；不能填写 URL、猜测路径或成品封面代替源帧。' },
    width: { type: 'integer', minimum: 512, maximum: 2048, multipleOf: 16 },
    height: { type: 'integer', minimum: 512, maximum: 2048, multipleOf: 16 },
    steps: { type: 'integer', minimum: 1, maximum: 60 },
    guidance: { type: 'number', minimum: 1, maximum: 8 },
    seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
  },
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function safeString(value, max, empty = false) {
  return typeof value === 'string' && (empty || value.trim().length > 0)
    && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

function absolutePath(value) {
  return safeString(value, 4096) && value === value.trim() && isAbsolute(value)
    && !value.startsWith('//') && normalize(value) === value && !/[\r\n\t]/u.test(value)
}

export function normalizeImageRequest(params) {
  if (!plainObject(params) || !['submit', 'status', 'result', 'cancel'].includes(params.action)) return null
  if (params.action !== 'submit') {
    if (params.action === 'status' && Object.keys(params).length === 1) return { action: 'status' }
    return Object.keys(params).length === 2 && typeof params.jobId === 'string' && JOB_ID.test(params.jobId)
      ? { action: params.action, jobId: params.jobId } : null
  }
  if (Object.keys(params).some(key => !SUBMIT_KEYS.has(key))) return null
  if (Object.hasOwn(params, 'prompt') === Object.hasOwn(params, 'design')) return null
  if (!Array.isArray(params.images) || params.images.length < 1 || params.images.length > 3
    || !params.images.every(absolutePath)) return null
  const request = { action: 'submit', images: [...params.images] }
  if (Object.hasOwn(params, 'prompt')) {
    if (!safeString(params.prompt, 8192)) return null
    request.prompt = params.prompt
  } else {
    const d = params.design
    if (!plainObject(d) || Object.keys(d).some(key => !['schema', 'profile', 'text', 'scene'].includes(key))
      || d.schema !== 'aiworker-qwen-cover-design/v1' || !safeString(d.profile, 128)
      || !plainObject(d.text) || Object.keys(d.text).sort().join(',') !== [...TEXT_FIELDS].sort().join(',')
      || TEXT_FIELDS.some(key => !safeString(d.text[key], 128))
      || (Object.hasOwn(d, 'scene') && !safeString(d.scene, 1000, true))) return null
    request.design = { schema: d.schema, profile: d.profile,
      text: Object.fromEntries(TEXT_FIELDS.map(key => [key, d.text[key]])),
      ...(Object.hasOwn(d, 'scene') ? { scene: d.scene } : {}) }
  }
  for (const key of ['width', 'height']) {
    if (Object.hasOwn(params, key)) {
      if (!Number.isSafeInteger(params[key]) || params[key] < 512 || params[key] > 2048 || params[key] % 16) return null
      request[key] = params[key]
    }
  }
  if (Object.hasOwn(params, 'steps')) {
    if (!Number.isSafeInteger(params.steps) || params.steps < 1 || params.steps > 60) return null
    request.steps = params.steps
  }
  if (Object.hasOwn(params, 'guidance')) {
    if (!Number.isFinite(params.guidance) || params.guidance < 1 || params.guidance > 8) return null
    request.guidance = params.guidance
  }
  if (Object.hasOwn(params, 'seed')) {
    if (!Number.isSafeInteger(params.seed) || params.seed < 0 || params.seed > 2147483647) return null
    request.seed = params.seed
  }
  return request
}

export function imageSessionScope(context) {
  const key = context?.sessionKey
  if (context?.agentId !== IMAGE_AGENT_ID || !safeString(key, 4096)
    || key !== key.trim() || !key.startsWith(`agent:${IMAGE_AGENT_ID}:`) || /[\r\n\t]/u.test(key)) return null
  return createHash('sha256').update(`${IMAGE_AGENT_ID}\0${key}`).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function imageRequestKey(scope, toolCallId, request) {
  return createHash('sha256').update(`${scope}\0${toolCallId}\0${canonicalJson(request)}`).digest('hex')
}

function result(text, details = {}) { return { content: [{ type: 'text', text }], details } }

export function imageReceipt(data, expectedJobId) {
  if (!plainObject(data) || typeof data.jobId !== 'string' || !JOB_ID.test(data.jobId) || !STATES.has(data.currentState)
    || (expectedJobId && data.jobId !== expectedJobId)) throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
  const short = { jobId: data.jobId, currentState: data.currentState }
  for (const key of ['errorCode', 'nextAction']) {
    if (typeof data[key] === 'string' && /^[A-Za-z0-9_:-]{1,128}$/u.test(data[key])) short[key] = data[key]
  }
  for (const key of ['completedSteps', 'totalSteps']) {
    if (Number.isSafeInteger(data[key]) && data[key] >= 0 && data[key] <= 10000) short[key] = data[key]
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof data[key] === 'string' && /^[0-9TZ:+. -]{1,64}$/u.test(data[key])) short[key] = data[key]
  }
  return short
}

function stateText(r) {
  const names = { QUEUED: '已受理，正在排队', RUNNING: '正在生成',
    GENERATED_PENDING_REVIEW: '图片已生成，等待检查文字与画面', FAILED: '生成失败',
    CANCELLED: '任务已取消', CANCEL_REQUESTED: '正在取消任务',
    RECONCILE_REQUIRED: '任务状态需要核对，请先查询，不要重复提交' }
  const progress = r.currentState === 'RUNNING' && Number.isInteger(r.completedSteps) && r.totalSteps > 0
    ? `（${r.completedSteps}/${r.totalSteps}步）` : ''
  return `${names[r.currentState]}${progress}。任务编号：${r.jobId}。`
}

export function createImageCommandTool({ context, client = createImageJobClient(), saveMedia, releaseReady = true,
  onSubmitted, onReceiptRead } = {}) {
  const scope = imageSessionScope(context)
  if (!scope) return null
  async function acknowledgeRead(r) {
    try { await onReceiptRead?.({ jobId: r.jobId, scope, sessionKey: context.sessionKey }) }
    catch { /* A notification-store failure cannot hide a valid job result. */ }
  }
  function isErrorNotice(r) { return ['FAILED', 'CANCELLED', 'RECONCILE_REQUIRED'].includes(r.currentState) }
  return {
    name: IMAGE_COMMAND_TOOL_NAME, label: 'H1 图片生成',
    description: '调用 H1 本地图片生成服务。submit 快速受理后台任务，不能等待模型推理或反复轮询；完成后可收到原会话的系统事件提示，事件排入不代表图片已送达；status 查询真实进度，省略 jobId 列出本会话最近任务；result 读取本会话已生成候选图片并返回附件，回复时使用原样 MEDIA 引用展示图片，不公布物理路径；cancel 仅在用户明确要求取消时调用。图片与中文文字全部由本地模型生成，禁止另行叠字或后期修补。任务生成成功仍待用户检查，不能保证中文准确或声称已经采用、发布。只处理当前会话工具返回的任务编号，不读取其他会话或任意文件。是否可发送飞书图片，以当前通道配置和真实附件路由验收为准，不能把会话事件当作已送达。',
    parameters: PARAMETERS, executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      if (!releaseReady) return result('图片服务正在维护，请稍后再试。', { errorCode: 'IMAGE_SERVICE_NOT_READY' })
      const request = normalizeImageRequest(params)
      if (!request || !safeString(toolCallId, 4096)) {
        return result('图片请求不完整，请提供图片和生成要求。', { errorCode: 'IMAGE_REQUEST_INVALID' })
      }
      try {
        if (request.action === 'submit') {
          const { action: _action, ...payload } = request
          const data = await client.submit({ ...payload, scope, requestKey: imageRequestKey(scope, toolCallId, payload) }, signal)
          const r = imageReceipt(data)
          if (onSubmitted) {
            try { await onSubmitted({ jobId: r.jobId, scope, sessionKey: context.sessionKey }) }
            catch { return result(`${stateText(r)}完成提醒暂不可用，可按任务编号查询。`, { ...r, notificationErrorCode: 'IMAGE_NOTIFICATION_UNAVAILABLE' }) }
          }
          return result(stateText(r), r)
        }
        if (request.action === 'cancel') {
          const r = imageReceipt(await client.cancel(request.jobId, scope, signal), request.jobId)
          if (isErrorNotice(r)) await acknowledgeRead(r)
          return result(stateText(r), r)
        }
        if (!request.jobId) {
          const data = await client.list(scope, signal)
          if (!Array.isArray(data.jobs) || data.jobs.length > 20) throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
          const jobs = data.jobs.map(item => imageReceipt(item))
          for (const r of jobs) if (isErrorNotice(r)) await acknowledgeRead(r)
          return result(jobs.length ? jobs.map(stateText).join('\n') : '本会话还没有图片任务。', { jobs })
        }
        const data = await client.status(request.jobId, scope, signal)
        const r = imageReceipt(data, request.jobId)
        if (request.action !== 'result' || r.currentState !== 'GENERATED_PENDING_REVIEW') {
          if (isErrorNotice(r)) await acknowledgeRead(r)
          return result(stateText(r), r)
        }
        if (typeof saveMedia !== 'function') throw new ImageServiceError('IMAGE_MEDIA_UNAVAILABLE')
        const buffer = await client.image(r.jobId, scope, data.outputSha256, signal)
        const media = await saveMedia(buffer)
        if (!absolutePath(media?.path)) throw new ImageServiceError('IMAGE_MEDIA_INVALID')
        await acknowledgeRead(r)
        return result(`图片已生成，请检查中文文字与画面。\nMEDIA:${media.path}`, r)
      } catch (error) {
        const errorCode = error instanceof ImageServiceError ? error.errorCode
          : signal?.aborted ? 'IMAGE_REQUEST_ABORTED' : 'IMAGE_SERVICE_UNAVAILABLE'
        const text = request.action === 'submit'
          ? '暂时无法确认图片是否受理，请先查询任务，避免重复提交。'
          : '暂时无法读取或操作图片任务，请稍后再查询。'
        return result(text, { errorCode })
      }
    },
  }
}
