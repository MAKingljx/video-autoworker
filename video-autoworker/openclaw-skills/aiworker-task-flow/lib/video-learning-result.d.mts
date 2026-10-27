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
export declare const VIDEO_LEARNING_RESULT_SCHEMA: 'aiworker-video-learning-result/v1'
export declare function buildVideoLearningResult(totalSegments: number, failures: VideoLearningFailure[]): VideoLearningResult
export declare function readVideoLearningResult(output: unknown): VideoLearningResult | null
export declare function hasPartialVideoLearning(output: unknown): boolean
export declare function videoLearningDisplayState(status: string, output: unknown): string
export declare function videoLearningSummary(output: unknown): string | null
