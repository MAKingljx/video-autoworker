import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import { createImageJobClient, ImageServiceError, normalizeImageInspection } from './image-job-client.js'
import { imageSessionScope, LEGACY_IMAGE_PROFILE, legacyImageBinding } from './image-profile-binding.js'

// The previous public tool combined submission, inspection and cancellation
// behind one `action` field. Its JSON schema could only require `action`, while
// the application correctly required more fields for a submission. Local tool
// callers could therefore emit a syntactically valid but business-invalid
// `{ action: 'submit' }`. Keep the shared executor below, but expose only
// action-specific contracts to OpenClaw.
const INTERNAL_IMAGE_COMMAND_TOOL_NAME = 'aiworker_image_executor'
export const IMAGE_SUBMIT_CREATIVE_TOOL_NAME = 'aiworker_submit_creative_image'
export const IMAGE_SUBMIT_DESIGN_TOOL_NAME = 'aiworker_submit_designed_cover'
export const IMAGE_SUBMIT_PROTECTED_TOOL_NAME = 'aiworker_submit_protected_cover'
export const IMAGE_TASK_TOOL_NAME = 'aiworker_image_task'
export const IMAGE_HELP_TOOL_NAME = 'aiworker_image_help'
export const IMAGE_VIDEO_COVER_DIRECTORY_TOOL_NAME = 'aiworker_video_cover_read_directory'
export const IMAGE_VIDEO_COVER_CANDIDATES_TOOL_NAME = 'aiworker_video_cover_get_candidates'
export const IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME = 'aiworker_video_cover_submit_protected'
export const IMAGE_VIDEO_COVER_TASK_TOOL_NAME = 'aiworker_video_cover_task'
export const QWEN_IMAGE_WORKFLOW_TOOL_NAMES = Object.freeze([
  IMAGE_VIDEO_COVER_DIRECTORY_TOOL_NAME,
  IMAGE_VIDEO_COVER_CANDIDATES_TOOL_NAME,
  IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME,
  IMAGE_VIDEO_COVER_TASK_TOOL_NAME,
])
export const IMAGE_COMMAND_TOOL_NAMES = Object.freeze([
  IMAGE_SUBMIT_CREATIVE_TOOL_NAME,
  IMAGE_SUBMIT_DESIGN_TOOL_NAME,
  IMAGE_SUBMIT_PROTECTED_TOOL_NAME,
  IMAGE_TASK_TOOL_NAME,
  IMAGE_HELP_TOOL_NAME,
])
export const IMAGE_PLUGIN_TOOL_NAMES = Object.freeze([...IMAGE_COMMAND_TOOL_NAMES, ...QWEN_IMAGE_WORKFLOW_TOOL_NAMES])

export function imageCommandToolNamesForProfile(profile) {
  return profile === 'qwen-current'
    ? [...IMAGE_COMMAND_TOOL_NAMES, ...QWEN_IMAGE_WORKFLOW_TOOL_NAMES]
    : [...IMAGE_COMMAND_TOOL_NAMES]
}
export const IMAGE_AGENT_ID = LEGACY_IMAGE_PROFILE
export { imageSessionScope }
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

const CREATIVE_SUBMIT_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['prompt', 'images'],
  properties: {
    prompt: PARAMETERS.properties.prompt,
    images: PARAMETERS.properties.images,
    width: PARAMETERS.properties.width,
    height: PARAMETERS.properties.height,
    steps: PARAMETERS.properties.steps,
    guidance: PARAMETERS.properties.guidance,
    seed: PARAMETERS.properties.seed,
  },
}

const DESIGN_SUBMIT_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['design', 'images'],
  properties: {
    design: PARAMETERS.properties.design,
    images: PARAMETERS.properties.images,
    width: PARAMETERS.properties.width,
    height: PARAMETERS.properties.height,
    steps: PARAMETERS.properties.steps,
    guidance: PARAMETERS.properties.guidance,
    seed: PARAMETERS.properties.seed,
  },
}

const PROTECTED_SUBMIT_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['protected', 'images'],
  properties: {
    protected: PARAMETERS.properties.protected,
    images: { ...PARAMETERS.properties.images, maxItems: 1 },
  },
}

const TASK_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['action', 'jobId'],
  properties: {
    action: { type: 'string', enum: ['status', 'result', 'inspect', 'cancel'] },
    jobId: PARAMETERS.properties.jobId,
  },
}

const HELP_PARAMETERS = { type: 'object', additionalProperties: false, properties: {} }
const VIDEO_COVER_DIRECTORY_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 120,
      description: '已学习视频的精确原文件名。' },
  },
}
const VIDEO_COVER_CANDIDATES_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['operationId', 'segmentIndex'],
  properties: {
    operationId: { type: 'string', pattern: '^[a-f0-9]{32}$',
      description: '仅由视频封面目录工具返回的当前会话工作流编号。' },
    segmentIndex: { type: 'integer', minimum: 1,
      description: '目录工具返回且可用的片段编号。' },
  },
}
const VIDEO_COVER_SUBMIT_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['operationId', 'frameRef', 'protected'],
  properties: {
    operationId: VIDEO_COVER_CANDIDATES_PARAMETERS.properties.operationId,
    frameRef: { type: 'string', pattern: '^[a-f0-9]{32}$',
      description: '仅由候选帧工具返回的当前会话候选帧引用。' },
    protected: PARAMETERS.properties.protected,
  },
}
const VIDEO_COVER_TASK_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['jobId', 'taskAction'],
  properties: {
    jobId: PARAMETERS.properties.jobId,
    taskAction: { type: 'string', enum: ['status', 'result', 'inspect', 'cancel'],
      description: '必须携带提交工具成功返回的图片任务编号。' },
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

export function createImageCommandTool({ context, binding = legacyImageBinding(), client = createImageJobClient(), saveMedia,
  releaseReady = true, onSubmitted, onReceiptRead } = {}) {
  const scope = imageSessionScope(context, binding)
  if (!scope) return null
  async function acknowledgeRead(r) {
    try { await onReceiptRead?.({ jobId: r.jobId, scope, sessionKey: context.sessionKey }) }
    catch { /* A notification-store failure cannot hide a valid job result. */ }
  }
  function isErrorNotice(r) { return ['FAILED', 'CANCELLED', 'RECONCILE_REQUIRED'].includes(r.currentState) }
  return {
    name: INTERNAL_IMAGE_COMMAND_TOOL_NAME, label: 'H1 图片生成',
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
        const safeErrorCode = /^[A-Za-z0-9_:-]{1,96}$/u.test(errorCode)
          ? errorCode : 'IMAGE_SERVICE_UNAVAILABLE'
        const text = request.action === 'submit'
          ? `图片服务未确认受理（${safeErrorCode}），请先查询任务，避免重复提交。`
          : '暂时无法读取或操作图片任务，请稍后再查询。'
        return result(text, { errorCode: safeErrorCode })
      }
    },
  }
}

const NO_PROGRESS_SUBMISSION_CODES = new Set([
  'IMAGE_REQUEST_INVALID',
  'IMAGE_REQUEST_ABORTED',
  'IMAGE_SERVICE_UNAVAILABLE',
  'IMAGE_RESPONSE_INVALID',
  'IMAGE_RESPONSE_TOO_LARGE',
])

function submissionSignature(scope, toolName, request) {
  return createHash('sha256').update(`${scope}\0${toolName}\0${canonicalJson(request)}`).digest('hex')
}

// This is intentionally memory-only. It scopes a no-progress fence to one
// trusted image session and one agent turn; it never persists prompts, source
// paths or image data and cannot change application-owned job state.
export function createImageSubmissionFence({ maxEntries = 256 } = {}) {
  const entries = new Map()
  function prune() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
  }
  return Object.freeze({
    isBlocked(scope, toolName, request) {
      return entries.has(submissionSignature(scope, toolName, request))
    },
    block(scope, toolName, request) {
      entries.set(submissionSignature(scope, toolName, request), true)
      prune()
    },
  })
}

function withSafeDetails(answer, details) {
  return {
    ...answer,
    details: { ...(plainObject(answer?.details) ? answer.details : {}), ...details },
  }
}

function submissionFailure({ errorCode, blocked = false } = {}) {
  const code = blocked ? 'IMAGE_REPEAT_BLOCKED' : errorCode || 'IMAGE_REQUEST_INVALID'
  const nextAction = blocked
    ? 'REPORT_IMAGE_SUBMISSION_BLOCKED'
    : code === 'IMAGE_REQUEST_INVALID'
      ? 'PROVIDE_REQUIRED_IMAGE_SUBMISSION_FIELDS'
      : 'REPORT_IMAGE_SUBMISSION_UNCONFIRMED'
  const text = blocked
    ? '本轮相同图片提交没有取得进展，已停止重复调用。请如实说明失败原因，不要继续提交。'
    : code === 'IMAGE_REQUEST_INVALID'
      ? '图片请求不完整，未提交到图片服务。请提供指定图片和完整生成要求。'
      : '暂时无法确认图片是否受理，本轮已停止重复提交。请先如实报告当前状态。'
  return { ...result(text, { errorCode: code, nextAction }), isError: true }
}

function submissionNextAction(receipt) {
  if (receipt?.currentState === 'QUEUED' || receipt?.currentState === 'RUNNING') return 'WAIT_FOR_IMAGE_NOTIFICATION'
  if (receipt?.currentState === 'GENERATED_PENDING_REVIEW') return 'READ_IMAGE_RESULT'
  return 'REPORT_IMAGE_TASK_STATE'
}

function taskNextAction(action, receipt) {
  if (action === 'cancel') return receipt?.currentState === 'CANCEL_REQUESTED'
    ? 'WAIT_FOR_IMAGE_CANCELLATION' : 'REPORT_IMAGE_TASK_STATE'
  if (action === 'result' && receipt?.currentState === 'GENERATED_PENDING_REVIEW') return 'INSPECT_IMAGE_RESULT'
  if (action === 'inspect') return 'REPORT_IMAGE_INSPECTION'
  return submissionNextAction(receipt)
}

function submitRequest(toolName, params) {
  if (!plainObject(params)) return null
  if (toolName === IMAGE_SUBMIT_CREATIVE_TOOL_NAME) {
    return normalizeImageRequest({ ...params, action: 'submit', creativeRedraw: true })
  }
  if (toolName === IMAGE_SUBMIT_DESIGN_TOOL_NAME) {
    return normalizeImageRequest({ ...params, action: 'submit', creativeRedraw: true })
  }
  if (toolName === IMAGE_SUBMIT_PROTECTED_TOOL_NAME) {
    return normalizeImageRequest({ ...params, action: 'submit' })
  }
  return null
}

function submissionDefinition({ name, label, description, parameters }) {
  return { name, label, description, parameters, executionMode: 'sequential' }
}

function normalizeCoverWorkflowRequest(action, params) {
  if (!plainObject(params)) return null
  const keys = Object.keys(params).sort().join(',')
  if (action === 'read_segments') {
    return keys === 'query' && safeString(params.query, 120) && params.query === params.query.trim()
      ? { action, query: params.query } : null
  }
  if (action === 'cover_frames') {
    return keys === 'operationId,segmentIndex' && /^[a-f0-9]{32}$/u.test(params.operationId)
      && Number.isSafeInteger(params.segmentIndex) && params.segmentIndex > 0
      ? { action, operationId: params.operationId, segmentIndex: params.segmentIndex } : null
  }
  if (action === 'submit_protected_cover') {
    const protectedPlan = protectedRequest(params.protected)
    return keys === 'frameRef,operationId,protected' && /^[a-f0-9]{32}$/u.test(params.operationId)
      && /^[a-f0-9]{32}$/u.test(params.frameRef) && protectedPlan
      ? { action, operationId: params.operationId, frameRef: params.frameRef, protected: protectedPlan } : null
  }
  if (action === 'image_task') {
    return keys === 'jobId,taskAction' && /^[0-9a-f]{32}$/u.test(params.jobId)
      && ['status', 'result', 'inspect', 'cancel'].includes(params.taskAction)
      ? { action, jobId: params.jobId, taskAction: params.taskAction } : null
  }
  return null
}

function workflowDetails(phase, status, values = {}) {
  return {
    schema: 'aiworker-capability/v1', capability: 'video_cover', phase, status,
    ...values,
  }
}

function workflowFailure(errorCode, nextAction) {
  return {
    ...result('视频封面工作流未完成；未创建新的图片任务。', workflowDetails('failed', 'failed', { errorCode, nextAction })),
    isError: true,
  }
}

function workflowErrorCode(error) {
  if (typeof error?.errorCode === 'string' && /^[A-Z0-9_]{1,96}$/u.test(error.errorCode)) {
    return error.errorCode
  }
  const message = typeof error?.message === 'string' ? error.message : ''
  const known = {
    video_frame_reference_expired: 'VIDEO_COVER_FRAME_REF_EXPIRED',
    video_frame_reference_scope_mismatch: 'VIDEO_COVER_SESSION_SCOPE_MISMATCH',
    video_frame_reference_workflow_mismatch: 'VIDEO_COVER_WORKFLOW_MISMATCH',
    video_frame_reference_reference_invalid: 'VIDEO_COVER_REFERENCE_INVALID',
    video_frame_reference_receipt_invalid: 'VIDEO_COVER_REFERENCE_INVALID',
    video_frame_reference_workflow_reference_invalid: 'VIDEO_COVER_WORKFLOW_REFERENCE_INVALID',
  }
  return known[message] || 'VIDEO_COVER_WORKFLOW_UNAVAILABLE'
}

function createImageHelpTool({ videoCoverWorkflowEnabled = false } = {}) {
  const videoCoverWorkflow = videoCoverWorkflowEnabled
    ? ` 已学习视频封面只用 ${IMAGE_VIDEO_COVER_DIRECTORY_TOOL_NAME}、${IMAGE_VIDEO_COVER_CANDIDATES_TOOL_NAME}、${IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME} 和 ${IMAGE_VIDEO_COVER_TASK_TOOL_NAME}；它们共享同一个受控工作流，绝不能通过 tool_search、tool_describe、tool_call 或旧工具转发。`
    : ''
  return {
    name: IMAGE_HELP_TOOL_NAME,
    label: '图片工具说明',
    description: '说明 H1 图片工具的严格提交方式。只返回安全用法，不创建图片任务。',
    parameters: HELP_PARAMETERS,
    executionMode: 'sequential',
    async execute() {
      return result(
        `提交原创图用 aiworker_submit_creative_image；设计封面用 aiworker_submit_designed_cover；保留原片用 aiworker_submit_protected_cover。三者都会返回任务编号。后续只能用 aiworker_image_task 携带该任务编号查询、读取、检查或取消。提交未返回任务编号时不得重试。${videoCoverWorkflow}`,
        { nextAction: 'USE_ACTION_SPECIFIC_IMAGE_TOOL' },
      )
    },
  }
}

// Public image tools use strict action-specific schemas. The old mixed-action
// executor remains private to this module so every path still reaches the same
// application queue, idempotency rules, notification service and media bridge.
export function createImageCommandTools({ context, binding = legacyImageBinding(), client = createImageJobClient(), saveMedia,
  releaseReady = true, onSubmitted, onReceiptRead, submissionFence = createImageSubmissionFence(),
  videoWorkflowClient, videoFrameStore } = {}) {
  const scope = imageSessionScope(context, binding)
  if (!scope) return []
  const executor = createImageCommandTool({ context, binding, client, saveMedia, releaseReady, onSubmitted, onReceiptRead })
  if (!executor) return []

  const submit = definition => ({
    ...definition,
    async execute(toolCallId, params, signal) {
      const request = submitRequest(definition.name, params)
      if (!request || !safeString(toolCallId, 4096)) {
        const raw = plainObject(params) ? params : {}
        if (submissionFence.isBlocked(scope, definition.name, raw)) return submissionFailure({ blocked: true })
        submissionFence.block(scope, definition.name, raw)
        return submissionFailure({ errorCode: 'IMAGE_REQUEST_INVALID' })
      }
      if (submissionFence.isBlocked(scope, definition.name, request)) return submissionFailure({ blocked: true })
      const answer = await executor.execute(toolCallId, request, signal)
      const details = plainObject(answer?.details) ? answer.details : {}
      if (!details.jobId && NO_PROGRESS_SUBMISSION_CODES.has(details.errorCode)) {
        submissionFence.block(scope, definition.name, request)
        return withSafeDetails(answer, {
          errorCode: details.errorCode,
          nextAction: details.errorCode === 'IMAGE_REQUEST_INVALID'
            ? 'PROVIDE_REQUIRED_IMAGE_SUBMISSION_FIELDS'
            : 'REPORT_IMAGE_SUBMISSION_UNCONFIRMED',
        })
      }
      return withSafeDetails(answer, { nextAction: submissionNextAction(details) })
    },
  })

  const task = {
    name: IMAGE_TASK_TOOL_NAME,
    label: 'H1 图片任务',
    // Result and inspection can carry native image blocks, so this capability
    // stays directly visible to the model rather than passing through the
    // generic tool-search JSON bridge.
    catalogMode: 'direct-only',
    description: '仅对提交工具返回的图片任务编号执行 status、result、inspect 或 cancel。不得用它再次提交图片。',
    parameters: TASK_PARAMETERS,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const request = normalizeImageRequest(params)
      if (!request || request.action === 'submit' || !safeString(toolCallId, 4096)) {
        return result('图片任务请求不完整，请提供工具返回的任务编号。', {
          errorCode: 'IMAGE_TASK_REQUEST_INVALID', nextAction: 'USE_RETURNED_IMAGE_JOB_ID',
        })
      }
      const answer = await executor.execute(toolCallId, request, signal)
      const details = plainObject(answer?.details) ? answer.details : {}
      return withSafeDetails(answer, {
        nextAction: details.errorCode ? 'REPORT_IMAGE_TASK_FAILURE' : taskNextAction(request.action, details),
      })
    },
  }

  const videoCoverWorkflowEnabled = binding.profile === 'qwen-current' && videoWorkflowClient && videoFrameStore
  const executeVideoCoverWorkflow = async (toolCallId, request, signal) => {
    try {
      if (request.action === 'read_segments') {
        const existing = typeof videoFrameStore.findWorkflow === 'function'
          ? await videoFrameStore.findWorkflow({ imageScope: scope, sessionKey: context.sessionKey, videoName: request.query })
          : null
        if (existing) {
          return result(`视频：${existing.videoName} 已在本回合准备完成；operationId=${existing.operationId}。不得重复读取目录，直接用该编号选择已返回的可用片段并调用 ${IMAGE_VIDEO_COVER_CANDIDATES_TOOL_NAME}。`, workflowDetails('segments', 'blocked', {
            operationId: existing.operationId, videoName: existing.videoName,
            availableSegmentCount: existing.segmentIndexes.length, nextAction: 'COVER_FRAMES',
          }))
        }
        const directory = await videoWorkflowClient.segments({ query: request.query }, signal)
        const availableIndexes = directory.items.filter(item => item.available === true).map(item => item.index)
        if (!availableIndexes.length) return workflowFailure('VIDEO_COVER_NO_AVAILABLE_SEGMENTS', 'REPORT_VIDEO_LEARNING_GAP')
        const workflow = await videoFrameStore.beginWorkflow({
          imageScope: scope, sessionKey: context.sessionKey, videoName: directory.videoName, segmentIndexes: availableIndexes,
        })
        const content = [{ type: 'text', text: `视频：${directory.videoName}；可用片段 ${availableIndexes.length}/${directory.totalSegments}；operationId=${workflow.operationId}。以下是已学习摘要目录；只可从标为可用的片段中选择一个编号，下一步调用 ${IMAGE_VIDEO_COVER_CANDIDATES_TOOL_NAME}。` }]
        for (const item of directory.items) {
          content.push({ type: 'text', text: `片段 ${item.index}｜${item.timeRange || '时间未知'}｜${item.available ? '可用' : '不可用'}｜${item.summary || '无摘要'}` })
        }
        return { content, details: workflowDetails('segments', 'ok', {
          operationId: workflow.operationId, videoName: directory.videoName, totalSegments: directory.totalSegments,
          availableSegmentCount: availableIndexes.length, directoryPreviewCompacted: directory.directoryPreviewCompacted,
          nextAction: 'COVER_FRAMES',
        }) }
      }
      if (request.action === 'cover_frames') {
        const workflow = await videoFrameStore.resolveWorkflow({
          operationId: request.operationId, imageScope: scope, sessionKey: context.sessionKey,
        })
        if (!workflow.segmentIndexes.includes(request.segmentIndex)) {
          return workflowFailure('VIDEO_COVER_SEGMENT_NOT_AVAILABLE', 'CHOOSE_AVAILABLE_SEGMENT')
        }
        const cached = typeof videoFrameStore.listWorkflowFrames === 'function'
          ? await videoFrameStore.listWorkflowFrames({
            operationId: workflow.operationId, segmentIndex: request.segmentIndex,
            imageScope: scope, sessionKey: context.sessionKey,
          }) : []
        if (cached.length > 0) {
          const content = [{ type: 'text', text: `片段 ${request.segmentIndex} 的候选帧已在本回合返回；不得重复抽帧。请选择一张现有 frameRef，以同一 operationId 调用 ${IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME}。` }]
          for (const frame of cached) {
            content.push({ type: 'text', text: `frameRef=${frame.frameRef}；片段 ${frame.segmentIndex}；${frame.timeRange}；${frame.width}×${frame.height}` })
            content.push({ type: 'image', data: frame.data, mimeType: 'image/jpeg' })
          }
          return { content, details: workflowDetails('frames', 'blocked', {
            operationId: workflow.operationId, videoName: workflow.videoName, candidateCount: cached.length,
            candidates: cached.map(({ frameRef, segmentIndex, timeRange, width, height, sha256 }) => ({
              frameRef, segmentIndex, timeRange, width, height, sha256,
            })),
            nextAction: 'SUBMIT_PROTECTED_COVER',
          }) }
        }
        const response = await videoWorkflowClient.frames({ query: workflow.videoName, segmentIndex: request.segmentIndex }, signal)
        const stored = await videoFrameStore.captureBatch({
          imageScope: scope, sessionKey: context.sessionKey, videoName: response.videoName,
          workflowId: workflow.operationId, candidates: response.candidates,
        })
        const content = [{ type: 'text', text: `视频：${response.videoName}。候选帧 ${stored.length} 张，来自片段 ${request.segmentIndex}。请选择一张当前返回的 frameRef，并以同一 operationId 调用 ${IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME}；不得构造路径或重读目录。` }]
        for (const frame of stored) {
          content.push({ type: 'text', text: `frameRef=${frame.frameRef}；片段 ${frame.segmentIndex}；${frame.timeRange}；原片时间 ${frame.frameTimeSeconds.toFixed(3)} 秒；${frame.width}×${frame.height}` })
          content.push({ type: 'image', data: frame.data, mimeType: 'image/jpeg' })
        }
        return { content, details: workflowDetails('frames', 'ok', {
          operationId: workflow.operationId, videoName: response.videoName, candidateCount: stored.length,
          candidates: stored.map(({ frameRef, segmentIndex, timeRange, frameTimeSeconds, width, height, sha256 }) => ({
            frameRef, segmentIndex, timeRange, frameTimeSeconds, width, height, sha256,
          })),
          nextAction: 'SUBMIT_PROTECTED_COVER',
        }) }
      }
      if (request.action === 'submit_protected_cover') {
        await videoFrameStore.resolveWorkflow({
          operationId: request.operationId, imageScope: scope, sessionKey: context.sessionKey,
        })
        const source = await videoFrameStore.resolve({
          frameRef: request.frameRef, imageScope: scope, sessionKey: context.sessionKey, workflowId: request.operationId,
        })
        const imageRequest = { action: 'submit', protected: request.protected, images: [source.path] }
        if (submissionFence.isBlocked(scope, IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME, imageRequest)) {
          return { ...submissionFailure({ blocked: true }), details: workflowDetails('submitted', 'blocked', {
            errorCode: 'IMAGE_REPEAT_BLOCKED', nextAction: 'REPORT_IMAGE_SUBMISSION_BLOCKED',
          }) }
        }
        const answer = await executor.execute(`cover-workflow:${request.operationId}:${request.frameRef}`, imageRequest, signal)
        const details = plainObject(answer?.details) ? answer.details : {}
        if (!details.jobId && NO_PROGRESS_SUBMISSION_CODES.has(details.errorCode)) {
          submissionFence.block(scope, IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME, imageRequest)
          return { ...answer, isError: true, details: workflowDetails('submitted', 'failed', {
            errorCode: details.errorCode, nextAction: 'REPORT_IMAGE_SUBMISSION_UNCONFIRMED',
          }) }
        }
        return { ...answer, details: workflowDetails('submitted', 'ok', {
          jobId: details.jobId, currentState: details.currentState, nextAction: submissionNextAction(details),
        }) }
      }
      const answer = await executor.execute(toolCallId, { action: request.taskAction, jobId: request.jobId }, signal)
      const details = plainObject(answer?.details) ? answer.details : {}
      return { ...answer, details: workflowDetails('task', details.errorCode ? 'failed' : 'ok', {
        jobId: request.jobId, currentState: details.currentState, errorCode: details.errorCode,
        nextAction: details.errorCode ? 'REPORT_IMAGE_TASK_FAILURE' : taskNextAction(request.taskAction, details),
      }) }
    } catch (error) {
      const errorCode = workflowErrorCode(error)
      return workflowFailure(errorCode, errorCode === 'VIDEO_COVER_WORKFLOW_UNAVAILABLE'
        ? 'REPORT_WORKFLOW_FAILURE' : 'RESTART_VIDEO_COVER_WORKFLOW')
    }
  }
  const videoCoverTool = ({ name, label, description, parameters, action }) => ({
    name,
    label,
    catalogMode: 'direct-only',
    description,
    parameters,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      if (!releaseReady) return workflowFailure('IMAGE_SERVICE_NOT_READY', 'WAIT_FOR_SERVICE_READY')
      if (!safeString(toolCallId, 4096)) return workflowFailure('VIDEO_COVER_WORKFLOW_REQUEST_INVALID', 'USE_WORKFLOW_SCHEMA')
      const request = normalizeCoverWorkflowRequest(action, params)
      if (!request) return workflowFailure('VIDEO_COVER_WORKFLOW_REQUEST_INVALID', 'USE_WORKFLOW_SCHEMA')
      return executeVideoCoverWorkflow(toolCallId, request, signal)
    },
  })
  const videoCoverWorkflowTools = videoCoverWorkflowEnabled ? [
    videoCoverTool({
      name: IMAGE_VIDEO_COVER_DIRECTORY_TOOL_NAME,
      label: 'H1 视频封面摘要目录',
      description: '视频封面工作流第1步。读取指定已学习视频的受控摘要目录并返回当前会话工作流编号。不得调用旧视频摘要工具。',
      parameters: VIDEO_COVER_DIRECTORY_PARAMETERS,
      action: 'read_segments',
    }),
    videoCoverTool({
      name: IMAGE_VIDEO_COVER_CANDIDATES_TOOL_NAME,
      label: 'H1 视频封面候选帧',
      description: '视频封面工作流第2步。使用目录工具返回的工作流编号和一个可用片段，返回三张原生候选帧。',
      parameters: VIDEO_COVER_CANDIDATES_PARAMETERS,
      action: 'cover_frames',
    }),
    videoCoverTool({
      name: IMAGE_VIDEO_COVER_SUBMIT_TOOL_NAME,
      label: 'H1 视频封面原片保护提交',
      description: '视频封面工作流第3步。使用当前会话工作流编号、候选帧引用和完整原片保护方案创建一次图片任务。成功时只返回真实图片任务编号。',
      parameters: VIDEO_COVER_SUBMIT_PARAMETERS,
      action: 'submit_protected_cover',
    }),
    videoCoverTool({
      name: IMAGE_VIDEO_COVER_TASK_TOOL_NAME,
      label: 'H1 视频封面图片任务',
      description: '视频封面工作流第4步。仅查询、读取、检查或取消提交工具返回的真实图片任务编号。',
      parameters: VIDEO_COVER_TASK_PARAMETERS,
      action: 'image_task',
    }),
  ] : []

  return [
    submit(submissionDefinition({
      name: IMAGE_SUBMIT_CREATIVE_TOOL_NAME, label: 'H1 原创图片提交', parameters: CREATIVE_SUBMIT_PARAMETERS,
      description: '仅用于已明确授权的整图创意重绘。必须提供至少一张获准参考图片和完整 prompt；成功只返回任务编号，随后等待完成提醒。',
    })),
    submit(submissionDefinition({
      name: IMAGE_SUBMIT_DESIGN_TOOL_NAME, label: 'H1 设计封面提交', parameters: DESIGN_SUBMIT_PARAMETERS,
      description: '仅用于已部署封面设计方案。必须提供参考图片和完整 design；成功只返回任务编号，随后等待完成提醒。',
    })),
    submit(submissionDefinition({
      name: IMAGE_SUBMIT_PROTECTED_TOOL_NAME, label: 'H1 原片保护封面提交', parameters: PROTECTED_SUBMIT_PARAMETERS,
      description: '默认视频封面工具。必须提供一张真实原图和完整 protected 编辑计划；成功只返回任务编号，随后等待完成提醒。',
    })),
    task,
    createImageHelpTool({ videoCoverWorkflowEnabled }),
    ...videoCoverWorkflowTools,
  ]
}
