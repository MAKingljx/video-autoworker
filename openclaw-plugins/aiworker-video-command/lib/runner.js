import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { normalizeVideoTaskResult } from './video-task-result.js'

export const INSTALLED_SUBMIT_SCRIPT = resolve(
  homedir(),
  'AI-worker-second-original-workspace',
  'skills',
  'aiworker-task-flow',
  'scripts',
  'submit-task.mjs',
)

const SUBMIT_TIMEOUT_MS = 25_000
const MAX_OUTPUT_BYTES = 64 * 1_024
const VIDEO_TRIGGER_UNCONFIRMED_EXIT_CODE = 75

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

function isTimeoutError(error) {
  return error?.code === 'ETIMEDOUT' || error?.killed === true || error?.signal === 'SIGTERM'
}

function isUnconfirmedSubmitError(error) {
  return isTimeoutError(error) || Number(error?.code) === VIDEO_TRIGGER_UNCONFIRMED_EXIT_CODE
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
      '--no-trigger-recovery',
    ]

    try {
      const result = await execute(nodePath, submitArgs, { timeout: SUBMIT_TIMEOUT_MS })
      const value = parseSingleLineJson(result.stdout)
      return normalizeVideoTaskResult(value, taskId)
    } catch (error) {
      if (isUnconfirmedSubmitError(error)) throw new Error('submit_unconfirmed')
      throw new Error('submit_failed')
    }
  }
}

export const runVideoTask = createVideoTaskRunner()
