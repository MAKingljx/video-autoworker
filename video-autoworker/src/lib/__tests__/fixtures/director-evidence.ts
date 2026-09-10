import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  directorEvidenceSourceIdentityDigest,
  persistRecoveredDirectorEvidenceProjectionReceiptCore,
  type DirectorEvidenceOutbox,
} from '@/lib/director-evidence-delivery-core'
import {
  DIRECTOR_EVIDENCE_PROJECT_ID,
  directorEvidenceDeliveryReceipt,
  directorEvidenceExpectedReceiptEntries,
  directorEvidenceProjectionBatches,
} from '@/lib/director-evidence-projection-semantics'

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}.000`
}

export function directorEvidenceFixtureItem(
  index = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    '证据名称': `可核验视频证据 ${index}`,
    '任务 ID': 'video-fixture-task',
    '素材 ID': 'MATERIAL-FIXTURE-001',
    '场景 ID': `SCENE-FIXTURE-${String(index).padStart(3, '0')}`,
    '镜头 ID': `SHOT-FIXTURE-${String(index).padStart(3, '0')}`,
    '起始时间码': clock(index - 1),
    '结束时间码': clock(index),
    '证据摘要': '人物进入环境后改变了判断。',
    '分析版本': 'video-analysis-v3',
    '校验摘要': createHash('sha256')
      .update(`director-evidence-fixture:${index}`, 'utf8')
      .digest('hex'),
    '置信度': 0.9,
    ...overrides,
  }
}

export function directorEvidenceFixtureProjectionResult(
  input: Record<string, unknown>,
  options: { outcome?: 'created' | 'unchanged' } = {},
): Record<string, unknown> {
  const workId = String(input.workId || '')
  const items = Array.isArray(input.items)
    ? input.items as Record<string, unknown>[]
    : []
  const batches = directorEvidenceProjectionBatches({ workId, items }, workId)
  if (batches.length !== 1) throw new Error('fixture_projection_batch_invalid')
  const entries = directorEvidenceExpectedReceiptEntries(batches)
  const outcome = options.outcome || 'created'
  return {
    ok: true,
    action: 'project-evidence',
    projectId: DIRECTOR_EVIDENCE_PROJECT_ID,
    workId,
    count: items.length,
    created: outcome === 'created' ? items.length : 0,
    unchanged: outcome === 'unchanged' ? items.length : 0,
    results: items.map((item, index) => ({
      stableId: entries[index].stableId,
      outcome,
      record: {
        table: 'material_evidence',
        stableId: entries[index].stableId,
        state: '候选',
        reviewed: false,
        fields: { ...item, '作品 ID': workId },
      },
    })),
  }
}

export function persistDirectorEvidenceFixtureReceipt(
  db: Database.Database,
  outbox: DirectorEvidenceOutbox,
  items: Record<string, unknown>[],
  nowSeconds = 100,
) {
  const projection = { workId: outbox.workId, items }
  const batches = directorEvidenceProjectionBatches(projection, outbox.workId)
  const results = batches.map(batch => directorEvidenceFixtureProjectionResult(batch))
  const receipt = directorEvidenceDeliveryReceipt(
    batches,
    results,
    directorEvidenceSourceIdentityDigest(outbox),
  )
  return persistRecoveredDirectorEvidenceProjectionReceiptCore(
    db,
    outbox,
    receipt,
    nowSeconds,
  )
}
