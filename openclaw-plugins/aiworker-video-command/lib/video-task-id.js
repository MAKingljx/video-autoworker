export const VIDEO_TASK_ID_PATTERN = /^(?:video-command|video-natural)-[a-f0-9]{64}$/u

export function isVideoTaskId(value) {
  return typeof value === 'string' && VIDEO_TASK_ID_PATTERN.test(value)
}
