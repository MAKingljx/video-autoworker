import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { resolve } from 'node:path'
import test from 'node:test'

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/Users/phoenix/.local/node-v22/bin/openclaw'
const SCRIPT = resolve('scripts/test-openclaw-same-turn-ab-canary.mjs')
const TOOL_NAME = 'aiworker_same_turn_stress'

function completion(body, { text, toolCall }) {
  const id = `chatcmpl-structural-${Date.now()}`
  const model = body.model || 'structural-model'
  const finishReason = toolCall ? 'tool_calls' : 'stop'
  const message = toolCall
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call-${toolCall.sequence}-${Date.now()}`,
          type: 'function',
          function: { name: TOOL_NAME, arguments: JSON.stringify(toolCall) },
        }],
      }
    : { role: 'assistant', content: text }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  }
}

function streamCompletion(response, full) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const choice = full.choices[0]
  const delta = choice.message.tool_calls
    ? { role: 'assistant', tool_calls: choice.message.tool_calls.map((call, index) => ({ ...call, index })) }
    : { role: 'assistant', content: choice.message.content }
  response.write(`data: ${JSON.stringify({
    id: full.id,
    object: 'chat.completion.chunk',
    created: full.created,
    model: full.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: full.id,
    object: 'chat.completion.chunk',
    created: full.created,
    model: full.model,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    usage: full.usage,
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function lastUserText(messages) {
  return [...messages].reverse().find(message => message?.role === 'user')?.content || ''
}

function nextScriptedResponse(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const prompt = String(lastUserText(messages))
  if (prompt.includes('下一轮落盘探针')) return completion(body, { text: 'NEXT_OK' })
  if (!prompt.includes('隔离同轮压力测试')) return completion(body, { text: 'READY' })
  // OpenClaw's OpenAI projection may omit `name` from role=tool messages; this
  // isolated turn has exactly one eligible tool, so role and payload are the
  // authoritative structural signals here.
  const results = messages.filter(message => message?.role === 'tool')
  if (results.length >= 10) return completion(body, { text: 'STRESS_OK' })
  let nonce = 'START'
  if (results.length > 0) {
    const raw = results.at(-1)?.content
    const text = Array.isArray(raw)
      ? raw.map(part => part?.text || '').join('')
      : String(raw || '')
    const match = text.match(/"nextNonce":"([^"]+)"/u)
    if (!match) throw new Error('scripted tool result did not expose nextNonce')
    nonce = match[1]
  }
  return completion(body, {
    toolCall: { sequence: results.length + 1, nonce },
  })
}

async function listen(server, port = 0) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  return server.address().port
}

async function findFourPortBlock() {
  for (let base = 22_000; base < 30_000; base += 4) {
    const reservations = []
    try {
      for (let offset = 0; offset < 4; offset += 1) {
        const server = net.createServer()
        await listen(server, base + offset)
        reservations.push(server)
      }
      await Promise.all(reservations.map(server => new Promise(resolveClose => server.close(resolveClose))))
      return base
    } catch {
      await Promise.all(reservations.map(server => new Promise(resolveClose => server.close(resolveClose))))
    }
  }
  throw new Error('no four-port block available for structural canary')
}

function runStructuralCanary(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('structural canary timed out'))
    }, 180_000)
    child.once('exit', code => {
      clearTimeout(timeout)
      resolveRun({ code, stdout, stderr })
    })
  })
}

test('scripted model traverses the real OpenClaw loop but remains fail-closed', {
  skip: !existsSync(OPENCLAW_BIN) || process.version !== 'v22.22.3',
}, async () => {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'structural-model', owned_by: 'test' }] }))
      return
    }
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const full = nextScriptedResponse(body)
        if (body.stream === true) streamCompletion(response, full)
        else {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(full))
        }
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'scripted-error' }))
      }
    })
  })
  const modelPort = await listen(server)
  const gatewayPortBase = await findFourPortBlock()
  try {
    const result = await runStructuralCanary({
      ...process.env,
      OPENCLAW_BIN,
      CANARY_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}`,
      CANARY_MODEL_ID: 'structural-model',
      CANARY_GATEWAY_PORT_BASE: String(gatewayPortBase),
      CANARY_EVIDENCE_CLASS: 'scripted-structural-only',
    })
    assert.equal(result.code, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.evidenceClass, 'scripted-structural-only', JSON.stringify(report))
    assert.equal(report.accepted, false)
    assert.equal(report.cells.length, 4)
    for (const cell of report.cells) {
      assert.equal(cell.realOpenClawLoop, true)
      assert.ok(cell.completedToolResults > 0 && cell.completedToolResults <= 10, JSON.stringify(cell))
      if (cell.completedToolResults < 8) {
        assert.ok(cell.reasons.includes('fewer-than-eight-tool-results'), JSON.stringify(cell))
      }
      assert.ok(cell.sameTurnModelCalls >= cell.completedToolResults + 1)
      assert.ok(cell.nextTurnModelCalls >= 1)
      assert.deepEqual(cell.toolResultBytes, Array(cell.completedToolResults).fill(24 * 1024))
      assert.ok(cell.reasons.includes('not-live-model-evidence'))
    }
  } finally {
    await new Promise((resolveClose, reject) => server.close(error => (
      error ? reject(error) : resolveClose()
    )))
  }
})
