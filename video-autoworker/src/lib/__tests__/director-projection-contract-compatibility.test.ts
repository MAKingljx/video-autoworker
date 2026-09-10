import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DIRECTOR_PROJECTION_PROTOCOL,
  DIRECTOR_PROJECTION_PROTOCOL_DIGEST,
  directorProjectionContractDigest,
  directorProjectionImplementationDigest,
  directorProjectionCompatibilitySha256,
  getDirectorProjectionReadCompatibleDigests,
  isCompatibleProjectionImplementationDigest,
  loadDirectorProjectionContractCompatibility,
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
  it('accepts both production source contracts and rejects an unknown digest', () => {
    const production = JSON.parse(readFileSync(
      join(process.cwd(), 'src/lib/director-projection-contract-compatibility.json'),
      'utf8',
    ))
    expect(DIRECTOR_PROJECTION_PROTOCOL).toMatchObject({
      projectionSchemaVersion: 1,
      receiptSchemaVersion: 1,
      storedTextNormalization: 'unicode-nfkc-crlf-trim-v1',
    })
    expect(DIRECTOR_PROJECTION_PROTOCOL_DIGEST)
      .toBe('11472003a209a0689952715aa4147b9bb7490d16799d3db68181e3341d49caab')
    expect(getDirectorProjectionReadCompatibleDigests(production, {
      digest: DIRECTOR_PROJECTION_PROTOCOL_DIGEST,
    })).toEqual([
      'e4bcabbcea89d809d8a81f15df27c8923d5a6b0727e0dbd0eaec517054c743b1',
      '1b23cf809e71d8aa13b2e3db37afcc9a66b4e151b834a368619b77be4c8ed932',
      'eec806b96c0b1389a25c4ffc1426b0e499d1b51a541691c46a660a20f5d157db',
    ])
    expect(isCompatibleProjectionImplementationDigest(
      production,
      '1b23cf809e71d8aa13b2e3db37afcc9a66b4e151b834a368619b77be4c8ed932',
    )).toBe(true)
    expect(() => validateDirectorProjectionContractCompatibility(production, {
      protocolDigest: DIRECTOR_PROJECTION_PROTOCOL_DIGEST,
      sourceDigest: '1b23cf809e71d8aa13b2e3db37afcc9a66b4e151b834a368619b77be4c8ed932',
    })).not.toThrow()
    expect(() => validateDirectorProjectionContractCompatibility(production, {
      sourceDigest: sha('f'),
    })).toThrow('director_projection_contract_source_mismatch')
  })

  it('keeps the protocol stable when an implementation member changes', () => {
    const production = JSON.parse(readFileSync(
      join(process.cwd(), 'src/lib/director-projection-contract-compatibility.json'),
      'utf8',
    ))
    const legacy = production.legacyImplementations[2]
    const changed = {
      ...legacy.closure,
      directorBrainServiceSha256: sha('f'),
      deliveryCoreSha256: sha('e'),
    }
    expect(directorProjectionImplementationDigest(changed)).not.toBe(legacy.digest)
    expect(() => validateDirectorProjectionContractCompatibility(production, {
      currentImplementation: {
        closure: changed,
        digest: directorProjectionImplementationDigest(changed),
      },
      protocolDigest: DIRECTOR_PROJECTION_PROTOCOL_DIGEST,
    })).not.toThrow()
    expect(production.protocol.digest).toBe(DIRECTOR_PROJECTION_PROTOCOL_DIGEST)
  })

  it('rejects an unknown protocol and a widened protocol declaration', () => {
    const production = JSON.parse(readFileSync(
      join(process.cwd(), 'src/lib/director-projection-contract-compatibility.json'),
      'utf8',
    ))
    expect(() => validateDirectorProjectionContractCompatibility(production, {
      protocolDigest: sha('f'),
    })).toThrow('director_projection_protocol_mismatch')
    production.protocol.descriptor.wireProtocol = 'director-command-jsonl-v2'
    expect(() => validateDirectorProjectionContractCompatibility(production))
      .toThrow('director_projection_contract_compatibility_invalid')
  })

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

  it.each([
    ['historical flat', false],
    ['prefixed product', true],
  ])('loads committed regression evidence from the %s tree', (_label, prefixed) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'projection-compatibility-layout-')))
    try {
      const productRoot = prefixed ? join(root, 'video-autoworker') : root
      const fixture = declaration()
      mkdirSync(productRoot, { recursive: true })
      writeFileSync(join(productRoot, 'package.json'), '{"name":"video-autoworker"}\n')
      writeFileSync(join(productRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(join(productRoot, 'next.config.js'), 'export default {}\n')
      const evidence = [
        ['src/lib/__tests__/one.test.ts', 'one\n'],
        ['src/lib/__tests__/two.test.ts', 'two\n'],
        ['openclaw-plugins/example/test/three.test.mjs', 'three\n'],
      ]
      fixture.value.regressionEvidence = evidence.map(([path, contents]) => {
        const pathname = join(productRoot, path)
        mkdirSync(dirname(pathname), { recursive: true })
        writeFileSync(pathname, contents)
        return { path, sha256: createHash('sha256').update(contents).digest('hex') }
      })
      const declarationPath = join(
        productRoot,
        'src/lib/director-projection-contract-compatibility.json',
      )
      mkdirSync(dirname(declarationPath), { recursive: true })
      writeFileSync(declarationPath, `${JSON.stringify(fixture.value)}\n`)
      execFileSync('/usr/bin/git', ['init', '-q', root])
      execFileSync('/usr/bin/git', ['-C', root, 'add', '.'])
      execFileSync('/usr/bin/git', [
        '-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-qm', 'fixture',
      ])
      const commit = execFileSync('/usr/bin/git', [
        '-C', root, 'rev-parse', 'HEAD',
      ], { encoding: 'utf8' }).trim()

      expect(loadDirectorProjectionContractCompatibility(productRoot, {
        gitCommit: commit,
        currentClosure: fixture.currentClosure,
        currentDigest: directorProjectionContractDigest(fixture.currentClosure),
      })).toMatchObject({ regressionEvidence: fixture.value.regressionEvidence })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
