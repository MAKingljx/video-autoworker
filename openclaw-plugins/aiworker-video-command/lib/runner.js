import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { executeFile, parseSingleLineJson } from './json-command.js'
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
const VIDEO_TRIGGER_UNCONFIRMED_EXIT_CODE = 75

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
