import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

import { createImageCommandTool, imageReceipt, imageSessionScope, normalizeImageRequest } from '../lib/image-command-tool.js'
import { createImageJobClient, IMAGE_BYTES_LIMIT, IMAGE_SERVICE_ORIGIN, INSPECTION_JSON_BYTES_LIMIT,
  normalizeImageInspection, PROTECTED_IMAGE_BYTES_LIMIT } from '../lib/image-job-client.js'

const context = { agentId: 'image-studio', sessionKey: 'agent:image-studio:protected-test' }
const scope = imageSessionScope(context)
const jobId = 'd'.repeat(32)
const hash = buffer => createHash('sha256').update(buffer).digest('hex')
const rect = { x: 60, y: 50, width: 800, height: 160 }
const plan = { schema: 'aiworker-protected-cover/v1', textLayers: [{ text: '北极驯鹿人', box: rect, style: '毛笔字', align: 'left' }] }
const request = { action: 'submit', images: ['/approved/native-1920.png'], protected: plan }
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

test('protected erasure-only OCR is explicitly not applicable and stage is bounded', () => {
  const data = { jobId, currentState: 'GENERATED_PENDING_REVIEW', mode: 'protected',
    textValidation: { matched: true, engine: 'not-applicable', mode: 'normalized_text_sequence', expectedCount: 0, observedCount: 0 } }
  assert.equal(imageReceipt(data).textValidation.engine, 'not-applicable')
  assert.equal(imageReceipt({ ...data, stage: 'erase_1' }).stage, 'erase_1')
  assert.throws(() => imageReceipt({ ...data, stage: '../../untrusted' }), /IMAGE_RECEIPT_INVALID/u)
  assert.throws(() => imageReceipt({ ...data, textValidation: { ...data.textValidation, expectedCount: 1 } }), /IMAGE_RECEIPT_INVALID/u)
})

function chunk(name, data) {
  const type = Buffer.from(name)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([header, type, data, checksum])
}

function png({ width = 2, height = 1, ancillary = [], rawWidth = width, colorType = 6, pixels } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...ancillary, chunk('IDAT', deflateSync(pixels ?? Buffer.alloc((rawWidth * (colorType === 6 ? 4 : 3) + 1) * height))), chunk('IEND', Buffer.alloc(0))])
}

const image = png()
function view(role, changes = {}) {
  return { role, mimeType: 'image/png', data: image.toString('base64'), sha256: hash(image), width: 2, height: 1, ...changes }
}
const inspection = (changes = {}) => ({ jobId, currentState: 'GENERATED_PENDING_REVIEW',
  images: [view('source'), view('result')], ...changes })
const completed = { jobId, currentState: 'GENERATED_PENDING_REVIEW', mode: 'protected', postProcessing: true,
  outputSha256: hash(image), width: 1920, height: 1080,
  photoProtection: { outsideChangedPixels: 0, protectedPixels: 1_800_000, changedPixels: 10_000,
    sourceWidth: 1920, sourceHeight: 1080 },
  textValidation: { matched: true, engine: 'apple-vision', mode: 'normalized_text_sequence', expectedCount: 1, observedCount: 1 } }

test('native image tool stays directly visible without changing optional activation or profile isolation', () => {
  const tool = createImageCommandTool({ context })
  assert.equal(tool.catalogMode, 'direct-only')
  assert.equal(tool.name, 'aiworker_generate_image')
  assert.equal(createImageCommandTool({ context: { ...context, agentId: 'gpt-main' } }), null)
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.2.2')
  assert.equal(pkg.version, manifest.version)
  assert.deepEqual(manifest.toolMetadata, { aiworker_generate_image: { optional: true } })
  assert.deepEqual(manifest.contracts.tools, ['aiworker_generate_image'])
})

test('protected requests preserve one native source, assign editorial roles and reject ambiguous modes', () => {
  assert.deepEqual(normalizeImageRequest(request), { ...request, protected: { ...plan, eraseRegions: [],
    textLayers: [{ ...plan.textLayers[0], role: 'title' }] } })
  assert.ok(normalizeImageRequest({ action: 'submit', images: request.images,
    protected: { schema: plan.schema, eraseRegions: [rect] } }))
  for (const invalid of [
    { ...request, prompt: 'rewrite scene' }, { ...request, design: {} },
    { ...request, creativeRedraw: true },
    { ...request, width: 1920 }, { ...request, height: 1080 },
    { ...request, images: [...request.images, '/approved/other.png'] },
    { ...request, protected: { schema: plan.schema } },
    { ...request, protected: { ...plan, eraseRegions: null } },
    { ...request, protected: { ...plan, output: '/outside' } },
    { ...request, protected: { ...plan, textLayers: [...plan.textLayers, ...plan.textLayers, ...plan.textLayers, ...plan.textLayers, ...plan.textLayers] } },
    { ...request, protected: { ...plan, eraseRegions: [{ ...rect, width: 0 }] } },
    { ...request, protected: { ...plan, eraseRegions: [{ ...rect, x: -1 }] } },
    { ...request, protected: { ...plan, eraseRegions: [{ ...rect, y: 2.5 }] } },
    { ...request, protected: { ...plan, textLayers: [{ ...plan.textLayers[0], text: 'title\nlabel' }] } },
    { ...request, protected: { ...plan, textLayers: [{ ...plan.textLayers[0], text: 'x'.repeat(129) }] } },
    { ...request, protected: { ...plan, textLayers: [{ ...plan.textLayers[0], style: 'x'.repeat(1001) }] } },
    { ...request, protected: { ...plan, textLayers: [{ ...plan.textLayers[0], align: 'right' }] } },
  ]) assert.equal(normalizeImageRequest(invalid), null)
  assert.equal(normalizeImageRequest({ action: 'inspect' }), null)
  assert.equal(normalizeImageRequest({ action: 'inspect', jobId, scope }), null)
  assert.deepEqual(normalizeImageRequest({ action: 'inspect', jobId }), { action: 'inspect', jobId })
})

test('full-frame redraw requires explicit intent while protected requests cannot carry it', () => {
  assert.equal(normalizeImageRequest({ action: 'submit', images: request.images, prompt: '重绘场景' }), null)
  assert.ok(normalizeImageRequest({ action: 'submit', images: request.images, prompt: '重绘场景', creativeRedraw: true }))
  assert.equal(normalizeImageRequest({ ...request, creativeRedraw: true }), null)
})

test('protected submission stays on the existing application and scope without rendering pixels', async () => {
  let received
  const tool = createImageCommandTool({ context, client: { submit: async value => {
    received = value
    return { jobId, currentState: 'QUEUED', mode: 'protected' }
  } } })
  const result = await tool.execute('protected-submit', request)
  assert.equal(received.scope, scope)
  assert.deepEqual(received.protected.textLayers, [{ ...plan.textLayers[0], role: 'title' }])
  assert.ok(!Object.hasOwn(received, 'width') && !Object.hasOwn(received, 'height'))
  assert.equal(result.details.mode, 'protected')
  assert.doesNotMatch(JSON.stringify(result), /approved|textLayers|base64/u)
})

test('protected receipt exposes bounded counts, not source paths or OCR body', () => {
  const received = imageReceipt({ ...completed,
    photoProtection: { ...completed.photoProtection, source: '/private/source.png' },
    textValidation: { ...completed.textValidation, observedText: 'private OCR text' } }, jobId)
  assert.deepEqual(received.photoProtection, completed.photoProtection)
  assert.deepEqual(received.textValidation, completed.textValidation)
  assert.doesNotMatch(JSON.stringify(received), /private|source\.png/u)
  for (const changed of [{ mode: 'other' }, { width: 10000 },
    { photoProtection: { outsideChangedPixels: -1 } },
    { textValidation: { ...completed.textValidation, matched: 'true' } }]) {
    assert.throws(() => imageReceipt({ ...completed, ...changed }, jobId), /IMAGE_RECEIPT_INVALID/u)
  }
})

test('inspection yields labeled native image blocks and never reads an arbitrary path', async () => {
  let args
  let acknowledged = false
  const tool = createImageCommandTool({ context, client: {
    status: async () => completed,
    inspection: async (...value) => { args = value; return inspection({ source: '/ignored/private.png' }) },
  }, onReceiptRead: () => { acknowledged = true } })
  const result = await tool.execute('inspect-current', { action: 'inspect', jobId })
  assert.equal(tool.catalogMode, 'direct-only')
  assert.deepEqual(args.slice(0, 2), [jobId, scope])
  assert.deepEqual(result.content.filter(item => item.type === 'image'), [
    { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
    { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
  ])
  assert.equal(result.details.visualInspectionImagesAvailable, true)
  assert.deepEqual(result.details.inspectionImages.map(item => item.role), ['source', 'result'])
  assert.match(result.content[0].text, /自动合成/u)
  assert.match(result.content[0].text, /不能声明视觉通过/u)
  assert.doesNotMatch(JSON.stringify(result.details), /base64|iVBOR|private/u)
  assert.equal(acknowledged, false)
})

test('pending inspection never fetches previews and malformed results fail closed', async () => {
  let inspected = false
  const pending = createImageCommandTool({ context, client: { status: async () => ({ jobId, currentState: 'RUNNING' }),
    inspection: async () => { inspected = true } } })
  assert.equal((await pending.execute('pending', { action: 'inspect', jobId })).details.currentState, 'RUNNING')
  assert.equal(inspected, false)
  const malformed = createImageCommandTool({ context, client: { status: async () => completed,
    inspection: async () => inspection({ images: [view('source'), view('source')] }) } })
  assert.equal((await malformed.execute('bad', { action: 'inspect', jobId })).details.errorCode, 'IMAGE_INSPECTION_INVALID')
})

test('inspection validates role, base64, digest and actual PNG decode bounds', () => {
  const valid = normalizeImageInspection(inspection({ images: [view('result'), view('source')] }), jobId)
  assert.equal(valid.images[0].role, 'source')
  const rgb = png({ colorType: 2 })
  assert.equal(normalizeImageInspection(inspection({ images: [view('source'),
    view('result', { data: rgb.toString('base64'), sha256: hash(rgb) })] }), jobId).images.length, 2)
  const bomb = png({ width: 2, rawWidth: 5 })
  const animated = png({ ancillary: [chunk('acTL', Buffer.alloc(8))] })
  const crcInvalid = Buffer.from(image)
  crcInvalid[35] ^= 1
  for (const input of [
    inspection({ jobId: 'f'.repeat(32) }), inspection({ currentState: 'RUNNING' }),
    inspection({ images: [view('source')] }), inspection({ images: [view('source'), view('source')] }),
    inspection({ images: [view('source'), view('result', { data: image.toString('base64') + '\n' })] }),
    inspection({ images: [view('source'), view('result', { sha256: 'f'.repeat(64) })] }),
    inspection({ images: [view('source'), view('result', { width: 1281 })] }),
    inspection({ images: [view('source'), view('result', { width: 3 })] }),
    inspection({ images: [view('source'), view('result', { mimeType: 'image/jpeg' })] }),
    ...[bomb, animated, crcInvalid, Buffer.concat([image, Buffer.from('trailer')])].map(buffer =>
      inspection({ images: [view('source'), view('result', { data: buffer.toString('base64'), sha256: hash(buffer) })] })),
  ]) assert.throws(() => normalizeImageInspection(input, jobId), /IMAGE_INSPECTION_INVALID/u)
})

test('inspection HTTP route stays fixed and has a separate bounded JSON envelope', async () => {
  let call
  const client = createImageJobClient({ fetchImpl: async (...value) => { call = value; return json(inspection()) } })
  assert.equal((await client.inspection(jobId, scope)).images.length, 2)
  assert.equal(call[0], `${IMAGE_SERVICE_ORIGIN}/v1/jobs/${jobId}/inspection?scope=${scope}`)
  assert.equal(call[1].redirect, 'error')
  await assert.rejects(client.inspection('../other', scope), /IMAGE_JOB_ID_INVALID/u)
  const tooLarge = createImageJobClient({ fetchImpl: async () => new Response('{}', {
    headers: { 'content-type': 'application/json', 'content-length': String(INSPECTION_JSON_BYTES_LIMIT + 1) },
  }) })
  await assert.rejects(tooLarge.inspection(jobId, scope), /IMAGE_RESPONSE_TOO_LARGE/u)
})

test('real preview images may exceed ordinary JSON limits without opening other routes', async () => {
  const width = 128
  const height = 128
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  let state = 17
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 4 + 1)
    for (let x = 1; x <= width * 4; x += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      pixels[offset + x] = state & 255
    }
  }
  const buffer = png({ width, height, pixels })
  const entry = { mimeType: 'image/png', data: buffer.toString('base64'), sha256: hash(buffer), width, height }
  const payload = inspection({ images: [{ ...entry, role: 'source' }, { ...entry, role: 'result' }] })
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024)
  const client = createImageJobClient({ fetchImpl: async () => json(payload) })
  assert.equal((await client.inspection(jobId, scope)).images.length, 2)
  await assert.rejects(client.status(jobId, scope), /IMAGE_RESPONSE_TOO_LARGE/u)
})

test('only protected native-size result download opts into the 40MiB bound', async () => {
  const large = png({ ancillary: [chunk('tEXt', Buffer.concat([Buffer.from('note\0'), Buffer.alloc(IMAGE_BYTES_LIMIT, 65)]))] })
  assert.ok(large.length > IMAGE_BYTES_LIMIT && large.length < PROTECTED_IMAGE_BYTES_LIMIT)
  const client = createImageJobClient({ fetchImpl: async () => new Response(large, { headers: { 'content-type': 'image/png' } }) })
  await assert.rejects(client.image(jobId, scope, hash(large)), /IMAGE_RESPONSE_TOO_LARGE/u)
  assert.equal((await client.image(jobId, scope, hash(large), undefined, { mode: 'protected' })).length, large.length)
  await assert.rejects(client.image(jobId, scope, hash(large), undefined, { mode: 'caller-selected-host' }), /IMAGE_MODE_INVALID/u)
  const oversized = createImageJobClient({ fetchImpl: async () => new Response(image, {
    headers: { 'content-type': 'image/png', 'content-length': String(PROTECTED_IMAGE_BYTES_LIMIT + 1) },
  }) })
  await assert.rejects(oversized.image(jobId, scope, hash(image), undefined, { mode: 'protected' }), /IMAGE_RESPONSE_TOO_LARGE/u)
})

test('protected result labels composition truthfully and selects HD storage only after owned status', async () => {
  let args
  const tool = createImageCommandTool({ context, client: { status: async () => completed,
    image: async (...input) => { args = input; return image } },
  saveMedia: async () => ({ path: '/safe/media/protected.png' }) })
  const answer = await tool.execute('protected-result', { action: 'result', jobId })
  assert.equal(args[4].mode, 'protected')
  assert.match(answer.content[0].text, /应用自动合成/u)
  assert.match(answer.content[0].text, /保护区变化0像素/u)
  assert.match(answer.content[0].text, /MEDIA:/u)
  assert.doesNotMatch(answer.content[0].text, /整图.*原生|已采用|视觉审核通过/u)
})
