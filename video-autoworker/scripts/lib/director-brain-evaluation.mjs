const KINDS = Object.freeze([
  'people_profile',
  'story_node',
  'story_relation',
  'material_judgment',
  'narrative_plan',
  'director_case',
  'skill_technique',
])

const KIND_SET = new Set(KINDS)
const DEFAULT_THRESHOLDS = Object.freeze({
  precision: 0.8,
  recall: 0.7,
  evidenceCoverage: 1,
  brokenReferenceRate: 0,
  hallucinationRate: 0.1,
  duplicateRate: 0.05,
})

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_must_be_object`)
  }
  return value
}

function text(value, label, maximum = 180) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label}_invalid`)
  }
  return value
}

function uniqueTextList(value, label, { required = false, maximum = 100 } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (required && value.length === 0)) {
    throw new Error(`${label}_invalid`)
  }
  const normalized = value.map((item, index) => text(item, `${label}_${index}`))
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}_duplicate`)
  return normalized
}

function deduplicatedTextList(value, label, { required = false, maximum = 100 } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (required && value.length === 0)) {
    throw new Error(`${label}_invalid`)
  }
  return [...new Set(value.map((item, index) => text(item, `${label}_${index}`)))]
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6))
}

function f1(precision, recall) {
  if (precision === null || recall === null) return null
  if (precision + recall === 0) return 0
  return Number(((2 * precision * recall) / (precision + recall)).toFixed(6))
}

function sameTextSet(left, right) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === rightSet.size && [...leftSet].every(value => rightSet.has(value))
}

function normalizeThresholds(value) {
  if (value === undefined) return { ...DEFAULT_THRESHOLDS }
  const supplied = object(value, 'thresholds')
  const extra = Object.keys(supplied).filter(key => !Object.hasOwn(DEFAULT_THRESHOLDS, key))
  if (extra.length) throw new Error(`threshold_unknown:${extra.join(',')}`)
  const normalized = { ...DEFAULT_THRESHOLDS }
  for (const [name, raw] of Object.entries(supplied)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw new Error(`threshold_invalid:${name}`)
    }
    normalized[name] = raw
  }
  return normalized
}

function normalizeGoldItem(value, index, reviewedEvidenceIds) {
  const item = object(value, `gold_${index}`)
  const allowed = new Set(['goldId', 'kind', 'evidenceIds'])
  const extra = Object.keys(item).filter(key => !allowed.has(key))
  if (extra.length) throw new Error(`gold_field_unknown:${extra.join(',')}`)
  const goldId = text(item.goldId, `gold_${index}_id`)
  const kind = text(item.kind, `gold_${index}_kind`, 64)
  if (!KIND_SET.has(kind)) throw new Error(`gold_kind_invalid:${kind}`)
  const evidenceIds = deduplicatedTextList(
    item.evidenceIds,
    `gold_${index}_evidence`,
    { required: true },
  )
  if (evidenceIds.some(id => !reviewedEvidenceIds.has(id))) {
    throw new Error(`gold_evidence_not_reviewed:${goldId}`)
  }
  return { goldId, kind, evidenceIds }
}

function normalizePrediction(value, index) {
  const item = object(value, `prediction_${index}`)
  const allowed = new Set([
    'candidateId',
    'kind',
    'evidenceIds',
    'matchedGoldId',
    'accepted',
  ])
  const extra = Object.keys(item).filter(key => !allowed.has(key))
  if (extra.length) throw new Error(`prediction_field_unknown:${extra.join(',')}`)
  const candidateId = text(item.candidateId, `prediction_${index}_id`)
  const kind = text(item.kind, `prediction_${index}_kind`, 64)
  if (!KIND_SET.has(kind)) throw new Error(`prediction_kind_invalid:${kind}`)
  const evidenceIds = deduplicatedTextList(item.evidenceIds, `prediction_${index}_evidence`)
  const matchedGoldId = item.matchedGoldId === undefined || item.matchedGoldId === null
    ? null
    : text(item.matchedGoldId, `prediction_${index}_matched_gold`)
  if (item.accepted !== undefined && typeof item.accepted !== 'boolean') {
    throw new Error(`prediction_${index}_accepted_invalid`)
  }
  return {
    candidateId,
    kind,
    evidenceIds,
    matchedGoldId,
    accepted: item.accepted,
  }
}

function emptyKindMetrics(kind) {
  return {
    kind,
    gold: 0,
    predictions: 0,
    truePositives: 0,
    precision: null,
    recall: null,
    f1: null,
  }
}

export function evaluateDirectorBrainCandidates(inputValue) {
  const input = object(inputValue, 'evaluation')
  const allowed = new Set([
    'schemaVersion',
    'projectId',
    'workId',
    'reviewedEvidenceIds',
    'gold',
    'predictions',
    'thresholds',
  ])
  const extra = Object.keys(input).filter(key => !allowed.has(key))
  if (extra.length) throw new Error(`evaluation_field_unknown:${extra.join(',')}`)
  if (input.schemaVersion !== 1) throw new Error('evaluation_schema_version_invalid')
  const projectId = text(input.projectId, 'project_id')
  const workId = text(input.workId, 'work_id')
  const reviewedEvidence = uniqueTextList(
    input.reviewedEvidenceIds,
    'reviewed_evidence',
    { required: true, maximum: 10_000 },
  )
  const reviewedEvidenceIds = new Set(reviewedEvidence)
  if (!Array.isArray(input.gold) || !Array.isArray(input.predictions)) {
    throw new Error('evaluation_items_invalid')
  }
  if (input.gold.length > 10_000 || input.predictions.length > 10_000) {
    throw new Error('evaluation_items_too_many')
  }
  const gold = input.gold.map((item, index) => normalizeGoldItem(item, index, reviewedEvidenceIds))
  const predictions = input.predictions.map((item, index) => normalizePrediction(item, index))
  const thresholds = normalizeThresholds(input.thresholds)

  const goldById = new Map()
  for (const item of gold) {
    if (goldById.has(item.goldId)) throw new Error(`gold_id_duplicate:${item.goldId}`)
    goldById.set(item.goldId, item)
  }
  const candidateIds = new Set()
  for (const item of predictions) {
    if (candidateIds.has(item.candidateId)) throw new Error(`candidate_id_duplicate:${item.candidateId}`)
    candidateIds.add(item.candidateId)
  }

  const validMatches = []
  const matchedGoldCounts = new Map()
  let brokenReferences = 0
  let evidenceBacked = 0
  let hallucinations = 0
  for (const prediction of predictions) {
    const referencesValid = prediction.evidenceIds.length > 0
      && prediction.evidenceIds.every(id => reviewedEvidenceIds.has(id))
    if (referencesValid) evidenceBacked += 1
    else brokenReferences += 1

    const goldItem = prediction.matchedGoldId ? goldById.get(prediction.matchedGoldId) : null
    const evidenceAgrees = Boolean(
      goldItem && sameTextSet(prediction.evidenceIds, goldItem.evidenceIds),
    )
    const validMatch = Boolean(
      goldItem && goldItem.kind === prediction.kind && referencesValid && evidenceAgrees,
    )
    if (validMatch) {
      validMatches.push(prediction)
      matchedGoldCounts.set(
        prediction.matchedGoldId,
        (matchedGoldCounts.get(prediction.matchedGoldId) || 0) + 1,
      )
    } else {
      hallucinations += 1
    }
  }

  const truePositiveGoldIds = new Set(validMatches.map(item => item.matchedGoldId))
  const duplicateMatches = [...matchedGoldCounts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0)
  const precision = ratio(truePositiveGoldIds.size, predictions.length)
  const recall = ratio(truePositiveGoldIds.size, gold.length)
  const evidenceCoverage = ratio(evidenceBacked, predictions.length)
  const brokenReferenceRate = ratio(brokenReferences, predictions.length)
  const hallucinationRate = ratio(hallucinations, predictions.length)
  const duplicateRate = ratio(duplicateMatches, predictions.length)
  const reviewedPredictions = predictions.filter(item => item.accepted !== undefined)
  const humanAcceptanceRate = ratio(
    reviewedPredictions.filter(item => item.accepted === true).length,
    reviewedPredictions.length,
  )

  const byKind = Object.fromEntries(KINDS.map(kind => {
    const metrics = emptyKindMetrics(kind)
    const kindGoldIds = new Set(gold.filter(item => item.kind === kind).map(item => item.goldId))
    const kindPredictions = predictions.filter(item => item.kind === kind)
    const kindTruePositiveIds = new Set(
      validMatches
        .filter(item => item.kind === kind && kindGoldIds.has(item.matchedGoldId))
        .map(item => item.matchedGoldId),
    )
    metrics.gold = kindGoldIds.size
    metrics.predictions = kindPredictions.length
    metrics.truePositives = kindTruePositiveIds.size
    metrics.precision = ratio(kindTruePositiveIds.size, kindPredictions.length)
    metrics.recall = ratio(kindTruePositiveIds.size, kindGoldIds.size)
    metrics.f1 = f1(metrics.precision, metrics.recall)
    return [kind, metrics]
  }))

  const observed = {
    precision,
    recall,
    evidenceCoverage,
    brokenReferenceRate,
    hallucinationRate,
    duplicateRate,
  }
  const checks = {
    precision: precision !== null && precision >= thresholds.precision,
    recall: recall !== null && recall >= thresholds.recall,
    evidenceCoverage: evidenceCoverage !== null
      && evidenceCoverage >= thresholds.evidenceCoverage,
    brokenReferenceRate: brokenReferenceRate !== null
      && brokenReferenceRate <= thresholds.brokenReferenceRate,
    hallucinationRate: hallucinationRate !== null
      && hallucinationRate <= thresholds.hallucinationRate,
    duplicateRate: duplicateRate !== null && duplicateRate <= thresholds.duplicateRate,
  }

  return {
    ok: true,
    schemaVersion: 1,
    projectId,
    workId,
    counts: {
      reviewedEvidence: reviewedEvidenceIds.size,
      gold: gold.length,
      predictions: predictions.length,
      truePositives: truePositiveGoldIds.size,
      brokenReferences,
      hallucinations,
      duplicateMatches,
      humanReviewed: reviewedPredictions.length,
    },
    metrics: {
      ...observed,
      f1: f1(precision, recall),
      humanAcceptanceRate,
      byKind,
    },
    gate: {
      pass: Object.values(checks).every(Boolean),
      thresholds,
      checks,
    },
  }
}

export const DIRECTOR_BRAIN_EVALUATION_KINDS = KINDS
export const DIRECTOR_BRAIN_DEFAULT_THRESHOLDS = DEFAULT_THRESHOLDS
