import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

export const INSTALLED_SUBMIT_SCRIPT = resolve(
  homedir(),
  'AI-worker-second-original-workspace',
  'skills',
  'aiworker-task-flow',
  'scripts',
  'submit-task.mjs',
)

const SUBMIT_TIMEOUT_MS = 25_000
const STATUS_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 64 * 1_024

function executeFile(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rejectPromise(error)
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function parseSingleLineJson(stdout) {
  if (typeof stdout !== 'string') throw new Error('invalid_output')
  const trimmed = stdout.trim()
  if (!trimmed || trimmed.split(/\r?\n/u).length !== 1) throw new Error('invalid_output')

  let value
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error('invalid_output')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_output')
  }
  return value
}

function validateIdentityAndStatus(value, taskId) {
  if (value.taskId !== taskId) throw new Error('task_identity_mismatch')
  if (typeof value.status !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value.status)) {
    throw new Error('invalid_status')
  }
}

function isTimeoutError(error) {
  return error?.code === 'ETIMEDOUT' || error?.killed === true || error?.signal === 'SIGTERM'
}

export function createVideoTaskRunner({
  execute = executeFile,
  scriptPath = INSTALLED_SUBMIT_SCRIPT,
  nodePath = process.execPath,
} = {}) {
  if (!isAbsolute(scriptPath) || !isAbsolute(nodePath)) {
    throw new TypeError('runner paths must be absolute')
  }

  return async function runVideoTask({ videoPath, taskId }) {
    const submitArgs = [
      scriptPath,
      '--video-file', videoPath,
      '--task-id', taskId,
      '--idempotency-key', taskId,
      '--delivery', 'none',
      '--wait-seconds', '0',
    ]

    try {
      const result = await execute(nodePath, submitArgs, { timeout: SUBMIT_TIMEOUT_MS })
      const value = parseSingleLineJson(result.stdout)
      validateIdentityAndStatus(value, taskId)
      if (typeof value.duplicate !== 'boolean') throw new Error('invalid_duplicate')
      return { taskId, status: value.status, duplicate: value.duplicate }
    } catch (error) {
      if (!isTimeoutError(error)) throw new Error('submit_failed')

      try {
        const statusResult = await execute(
          nodePath,
          [scriptPath, '--status', taskId],
          { timeout: STATUS_TIMEOUT_MS },
        )
        const statusValue = parseSingleLineJson(statusResult.stdout)
        validateIdentityAndStatus(statusValue, taskId)
        return { taskId, status: statusValue.status, duplicate: true }
      } catch {
        throw new Error('status_unconfirmed')
      }
    }
  }
}

export const runVideoTask = createVideoTaskRunner()
