export const MAX_DIRECTOR_WORK_LENGTH = 240

export function isValidDirectorWork(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= MAX_DIRECTOR_WORK_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
