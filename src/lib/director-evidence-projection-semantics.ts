import { createHash } from 'node:crypto'

export const DIRECTOR_EVIDENCE_PROJECT_ID = 'PROJ-VIDEO-AUTOWORKER'
export const DIRECTOR_EVIDENCE_SOURCE_AUTHORITY = 'video-autoworker-final-result-v1'
export const DIRECTOR_EVIDENCE_TRANSFORM_SCHEMA_VERSION = 1
export const DIRECTOR_EVIDENCE_DELIVERY_RECEIPT_AUTHORITY =
  'video-autoworker-director-evidence-delivery-v1'

export const MAX_EVIDENCE_PROJECTION_ITEMS = 50
export const MAX_EVIDENCE_PROJECTION_INPUT_BYTES = 256 * 1024
export const MAX_TRANSFORMED_EVIDENCE_ITEMS = 241

export type DirectorEvidenceProjectionBatch = {
  workId: string
  items: Record<string, unknown>[]
}

export type DirectorEvidenceProjectionReceiptEntry = {
  stableId: string
  startSeconds: number
  endSeconds: number
}

export type DirectorEvidenceDeliveryReceipt = {
  authority: typeof DIRECTOR_EVIDENCE_DELIVERY_RECEIPT_AUTHORITY
  schemaVersion: 1
  projectId: typeof DIRECTOR_EVIDENCE_PROJECT_ID
  workId: string
  sourceIdentitySha256: string
  projectionSha256: string
  entries: DirectorEvidenceProjectionReceiptEntry[]
}

const STABLE_ID = /^[A-Za-z0-9._:-]{1,160}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const REQUIRED_EVIDENCE_IDENTITY_FIELDS = [
  '任务 ID', '素材 ID', '场景 ID', '镜头 ID', '起始时间码', '结束时间码',
  '分析版本', '校验摘要',
] as const
const EVIDENCE_IDENTITY_FIELDS = [
  '任务 ID', '批次 ID', '素材 ID', '场景 ID', '镜头 ID', '起始时间码', '结束时间码',
  '分析版本', '校验摘要',
] as const

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
    || result.projectId !== DIRECTOR_EVIDENCE_PROJECT_ID
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

function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2,}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value.trim())
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    + Number(String(match[4] || '').padEnd(3, '0') || 0) / 1000
}

function normalizedProjectionField(key: string, value: unknown): unknown {
  if (key !== '观察日期') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return value
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => (
      `${JSON.stringify(key)}:${canonical(object[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

function stableEvidenceId(workId: string, item: Record<string, unknown>): string {
  if (!STABLE_ID.test(workId)) throw new Error('director_evidence_projection_receipt_invalid')
  for (const field of REQUIRED_EVIDENCE_IDENTITY_FIELDS) {
    if (!Object.hasOwn(item, field)) {
      throw new Error('director_evidence_projection_receipt_invalid')
    }
  }
  return `DB-EVIDENCE-${digest({
    '作品 ID': workId,
    ...Object.fromEntries(EVIDENCE_IDENTITY_FIELDS
      .filter(field => Object.hasOwn(item, field))
      .map(field => [field, item[field]])),
  })}`
}

export function directorEvidenceRecordMatchesProjection(
  record: Record<string, unknown>,
  expectedFields: Record<string, unknown>,
  expectedWorkId: string,
): boolean {
  const fields = record.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false
  const actualFields = fields as Record<string, unknown>
  return actualFields['作品 ID'] === expectedWorkId
    && Object.entries(expectedFields).every(([key, expected]) => (
      Object.hasOwn(actualFields, key)
        && canonical(normalizedProjectionField(key, actualFields[key]))
          === canonical(normalizedProjectionField(key, expected))
    ))
}

function receiptBase(
  batches: DirectorEvidenceProjectionBatch[],
  sourceIdentitySha256: string,
): Omit<DirectorEvidenceDeliveryReceipt, 'entries'> {
  if (!SHA256.test(sourceIdentitySha256) || !batches.length
    || batches.some(batch => batch.workId !== batches[0].workId)) {
    throw new Error('director_evidence_projection_receipt_invalid')
  }
  return {
    authority: DIRECTOR_EVIDENCE_DELIVERY_RECEIPT_AUTHORITY,
    schemaVersion: 1,
    projectId: DIRECTOR_EVIDENCE_PROJECT_ID,
    workId: batches[0].workId,
    sourceIdentitySha256,
    projectionSha256: digest({
      workId: batches[0].workId,
      items: batches.flatMap(batch => batch.items),
    }),
  }
}

function expectedEntries(
  batches: DirectorEvidenceProjectionBatch[],
): Array<DirectorEvidenceProjectionReceiptEntry & { item: Record<string, unknown> }> {
  const entries: Array<DirectorEvidenceProjectionReceiptEntry & {
    item: Record<string, unknown>
  }> = []
  const observedStableIds = new Set<string>()
  for (const batch of batches) {
    for (const item of batch.items) {
      const stableId = stableEvidenceId(batch.workId, item)
      const startSeconds = parseClock(item['起始时间码'])
      const endSeconds = parseClock(item['结束时间码'])
      if (observedStableIds.has(stableId) || startSeconds === null || endSeconds === null
        || endSeconds <= startSeconds) {
        throw new Error('director_evidence_projection_receipt_invalid')
      }
      observedStableIds.add(stableId)
      entries.push({ stableId, startSeconds, endSeconds, item })
    }
  }
  if (!entries.length || entries.length > MAX_TRANSFORMED_EVIDENCE_ITEMS) {
    throw new Error('director_evidence_projection_receipt_invalid')
  }
  return entries
}

export function directorEvidenceExpectedReceiptEntries(
  batches: DirectorEvidenceProjectionBatch[],
): DirectorEvidenceProjectionReceiptEntry[] {
  return expectedEntries(batches).map(({ stableId, startSeconds, endSeconds }) => ({
    stableId,
    startSeconds,
    endSeconds,
  }))
}

export function directorEvidenceDeliveryReceipt(
  batches: DirectorEvidenceProjectionBatch[],
  results: Record<string, unknown>[],
  sourceIdentitySha256: string,
): DirectorEvidenceDeliveryReceipt {
  const base = receiptBase(batches, sourceIdentitySha256)
  const expected = expectedEntries(batches)
  if (results.length !== batches.length) {
    throw new Error('director_evidence_projection_receipt_invalid')
  }
  let ordinal = 0
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]
    const result = results[batchIndex]
    directorEvidenceProjectionResultCount(result, batch)
    if (!Array.isArray(result.results) || result.results.length !== batch.items.length) {
      throw new Error('director_evidence_projection_receipt_invalid')
    }
    let created = 0
    let unchanged = 0
    for (let index = 0; index < batch.items.length; index++) {
      const raw = result.results[index]
      const item = batch.items[index]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('director_evidence_projection_receipt_invalid')
      }
      const value = raw as Record<string, unknown>
      const stableId = String(value.stableId || '')
      const expectedEntry = expected[ordinal++]
      const outcome = value.outcome
      const record = value.record
      if (stableId !== expectedEntry.stableId
        || (outcome !== 'created' && outcome !== 'unchanged')
        || !record || typeof record !== 'object' || Array.isArray(record)
        || (record as Record<string, unknown>).table !== 'material_evidence'
        || (record as Record<string, unknown>).stableId !== stableId
        || !directorEvidenceRecordMatchesProjection(
          record as Record<string, unknown>, item, batch.workId,
        )) {
        throw new Error('director_evidence_projection_receipt_invalid')
      }
      if (outcome === 'created') created++
      else unchanged++
    }
    if (created !== result.created || unchanged !== result.unchanged) {
      throw new Error('director_evidence_projection_receipt_invalid')
    }
  }
  return {
    ...base,
    entries: expected.map(({ stableId, startSeconds, endSeconds }) => ({
      stableId, startSeconds, endSeconds,
    })),
  }
}

export function directorEvidenceVerifiedReadReceipt(
  batches: DirectorEvidenceProjectionBatch[],
  records: Record<string, unknown>[],
  sourceIdentitySha256: string,
): DirectorEvidenceDeliveryReceipt {
  const base = receiptBase(batches, sourceIdentitySha256)
  const expected = expectedEntries(batches)
  const expectedByStableId = new Map(expected.map(entry => [entry.stableId, entry]))
  const observed = new Set<string>()
  for (const record of records) {
    const stableId = String(record.stableId || '')
    const entry = expectedByStableId.get(stableId)
    if (!entry || observed.has(stableId)
      || record.table !== 'material_evidence'
      || !directorEvidenceRecordMatchesProjection(record, entry.item, base.workId)) {
      throw new Error('director_evidence_projection_recovery_conflict')
    }
    observed.add(stableId)
  }
  if (observed.size !== expected.length) {
    throw new Error('director_evidence_projection_recovery_conflict')
  }
  return {
    ...base,
    entries: expected.map(({ stableId, startSeconds, endSeconds }) => ({
      stableId, startSeconds, endSeconds,
    })),
  }
}

export function parseDirectorEvidenceDeliveryReceipt(
  value: unknown,
): DirectorEvidenceDeliveryReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).sort().join(',')
      !== 'authority,entries,projectId,projectionSha256,schemaVersion,sourceIdentitySha256,workId'
    || candidate.authority !== DIRECTOR_EVIDENCE_DELIVERY_RECEIPT_AUTHORITY
    || candidate.schemaVersion !== 1
    || candidate.projectId !== DIRECTOR_EVIDENCE_PROJECT_ID
    || typeof candidate.workId !== 'string' || !STABLE_ID.test(candidate.workId)
    || typeof candidate.sourceIdentitySha256 !== 'string'
    || !SHA256.test(candidate.sourceIdentitySha256)
    || typeof candidate.projectionSha256 !== 'string' || !SHA256.test(candidate.projectionSha256)
    || !Array.isArray(candidate.entries)
    || candidate.entries.length < 1
    || candidate.entries.length > MAX_TRANSFORMED_EVIDENCE_ITEMS) return null
  const observed = new Set<string>()
  const entries: DirectorEvidenceProjectionReceiptEntry[] = []
  for (const raw of candidate.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const entry = raw as Record<string, unknown>
    const stableId = String(entry.stableId || '')
    const startSeconds = entry.startSeconds
    const endSeconds = entry.endSeconds
    if (Object.keys(entry).sort().join(',') !== 'endSeconds,stableId,startSeconds'
      || !STABLE_ID.test(stableId) || observed.has(stableId)
      || typeof startSeconds !== 'number' || !Number.isFinite(startSeconds)
      || typeof endSeconds !== 'number' || !Number.isFinite(endSeconds)
      || startSeconds < 0 || endSeconds <= startSeconds) return null
    observed.add(stableId)
    entries.push({ stableId, startSeconds, endSeconds })
  }
  return {
    authority: DIRECTOR_EVIDENCE_DELIVERY_RECEIPT_AUTHORITY,
    schemaVersion: 1,
    projectId: DIRECTOR_EVIDENCE_PROJECT_ID,
    workId: candidate.workId,
    sourceIdentitySha256: candidate.sourceIdentitySha256,
    projectionSha256: candidate.projectionSha256,
    entries,
  }
}
