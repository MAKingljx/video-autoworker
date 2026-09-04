import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import type { N8nTaskRun } from '@/lib/n8n-task-runs'
import {
  DIRECTOR_COMMAND_LIMITS,
  directorEvidenceBindingForResolvedWork,
  directorEvidenceDigest,
  drainDirectorEvidenceOutboxCore,
  enqueueDirectorEvidenceOutboxCore,
  getDirectorEvidenceOutboxCore,
  getDirectorEvidenceOutboxCountsCore,
  normalizedDirectorWorkQuery,
  serializeDirectorCommandInput,
} from '@/lib/director-evidence-delivery-core'
import type {
  DirectorCommand,
  DirectorCommandRunner,
  DirectorEvidenceBinding,
  DirectorEvidenceOutboxCounts,
  DirectorEvidenceOutbox,
} from '@/lib/director-evidence-delivery-core'
import { getDirectorBrainScope } from '@/lib/director-brain-scope'

export {
  DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
  directorEvidenceBindingFromInput,
  directorWorkQueryDigest,
  sameDirectorEvidenceBinding,
} from '@/lib/director-evidence-delivery-core'
export type {
  DirectorCommandRunner,
  DirectorEvidenceBinding,
  DirectorEvidenceOutbox,
} from '@/lib/director-evidence-delivery-core'
export {
  DIRECTOR_EVIDENCE_PROJECT_ID,
  DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
} from '@/lib/director-evidence-projection-semantics'

export const DIRECTOR_EVIDENCE_PROJECTION_CONTRACT_AUTHORITY =
  'director-evidence-projection-contract-v1'
export const DIRECTOR_EVIDENCE_PROJECTION_SCHEMA_VERSION = 1

const SHA256 = /^[a-f0-9]{64}$/u
const DIRECTOR_BRAIN_CLI_SHA256 = '8fbdfdfb8b7ff45601a8b29004d85fec7346de67caa78b3ee11da3db317e7f6e'
const DIRECTOR_BRAIN_SERVICE_SHA256 = 'c10d17caa790206f33562e03f5bea5330ad65bad8e637b562fa905e910c8519b'
const DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256 = '65d3a771f631b4cbf34c31e31b821d63a357008af3a09d2ea4e21a44b9852b5c'
const DIRECTOR_BRAIN_SCHEMA_SHA256 = '72ef48a91f943fbd15786ecba648fccb2f9c91722c607df96c05578d953e074f'
const DIRECTOR_EVIDENCE_TRANSFORMER_SHA256 = 'b3dd0dcd11fb7c1b9bbfd21c840fe4e2c48e091a5f8cfcdddb50d1616bd9e6d1'
const DIRECTOR_EVIDENCE_LIBRARY_SHA256 = 'dc472b4386d4d21a61520cbb0f5abc2829a819063975aafc54312483347fe8cc'
const DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256 = '1e5153a633225b6454ab722b689de9ee7a5dcfccff697c19d2ea2d0a708e2cda'
const DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256 = 'ceefa7f9b1f37c359637ec13947aade3d093fa53f7c2de591901446207f10040'
const DIRECTOR_COMMAND_ENV_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const
const COMMAND_TIMEOUT_MS = {
  operate: 30_000,
  'propose-batch': 180_000,
  transform: 30_000,
  'project-evidence': 10 * 60_000,
} as const

export function directorCommandTimeoutMs(
  command: DirectorCommand,
  input: Record<string, unknown>,
): number {
  if (command !== 'propose-batch' || !Array.isArray(input.items)) {
    return COMMAND_TIMEOUT_MS[command]
  }
  // propose_batch intentionally performs stable, reference-checked creates in
  // sequence. Give each bounded item time for Feishu round trips without
  // turning every read-only operate call into a long-running process.
  return Math.min(180_000, 30_000 + input.items.length * 15_000)
}

function commandPaths(command: DirectorCommand): { script: string; args: string[] } {
  if (command === 'transform') {
    const script = process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH
      || join(homedir(), 'AI-worker-second-original-workspace', 'skills', 'aiworker-task-flow',
        'scripts', 'project-director-evidence.mjs')
    return { script, args: [] }
  }
  const script = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
    || join(homedir(), '.openclaw-qwen-current', 'extensions', 'aiworker-director-brain',
      'runtime', 'scripts', 'feishu-director-brain.mjs')
  return { script, args: [command] }
}

function configuredDigest(
  environmentKey: string,
  fallback: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const expected = source[environmentKey] || fallback
  if (!SHA256.test(expected)) throw new Error('director_command_identity_invalid')
  return expected
}

export function directorEvidenceProjectionContractDigest(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return directorEvidenceDigest({
    authority: DIRECTOR_EVIDENCE_PROJECTION_CONTRACT_AUTHORITY,
    schemaVersion: DIRECTOR_EVIDENCE_PROJECTION_SCHEMA_VERSION,
    directorBrainCliSha256: configuredDigest(
      'AIWORKER_DIRECTOR_BRAIN_CLI_SHA256', DIRECTOR_BRAIN_CLI_SHA256, source,
    ),
    directorBrainServiceSha256: configuredDigest(
      'AIWORKER_DIRECTOR_BRAIN_SERVICE_SHA256', DIRECTOR_BRAIN_SERVICE_SHA256, source,
    ),
    directorBrainSensitiveValueScannerSha256: configuredDigest(
      'AIWORKER_DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256',
      DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256,
      source,
    ),
    directorBrainSchemaSha256: configuredDigest(
      'AIWORKER_DIRECTOR_BRAIN_SCHEMA_SHA256', DIRECTOR_BRAIN_SCHEMA_SHA256, source,
    ),
    evidenceTransformerSha256: configuredDigest(
      'AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_SHA256',
      DIRECTOR_EVIDENCE_TRANSFORMER_SHA256,
      source,
    ),
    evidenceLibrarySha256: configuredDigest(
      'AIWORKER_DIRECTOR_EVIDENCE_LIBRARY_SHA256', DIRECTOR_EVIDENCE_LIBRARY_SHA256, source,
    ),
    appProjectionSemanticsSha256: configuredDigest(
      'AIWORKER_DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256',
      DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256,
      source,
    ),
    deliveryCoreSha256: configuredDigest(
      'AIWORKER_DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256',
      DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256,
      source,
    ),
  })
}

export function directorCommandEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {}
  for (const key of DIRECTOR_COMMAND_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  return environment as NodeJS.ProcessEnv
}

async function validatedCommandFile(
  pathname: string,
  options: { executable: boolean; expectedSha256?: string },
): Promise<string> {
  if (!isAbsolute(pathname)) throw new Error('director_command_path_invalid')
  let physicalPath: string
  try {
    physicalPath = await realpath(pathname)
    if (!isAbsolute(physicalPath)) throw new Error('director_command_path_invalid')
    const before = await stat(physicalPath)
    if (!before.isFile()) throw new Error('director_command_path_invalid')
    if ((before.mode & 0o6022) !== 0) throw new Error('director_command_permissions_invalid')
    await access(physicalPath, options.executable ? fsConstants.X_OK : fsConstants.R_OK)
    if (options.expectedSha256) {
      const contents = await readFile(physicalPath)
      const after = await stat(physicalPath)
      if (!after.isFile()
        || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('director_command_identity_changed')
      }
      if (createHash('sha256').update(contents).digest('hex') !== options.expectedSha256) {
        throw new Error('director_command_identity_mismatch')
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('director_command_')) throw error
    throw new Error('director_command_path_invalid', { cause: error })
  }
  return physicalPath
}

async function validateCommandDependencyClosure(
  command: DirectorCommand,
  physicalScriptPath: string,
): Promise<void> {
  const scriptDirectory = dirname(physicalScriptPath)
  if (command === 'transform') {
    await validatedCommandFile(resolve(scriptDirectory, '..', 'lib', 'director-brain-evidence.mjs'), {
      executable: false,
      expectedSha256: configuredDigest(
        'AIWORKER_DIRECTOR_EVIDENCE_LIBRARY_SHA256',
        DIRECTOR_EVIDENCE_LIBRARY_SHA256,
      ),
    })
    return
  }
  await Promise.all([
    validatedCommandFile(resolve(scriptDirectory, 'lib', 'feishu-director-brain.mjs'), {
      executable: false,
      expectedSha256: configuredDigest(
        'AIWORKER_DIRECTOR_BRAIN_SERVICE_SHA256',
        DIRECTOR_BRAIN_SERVICE_SHA256,
      ),
    }),
    validatedCommandFile(resolve(scriptDirectory, 'lib', 'sensitive-value-scanner.mjs'), {
      executable: false,
      expectedSha256: configuredDigest(
        'AIWORKER_DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256',
        DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256,
      ),
    }),
    validatedCommandFile(resolve(scriptDirectory, '..', 'ops', 'feishu-director-brain', 'schema.json'), {
      executable: false,
      expectedSha256: configuredDigest(
        'AIWORKER_DIRECTOR_BRAIN_SCHEMA_SHA256',
        DIRECTOR_BRAIN_SCHEMA_SHA256,
      ),
    }),
  ])
}

export async function runDirectorCommand(
  command: DirectorCommand,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const configuredNodePath = process.env.AIWORKER_NODE_BIN || process.execPath
  const { script, args } = commandPaths(command)
  const [nodePath, scriptPath] = await Promise.all([
    validatedCommandFile(configuredNodePath, { executable: true }),
    validatedCommandFile(script, {
      executable: false,
      expectedSha256: configuredDigest(
        command === 'transform'
          ? 'AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_SHA256'
          : 'AIWORKER_DIRECTOR_BRAIN_CLI_SHA256',
        command === 'transform'
          ? DIRECTOR_EVIDENCE_TRANSFORMER_SHA256
          : DIRECTOR_BRAIN_CLI_SHA256,
      ),
    }),
  ])
  await validateCommandDependencyClosure(command, scriptPath)
  const stdin = serializeDirectorCommandInput(command, input)
  const maxOutputBytes = DIRECTOR_COMMAND_LIMITS[command].maxOutputBytes
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(nodePath, [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: directorCommandEnvironment(),
      shell: false,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(error)
    }
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxOutputBytes) return fail(new Error('director_command_output_too_large'))
      target.push(buffer)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.on('error', error => fail(new Error('director_command_spawn_failed', { cause: error })))
    child.stdin.on('error', error => fail(new Error('director_command_stdin_failed', { cause: error })))
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        let safeCode = 'director_command_failed'
        try {
          const parsed = JSON.parse(Buffer.concat(stderr).toString('utf8').trim())
          if (typeof parsed?.error === 'string' && /^[A-Za-z0-9_:-]{1,200}$/u.test(parsed.error)) {
            safeCode = parsed.error
          }
        } catch { /* keep the fixed safe code */ }
        return reject(new Error(safeCode))
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8').trim())
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('director_command_result_invalid')
        }
        resolvePromise(parsed as Record<string, unknown>)
      } catch {
        reject(new Error('director_command_result_invalid'))
      }
    })
    timer = setTimeout(
      () => fail(new Error('director_command_timeout')),
      directorCommandTimeoutMs(command, input),
    )
    try {
      child.stdin.end(stdin)
    } catch (error) {
      fail(new Error('director_command_stdin_failed', { cause: error }))
    }
  })
}

export async function resolveDirectorWorkBinding(
  queryValue: unknown,
  options: { runner?: DirectorCommandRunner } = {},
): Promise<DirectorEvidenceBinding> {
  const query = normalizedDirectorWorkQuery(queryValue)
  const result = await (options.runner || runDirectorCommand)('operate', {
    action: 'resolve_work',
    query,
  })
  const work = result.work
  if (result.ok !== true || result.action !== 'resolve_work' || result.found !== true
    || !work || typeof work !== 'object' || Array.isArray(work)) {
    throw new Error('director_work_not_found')
  }
  return directorEvidenceBindingForResolvedWork(
    (work as Record<string, unknown>).workId,
    query,
  )
}

export function getDirectorEvidenceOutbox(
  db: Database.Database,
  taskId: string,
): DirectorEvidenceOutbox | null {
  return getDirectorEvidenceOutboxCore(db, taskId)
}

export function getDirectorEvidenceOutboxCounts(
  db: Database.Database,
): DirectorEvidenceOutboxCounts {
  return getDirectorEvidenceOutboxCountsCore(
    db,
    directorEvidenceProjectionContractDigest(),
    getDirectorBrainScope(),
  )
}

export function enqueueDirectorEvidenceOutbox(
  db: Database.Database,
  parent: N8nTaskRun,
  nowSeconds = Math.floor(Date.now() / 1_000),
): 'skipped' | 'created' | 'existing' | 'conflict' {
  return enqueueDirectorEvidenceOutboxCore(
    db,
    parent,
    directorEvidenceProjectionContractDigest(),
    nowSeconds,
  )
}

export async function drainDirectorEvidenceOutbox(
  db: Database.Database,
  options: {
    nowSeconds?: number
    now?: () => number
    limit?: number
    runner?: DirectorCommandRunner
  } = {},
): Promise<{ scanned: number; delivered: number; pending: number; conflict: number }> {
  const scope = getDirectorBrainScope()
  return await drainDirectorEvidenceOutboxCore(db, {
    scope,
    currentProjectionContractDigest: directorEvidenceProjectionContractDigest(),
    nowSeconds: options.nowSeconds,
    now: options.now,
    limit: options.limit,
    runner: options.runner || runDirectorCommand,
  })
}
