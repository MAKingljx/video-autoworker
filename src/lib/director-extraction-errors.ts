const ERROR_CODE_PATTERN = /^[A-Za-z0-9_:-]{1,200}$/u
const DETERMINISTIC_SIZE_CONFLICTS = new Set([
  'director_extraction_learning_context_budget_exceeded',
  'director_extraction_output_too_large',
  'director_extraction_phase_input_too_large',
  'director_extraction_projection_input_too_large',
  'director_extraction_seed_too_large',
  'learning_context_output_too_large',
  'learning_context_request_budget_exceeded',
])

export type DirectorExtractionHttpFailure = {
  code: string
  status: number
  message: string
}

const PUBLIC_FAILURES: Readonly<Record<string, Omit<DirectorExtractionHttpFailure, 'code'>>> = {
  director_extraction_source_not_found: {
    status: 404,
    message: '没有找到这部作品已完成的视频分析',
  },
  director_extraction_source_ambiguous: {
    status: 409,
    message: '匹配到多个视频结果，请补充更准确的作品名或集数',
  },
  director_extraction_source_not_ready: {
    status: 409,
    message: '视频分析还没有完成，请稍后再试',
  },
  director_extraction_source_contract_invalid: {
    status: 409,
    message: '视频分析结果暂时不能用于导演知识整理',
  },
  director_extraction_work_not_reviewed: {
    status: 409,
    message: '作品尚未完成登记或审核',
  },
  director_extraction_work_not_registered: {
    status: 409,
    message: '视频尚未保存可信的作品绑定，请重新完成作品解析',
  },
  director_extraction_work_binding_conflict: {
    status: 409,
    message: '视频与作品绑定不一致，已停止',
  },
  director_extraction_source_conflict: {
    status: 409,
    message: '视频分析结果已变化，已停止提炼',
  },
  director_extraction_objective_conflict: {
    status: 409,
    message: '这次整理目标与已经开始的整理不一致',
  },
  director_extraction_review_references_invalid: {
    status: 409,
    message: '本阶段缺少已复核的上层内容',
  },
  director_extraction_reference_not_reviewed: {
    status: 409,
    message: '上层内容尚未完成复核',
  },
  director_extraction_review_not_expected: {
    status: 409,
    message: '当前阶段不需要提交复核结果',
  },
  director_extraction_review_conflict: {
    status: 409,
    message: '复核结果与已保存状态不一致',
  },
}

export function safeDirectorExtractionErrorCode(
  error: unknown,
  fallback = 'director_extraction_failed',
): string {
  const message = error instanceof Error ? error.message : ''
  return ERROR_CODE_PATTERN.test(message) ? message : fallback
}

export function directorExtractionHttpFailure(error: unknown): DirectorExtractionHttpFailure {
  const observedCode = safeDirectorExtractionErrorCode(error)
  const failure = PUBLIC_FAILURES[observedCode]
  if (failure) return { code: observedCode, ...failure }
  return {
    code: 'director_extraction_unavailable',
    status: 503,
    message: '导演知识提炼暂时不可用，请稍后重试',
  }
}

export function isDirectorExtractionDeterministicConflict(code: string): boolean {
  return DETERMINISTIC_SIZE_CONFLICTS.has(code)
    || /(?:source|binding|contract|checkpoint|projection|authority|evidence_reference|reviewed_(?:cases|reference|candidate)|candidate_|learning_reference|previous_version|previous_entity|technique_reference)/u
    .test(code)
}
