import { isAbsolute } from 'node:path'

import { INSTALLED_SUBMIT_SCRIPT } from './runner.js'
import { executeFile, parseSingleLineJson } from './json-command.js'
import { isVideoTaskId } from './video-task-id.js'
import { normalizeVideoStatusResult } from './video-status-result.js'

const STATUS_TIMEOUT_MS = 15_000

export function createVideoStatusRunner({
  execute = executeFile,
  scriptPath = INSTALLED_SUBMIT_SCRIPT,
  nodePath = process.execPath,
} = {}) {
  if (!isAbsolute(scriptPath) || !isAbsolute(nodePath)) {
    throw new TypeError('runner paths must be absolute')
  }

  return async function runVideoStatus({ taskId }) {
    if (!isVideoTaskId(taskId)) throw new Error('status_failed')
    try {
      const result = await execute(
        nodePath,
        [scriptPath, '--status', taskId],
        { timeout: STATUS_TIMEOUT_MS },
      )
      const value = parseSingleLineJson(result.stdout)
      return normalizeVideoStatusResult(value, taskId)
    } catch {
      throw new Error('status_failed')
    }
  }
}

export const runVideoStatus = createVideoStatusRunner()
