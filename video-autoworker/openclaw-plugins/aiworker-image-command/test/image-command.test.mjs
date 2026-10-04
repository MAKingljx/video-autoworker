import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { createImageCommandTool, imageSessionScope, imageRequestKey, normalizeImageRequest } from '../lib/image-command-tool.js'
import { createImageJobClient, IMAGE_SERVICE_ORIGIN, ImageServiceError } from '../lib/image-job-client.js'

const context = { agentId: 'image-studio', sessionKey: 'agent:image-studio:main' }
const jobId = 'a'.repeat(32)
const scope = imageSessionScope(context)
const queued = { jobId, currentState: 'QUEUED' }
const params = { action: 'submit', prompt: '用原图生成冷冻人的中文封面', images: ['/approved/source.png'] }
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const digest = createHash('sha256').update(png).digest('hex')
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('scope comes only from the matching trusted agent and session', () => {
  assert.equal(scope, createHash('sha256').update('image-studio\0agent:image-studio:main').digest('hex'))
  for (const invalid of [undefined, {}, { agentId: 'gpt-main', sessionKey: context.sessionKey },
    { ...context, sessionKey: '' }, { ...context, sessionKey: 'agent:gpt-main:main' },
    { ...context, sessionKey: 'agent:image-studio:main\n' }]) {
    assert.equal(createImageCommandTool({ context: invalid }), null)
  }
  assert.notEqual(imageSessionScope({ ...context, sessionKey: 'agent:image-studio:other' }), scope)
})

test('submit is a single quick application call and exposes no scope or prompt', async () => {
  let captured
  const tool = createImageCommandTool({ context, client: { submit: async input => { captured = input; return queued } } })
  const answer = await tool.execute('tool-1', params)
  assert.equal(captured.scope, scope)
  assert.match(captured.requestKey, /^[0-9a-f]{64}$/u)
  assert.deepEqual(answer.details, queued)
  assert.match(answer.content[0].text, /已受理/u)
  assert.doesNotMatch(JSON.stringify(answer), /approved|scope|base64/u)
})

test('same tool call and canonical payload have the same request key', async () => {
  const keys = []
  const client = { submit: async input => { keys.push(input.requestKey); return queued } }
  const tool = createImageCommandTool({ context, client })
  await tool.execute('same-call', params)
  await tool.execute('same-call', { images: params.images, prompt: params.prompt, action: params.action })
  await tool.execute('other-call', params)
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[0], keys[2])
  assert.notEqual(imageRequestKey(scope, 'same-call', { prompt: '新要求' }), keys[0])
})

test('model parameters cannot replace identity, destinations, paths or service URLs', async () => {
  let called = false
  const tool = createImageCommandTool({ context, client: { submit: async () => { called = true; return queued } } })
  for (const key of ['scope', 'sessionKey', 'requestKey', 'url', 'host', 'output', 'chatId']) {
    const answer = await tool.execute('bad', { ...params, [key]: 'attacker' })
    assert.equal(answer.details.errorCode, 'IMAGE_REQUEST_INVALID')
  }
  assert.equal(called, false)
})

test('submit validates prompt XOR design, normalized paths and allowed numeric settings', () => {
  const design = { schema: 'aiworker-qwen-cover-design/v1', profile: 'ice-documentary',
    text: { kicker: '纪实短片', title: '冷冻人', subtitle: '等待未来？', caption: '走进低温保存现场' } }
  assert.ok(normalizeImageRequest({ action: 'submit', images: params.images, design }))
  for (const request of [{ ...params, design }, { action: 'submit', images: params.images },
    { ...params, prompt: '' }, { ...params, prompt: 'x'.repeat(8193) },
    { ...params, images: ['https://outside/image.png'] }, { ...params, images: ['/approved/../secret.png'] },
    { ...params, images: ['/approved/a.png\n'] }, { ...params, images: [] },
    { ...params, width: 4096 }, { ...params, width: 513 }, { ...params, height: 511 },
    { ...params, seed: -1 }, { ...params, seed: 2147483648 }, { ...params, steps: 100 },
    { ...params, guidance: NaN }, { ...params, guidance: 8.1 }]) {
    assert.equal(normalizeImageRequest(request), null)
  }
  assert.ok(normalizeImageRequest({ ...params, width: 1024, height: 768, steps: 30, guidance: 3.5, seed: 2147483647 }))
})

test('job queries only accept the exact id and action fields', async () => {
  const calls = []
  const tool = createImageCommandTool({ context, client: {
    status: async (...args) => { calls.push(args); return { jobId, currentState: 'RUNNING', completedSteps: 7, totalSteps: 40 } },
  } })
  const answer = await tool.execute('status', { action: 'status', jobId })
  assert.match(answer.content[0].text, /7\/40/u)
  assert.deepEqual(calls[0].slice(0, 2), [jobId, scope])
  assert.equal(normalizeImageRequest({ action: 'status', jobId: '../other' }), null)
  assert.equal(normalizeImageRequest({ action: 'status', jobId, scope: 'wrong' }), null)
})

test('cancel uses the same session ownership and actual backend receipt', async () => {
  let args
  const tool = createImageCommandTool({ context, client: { cancel: async (...input) => {
    args = input; return { jobId, currentState: 'CANCELLED' }
  } } })
  const answer = await tool.execute('cancel', { action: 'cancel', jobId })
  assert.deepEqual(args.slice(0, 2), [jobId, scope])
  assert.equal(answer.details.currentState, 'CANCELLED')
})

test('cancel requested is not falsely presented as cancellation complete', async () => {
  const tool = createImageCommandTool({ context, client: { cancel: async () => ({ jobId, currentState: 'CANCEL_REQUESTED' }) } })
  const answer = await tool.execute('cancel', { action: 'cancel', jobId })
  assert.match(answer.content[0].text, /正在取消/u)
  assert.equal(answer.details.currentState, 'CANCEL_REQUESTED')
})

test('status without job id recovers recent owned jobs and filters private fields', async () => {
  let receivedScope
  const tool = createImageCommandTool({ context, client: { list: async input => {
    receivedScope = input
    return { jobs: [{ ...queued, prompt: 'private prompt', output: '/private/image.png', scope }] }
  } } })
  const answer = await tool.execute('list', { action: 'status' })
  assert.equal(receivedScope, scope)
  assert.deepEqual(answer.details.jobs, [queued])
  assert.doesNotMatch(JSON.stringify(answer), /private|scope/u)
})

test('notification subscription errors preserve the known accepted job', async () => {
  const tool = createImageCommandTool({ context, client: { submit: async () => queued },
    onSubmitted: async () => { throw new Error('disk error') } })
  const answer = await tool.execute('submit', params)
  assert.equal(answer.details.jobId, jobId)
  assert.equal(answer.details.currentState, 'QUEUED')
  assert.equal(answer.details.notificationErrorCode, 'IMAGE_NOTIFICATION_UNAVAILABLE')
})

test('result stores only a verified service image and returns a native MEDIA path', async () => {
  let saved
  let imageArgs
  const tool = createImageCommandTool({ context,
    client: {
      status: async () => ({ jobId, currentState: 'GENERATED_PENDING_REVIEW', outputSha256: digest,
        output: '/untrusted/ignored.png', prompt: 'must not leak' }),
      image: async (...args) => { imageArgs = args; return png },
    },
    saveMedia: async buffer => { saved = buffer; return { path: '/safe/openclaw/media/outbound/image.png' } },
  })
  const answer = await tool.execute('result', { action: 'result', jobId })
  assert.equal(saved, png)
  assert.deepEqual(imageArgs.slice(0, 3), [jobId, scope, digest])
  assert.match(answer.content[0].text, /MEDIA:\/safe\/openclaw\/media\/outbound\/image.png/u)
  assert.doesNotMatch(JSON.stringify(answer), /untrusted|must not leak|base64|iVBOR/u)
  assert.match(answer.content[0].text, /请检查/u)
})

test('pending result never attempts image retrieval', async () => {
  const tool = createImageCommandTool({ context, client: { status: async () => queued,
    image: async () => { throw new Error('must not fetch') } } })
  assert.equal((await tool.execute('result', { action: 'result', jobId })).details.currentState, 'QUEUED')
})

test('generated status does not acknowledge an image; an actual MEDIA read does', async () => {
  const acknowledgements = []
  const tool = createImageCommandTool({ context, client: {
    status: async () => ({ jobId, currentState: 'GENERATED_PENDING_REVIEW', outputSha256: digest }),
    image: async () => png,
  }, saveMedia: async () => ({ path: '/safe/media/image.png' }),
  onReceiptRead: input => acknowledgements.push(input) })
  await tool.execute('status', { action: 'status', jobId })
  assert.equal(acknowledgements.length, 0)
  const answer = await tool.execute('result', { action: 'result', jobId })
  assert.match(answer.content[0].text, /MEDIA:/u)
  assert.deepEqual(acknowledgements, [{ jobId, scope, sessionKey: context.sessionKey }])
})

test('notification acknowledgement failure never hides a verified candidate image', async () => {
  const tool = createImageCommandTool({ context, client: {
    status: async () => ({ jobId, currentState: 'GENERATED_PENDING_REVIEW', outputSha256: digest }),
    image: async () => png,
  }, saveMedia: async () => ({ path: '/safe/media/image.png' }),
  onReceiptRead: async () => { throw new Error('unavailable') } })
  const answer = await tool.execute('result', { action: 'result', jobId })
  assert.match(answer.content[0].text, /MEDIA:/u)
  assert.equal(answer.details.currentState, 'GENERATED_PENDING_REVIEW')
})

test('wrong id or unknown status from the service fails closed', async () => {
  for (const data of [{ jobId: 'b'.repeat(32), currentState: 'RUNNING' }, { jobId, currentState: 'PUBLISHED' }]) {
    const tool = createImageCommandTool({ context, client: { status: async () => data } })
    assert.equal((await tool.execute('status', { action: 'status', jobId })).details.errorCode, 'IMAGE_RECEIPT_INVALID')
  }
})

test('release maintenance does not submit and error output cannot leak credentials', async () => {
  const blocked = createImageCommandTool({ context, releaseReady: false, client: { submit: async () => { throw new Error('unexpected') } } })
  assert.equal((await blocked.execute('call', params)).details.errorCode, 'IMAGE_SERVICE_NOT_READY')
  const broken = createImageCommandTool({ context, client: { submit: async () => { throw new Error('secret=private-value') } } })
  const answer = await broken.execute('call', params)
  assert.equal(answer.details.errorCode, 'IMAGE_SERVICE_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(answer), /private-value/u)
})

test('HTTP client uses only loopback routes, refuses redirects, and keeps scope on reads/cancel', async () => {
  const calls = []
  const client = createImageJobClient({ fetchImpl: async (...args) => { calls.push(args); return json(queued) } })
  await client.submit({ scope, requestKey: 'b'.repeat(64), images: params.images, prompt: params.prompt })
  await client.status(jobId, scope)
  await client.cancel(jobId, scope)
  await client.list(scope)
  assert.equal(calls[0][0], `${IMAGE_SERVICE_ORIGIN}/v1/jobs`)
  assert.equal(calls[1][0], `${IMAGE_SERVICE_ORIGIN}/v1/jobs/${jobId}?scope=${scope}`)
  assert.equal(calls[2][0], `${IMAGE_SERVICE_ORIGIN}/v1/jobs/${jobId}/cancel`)
  assert.deepEqual(JSON.parse(calls[2][1].body), { scope })
  assert.equal(calls[3][0], `${IMAGE_SERVICE_ORIGIN}/v1/jobs?scope=${scope}`)
  assert.ok(calls.every(([, options]) => options.redirect === 'error'))
  assert.ok(calls.every(([, options]) => options.signal instanceof AbortSignal))
  assert.throws(() => client.status('../elsewhere', scope), /IMAGE_JOB_ID_INVALID/u)
})

test('HTTP JSON reads enforce MIME, object shape, byte bound and safe error codes', async () => {
  for (const [response, expected] of [
    [new Response('{}', { headers: { 'content-type': 'text/html' } }), 'IMAGE_RESPONSE_INVALID'],
    [json([]), 'IMAGE_RESPONSE_INVALID'],
    [json({ large: 'x'.repeat(65536) }), 'IMAGE_RESPONSE_TOO_LARGE'],
    [json({ errorCode: 'IMAGE_SCOPE_MISMATCH' }, 403), 'IMAGE_SCOPE_MISMATCH'],
    [json({ errorCode: 'secret private-value' }, 500), 'IMAGE_SERVICE_ERROR'],
  ]) {
    const client = createImageJobClient({ fetchImpl: async () => response })
    await assert.rejects(client.status(jobId, scope), error => error instanceof ImageServiceError && error.errorCode === expected)
  }
})

test('image fetch verifies PNG type, PNG signature, bound and SHA-256', async () => {
  const client = createImageJobClient({ fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) })
  assert.deepEqual(await client.image(jobId, scope, digest), png)
  await assert.rejects(client.image(jobId, scope, 'f'.repeat(64)), /IMAGE_DIGEST_MISMATCH/u)
  for (const response of [new Response(png, { headers: { 'content-type': 'image/jpeg' } }),
    new Response('not PNG', { headers: { 'content-type': 'image/png' } })]) {
    const invalid = createImageJobClient({ fetchImpl: async () => response })
    await assert.rejects(invalid.image(jobId, scope, digest), /IMAGE_FORMAT_INVALID/u)
  }
})
