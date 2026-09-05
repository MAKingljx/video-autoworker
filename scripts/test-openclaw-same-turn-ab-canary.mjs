#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildProjectionDisabledDirectorEntry,
  buildStressPluginEntry,
  DEFAULT_EXPECTED_OPENCLAW_VERSION,
  DEFAULT_TOOL_CALLS,
  DEFAULT_TOOL_RESULT_BYTES,
  MATRIX_CELLS,
  MAX_TOOL_CALLS,
  MAX_TOOL_RESULT_BYTES,
  MIN_TOOL_CALLS,
  MIN_TOOL_RESULT_BYTES,
  normalizedCatalogToolIds,
  normalizedToolIds,
  parseBoundedInteger,
  stressPluginManifest,
  validateCellObservation,
  validateMatrixReport,
} from './lib/openclaw-same-turn-ab-canary.mjs'
import { fingerprintOpenClawToolInventory } from './lib/openclaw-tool-capability-fingerprint.mjs'

const SESSION_KEY = 'agent:second-original:main'
const TARGET_AGENT_ID = 'second-original'
const STRESS_TOOL_ID = 'aiworker_same_turn_stress'
const REQUIRED_TOOL_IDS = Object.freeze([
  'aiworker_analyze_video',
  'aiworker_director_brain',
  STRESS_TOOL_ID,
  'session_status',
])
const PREFIX = join(tmpdir(), 'aiworker-openclaw-same-turn-ab-')

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function textParts(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(part => part?.type === 'text')
    .map(part => String(part.text || '')).join('\n')
}

function parseOpenClawVersion(bin) {
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('openclaw-version-check-failed')
  const match = `${result.stdout}\n${result.stderr}`.match(/OpenClaw\s+([^\s]+)/u)
  if (!match) throw new Error('openclaw-version-unparseable')
  return match[1]
}

function createObservationProxy({ upstreamBaseUrl, upstreamApiKey }) {
  const upstream = new URL(upstreamBaseUrl)
  let phase = 'preflight'
  const observations = []
  const protocol = upstream.protocol === 'https:' ? https : http
  const server = http.createServer((request, response) => {
    const requestChunks = []
    request.on('data', chunk => requestChunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(requestChunks)
      let parsed = null
      try { parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) : null } catch { /* measured only */ }
      const observation = {
        phase,
        method: request.method,
        path: request.url,
        requestBytes: body.length,
        messagesBytes: Array.isArray(parsed?.messages) ? jsonBytes(parsed.messages) : null,
        toolsBytes: Array.isArray(parsed?.tools) ? jsonBytes(parsed.tools) : null,
        messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
        statusCode: null,
      }
      if (request.method === 'POST') observations.push(observation)
      const target = new URL(request.url, `${upstream.origin}/`)
      const headers = { ...request.headers, host: upstream.host }
      delete headers['content-length']
      for (const hopByHop of [
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailer', 'transfer-encoding', 'upgrade',
      ]) delete headers[hopByHop]
      if (upstreamApiKey) headers.authorization = `Bearer ${upstreamApiKey}`
      else delete headers.authorization
      const proxyRequest = protocol.request(target, {
        method: request.method,
        headers: { ...headers, 'content-length': body.length },
      }, proxyResponse => {
        observation.statusCode = proxyResponse.statusCode || null
        response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers)
        proxyResponse.pipe(response)
      })
      proxyRequest.on('error', () => {
        observation.statusCode = 502
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
        response.end('{"error":"canary_upstream_unavailable"}')
      })
      proxyRequest.end(body)
    })
  })
  return {
    observations,
    setPhase(value) { phase = value },
    async start() {
      await new Promise((resolveStart, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolveStart())
      })
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
    async stop() {
      if (!server.listening) return
      await new Promise((resolveStop, reject) => server.close(error => (
        error ? reject(error) : resolveStop()
      )))
    },
  }
}

function copyPlugin(projectRoot, stateDir, pluginId) {
  const source = join(projectRoot, 'openclaw-plugins', pluginId)
  const destination = join(stateDir, 'extensions', pluginId)
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const member of ['index.js', 'openclaw.plugin.json', 'package.json', 'lib']) {
    cpSync(join(source, member), join(destination, member), { recursive: true })
  }
  return destination
}

function installStressPlugin(stateDir) {
  const destination = join(stateDir, 'extensions', 'aiworker-same-turn-stress')
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  writeFileSync(join(destination, 'index.js'), buildStressPluginEntry(), { mode: 0o600 })
  writeFileSync(
    join(destination, 'openclaw.plugin.json'),
    `${JSON.stringify(stressPluginManifest(), null, 2)}\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(destination, 'package.json'),
    `${JSON.stringify({ name: 'aiworker-same-turn-stress', version: '0.0.0-canary', type: 'module' }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

function installDirectorRuntimeFixture(stateDir) {
  const root = join(stateDir, 'extensions', 'aiworker-director-brain', 'runtime', 'scripts', 'lib')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'feishu-director-brain.mjs'), [
    'export async function executeDirectorBrainOperation() {',
    "  return { ok: false, error: 'canary_fixture_has_no_business_data' }",
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
}

function makeProvider(baseUrl, modelId, modelName) {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: 'openai-completions',
    apiKey: 'isolated-observation-proxy',
    auth: 'api-key',
    timeoutSeconds: 900,
    request: { allowPrivateNetwork: true },
    models: [{
      id: modelId,
      name: modelName,
      api: 'openai-completions',
      reasoning: true,
      input: ['text'],
      contextWindow: 131_072,
      contextTokens: 98_304,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsTools: true, thinkingFormat: 'qwen-chat-template' },
    }],
  }
}

function writeCellConfig({
  configPath,
  gatewayPort,
  gatewayToken,
  modelProxyUrl,
  modelId,
  modelName,
  precheck,
  projection,
  runSalt,
  toolCalls,
  toolResultBytes,
  thinking,
  workspaceDir,
}) {
  const config = {
    models: { mode: 'merge', providers: { 'same-turn-live': makeProvider(modelProxyUrl, modelId, modelName) } },
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: `same-turn-live/${modelId}` },
        models: { [`same-turn-live/${modelId}`]: { streaming: false } },
        timeoutSeconds: 720,
        compaction: {
          mode: 'safeguard',
          truncateAfterCompaction: true,
          keepRecentTokens: 4_096,
          recentTurnsPreserve: 4,
          maxActiveTranscriptBytes: '128kb',
          midTurnPrecheck: { enabled: precheck },
        },
      },
      list: [{
        id: TARGET_AGENT_ID,
        name: TARGET_AGENT_ID,
        workspace: workspaceDir,
        model: `same-turn-live/${modelId}`,
        tools: {
          profile: 'full',
          alsoAllow: ['aiworker_analyze_video', 'aiworker_director_brain', STRESS_TOOL_ID],
          codeMode: false,
        },
        thinkingDefault: thinking,
      }],
    },
    gateway: {
      mode: 'local', bind: 'loopback', port: gatewayPort,
      auth: { mode: 'token', token: gatewayToken },
    },
    plugins: {
      allow: ['aiworker-director-brain', 'aiworker-video-command', 'aiworker-same-turn-stress'],
      entries: {
        'aiworker-director-brain': {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: { releaseReady: true, targetAgentId: TARGET_AGENT_ID },
        },
        'aiworker-video-command': { enabled: true, config: { releaseReady: false } },
        'aiworker-same-turn-stress': {
          enabled: true,
          config: { targetAgentId: TARGET_AGENT_ID, totalCalls: toolCalls, resultBytes: toolResultBytes, runSalt },
        },
      },
    },
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return { projectionConfigured: projection, precheckConfigured: precheck }
}

function rowsFromSession(stateDir) {
  const storePath = join(stateDir, 'agents', TARGET_AGENT_ID, 'sessions', 'sessions.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  const entry = store[SESSION_KEY]
  if (!entry || typeof entry.sessionFile !== 'string') throw new Error('session-transcript-not-found')
  const sessionFile = resolve(dirname(storePath), entry.sessionFile)
  const rows = readFileSync(sessionFile, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse)
  return { entry, rows, sessionFile }
}

function assistantStopReason(rows) {
  return rows.map(row => row?.message).filter(message => message?.role === 'assistant')
    .map(message => message?.stopReason).filter(value => typeof value === 'string').at(-1) || null
}

function toolResultTextBytes(rows) {
  return rows.map(row => row?.message).filter(message => (
    message?.role === 'toolResult' && message?.toolName === STRESS_TOOL_ID
  )).map(message => Buffer.byteLength(textParts(message), 'utf8'))
}

function modelPhaseMetrics(observations, phase) {
  const rows = observations.filter(entry => entry.phase === phase && entry.method === 'POST')
  return {
    modelCalls: rows.length,
    peakRequestBytes: Math.max(0, ...rows.map(entry => entry.requestBytes || 0)),
    peakMessagesBytes: Math.max(0, ...rows.map(entry => entry.messagesBytes || 0)),
    peakToolsBytes: Math.max(0, ...rows.map(entry => entry.toolsBytes || 0)),
    httpStatuses: rows.map(entry => entry.statusCode),
  }
}

function readAudit(stateDir) {
  const path = join(stateDir, 'same-turn-stress-audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse)
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), 10_000)
    child.once('exit', () => { clearTimeout(timer); resolveExit(true) })
  })
  if (!exited && child.exitCode === null) child.kill('SIGKILL')
}

async function runCell(options, descriptor, index) {
  const root = mkdtempSync(PREFIX)
  chmodSync(root, 0o700)
  const stateDir = join(root, 'state')
  const homeDir = join(root, 'home')
  const workspaceDir = join(root, 'workspace')
  const configPath = join(stateDir, 'openclaw.json')
  const logPath = join(root, 'gateway.log')
  for (const path of [stateDir, homeDir, workspaceDir]) mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(join(workspaceDir, 'AGENTS.md'), 'This isolated canary must follow the exact user request and use tools sequentially.\n', { mode: 0o600 })
  const directorDestination = copyPlugin(options.projectRoot, stateDir, 'aiworker-director-brain')
  copyPlugin(options.projectRoot, stateDir, 'aiworker-video-command')
  installDirectorRuntimeFixture(stateDir)
  installStressPlugin(stateDir)
  if (!descriptor.projection) {
    writeFileSync(join(directorDestination, 'index.js'), buildProjectionDisabledDirectorEntry(), { mode: 0o600 })
  }
  const proxy = createObservationProxy({
    upstreamBaseUrl: options.modelBaseUrl,
    upstreamApiKey: options.modelApiKey,
  })
  const modelProxyUrl = await proxy.start()
  const gatewayPort = options.portBase + index
  const gatewayToken = `same-turn-${randomUUID()}`
  const runSalt = randomUUID()
  writeCellConfig({
    configPath, gatewayPort, gatewayToken, modelProxyUrl,
    modelId: options.modelId, modelName: options.modelName,
    precheck: descriptor.precheck, projection: descriptor.projection,
    runSalt, toolCalls: options.toolCalls, toolResultBytes: options.toolResultBytes,
    thinking: options.thinking,
    workspaceDir,
  })
  const childEnv = {
    ...process.env,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  }
  for (const name of ['OPENCLAW_PROFILE', 'OPENCLAW_GATEWAY_TOKEN', 'GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_PASSWORD', 'GATEWAY_PASSWORD']) {
    delete childEnv[name]
  }
  let gateway = null
  let logFd = null
  const call = (method, params, timeoutMs = 15_000) => new Promise((resolveCall, reject) => {
    const child = spawn(options.openclawBin, [
      'gateway', 'call', method,
      '--token', gatewayToken,
      '--timeout', String(timeoutMs),
      '--params', JSON.stringify(params),
      '--json',
    ], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let outputBytes = 0
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${method}-timed-out`))
    }, timeoutMs + 5_000)
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes <= 4 * 1024 * 1024) stdout += chunk
    })
    child.stderr.on('data', chunk => {
      outputBytes += chunk.length
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code !== 0 || outputBytes > 4 * 1024 * 1024) {
        reject(new Error(`${method}-failed`))
        return
      }
      const output = stdout.trim()
      const start = output.indexOf('{')
      if (start < 0) {
        reject(new Error(`${method}-returned-no-json`))
        return
      }
      try {
        const value = JSON.parse(output.slice(start))
        resolveCall(value?.result && typeof value.result === 'object' ? value.result : value)
      } catch {
        reject(new Error(`${method}-returned-invalid-json`))
      }
    })
  })
  const waitForRun = runId => call('agent.wait', { runId, timeoutMs: 720_000 }, 725_000)
  const send = async (message, label) => {
    const sent = await call('chat.send', {
      sessionKey: SESSION_KEY,
      message,
      idempotencyKey: randomUUID(),
      deliver: false,
    })
    if (typeof sent.runId !== 'string') throw new Error('chat-send-returned-no-run-id')
    const waited = await waitForRun(sent.runId)
    if (label !== 'stress' && waited.status !== 'ok') {
      throw new Error(`${label}-agent-run-${waited.status || 'unknown'}`)
    }
    return waited
  }
  try {
    logFd = openSync(logPath, 'a', 0o600)
    gateway = spawn(options.openclawBin, [
      'gateway', '--port', String(gatewayPort), '--auth', 'token', '--token', gatewayToken, '--verbose',
    ], { env: childEnv, stdio: ['ignore', logFd, logFd] })
    let healthy = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (gateway.exitCode !== null) throw new Error('isolated-gateway-exited')
      try { await call('health', {}, 2_000); healthy = true; break } catch { /* bounded retry */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
    }
    if (!healthy) throw new Error('isolated-gateway-not-healthy')
    proxy.setPhase('warmup')
    await send('只回复 READY，不要调用任何工具。', 'warmup')
    const before = rowsFromSession(stateDir)
    const effectiveBeforeInventory = await call('tools.effective', {
      agentId: TARGET_AGENT_ID, sessionKey: SESSION_KEY,
    })
    const catalogBeforeInventory = await call('tools.catalog', {
      agentId: TARGET_AGENT_ID, includePlugins: true,
    })
    const effectiveBefore = normalizedToolIds(effectiveBeforeInventory)
    const catalogBefore = normalizedCatalogToolIds(catalogBeforeInventory)
    const effectiveFingerprintBefore = fingerprintOpenClawToolInventory(effectiveBeforeInventory, {
      agentId: TARGET_AGENT_ID,
      kind: 'effective',
      label: `${descriptor.id} tools.effective before`,
    })
    const catalogFingerprintBefore = fingerprintOpenClawToolInventory(catalogBeforeInventory, {
      agentId: TARGET_AGENT_ID,
      kind: 'catalog',
      label: `${descriptor.id} tools.catalog before`,
    })
    const rowOffset = before.rows.length
    const transcriptBytesBeforeStress = statSync(before.sessionFile).size
    proxy.setPhase('stress')
    const stressWait = await send([
      `这是隔离同轮压力测试 ${descriptor.id}。`,
      `必须在同一轮中串行调用 ${STRESS_TOOL_ID} 恰好 ${options.toolCalls} 次。`,
      '第一次参数为 sequence=1, nonce=START。',
      '每次必须等待工具结果，下一次使用结果中的 nextNonce；不得并行、跳号、改用其他工具或提前结束。',
      `第 ${options.toolCalls} 次结果的 nextNonce=COMPLETE 后，只回复 STRESS_OK。`,
    ].join('\n'), 'stress')
    const afterStress = rowsFromSession(stateDir)
    const stressRows = afterStress.rows.slice(rowOffset)
    const audit = readAudit(stateDir)
    const persistedToolResultBytes = toolResultTextBytes(stressRows)
    const sameTurnThinkingBytes = stressRows.map(row => row?.message)
      .filter(message => message?.role === 'assistant' && Array.isArray(message.content))
      .flatMap(message => message.content)
      .filter(part => ['thinking', 'reasoning'].includes(part?.type))
      .reduce((total, part) => total + Buffer.byteLength(String(part.text || part.thinking || ''), 'utf8'), 0)
    const stressMetrics = modelPhaseMetrics(proxy.observations, 'stress')
    const transcriptBytesAfterStress = statSync(afterStress.sessionFile).size
    const stopReason = assistantStopReason(stressRows)
    const stressFinalText = stressRows.map(row => row?.message)
      .filter(message => message?.role === 'assistant').map(textParts).filter(Boolean).at(-1) || ''
    proxy.setPhase('next-turn')
    await send('这是下一轮落盘探针。只回复 NEXT_OK，不要调用工具。', 'next-turn')
    const afterNext = rowsFromSession(stateDir)
    const nextMetrics = modelPhaseMetrics(proxy.observations, 'next-turn')
    const effectiveAfterInventory = await call('tools.effective', {
      agentId: TARGET_AGENT_ID, sessionKey: SESSION_KEY,
    })
    const catalogAfterInventory = await call('tools.catalog', {
      agentId: TARGET_AGENT_ID, includePlugins: true,
    })
    const effectiveAfter = normalizedToolIds(effectiveAfterInventory)
    const catalogAfter = normalizedCatalogToolIds(catalogAfterInventory)
    const effectiveFingerprintAfter = fingerprintOpenClawToolInventory(effectiveAfterInventory, {
      agentId: TARGET_AGENT_ID,
      kind: 'effective',
      label: `${descriptor.id} tools.effective after`,
    })
    const catalogFingerprintAfter = fingerprintOpenClawToolInventory(catalogAfterInventory, {
      agentId: TARGET_AGENT_ID,
      kind: 'catalog',
      label: `${descriptor.id} tools.catalog after`,
    })
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const cell = {
      id: descriptor.id,
      precheck: descriptor.precheck,
      projection: descriptor.projection,
      evidenceClass: options.evidenceClass,
      realOpenClawLoop: true,
      requestedToolResults: options.toolCalls,
      completedToolResults: audit.length,
      toolResultBytes: audit.map(entry => entry.bytes),
      toolSequences: audit.map(entry => entry.sequence),
      persistedToolResultBytes,
      currentTurnRawResultChainCompleted: audit.length === options.toolCalls
        && audit.at(-1)?.sequence === options.toolCalls,
      stressFinalReplyMatched: stressFinalText.trim() === 'STRESS_OK',
      stressWaitStatus: stressWait.status || null,
      stopReason,
      sameTurnModelCalls: stressMetrics.modelCalls,
      sameTurnPeakRequestBytes: stressMetrics.peakRequestBytes,
      sameTurnPeakMessagesBytes: stressMetrics.peakMessagesBytes,
      sameTurnPeakToolsBytes: stressMetrics.peakToolsBytes,
      sameTurnThinkingBytes,
      sameTurnHttpStatuses: stressMetrics.httpStatuses,
      nextTurnModelCalls: nextMetrics.modelCalls,
      nextTurnRequestBytes: nextMetrics.peakRequestBytes,
      nextTurnMessagesBytes: nextMetrics.peakMessagesBytes,
      transcriptBytesBeforeStress,
      transcriptBytesAfterStress,
      transcriptBytesAfterNextTurn: statSync(afterNext.sessionFile).size,
      precheckLogEvents: (log.match(/mid.?turn.*precheck|preflightCompaction/giu) || []).length,
      contextOverflowDetected: /context overflow|estimated context size exceeds safe threshold/iu.test(log),
      effectiveToolIdsBefore: effectiveBefore,
      effectiveToolIdsAfter: effectiveAfter,
      catalogToolIdsBefore: catalogBefore,
      catalogToolIdsAfter: catalogAfter,
      effectiveToolFingerprintBefore: effectiveFingerprintBefore,
      effectiveToolFingerprintAfter: effectiveFingerprintAfter,
      catalogToolFingerprintBefore: catalogFingerprintBefore,
      catalogToolFingerprintAfter: catalogFingerprintAfter,
    }
    const validation = validateCellObservation(cell, {
      requestedCalls: options.toolCalls,
      requestedResultBytes: options.toolResultBytes,
      requiredToolIds: REQUIRED_TOOL_IDS,
    })
    return { ...cell, ...validation }
  } finally {
    await terminate(gateway)
    if (logFd !== null) closeSync(logFd)
    await proxy.stop()
    if (!options.keepArtifacts) {
      const physical = resolve(root)
      if (!physical.startsWith(resolve(PREFIX)) || basename(physical).length < 12) {
        throw new Error('refusing-unexpected-canary-cleanup-path')
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
    }
  }
}

async function verifyLiveModelEndpoint(baseUrl, apiKey) {
  const target = new URL('/v1/models', baseUrl)
  const response = await fetch(target, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`model-endpoint-preflight-http-${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload?.data) || payload.data.length === 0) {
    throw new Error('model-endpoint-returned-no-models')
  }
}

export async function runSameTurnAbCanary(env = process.env) {
  const options = {
    projectRoot: resolve(env.CANARY_PROJECT_ROOT || process.cwd()),
    openclawBin: env.OPENCLAW_BIN || 'openclaw',
    expectedOpenclawVersion: env.CANARY_EXPECTED_OPENCLAW_VERSION || DEFAULT_EXPECTED_OPENCLAW_VERSION,
    modelBaseUrl: env.CANARY_MODEL_BASE_URL,
    modelApiKey: env.CANARY_MODEL_API_KEY || '',
    modelId: env.CANARY_MODEL_ID,
    modelName: env.CANARY_MODEL_NAME || env.CANARY_MODEL_ID,
    toolCalls: parseBoundedInteger(env.CANARY_TOOL_CALLS, {
      name: 'CANARY_TOOL_CALLS', defaultValue: DEFAULT_TOOL_CALLS,
      minimum: MIN_TOOL_CALLS, maximum: MAX_TOOL_CALLS,
    }),
    toolResultBytes: parseBoundedInteger(env.CANARY_TOOL_RESULT_BYTES, {
      name: 'CANARY_TOOL_RESULT_BYTES', defaultValue: DEFAULT_TOOL_RESULT_BYTES,
      minimum: MIN_TOOL_RESULT_BYTES, maximum: MAX_TOOL_RESULT_BYTES,
    }),
    portBase: parseBoundedInteger(env.CANARY_GATEWAY_PORT_BASE, {
      name: 'CANARY_GATEWAY_PORT_BASE', defaultValue: 19_890,
      minimum: 1_024, maximum: 65_531,
    }),
    keepArtifacts: env.CANARY_KEEP_ARTIFACTS === '1',
    evidenceClass: env.CANARY_EVIDENCE_CLASS || 'live-model-real-openclaw-loop',
    thinking: env.CANARY_THINKING || 'off',
  }
  if (!['live-model-real-openclaw-loop', 'scripted-structural-only'].includes(options.evidenceClass)) {
    throw new Error('CANARY_EVIDENCE_CLASS is invalid')
  }
  if (!['off', 'low', 'medium', 'high'].includes(options.thinking)) {
    throw new Error('CANARY_THINKING is invalid')
  }
  if (!options.modelBaseUrl || !options.modelId) {
    throw new Error('live-model-required: set CANARY_MODEL_BASE_URL and CANARY_MODEL_ID')
  }
  if (process.version !== 'v22.22.3') throw new Error(`node-version-mismatch:${process.version}`)
  const openclawVersion = parseOpenClawVersion(options.openclawBin)
  if (openclawVersion !== options.expectedOpenclawVersion) {
    throw new Error(`openclaw-version-mismatch:${openclawVersion}`)
  }
  await verifyLiveModelEndpoint(options.modelBaseUrl, options.modelApiKey)
  const cells = []
  for (let index = 0; index < MATRIX_CELLS.length; index += 1) {
    cells.push(await runCell(options, MATRIX_CELLS[index], index))
  }
  const report = {
    schemaVersion: 1,
    evidenceClass: options.evidenceClass,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    openclawVersion,
    expectedOpenclawVersion: options.expectedOpenclawVersion,
    model: { id: options.modelId, baseUrlOrigin: new URL(options.modelBaseUrl).origin },
    stress: { toolCalls: options.toolCalls, toolResultBytes: options.toolResultBytes, thinking: options.thinking },
    requiredToolIds: REQUIRED_TOOL_IDS,
    cells,
  }
  const validation = validateMatrixReport(report)
  return { ...report, ...validation }
}

async function main() {
  try {
    const report = await runSameTurnAbCanary()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.accepted ? 0 : 1
  } catch (error) {
    const report = {
      schemaVersion: 1,
      accepted: false,
      evidenceClass: 'none-fail-closed',
      generatedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : 'unknown-canary-error',
      nodeVersion: process.version,
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
