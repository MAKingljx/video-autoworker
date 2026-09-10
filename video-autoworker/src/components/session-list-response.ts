export const SESSION_READ_UNAVAILABLE_MESSAGE = '会话读取暂不可用'

export type SessionListResponse =
  | { available: true; sessions: unknown[] }
  | { available: false; message: string }

export function parseSessionListResponse(value: unknown): SessionListResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { available: false, message: SESSION_READ_UNAVAILABLE_MESSAGE }
  }
  const response = value as Record<string, unknown>
  if (response.available === true && Array.isArray(response.sessions)) {
    return { available: true, sessions: response.sessions }
  }
  return { available: false, message: SESSION_READ_UNAVAILABLE_MESSAGE }
}
