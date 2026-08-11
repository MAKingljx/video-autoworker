import { execFile } from 'node:child_process'

const MAX_OUTPUT_BYTES = 64 * 1_024

export function executeFile(file, args, options) {
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

export function parseSingleLineJson(stdout) {
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
