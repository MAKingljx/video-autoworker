import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readIndependentWorkerStatus } from './independent-worker-release.mjs'

const ENV_KEYS = new Set(['MISSION_CONTROL_DB_PATH', 'AIWORKER_BG_N8N_DB_PATH',
  'AIWORKER_SCHEDULER_MANIFEST', 'AIWORKER_SCHEDULER_STATE_DIR', 'MC_AUTH_MODE',
  'MC_OPENCLAW_TENANT_ID', 'MC_OPENCLAW_WORKSPACE_ID', 'AIWORKER_OPENCLAW_QWEN_STATE_DIR',
  'AIWORKER_QWEN_WORKSPACE'])

function file(pathname, maximum = 1024 * 1024) {
  if (!isAbsolute(pathname || '') || resolve(pathname) !== pathname) throw new Error('path_invalid')
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(pathname) !== pathname
    || entry.nlink !== 1 || entry.uid !== process.getuid() || (entry.mode & 0o022)
    || entry.size > maximum) throw new Error('file_unsafe')
  return readFileSync(pathname, 'utf8')
}

/** Parse only the deployment allowlist; never evaluate shell or return credentials. */
export function parseDeploymentEnvironment(source) {
  const values = {}
  for (const line of source.split(/\r?\n/u)) {
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line.trim())
    if (!match || !ENV_KEYS.has(match[1])) continue
    let value = match[2]
    if (/^["']/u.test(value)) {
      if (value.at(-1) !== value[0]) throw new Error('environment_quote_invalid')
      value = value.slice(1, -1)
    }
    if (/[`$\u0000-\u001f]/u.test(value)) throw new Error('environment_expression_rejected')
    if (Object.hasOwn(values, match[1])) throw new Error('environment_duplicate')
    values[match[1]] = value
  }
  return values
}

export function readWorkerLaunchArguments(pathname) {
  const source = file(pathname)
  let plist
  try { plist = JSON.parse(source) } catch {
    plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', pathname],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }))
  }
  if (!Array.isArray(plist.ProgramArguments) || plist.ProgramArguments.some(value => typeof value !== 'string')) {
    throw new Error('worker_arguments_invalid')
  }
  return plist.ProgramArguments
}

/** Discover declared installation bindings, preserving every explicit caller value. */
export async function discoverDeploymentEnvironment({ env = process.env, home = homedir(),
  workerArguments, readWorker = readIndependentWorkerStatus, verifyWorker = true } = {}) {
  const environment = {}, sources = {}, missing = []
  const issue = (field, code) => missing.push({ field, code })
  const select = (key, value, source) => {
    if (Object.hasOwn(env, key)) { environment[key] = env[key]; sources[key] = 'explicit'; return }
    if (value !== undefined && value !== null && value !== '') { environment[key] = String(value); sources[key] = source }
  }
  const installationPath = env.AIWORKER_BG_INSTALLATION_FILE || join(
    env.AIWORKER_BG_SUPERVISOR_DIR || join(env.AIWORKER_BG_RUN_DIR
      || join(home, 'ai-worker/state/video-autoworker/blue-green'), 'supervisor'), 'installation.json')
  let installation = {}
  try {
    installation = JSON.parse(file(installationPath))
    if (installation.schema !== 'video-autoworker-blue-green-launchd/v2') throw new Error('installation_schema_invalid')
  } catch (error) { issue('installation', error.code === 'ENOENT' ? 'missing' : 'invalid') }
  const platformPath = env.AIWORKER_PLATFORM_ENV_FILE || join(home, '.config/video-autoworker/platform.env')
  let platform = {}
  try {
    const entry = lstatSync(platformPath)
    if ((entry.mode & 0o777) !== 0o600) throw new Error('platform_mode_invalid')
    platform = parseDeploymentEnvironment(file(platformPath))
  } catch (error) { issue('platform', error.code === 'ENOENT' ? 'missing' : 'invalid') }
  select('AIWORKER_PLATFORM_ENV_FILE', platformPath, 'platform')
  select('AIWORKER_BG_RUN_DIR', installation.runDir, 'installation')
  select('AIWORKER_BG_RELEASES_DIR', installation.releasesDir, 'installation')
  select('AIWORKER_BG_LAUNCH_AGENTS_DIR', installation.launchAgentsDir, 'installation')
  select('AIWORKER_BG_LIVE_DB_PATH', platform.MISSION_CONTROL_DB_PATH, 'platform')
  select('NODE_BIN', installation.nodeBin, 'installation')
  for (const name of ['router', 'blue', 'green']) select(`AIWORKER_BG_${name.toUpperCase()}_PORT`,
    installation.services?.[name]?.port, 'installation')
  for (const [key, value] of Object.entries(platform)) if (key !== 'AIWORKER_SCHEDULER_MANIFEST') select(key, value, 'platform')
  const runDir = environment.AIWORKER_BG_RUN_DIR
  if (runDir) {
    select('AIWORKER_BG_ROUTER_STATE', join(runDir, 'router-state.json'), 'installation')
    // The bootstrap record names the actual shared database; do not invent a database path.
    try { select('AIWORKER_BG_N8N_DB_PATH', JSON.parse(file(join(runDir, 'baseline.json'))).n8nDbPath, 'baseline') }
    catch { /* Required only when a shared component changes; the coordinator enforces that boundary. */ }
  }
  let artifact, workerState
  try {
    const args = workerArguments || readWorkerLaunchArguments(join(
      environment.AIWORKER_BG_LAUNCH_AGENTS_DIR || join(home, 'Library/LaunchAgents'), 'com.aiworker.scheduler-worker.plist'))
    const option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
    artifact = option('--artifact'); workerState = option('--state-dir')
  } catch { /* A verified platform manifest remains usable if it matches the live worker. */ }
  select('AIWORKER_SCHEDULER_STATE_DIR', workerState, 'worker-launch-agent')
  const manifestPath = artifact ? join(artifact, 'worker-manifest.json') : platform.AIWORKER_SCHEDULER_MANIFEST
  select('AIWORKER_SCHEDULER_MANIFEST', manifestPath, artifact ? 'worker-launch-agent' : 'platform')
  if (verifyWorker) {
    try {
      const manifest = JSON.parse(file(environment.AIWORKER_SCHEDULER_MANIFEST, 32 * 1024 * 1024))
      const status = await readWorker(environment.AIWORKER_SCHEDULER_STATE_DIR)
      if (manifest.schema !== 'video-autoworker-scheduler-artifact/v1'
        || status.worker?.contentSha256 !== manifest.contentSha256) issue('workerManifest', 'live_identity_mismatch')
    } catch { issue('workerManifest', 'unavailable_or_unsafe') }
  }
  for (const key of ['AIWORKER_BG_RUN_DIR', 'AIWORKER_BG_RELEASES_DIR', 'AIWORKER_BG_LIVE_DB_PATH',
    'AIWORKER_SCHEDULER_STATE_DIR', 'AIWORKER_SCHEDULER_MANIFEST', 'MC_AUTH_MODE',
    'MC_OPENCLAW_TENANT_ID', 'MC_OPENCLAW_WORKSPACE_ID']) if (!environment[key]) issue(key, 'missing')
  for (const key of ['AIWORKER_BG_RUN_DIR', 'AIWORKER_BG_RELEASES_DIR', 'AIWORKER_SCHEDULER_STATE_DIR', 'AIWORKER_BG_LIVE_DB_PATH']) {
    const pathname = environment[key]
    if (!pathname) continue
    try {
      const entry = lstatSync(pathname)
      if (!isAbsolute(pathname) || resolve(pathname) !== pathname || realpathSync(pathname) !== pathname
        || entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o022)
        || (key === 'AIWORKER_BG_LIVE_DB_PATH' ? !entry.isFile() : !entry.isDirectory())) throw new Error('unsafe')
    } catch { issue(key, 'invalid_or_unsafe') }
  }
  const ports = ['ROUTER', 'BLUE', 'GREEN'].map(name => environment[`AIWORKER_BG_${name}_PORT`])
  if (ports.some(port => !/^[0-9]+$/u.test(port || '') || Number(port) < 1 || Number(port) > 65535)
    || new Set(ports.map(Number)).size !== 3) issue('ports', 'missing_or_invalid')
  return { schema: 'video-autoworker-deployment-discovery/v1',
    currentState: missing.length ? 'blocked' : 'ready', errorCode: missing.length ? 'deployment_binding_missing' : null,
    nextAction: missing.length ? 'provide_reported_bindings' : 'create_release_plan',
    environment, sources, installationPath, controlRoot: installation.projectRoot || null, missing }
}
