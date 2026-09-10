import { describe, expect, it } from 'vitest'
import {
  directorProjectionContractDigest,
  directorProjectionCompatibilitySha256,
  getDirectorProjectionReadCompatibleDigests,
  validateDirectorProjectionContractCompatibility,
} from '../../../scripts/lib/director-projection-contract-compatibility.mjs'

const sha = (value: string) => value.repeat(64)

function declaration() {
  const fromClosure = {
    directorBrainCliSha256: sha('1'),
    directorBrainServiceSha256: sha('2'),
    directorBrainSensitiveValueScannerSha256: sha('3'),
    directorBrainSchemaSha256: sha('4'),
    evidenceTransformerSha256: sha('5'),
    evidenceLibrarySha256: sha('6'),
    appProjectionSemanticsSha256: sha('7'),
    deliveryCoreSha256: sha('8'),
  }
  const currentClosure = {
    ...fromClosure,
    appProjectionSemanticsSha256: sha('9'),
    deliveryCoreSha256: sha('a'),
  }
  return {
    value: {
      schema: 'video-autoworker-director-projection-compatibility/v1',
      transitionId: 'receipt-text-normalization-20260910',
      fromContract: {
        digest: directorProjectionContractDigest(fromClosure),
        closure: fromClosure,
      },
      toContract: { digest: directorProjectionContractDigest(currentClosure) },
      changedClosureMembers: [
        'appProjectionSemanticsSha256',
        'deliveryCoreSha256',
      ],
      unchanged: {
        projectionAuthority: 'director-evidence-projection-contract-v1',
        projectionSchemaVersion: 1,
        receiptSchemaVersion: 1,
        stableEvidenceIdentity: true,
        wireProtocol: true,
        sourceIdentity: true,
        outboxIdentity: true,
      },
      recovery: {
        mode: 'verified-read-only',
        compatibleSourceDigests: [directorProjectionContractDigest(fromClosure)],
        preserveOutboxIdentity: true,
        remoteWrites: false,
        requiredConflictCode: 'director_evidence_projection_receipt_invalid',
      },
      rollback: {
        direction: 'forward-only',
        automaticCompensationBeforeReturn: true,
        explicitReverse: false,
      },
      regressionEvidence: [
        { path: 'src/lib/__tests__/one.test.ts', sha256: sha('b') },
        { path: 'src/lib/__tests__/two.test.ts', sha256: sha('c') },
        { path: 'openclaw-plugins/example/test/three.test.mjs', sha256: sha('d') },
      ],
    },
    currentClosure,
  }
}

describe('director projection contract compatibility declaration', () => {
  it('returns only the exact verified-read source digest for the current target contract', () => {
    const fixture = declaration()
    const current = {
      closure: fixture.currentClosure,
      digest: directorProjectionContractDigest(fixture.currentClosure),
    }
    const digests = getDirectorProjectionReadCompatibleDigests(fixture.value, current)
    expect(digests).toEqual([fixture.value.fromContract.digest])
    expect(Object.isFrozen(digests)).toBe(true)
    expect(directorProjectionCompatibilitySha256(fixture.value)).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => validateDirectorProjectionContractCompatibility(fixture.value, {
      sourceDigest: sha('f'),
    })).toThrow('director_projection_contract_source_mismatch')
  })

  it('rejects a declaration when the real closure changes outside its exact allowlist', () => {
    const fixture = declaration()
    const changedClosure = {
      ...fixture.currentClosure,
      evidenceTransformerSha256: sha('e'),
    }
    fixture.value.toContract.digest = directorProjectionContractDigest(changedClosure)
    expect(() => validateDirectorProjectionContractCompatibility(fixture.value, {
      currentClosure: changedClosure,
      currentDigest: directorProjectionContractDigest(changedClosure),
    })).toThrow('director_projection_contract_change_scope_mismatch')
  })

  it('rejects reverse, remote-write, and unrelated closure compatibility claims', () => {
    for (const mutate of [
      (value: any) => { value.rollback.explicitReverse = true },
      (value: any) => { value.recovery.remoteWrites = true },
      (value: any) => { value.changedClosureMembers.push('evidenceTransformerSha256') },
      (value: any) => { value.regressionEvidence[0].path = 'src/../escape.test.ts' },
    ]) {
      const fixture = declaration()
      mutate(fixture.value)
      expect(() => validateDirectorProjectionContractCompatibility(fixture.value))
        .toThrow('director_projection_contract_compatibility_invalid')
    }
  })
})
