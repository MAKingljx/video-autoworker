import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import { createImageJobClient, ImageServiceError, normalizeImageInspection } from './image-job-client.js'

export const IMAGE_COMMAND_TOOL_NAME = 'aiworker_generate_image'
export const IMAGE_AGENT_ID = 'image-studio'
const JOB_ID = /^[0-9a-f]{32}$/u
const STATES = new Set(['QUEUED', 'RUNNING', 'GENERATED_PENDING_REVIEW', 'FAILED', 'CANCELLED', 'CANCEL_REQUESTED', 'RECONCILE_REQUIRED'])
const SUBMIT_KEYS = new Set(['action', 'prompt', 'design', 'protected', 'images', 'width', 'height', 'steps', 'guidance', 'seed', 'creativeRedraw'])
const TEXT_FIELDS = ['kicker', 'title', 'subtitle', 'caption']
const RECTANGLE = { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'],
  properties: { x: { type: 'integer', minimum: 0, maximum: 8192 }, y: { type: 'integer', minimum: 0, maximum: 8192 },
    width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 } } }

const PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['submit', 'status', 'result', 'inspect', 'cancel'] },
    jobId: { type: 'string', pattern: '^[0-9a-f]{32}$', description: '由本工具返回的图片任务编号；status 可省略，列出本会话最近任务。' },
    prompt: { type: 'string', minLength: 1, maxLength: 8192,
      description: '原生整图创作要求。与 design、protected 三选一；只有明确创意重绘时才能使用，真实视频帧封面使用 protected。' },
    creativeRedraw: { type: 'boolean',
      description: '仅 prompt/design 必填且必须为 true：明确授权模型重绘整张参考图。真实视频帧封面不得填写，改用 protected。' },
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
    protected: {
      type: 'object', additionalProperties: false, required: ['schema'],
      properties: {
        schema: { type: 'string', const: 'aiworker-protected-cover/v1' },
        eraseRegions: { type: 'array', maxItems: 4, items: RECTANGLE },
        textLayers: { type: 'array', maxItems: 4, items: {
          type: 'object', additionalProperties: false, required: ['text', 'box'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 128 }, box: RECTANGLE,
            style: { type: 'string', maxLength: 1000 }, align: { type: 'string', enum: ['left', 'center'] },
            role: { type: 'string', enum: ['kicker', 'title', 'subtitle', 'caption'] } },
        } },
      },
      description: '原片保护封面：只传一张真实高清原图；坐标是源图原生像素，不能按缩略图猜。H1模型生成字形/修补素材，应用自动合成并核验保护区。标题层填写 role；未填时第一行自动为 title、第二行为 subtitle。至少有一项编辑；保持原尺寸，不填写外层width/height。',
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

function rectangle(value) {
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'height,width,x,y'
    || ['x', 'y', 'width', 'height'].some(key => !Number.isSafeInteger(value[key])
      || value[key] < (key === 'x' || key === 'y' ? 0 : 1) || value[key] > 8192)) return null
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

// Only normalize the public request shape here. Source bounds, edited-area
// budget, model stages and pixel protection remain application-owned.
function protectedRequest(value) {
  if (!plainObject(value) || value.schema !== 'aiworker-protected-cover/v1'
    || Object.keys(value).some(key => !['schema', 'eraseRegions', 'textLayers'].includes(key))) return null
  const eraseRegions = Object.hasOwn(value, 'eraseRegions') ? value.eraseRegions : []
  const textLayers = Object.hasOwn(value, 'textLayers') ? value.textLayers : []
  if (!Array.isArray(eraseRegions) || !Array.isArray(textLayers)
    || eraseRegions.length > 4 || textLayers.length > 4 || eraseRegions.length + textLayers.length === 0) return null
  const erasures = eraseRegions.map(rectangle)
  if (erasures.some(item => item === null)) return null
  const layers = []
  for (const [index, item] of textLayers.entries()) {
    if (!plainObject(item) || Object.keys(item).some(key => !['text', 'box', 'style', 'align', 'role'].includes(key))
      || !safeString(item.text, 128) || item.text !== item.text.trim() || /[\r\n\t]/u.test(item.text)
      || (Object.hasOwn(item, 'style') && !safeString(item.style, 1000, true))
      || (Object.hasOwn(item, 'align') && !['left', 'center'].includes(item.align))
      || (Object.hasOwn(item, 'role') && !['kicker', 'title', 'subtitle', 'caption'].includes(item.role))) return null
    const box = rectangle(item.box)
    if (!box) return null
    const role = Object.hasOwn(item, 'role') ? item.role : (index === 0 ? 'title' : index === 1 ? 'subtitle' : 'caption')
    layers.push({ text: item.text, box, ...(Object.hasOwn(item, 'style') ? { style: item.style } : {}),
      ...(Object.hasOwn(item, 'align') ? { align: item.align } : {}), role })
  }
  return { schema: value.schema, eraseRegions: erasures, textLayers: layers }
}

export function normalizeImageRequest(params) {
  if (!plainObject(params) || !['submit', 'status', 'result', 'inspect', 'cancel'].includes(params.action)) return null
  if (params.action !== 'submit') {
    if (params.action === 'status' && Object.keys(params).length === 1) return { action: 'status' }
    return Object.keys(params).length === 2 && typeof params.jobId === 'string' && JOB_ID.test(params.jobId)
      ? { action: params.action, jobId: params.jobId } : null
  }
  if (Object.keys(params).some(key => !SUBMIT_KEYS.has(key))) return null
  if (['prompt', 'design', 'protected'].filter(key => Object.hasOwn(params, key)).length !== 1) return null
  if (!Array.isArray(params.images) || params.images.length < 1 || params.images.length > 3
    || !params.images.every(absolutePath)) return null
  const request = { action: 'submit', images: [...params.images] }
  if (Object.hasOwn(params, 'protected')) {
    if (params.images.length !== 1 || Object.hasOwn(params, 'width') || Object.hasOwn(params, 'height')
      || Object.hasOwn(params, 'creativeRedraw')) return null
    const plan = protectedRequest(params.protected)
    if (!plan) return null
    request.protected = plan
  } else if (Object.hasOwn(params, 'prompt')) {
    if (!safeString(params.prompt, 8192) || params.creativeRedraw !== true) return null
    request.prompt = params.prompt
  } else {
    const d = params.design
    if (!plainObject(d) || Object.keys(d).some(key => !['schema', 'profile', 'text', 'scene'].includes(key))
      || d.schema !== 'aiworker-qwen-cover-design/v1' || !safeString(d.profile, 128)
      || !plainObject(d.text) || Object.keys(d.text).sort().join(',') !== [...TEXT_FIELDS].sort().join(',')
      || TEXT_FIELDS.some(key => !safeString(d.text[key], 128)) || params.creativeRedraw !== true
      || (Object.hasOwn(d, 'scene') && !safeString(d.scene, 1000, true))) return null
    request.design = { schema: d.schema, profile: d.profile,
      text: Object.fromEntries(TEXT_FIELDS.map(key => [key, d.text[key]])),
      ...(Object.hasOwn(d, 'scene') ? { scene: d.scene } : {}) }
  }
  if (!Object.hasOwn(params, 'protected')) request.creativeRedraw = true
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
  if (Object.hasOwn(data, 'stage')) {
    if (typeof data.stage !== 'string' || !/^[a-z0-9_]{1,64}$/u.test(data.stage)) throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
    short.stage = data.stage
  }
  if (Object.hasOwn(data, 'mode')) {
    if (!['raw', 'protected'].includes(data.mode)) throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
    short.mode = data.mode
  }
  for (const key of ['width', 'height']) {
    if (Object.hasOwn(data, key)) {
      if (!Number.isSafeInteger(data[key]) || data[key] < 1 || data[key] > 8192) throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
      short[key] = data[key]
    }
  }
  if (Object.hasOwn(data, 'postProcessing')) {
    if (typeof data.postProcessing !== 'boolean') throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
    short.postProcessing = data.postProcessing
  }
  if (Object.hasOwn(data, 'photoProtection')) {
    if (!plainObject(data.photoProtection)) throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
    short.photoProtection = {}
    for (const key of ['outsideChangedPixels', 'protectedPixels', 'changedPixels', 'sourceWidth', 'sourceHeight']) {
      if (Object.hasOwn(data.photoProtection, key)) {
        const value = data.photoProtection[key]
        if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 31 - 1) throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
        short.photoProtection[key] = value
      }
    }
  }
  if (Object.hasOwn(data, 'textValidation')) {
    const check = data.textValidation
    if (!plainObject(check) || typeof check.matched !== 'boolean'
      || check.engine !== (check.expectedCount === 0 ? 'not-applicable' : 'apple-vision') || check.mode !== 'normalized_text_sequence'
      || !Number.isSafeInteger(check.expectedCount) || check.expectedCount < 0 || check.expectedCount > 4
      || !Number.isSafeInteger(check.observedCount) || check.observedCount < 0 || check.observedCount > 128) {
      throw new ImageServiceError('IMAGE_RECEIPT_INVALID')
    }
    short.textValidation = { matched: check.matched, engine: check.engine, mode: check.mode,
      expectedCount: check.expectedCount, observedCount: check.observedCount }
  }
  return short
}

function generationMethod(r) {
  if (r.mode !== 'protected') return '图片由H1本地模型生成。'
  const protection = r.photoProtection
  const counts = protection && Number.isSafeInteger(protection.outsideChangedPixels)
    ? `保护区变化${protection.outsideChangedPixels}像素。` : '请核对照片保护收据。'
  const text = r.textValidation?.expectedCount > 0 ? `文字核验${r.textValidation.matched ? '匹配' : '未匹配'}。` : ''
  return `采用原片保护；新增字形与修补素材由H1模型生成，应用自动合成。${counts}${text}`
}

function stateText(r) {
  const names = { QUEUED: '已受理，正在排队', RUNNING: '正在生成',
    GENERATED_PENDING_REVIEW: '图片已生成，等待检查文字与画面', FAILED: '生成失败',
    CANCELLED: '任务已取消', CANCEL_REQUESTED: '正在取消任务',
    RECONCILE_REQUIRED: '任务状态需要核对，请先查询，不要重复提交' }
  const progress = r.currentState === 'RUNNING' && Number.isInteger(r.completedSteps) && r.totalSteps > 0
    ? `（${r.completedSteps}/${r.totalSteps}步）` : ''
  const stage = r.currentState === 'RUNNING' && r.stage
    ? r.stage.startsWith('erase_') ? '，正在修补指定区域'
      : r.stage.startsWith('text_layer_') ? '，正在生成字形素材'
        : r.stage.startsWith('ocr') ? '，正在核对成品文字'
          : r.stage === 'verify' ? '，正在核对照片保护区域' : ''
    : ''
  return `${names[r.currentState]}${stage}${progress}。任务编号：${r.jobId}。`
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
    // Tool Search's generic JSON bridge cannot preserve native image blocks.
    // This public SDK contract changes presentation, not the tool allowlist.
    catalogMode: 'direct-only',
    description: '调用H1唯一图片应用。照片封面优先protected：保留原图原生分辨率，H1模型生成字形及修补素材，应用保护原片并自动合成；原创整图用prompt/design。只有工具实际返回32位hex任务编号和受理状态才可声称已受理，不得自造编号；submit成功后立即结束回复，等待完成提醒，不反复轮询。status查实际进度；result读回原生尺寸候选附件，原样使用MEDIA引用，不公布物理路径；inspect仅对当前会话已完成任务返回源图和成品的原生image图块，供对照文字、主体、字效与清晰度。看不到图块就明确未完成视觉审核，不能依据收据冒称看图通过。cancel只在用户明确要求取消时用。不得直接运行模型、人工绘字/修图、改其他profile或创建第二队列。生成、保护区校验或OCR匹配不等于最终视觉通过，不自动采用发布。飞书送达以实际渠道和媒体路由验收为准。',
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
        if (request.action === 'inspect' && r.currentState === 'GENERATED_PENDING_REVIEW') {
          const inspection = normalizeImageInspection(await client.inspection(r.jobId, scope, signal), r.jobId)
          const content = [{ type: 'text', text: `${generationMethod(r)}以下依次为源图和成品缩略检查图；请逐项对照，未经看图不能声明视觉通过。` }]
          for (const image of inspection.images) {
            content.push({ type: 'text', text: image.role === 'source' ? '源图' : '成品' })
            content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
          }
          return { content, details: { ...r, visualInspectionImagesAvailable: true,
            inspectionImages: inspection.images.map(({ role, sha256, width, height }) => ({ role, sha256, width, height })) } }
        }
        if (request.action !== 'result' || r.currentState !== 'GENERATED_PENDING_REVIEW') {
          if (isErrorNotice(r)) await acknowledgeRead(r)
          return result(stateText(r), r)
        }
        if (typeof saveMedia !== 'function') throw new ImageServiceError('IMAGE_MEDIA_UNAVAILABLE')
        const buffer = await client.image(r.jobId, scope, data.outputSha256, signal, { mode: r.mode ?? 'raw' })
        const media = await saveMedia(buffer)
        if (!absolutePath(media?.path)) throw new ImageServiceError('IMAGE_MEDIA_INVALID')
        await acknowledgeRead(r)
        return result(`图片已生成，请检查中文文字与画面。${generationMethod(r)}可调用inspect看源图和成品，不要仅凭收据判通过。\nMEDIA:${media.path}`, r)
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
