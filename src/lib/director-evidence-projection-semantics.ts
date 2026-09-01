export const DIRECTOR_EVIDENCE_PROJECT_ID = 'PROJ-VIDEO-AUTOWORKER'
export const DIRECTOR_EVIDENCE_SOURCE_AUTHORITY = 'video-autoworker-final-result-v1'
export const DIRECTOR_EVIDENCE_TRANSFORM_SCHEMA_VERSION = 1

export const MAX_EVIDENCE_PROJECTION_ITEMS = 50
export const MAX_EVIDENCE_PROJECTION_INPUT_BYTES = 256 * 1024
export const MAX_TRANSFORMED_EVIDENCE_ITEMS = 241

export type DirectorEvidenceProjectionBatch = {
  workId: string
  items: Record<string, unknown>[]
}

export function directorEvidenceTransformEnvelope(
  item: { taskId: string; workId: string },
  output: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: DIRECTOR_EVIDENCE_TRANSFORM_SCHEMA_VERSION,
    projectId: DIRECTOR_EVIDENCE_PROJECT_ID,
    workId: item.workId,
    taskId: item.taskId,
    materialId: output.materialId,
    mediaDurationSeconds: output.mediaDurationSeconds,
    analysisVersion: output.analysisVersion,
    status: 'succeeded',
    taskType: output.taskType,
    sourceAuthority: DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
    output,
  }
}

function projectionRequestBytes(value: DirectorEvidenceProjectionBatch): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8')
}

export function directorEvidenceProjectionBatches(
  projection: Record<string, unknown>,
  expectedWorkId: string,
): DirectorEvidenceProjectionBatch[] {
  if (Object.keys(projection).sort().join(',') !== 'items,workId'
    || projection.workId !== expectedWorkId
    || !Array.isArray(projection.items)
    || projection.items.length < 1
    || projection.items.length > MAX_TRANSFORMED_EVIDENCE_ITEMS
    || projection.items.some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('director_evidence_projection_payload_invalid')
  }

  const batches: DirectorEvidenceProjectionBatch[] = []
  let items: Record<string, unknown>[] = []
  for (const value of projection.items as Record<string, unknown>[]) {
    const candidate = [...items, value]
    const request = { workId: expectedWorkId, items: candidate }
    if (candidate.length > MAX_EVIDENCE_PROJECTION_ITEMS
      || projectionRequestBytes(request) > MAX_EVIDENCE_PROJECTION_INPUT_BYTES) {
      if (items.length === 0) throw new Error('director_evidence_projection_item_too_large')
      batches.push({ workId: expectedWorkId, items })
      items = [value]
      if (projectionRequestBytes({ workId: expectedWorkId, items })
        > MAX_EVIDENCE_PROJECTION_INPUT_BYTES) {
        throw new Error('director_evidence_projection_item_too_large')
      }
    } else {
      items = candidate
    }
  }
  if (items.length > 0) batches.push({ workId: expectedWorkId, items })
  return batches
}

export function directorEvidenceProjectionResultCount(
  result: Record<string, unknown>,
  batch: DirectorEvidenceProjectionBatch,
): number {
  if (result.ok !== true || result.action !== 'project-evidence'
    || result.workId !== batch.workId
    || typeof result.count !== 'number' || !Number.isSafeInteger(result.count)
    || result.count !== batch.items.length
    || typeof result.created !== 'number' || !Number.isSafeInteger(result.created)
    || result.created < 0 || result.created > result.count
    || typeof result.unchanged !== 'number' || !Number.isSafeInteger(result.unchanged)
    || result.unchanged < 0 || result.unchanged > result.count
    || result.created + result.unchanged !== result.count) {
    throw new Error('director_evidence_projection_result_invalid')
  }
  return result.count
}
