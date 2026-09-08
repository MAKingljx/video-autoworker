#!/usr/bin/env node
// Reusable, non-delivering dialogue QA. Every attempt has one private input/run
// directory; source selection and per-host values belong in that input, not code.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const uid = process.getuid?.()
if (uid === undefined || process.argv.length !== 4 || process.argv[2] !== '--config') {
  throw new Error('usage: test-openclaw-owned-dialogue.mjs --config <private-input.json>')
}
const inputPath = resolve(process.argv[3])
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const runRoot = dirname(inputPath)
const statusPath = join(runRoot, 'dialogue-status.json')
const ownershipPath = join(runRoot, 'synthetic-session-ownership.json')
const input = readJson(inputPath, 0o600)
const nodePath = input.nodePath
const openclawPath = input.openclawPath
const profile = input.profile
const agentId = input.agentId
const stateRoot = input.stateRoot
const configPath = input.configPath
const sessionReadEnv = { HOME: process.env.HOME, OPENCLAW_STATE_DIR: stateRoot, OPENCLAW_CONFIG_PATH: configPath }
let model = ''
let secretHelper = ''
const allowedTools = new Set(['aiworker_director_brain'])

function writeProgress(stage, completedTurns) {
  const temporary = join(runRoot, `.progress-${randomUUID()}.json`)
  writeFileSync(temporary, JSON.stringify({ stage, completedTurns, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, join(runRoot, 'progress.json'))
}
function fail(code) { throw new Error(code) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function normalized(pathname) {
  return typeof pathname === 'string' && isAbsolute(pathname) && resolve(pathname) === pathname
    && !/[\u0000-\u001f\u007f]/u.test(pathname)
}
function safeDirectory(pathname, mode = null) {
  if (!normalized(pathname)) fail('directory_path_invalid')
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid
    || realpathSync(pathname) !== pathname || (entry.mode & 0o022) !== 0
    || (mode !== null && (entry.mode & 0o777) !== mode)) fail('directory_identity_invalid')
  return entry
}
function safeFile(pathname, mode = null) {
  if (!normalized(pathname)) fail('file_path_invalid')
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid || entry.nlink !== 1
    || realpathSync(pathname) !== pathname || (entry.mode & 0o022) !== 0
    || (mode !== null && (entry.mode & 0o777) !== mode)) fail('file_identity_invalid')
  return entry
}
function readJson(pathname, mode = null) {
  const before = safeFile(pathname, mode)
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('file_changed')
    const source = readFileSync(fd)
    try { return JSON.parse(source.toString('utf8')) } finally { source.fill(0) }
  } finally { closeSync(fd) }
}
function writeStatus(value) {
  const source = Buffer.from(`${JSON.stringify(value)}\n`)
  const fd = openSync(statusPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, source); fsyncSync(fd) } finally { source.fill(0); closeSync(fd) }
  const parent = openSync(dirname(statusPath), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || runRoot,
    env: options.env,
    encoding: null,
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
  })
}
function clearResult(result) {
  if (Buffer.isBuffer(result.stdout)) result.stdout.fill(0)
  if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0)
}
function commandOutput(command, args) {
  const result = run(command, args, { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8').trim() : ''
  const ok = result.status === 0 && !result.error && !result.signal
  clearResult(result)
  if (!ok) fail('command_identity_unavailable')
  return output
}
function parseMixedJson(source) {
  const firstObject = source.indexOf('{')
  const firstArray = source.indexOf('[')
  const starts = [firstObject, firstArray].filter(index => index >= 0)
  if (!starts.length) fail('agent_json_missing')
  const start = Math.min(...starts)
  const end = source.lastIndexOf(source[start] === '{' ? '}' : ']')
  if (end <= start) fail('agent_json_invalid')
  try { return JSON.parse(source.slice(start, end + 1)) } catch { fail('agent_json_invalid') }
}
function transcriptFacts(rows, prompts, workName) {
  const routes = prompts.map(prompt => inspectCurrentTurnToolRoute(rows, prompt))
  const calls = routes.flatMap(route => route.calls).map(call => ({
    name: call.name,
    action: typeof call.arguments.action === 'string' ? call.arguments.action : null,
  }))
  const totalToolCalls = rows.reduce((count, row) => count + (
    row?.message?.role === 'assistant' && Array.isArray(row.message.content)
      ? row.message.content.filter(part => part?.type === 'toolCall').length : 0
  ), 0)
  return {
    rows: rows.length,
    calls,
    allPromptsMatched: routes.every(route => route.foundPrompt),
    allToolCallsAccountedFor: calls.length === totalToolCalls,
    directorExplain: exactSuccessfulToolRouteVerified(routes[2], {
      name: 'aiworker_director_brain',
      arguments: { action: 'explain', topic: 'technique_learning' },
    }),
    directorResolveWork: exactSuccessfulToolRouteVerified(routes[3], {
      name: 'aiworker_director_brain',
      arguments: { action: 'resolve_work', query: workName },
    }),
    forbidden: calls.filter(call => !allowedTools.has(call.name)
      || (call.name === 'aiworker_director_brain'
        && !['explain', 'resolve_work'].includes(call.action))),
  }
}

let stage = 'preflight'
let token = ''
let workRoot = ''
let childEnv = null
let sessionKey = ''
let sessionRuntime = null
let cleanupOwnedSyntheticSession = null
let captureSnapshot = null
let ownershipVerified = false
let cleanupRequired = false
let cleanupAttempted = false
let cleanupResult = null
let expectedSessionId = null
let parseAgentResult = null
let summarizeNonDelivery = null
let inspectCurrentTurnToolRoute = null
let exactSuccessfulToolRouteVerified = null
let richCanaryContract = null
let lastTurnDiagnostics = null
let attemptOwned = false
let attemptedTurns = 0
let nonDeliveringTurnsVerified = 0
let explicitDeliveryEvidenceDetected = false
async function cleanupSyntheticSession() {
  cleanupAttempted = true
  cleanupResult = await cleanupOwnedSyntheticSession({
    sessionKey, agentId, ownershipVerified, expectedSessionId,
    readEntry: () => sessionRuntime.runtime.getSessionEntry({ agentId, env: sessionReadEnv, sessionKey }),
    deleteSession: parameters => {
      const result = run(openclawPath, [
        '--profile', profile, 'gateway', 'call', 'sessions.delete',
        '--params', JSON.stringify(parameters), '--json',
      ], { env: childEnv })
      const ok = result.status === 0 && !result.error && !result.signal
      const value = ok && Buffer.isBuffer(result.stdout) ? parseMixedJson(result.stdout.toString('utf8')) : null
      clearResult(result)
      if (!ok) fail('synthetic_session_delete_rpc_failed')
      return value
    },
  })
  return cleanupResult
}
try {
  if (process.version !== input.expectedNodeVersion || realpathSync(process.execPath) !== realpathSync(nodePath)) fail('runtime_identity_invalid')
  safeDirectory(runRoot, 0o700); safeDirectory(repositoryRoot); safeDirectory(stateRoot)
  safeFile(configPath, 0o600)
  const relativeRun = relative(repositoryRoot, runRoot)
  if (!relativeRun || (!relativeRun.startsWith(`..${sep}`) && relativeRun !== '..' && !isAbsolute(relativeRun))) fail('run_root_inside_source')
  if (input.schema !== 'video-autoworker-owned-dialogue-input/v1' || input.armed !== true
    || input.qaSourceRoot !== repositoryRoot || !/^[a-f0-9]{40}$/u.test(input.expectedQaCommit || '')
    || !normalized(nodePath) || !normalized(openclawPath) || !normalized(stateRoot)
    || configPath !== join(stateRoot, 'openclaw.json')
    || !/^[a-z0-9][a-z0-9-]*$/u.test(profile) || agentId !== 'second-original'
    || !/^[a-z0-9][a-z0-9.-]*$/u.test(input.gatewayLaunchLabel || '')
    || !Number.isSafeInteger(input.gatewayPort) || input.gatewayPort < 1024 || input.gatewayPort > 65535
    || !Number.isSafeInteger(input.expectedGatewayPid) || input.expectedGatewayPid < 1
    || input.expectedThinking !== 'medium' || typeof input.expectedModel !== 'string') fail('input_not_armed')
  if (existsSync(statusPath) || existsSync(ownershipPath) || existsSync(join(runRoot, 'attempt-started.json'))) fail('attempt_already_used')
  writeFileSync(join(runRoot, 'attempt-started.json'), JSON.stringify({
    schema: 'video-autoworker-owned-dialogue-attempt/v1', startedAt: new Date().toISOString(),
    inputSha256: sha256(readFileSync(inputPath)), qaCommit: input.expectedQaCommit,
  }) + '\n', { flag: 'wx', mode: 0o600 })
  attemptOwned = true
  secretHelper = join(repositoryRoot, 'scripts/lib/openclaw-secret-reference.mjs')
  safeFile(secretHelper)
  const openclawEntry = realpathSync(openclawPath)
  safeFile(openclawEntry)
  safeDirectory(input.qaSourceRoot)
  if (commandOutput('/usr/bin/git', ['-C', input.qaSourceRoot, 'rev-parse', 'HEAD']) !== input.expectedQaCommit
    || commandOutput('/usr/bin/git', ['-C', input.qaSourceRoot, 'status', '--porcelain=v1']) !== '') fail('qa_source_not_exact')
  const runtimeHelper = join(input.qaSourceRoot, 'scripts/lib/openclaw-rich-canary-session-runtime.mjs')
  const cleanupHelper = join(input.qaSourceRoot, 'scripts/lib/openclaw-owned-synthetic-session.mjs')
  safeFile(cleanupHelper)
  ;({ cleanupOwnedSyntheticSession } = await import(pathToFileURL(cleanupHelper).href))
  const agentHelper = join(repositoryRoot, 'scripts/lib/openclaw-agent-config.mjs')
  safeFile(runtimeHelper); safeFile(agentHelper)
  const parserHelper = join(input.qaSourceRoot, 'scripts/lib/openclaw-agent-json-result.mjs')
  safeFile(parserHelper)
  ;({
    parseOpenClawAgentJsonResult: parseAgentResult,
    summarizeNonDeliveryVerification: summarizeNonDelivery,
  } = await import(pathToFileURL(parserHelper).href))
  if (typeof parseAgentResult !== 'function' || typeof summarizeNonDelivery !== 'function') fail('agent_parser_unavailable')
  const routeHelper = join(input.qaSourceRoot, 'scripts/lib/openclaw-rich-canary-contract.mjs')
  safeFile(routeHelper)
  ;({ inspectCurrentTurnToolRoute, exactSuccessfulToolRouteVerified, RICH_CANARY_CONTRACT: richCanaryContract } = await import(pathToFileURL(routeHelper).href))
  const runtimeModule = await import(pathToFileURL(runtimeHelper).href)
  sessionRuntime = await runtimeModule.loadOpenClawRichCanarySessionRuntime({ openclawBin: openclawPath, expectedVersion: input.expectedSdkVersion })
  captureSnapshot = runtimeModule.captureOpenClawRichCanarySessionSnapshot
  const { readOpenClawAgentEntries } = await import(pathToFileURL(agentHelper).href)
  const currentConfig = readJson(configPath, 0o600)
  const matches = readOpenClawAgentEntries(currentConfig).filter(value => value.id === agentId)
  if (matches.length !== 1) fail('agent_identity_invalid')
  const currentAgent = matches[0]
  const selectedModel = currentAgent?.model ?? currentConfig.agents?.defaults?.model
  model = typeof selectedModel === 'string' ? selectedModel : selectedModel?.primary
  const thinking = currentAgent?.thinkingDefault ?? currentConfig.agents?.defaults?.thinkingDefault
  if (model !== input.expectedModel || thinking !== input.expectedThinking) fail('default_model_changed')
  const listener = commandOutput('/usr/sbin/lsof', ['-nP', `-iTCP:${input.gatewayPort}`, '-sTCP:LISTEN', '-Fp'])
  const pids = [...new Set(listener.split(/\r?\n/u).filter(line => /^p[1-9][0-9]*$/u.test(line)).map(line => Number(line.slice(1))))]
  if (pids.length !== 1 || pids[0] !== input.expectedGatewayPid) fail('gateway_identity_invalid')
  const launch = run('/bin/launchctl', ['print', `gui/${uid}/${input.gatewayLaunchLabel}`], { env: process.env })
  const launchOk = launch.status === 0 && !launch.error && !launch.signal
  clearResult(launch)
  if (!launchOk) fail('gateway_launchagent_unavailable')
  sessionKey = `agent:${agentId}:codex-postdeploy-${randomUUID()}`
  if (sessionRuntime.runtime.getSessionEntry({ agentId, env: sessionReadEnv, sessionKey }) != null) fail('session_key_conflict')
  ownershipVerified = true
  writeFileSync(ownershipPath, JSON.stringify({ schema: 'video-autoworker-owned-synthetic-session/v1',
    profile, agentId, sessionKey, absentBeforeTest: true, qaCommit: input.expectedQaCommit }) + '\n', { flag: 'wx', mode: 0o600 })
  const anchor = `ANCHOR-${randomUUID()}`
  const workName = `不存在的合成作品-${randomUUID()}`
  const prompts = [
    `这是部署后隔离测试。请记住合成锚点“${anchor}”，不要调用任何工具，只回复“已记住”。`,
    '接下来只做导演脑的只读查询，不创建或修改任何内容。不要调用工具，用一句话确认这个边界。',
    '请只调用 aiworker_director_brain，参数必须为 action=explain、topic=technique_learning；逐字使用工具给出的只读答案。不得调用 propose、视频、任务或写入类能力。',
    `请只调用 aiworker_director_brain，参数必须为 action=resolve_work、query=${workName}；这是唯一且不存在的合成作品名，只做只读 not-found 验证。不得调用 propose 或任何其他工具。`,
    `不要调用工具。请只回复第1轮要求记住的完整合成锚点。`,
  ]
  workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aiworker-postdeploy-dialogue.')))
  const secretResult = run(nodePath, [secretHelper, configPath], {
    env: { HOME: process.env.HOME, PATH: `${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  })
  const secretOk = secretResult.status === 0 && !secretResult.error && !secretResult.signal
    && Buffer.isBuffer(secretResult.stdout) && secretResult.stdout.length > 1
  if (secretOk) token = secretResult.stdout.toString('utf8').trim()
  clearResult(secretResult)
  if (!secretOk || token.length < 8) fail('gateway_secret_unavailable')
  childEnv = {
    ...sessionReadEnv, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: 'en_US.UTF-8',
    PATH: `${dirname(nodePath)}:${dirname(openclawPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    OPENCLAW_GATEWAY_TOKEN: token,
  }
  cleanupRequired = true
  const turns = []
  for (let index = 0; index < prompts.length; index += 1) {
    stage = `turn_${index + 1}`
    writeProgress(stage, turns.length)
    const promptPath = join(workRoot, `prompt-${index + 1}.txt`)
    writeFileSync(promptPath, prompts[index], { mode: 0o600, flag: 'wx' })
    const started = Date.now()
    const agentArguments = [
      '--profile', profile, 'agent', '--agent', agentId, '--session-key', sessionKey,
      '--message-file', promptPath, '--timeout', '240', '--json',
    ]
    attemptedTurns += 1
    const result = run(openclawPath, agentArguments,
      { env: childEnv, timeout: 250_000, maxBuffer: 16 * 1024 * 1024 })
    const elapsedMs = Date.now() - started
    rmSync(promptPath, { force: true })
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : ''
    const ok = result.status === 0 && !result.error && !result.signal
    const value = ok ? parseMixedJson(stdout) : null
    let parsed = null
    let parserError = null
    if (value) {
      try { parsed = parseAgentResult(value, { argv: agentArguments, expectedModel: model }) }
      catch (error) { parserError = String(error.message).replace(/[^a-z0-9_:]/giu, '_').slice(0,180) }
    }
    if (parserError?.endsWith(':unexpected_delivery_evidence')) explicitDeliveryEvidenceDetected = true
    const text = parsed?.visibleText || ''
    const turn = {
      index: index + 1,
      elapsedMs,
      outputBytes: Buffer.byteLength(stdout),
      responseSha256: sha256(Buffer.from(text)),
      commandSucceeded: ok,
      exitCode: result.status,
      signal: result.signal,
      parserError,
      responseShape: value && typeof value === 'object' ? Object.keys(value).sort() : [],
      deliveryFalse: parsed?.externalDelivery === false,
      deliveryEvidence: parsed?.deliveryEvidence || null,
      durationMs: parsed?.durationMs ?? null,
      totalTokens: parsed?.totalTokens ?? null,
      textPresent: Boolean(text),
      anchorPresent: text.includes(anchor),
      notFoundReplyVerified: index === 3 && text === richCanaryContract.resolutionNotFoundAnswer,
      modelMatched: parsed?.modelMatched === true,
    }
    lastTurnDiagnostics = turn
    if (turn.deliveryFalse) nonDeliveringTurnsVerified += 1
    clearResult(result)
    if (!ok || !turn.textPresent || !turn.deliveryFalse || !turn.modelMatched) fail(`turn_${index + 1}_failed`)
    turns.push(turn)
    writeProgress(stage, turns.length)
  }
  stage = 'transcript_verify'
  const snapshot = captureSnapshot(sessionRuntime, { agentId, env: sessionReadEnv, sessionKey })
  expectedSessionId = snapshot.entry.sessionId
  const facts = transcriptFacts(snapshot.events, prompts, workName)
  if (!turns[4].anchorPresent || !facts.allPromptsMatched || !facts.allToolCallsAccountedFor
    || facts.calls.length !== 2
    || !facts.directorExplain || !facts.directorResolveWork || !turns[3].notFoundReplyVerified
    || facts.forbidden.length !== 0) fail('dialogue_contract_failed')
  stage = 'synthetic_session_cleanup'
  await cleanupSyntheticSession()
  stage = 'complete'
  const deliveryVerification = summarizeNonDelivery({
    attemptedTurns,
    verifiedTurns: nonDeliveringTurnsVerified,
    explicitDeliveryEvidenceDetected,
  })
  writeStatus({
    schema: 'video-autoworker-postdeploy-dialogue-result/v1',
    ok: true,
    profile,
    agentId,
    model,
    modelOverride: false,
    thinkingOverride: false,
    qaCommit: input.expectedQaCommit,
    sessionKeySha256: sha256(Buffer.from(sessionKey)),
    syntheticAnchorSha256: sha256(Buffer.from(anchor)),
    syntheticWorkNameSha256: sha256(Buffer.from(workName)),
    rawDialogueExported: false,
    syntheticSessionPersistedDuringTest: true,
    sessionCleanup: cleanupResult,
    ...deliveryVerification,
    turns,
    transcript: {
      rows: facts.rows,
      allPromptsMatched: facts.allPromptsMatched,
      allToolCallsAccountedFor: facts.allToolCallsAccountedFor,
      toolCalls: facts.calls,
      directorExplain: facts.directorExplain,
      directorResolveWork: facts.directorResolveWork,
      notFoundReplyVerified: turns[3].notFoundReplyVerified,
      forbiddenToolCalls: 0,
    },
  })
} catch (error) {
  if (cleanupRequired && !cleanupAttempted) {
    try { await cleanupSyntheticSession() } catch { cleanupResult = { activeSessionAbsent: false, cleanupFailed: true } }
  }
  const code = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
    ? error.message : 'dialogue_wrapper_failed'
  try {
    if (attemptOwned && !existsSync(statusPath)) {
      const deliveryVerification = typeof summarizeNonDelivery === 'function'
        ? summarizeNonDelivery({
            attemptedTurns,
            verifiedTurns: nonDeliveringTurnsVerified,
            explicitDeliveryEvidenceDetected,
          })
        : {
            externalDelivery: null,
            externalDeliveryVerified: false,
            explicitDeliveryEvidenceDetected,
          }
      writeStatus({ schema: 'video-autoworker-postdeploy-dialogue-result/v1', ok: false, stage, error: code, lastTurnDiagnostics, rawDialogueExported: false, sessionCleanup: cleanupResult, ...deliveryVerification })
    }
  } catch {}
  if (!attemptOwned) process.stderr.write(`${code}\n`)
  process.exitCode = 1
} finally {
  if (childEnv) childEnv.OPENCLAW_GATEWAY_TOKEN = ''
  token = ''
  if (workRoot && basename(workRoot).startsWith('aiworker-postdeploy-dialogue.')) {
    try { rmSync(workRoot, { recursive: true, force: true }) } catch { process.exitCode = 1 }
  }
}
