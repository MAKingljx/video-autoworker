import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

interface EvaluationModule {
  evaluateDirectorBrainCandidates: (input: unknown) => Record<string, any>
}

async function loadModule(): Promise<EvaluationModule> {
  const pathname = resolve(process.cwd(), 'scripts/lib/director-brain-evaluation.mjs')
  return await import(/* @vite-ignore */ pathToFileURL(pathname).href) as EvaluationModule
}

function fixture() {
  return {
    schemaVersion: 1,
    projectId: 'PROJ-VIDEO-AUTOWORKER',
    workId: 'WORK-DOCUMENTARY-001',
    reviewedEvidenceIds: ['EVIDENCE-1', 'EVIDENCE-2'],
    gold: [
      { goldId: 'G-PERSON-1', kind: 'people_profile', evidenceIds: ['EVIDENCE-1'] },
      { goldId: 'G-STORY-1', kind: 'story_node', evidenceIds: ['EVIDENCE-2'] },
    ],
    predictions: [
      {
        candidateId: 'C-PERSON-1',
        kind: 'people_profile',
        evidenceIds: ['EVIDENCE-1'],
        matchedGoldId: 'G-PERSON-1',
        accepted: true,
      },
      {
        candidateId: 'C-STORY-1',
        kind: 'story_node',
        evidenceIds: ['EVIDENCE-2'],
        matchedGoldId: 'G-STORY-1',
        accepted: true,
      },
    ],
  }
}

describe('director brain offline quality evaluation', () => {
  it('passes a fully referenced and correct candidate set', async () => {
    const { evaluateDirectorBrainCandidates } = await loadModule()
    const result = evaluateDirectorBrainCandidates(fixture())

    expect(result.counts).toMatchObject({
      gold: 2,
      predictions: 2,
      truePositives: 2,
      brokenReferences: 0,
      hallucinations: 0,
    })
    expect(result.metrics).toMatchObject({
      precision: 1,
      recall: 1,
      f1: 1,
      evidenceCoverage: 1,
      humanAcceptanceRate: 1,
    })
    expect(result.metrics.byKind.story_node.f1).toBe(1)
    expect(result.gate.pass).toBe(true)
  })

  it('fails the gate for unsupported or broken-reference candidates', async () => {
    const { evaluateDirectorBrainCandidates } = await loadModule()
    const input = fixture()
    input.predictions.push({
      candidateId: 'C-STORY-BROKEN',
      kind: 'story_node',
      evidenceIds: ['EVIDENCE-UNKNOWN'],
      matchedGoldId: 'G-STORY-1',
      accepted: false,
    })
    const result = evaluateDirectorBrainCandidates(input)

    expect(result.counts.brokenReferences).toBe(1)
    expect(result.counts.hallucinations).toBe(1)
    expect(result.metrics.brokenReferenceRate).toBeCloseTo(1 / 3, 5)
    expect(result.gate.pass).toBe(false)
    expect(result.gate.checks.brokenReferenceRate).toBe(false)
  })

  it('counts duplicate matches without inflating recall', async () => {
    const { evaluateDirectorBrainCandidates } = await loadModule()
    const input = fixture()
    input.predictions.push({
      candidateId: 'C-STORY-DUPLICATE',
      kind: 'story_node',
      evidenceIds: ['EVIDENCE-2'],
      matchedGoldId: 'G-STORY-1',
      accepted: false,
    })
    const result = evaluateDirectorBrainCandidates(input)

    expect(result.counts.truePositives).toBe(2)
    expect(result.counts.duplicateMatches).toBe(1)
    expect(result.metrics.recall).toBe(1)
    expect(result.metrics.duplicateRate).toBeCloseTo(1 / 3, 5)
    expect(result.gate.pass).toBe(false)
  })

  it('rejects gold evidence that was not reviewed', async () => {
    const { evaluateDirectorBrainCandidates } = await loadModule()
    const input = fixture()
    input.gold[0].evidenceIds = ['EVIDENCE-UNKNOWN']

    expect(() => evaluateDirectorBrainCandidates(input))
      .toThrow('gold_evidence_not_reviewed:G-PERSON-1')
  })

  it('rejects a claimed gold match backed by a different reviewed evidence set', async () => {
    const { evaluateDirectorBrainCandidates } = await loadModule()
    const input = fixture()
    input.reviewedEvidenceIds.push('EVIDENCE-OTHER')
    input.predictions[0].evidenceIds = ['EVIDENCE-OTHER']

    const result = evaluateDirectorBrainCandidates(input)

    expect(result.counts.truePositives).toBe(1)
    expect(result.counts.hallucinations).toBe(1)
    expect(result.gate.pass).toBe(false)
  })

  it('does not count a prediction with extra reviewed evidence as a true positive', async () => {
    const { evaluateDirectorBrainCandidates } = await loadModule()
    const input = fixture()
    input.reviewedEvidenceIds.push('EVIDENCE-EXTRA')
    input.predictions[0].evidenceIds.push('EVIDENCE-EXTRA')

    const result = evaluateDirectorBrainCandidates(input)

    expect(result.counts.truePositives).toBe(1)
    expect(result.counts.brokenReferences).toBe(0)
    expect(result.counts.hallucinations).toBe(1)
    expect(result.metrics.precision).toBe(0.5)
    expect(result.gate.pass).toBe(false)
  })

  it('compares gold and prediction evidence as deduplicated order-independent sets', async () => {
    const { evaluateDirectorBrainCandidates } = await loadModule()
    const input = fixture()
    input.gold[0].evidenceIds = ['EVIDENCE-1', 'EVIDENCE-2', 'EVIDENCE-1']
    input.predictions[0].evidenceIds = ['EVIDENCE-2', 'EVIDENCE-1', 'EVIDENCE-2']

    const result = evaluateDirectorBrainCandidates(input)

    expect(result.counts.truePositives).toBe(2)
    expect(result.counts.hallucinations).toBe(0)
    expect(result.metrics.precision).toBe(1)
    expect(result.gate.pass).toBe(true)
  })

  it('runs the bounded CLI with an absolute input path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-brain-evaluation-'))
    try {
      const pathname = join(root, 'evaluation.json')
      await writeFile(pathname, JSON.stringify(fixture()), { mode: 0o600 })
      const { stdout } = await execFileAsync(
        process.execPath,
        [resolve(process.cwd(), 'scripts/director-brain-evaluation.mjs'), '--input', pathname],
        { maxBuffer: 2 * 1024 * 1024 },
      )
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, gate: { pass: true } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
