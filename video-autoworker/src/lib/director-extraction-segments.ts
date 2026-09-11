import type Database from 'better-sqlite3'
import {
  DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES,
} from '@/lib/director-extraction-learning'
import {
  directorExtractionDigest,
  parseDirectorExtractionOutput,
  type DirectorExtractionCandidateOutput,
  type DirectorExtractionPhase,
} from '@/lib/director-extraction-state'
import { ensureDirectorMaintainabilitySchema } from '@/lib/director-maintainability-schema'

export interface DirectorExtractionSegment {
  phaseTaskId: string
  index: number
  count: number
  input: Record<string, unknown>
  inputSha256: string
  output: DirectorExtractionCandidateOutput | null
  outputSha256: string | null
  status: 'pending' | 'completed'
  updatedAt: number
}

function parseSegmentOutput(
  phase: DirectorExtractionPhase,
  value: unknown,
): DirectorExtractionCandidateOutput {
  if (phase !== 'perception' && value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>
    if (candidate.schemaVersion === 1 && candidate.phase === phase
      && Array.isArray(candidate.candidates) && candidate.candidates.length === 0
      && Object.keys(candidate).sort().join(',') === 'candidates,phase,schemaVersion') {
      return Object.freeze({ schemaVersion: 1, phase, candidates: [] }) as DirectorExtractionCandidateOutput
    }
  }
  return parseDirectorExtractionOutput(phase, value)
}

function segmentInput(
  phase: DirectorExtractionPhase,
  input: Record<string, unknown>,
  index: number,
  count: number,
): Record<string, unknown> {
  const value = {
    ...input,
    segment: { schemaVersion: 1, phase, index, count },
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES) {
    throw new Error('director_extraction_segment_input_too_large')
  }
  return value
}

export function splitDirectorExtractionPhaseInput(
  input: Record<string, unknown>,
): Record<string, unknown>[] {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') <= DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES) {
    return [input]
  }
  const evidence = input.evidence
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('director_extraction_segment_source_invalid')
  }
  const source = evidence as Record<string, unknown>
  const units = [
    ...(Array.isArray(source.timeline)
      ? source.timeline.map(value => ({ field: 'timeline' as const, value })) : []),
    ...(Array.isArray(source.chapters)
      ? source.chapters.map(value => ({ field: 'chapters' as const, value })) : []),
  ]
  if (!units.length) throw new Error('director_extraction_segment_source_empty')
  const baseEvidence: Record<string, unknown> = { ...source, timeline: [], chapters: [] }
  delete baseEvidence.directorPerception
  const segments: Record<string, unknown>[] = []
  let current: Record<string, unknown> & { timeline: unknown[]; chapters: unknown[] } = {
    ...baseEvidence, timeline: [], chapters: [],
  }
  const emit = () => {
    if (!current.timeline.length && !current.chapters.length) return
    segments.push({ ...input, evidence: current })
    current = { ...baseEvidence, timeline: [], chapters: [] }
  }
  for (const unit of units) {
    current[unit.field].push(unit.value)
    const candidate = { ...input, evidence: current }
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8')
      > DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES) {
      current[unit.field].pop()
      emit()
      current[unit.field].push(unit.value)
      if (Buffer.byteLength(JSON.stringify({ ...input, evidence: current }), 'utf8')
        > DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES) {
        throw new Error('director_extraction_segment_unit_too_large')
      }
    }
  }
  emit()
  if (source.directorPerception !== undefined) {
    const first = segments[0]
    const withPerception = {
      ...first,
      evidence: {
        ...(first.evidence as Record<string, unknown>),
        directorPerception: source.directorPerception,
      },
    }
    if (Buffer.byteLength(JSON.stringify(withPerception), 'utf8')
      <= DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES) {
      segments[0] = withPerception
    } else {
      const perceptionOnly = {
        ...input,
        evidence: {
          ...baseEvidence,
          timeline: [],
          chapters: [],
          directorPerception: source.directorPerception,
        },
      }
      if (Buffer.byteLength(JSON.stringify(perceptionOnly), 'utf8')
        > DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES) {
        throw new Error('director_extraction_segment_unit_too_large')
      }
      segments.unshift(perceptionOnly)
    }
  }
  return segments
}

export function planDirectorExtractionSegments(
  phase: DirectorExtractionPhase,
  inputs: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  if (!inputs.length || inputs.length > 256) throw new Error('director_extraction_segment_count_invalid')
  return inputs.map((input, index) => segmentInput(phase, input, index, inputs.length))
}

export function ensureDirectorExtractionSegments(
  db: Database.Database,
  phaseTaskId: string,
  phase: DirectorExtractionPhase,
  inputs: readonly Record<string, unknown>[],
  nowSeconds = Math.floor(Date.now() / 1_000),
): DirectorExtractionSegment[] {
  ensureDirectorMaintainabilitySchema(db)
  const planned = planDirectorExtractionSegments(phase, inputs)
  db.transaction(() => {
    const existing = db.prepare(`
      SELECT segment_index, segment_count, input_sha256, phase_input
      FROM director_extraction_segments WHERE phase_task_id = ? ORDER BY segment_index
    `).all(phaseTaskId) as Array<{
      segment_index: number; segment_count: number; input_sha256: string; phase_input: string
    }>
    if (existing.length) {
      if (existing.length !== planned.length || existing.some((row, index) => (
        row.segment_index !== index || row.segment_count !== planned.length
        || row.input_sha256 !== directorExtractionDigest(planned[index])
        || row.phase_input !== JSON.stringify(planned[index])
      ))) throw new Error('director_extraction_segment_plan_conflict')
      return
    }
    const insert = db.prepare(`
      INSERT INTO director_extraction_segments (
        phase_task_id, segment_index, segment_count, input_sha256, phase_input,
        output_sha256, candidate_output, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?)
    `)
    planned.forEach((input, index) => insert.run(
      phaseTaskId, index, planned.length, directorExtractionDigest(input),
      JSON.stringify(input), nowSeconds, nowSeconds,
    ))
  }).immediate()
  return listDirectorExtractionSegments(db, phaseTaskId, phase)
}

export function listDirectorExtractionSegments(
  db: Database.Database,
  phaseTaskId: string,
  phase: DirectorExtractionPhase,
): DirectorExtractionSegment[] {
  ensureDirectorMaintainabilitySchema(db)
  const rows = db.prepare(`
    SELECT * FROM director_extraction_segments WHERE phase_task_id = ? ORDER BY segment_index
  `).all(phaseTaskId) as Array<Record<string, unknown>>
  return rows.map(row => {
    const input = JSON.parse(String(row.phase_input)) as Record<string, unknown>
    const output = row.candidate_output === null
      ? null
      : parseSegmentOutput(phase, JSON.parse(String(row.candidate_output)))
    if (row.input_sha256 !== directorExtractionDigest(input)
      || (output && row.output_sha256 !== directorExtractionDigest(output))) {
      throw new Error('director_extraction_segment_invalid')
    }
    return {
      phaseTaskId,
      index: Number(row.segment_index),
      count: Number(row.segment_count),
      input,
      inputSha256: String(row.input_sha256),
      output,
      outputSha256: row.output_sha256 === null ? null : String(row.output_sha256),
      status: row.status as 'pending' | 'completed',
      updatedAt: Number(row.updated_at),
    }
  })
}

export function completeDirectorExtractionSegment(
  db: Database.Database,
  phaseTaskId: string,
  phase: DirectorExtractionPhase,
  index: number,
  outputValue: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
): DirectorExtractionSegment[] {
  ensureDirectorMaintainabilitySchema(db)
  const output = parseSegmentOutput(phase, outputValue)
  const encoded = JSON.stringify(output)
  const outputSha256 = directorExtractionDigest(output)
  const current = db.prepare(`
    SELECT status, output_sha256 FROM director_extraction_segments
    WHERE phase_task_id = ? AND segment_index = ?
  `).get(phaseTaskId, index) as { status: string; output_sha256: string | null } | undefined
  if (!current) throw new Error('director_extraction_segment_missing')
  if (current.status === 'completed') {
    if (current.output_sha256 !== outputSha256) throw new Error('director_extraction_segment_conflict')
    return listDirectorExtractionSegments(db, phaseTaskId, phase)
  }
  const changed = db.prepare(`
    UPDATE director_extraction_segments
    SET output_sha256 = ?, candidate_output = ?, status = 'completed', updated_at = ?
    WHERE phase_task_id = ? AND segment_index = ? AND status = 'pending'
  `).run(outputSha256, encoded, nowSeconds, phaseTaskId, index)
  if (changed.changes !== 1) throw new Error('director_extraction_segment_conflict')
  return listDirectorExtractionSegments(db, phaseTaskId, phase)
}

export function mergeDirectorExtractionSegments(
  phase: DirectorExtractionPhase,
  segments: readonly DirectorExtractionSegment[],
): DirectorExtractionCandidateOutput {
  if (!segments.length || segments.some((segment, index) => (
    segment.index !== index || segment.count !== segments.length
    || segment.status !== 'completed' || !segment.output
  ))) throw new Error('director_extraction_segments_incomplete')
  const candidates: DirectorExtractionCandidateOutput['candidates'] = []
  const identities = new Map<string, string>()
  for (const candidate of segments.flatMap(segment => segment.output!.candidates)) {
    const identity = directorExtractionDigest(candidate)
    const previous = identities.get(candidate.candidateKey)
    if (previous && previous !== identity) {
      throw new Error('director_extraction_segment_candidate_conflict')
    }
    if (!previous) {
      identities.set(candidate.candidateKey, identity)
      candidates.push(candidate)
    }
  }
  return parseDirectorExtractionOutput(phase, { schemaVersion: 1, phase, candidates })
}
