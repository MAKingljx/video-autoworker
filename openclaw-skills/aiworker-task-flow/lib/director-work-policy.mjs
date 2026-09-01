export const MAX_DIRECTOR_WORK_LENGTH = 240

export function isDirectorWork(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= MAX_DIRECTOR_WORK_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function assertOptionalDirectorWork(
  value,
  message = 'director_work_invalid',
) {
  if (value === undefined || value === null) return value
  if (!isDirectorWork(value)) throw new Error(message)
  return value
}
