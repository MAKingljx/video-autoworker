export interface VideoLearningFailure {
  index: number
  timeRange: string
  stage: 'vision' | 'summary'
  errorCode: string
}
export interface VideoLearningResult {
  schema: 'aiworker-video-learning-result/v1'
  status: 'complete' | 'partial'
  totalSegments: number
  completedSegments: number
  failedSegments: VideoLearningFailure[]
}
export const VIDEO_LEARNING_RESULT_SCHEMA: 'aiworker-video-learning-result/v1'
export function buildVideoLearningResult(totalSegments: number, failures: VideoLearningFailure[]): VideoLearningResult
export function readVideoLearningResult(output: unknown): VideoLearningResult | null
export function hasPartialVideoLearning(output: unknown): boolean
export function videoLearningDisplayState(status: string, output: unknown): string
export function videoLearningSummary(output: unknown): string | null
