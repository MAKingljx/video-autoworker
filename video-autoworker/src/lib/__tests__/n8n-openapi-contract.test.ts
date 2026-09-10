import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('n8n rolling and callback OpenAPI contract', () => {
  it('documents the server-resolved director work name on the trigger boundary', () => {
    const trigger = document.paths['/api/n8n/trigger'].post
    const request = trigger.requestBody.content['application/json'].schema
    expect(request.properties.directorWork).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 240,
    })
    expect(request.properties.directorWork.description).toContain('input.materialId')
    expect(request.properties.input.properties.materialId).toMatchObject({
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$',
    })
    expect(request.allOf).toContainEqual({
      if: { required: ['directorWork'] },
      then: { properties: { input: { required: ['materialId'] } } },
    })
    expect(trigger.responses['423'].content['application/json'].schema.properties.code.enum)
      .toEqual(['N8N_INTAKE_DRAINING', 'DEPLOYMENT_IN_PROGRESS'])
    expect(trigger.responses['503'].description).toMatch(/deployment lock/i)
  })

  it('documents one shared lock for both intake mutations', () => {
    const mutation = document.paths['/api/n8n/intake-control'].post
    expect(mutation.responses['423'].description).toMatch(/drain or resume/i)
    expect(mutation.responses['503'].description).toMatch(/acquired or released/i)
  })

  it('documents the strict review-polling director extraction boundary', () => {
    const operation = document.paths['/api/n8n/director-extraction'].post
    const variants = operation.requestBody.content['application/json'].schema.oneOf
    const start = variants.find((variant: Record<string, any>) => (
      variant.properties.action.enum.includes('start_extraction')
    ))
    const backfill = variants.find((variant: Record<string, any>) => (
      variant.properties.action.enum.includes('backfill_extraction')
    ))
    const status = variants.find((variant: Record<string, any>) => (
      variant.properties.action.enum.includes('extraction_status')
    ))

    expect(start).toMatchObject({
      additionalProperties: false,
      required: ['action', 'workId'],
    })
    expect(Object.keys(start.properties).sort()).toEqual([
      'action',
      'objective',
      'sourceQuery',
      'workId',
    ])
    expect(start.properties.action.enum).toEqual(['start_extraction'])
    expect(backfill).toMatchObject({
      additionalProperties: false,
      required: ['action', 'workId'],
    })
    expect(Object.keys(backfill.properties).sort()).toEqual(['action', 'workId'])
    expect(backfill.properties.action.enum).toEqual(['backfill_extraction'])
    expect(status).toMatchObject({
      additionalProperties: false,
      required: ['action', 'workId'],
    })
    expect(Object.keys(status.properties).sort()).toEqual(['action', 'workId'])
  })

  const document = JSON.parse(
    readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8'),
  ) as Record<string, any>

  it('documents generic execution-owned parent claims', () => {
    const claim = document.paths['/api/n8n/claim'].post
    const request = claim.requestBody.content['application/json'].schema
    expect(claim.operationId).toBe('claimN8nTaskRun')
    expect(claim.summary).not.toMatch(/video/i)
    expect(request.required).toContain('executionOwner')
    expect(request.properties.executionOwner.pattern).toBe('^n8n-execution:[A-Za-z0-9._:-]{1,100}$')
    expect(claim.responses['200'].content['application/json'].schema.required)
      .toEqual(expect.arrayContaining(['claimed', 'resumed', 'duplicate']))
  })

  it('never documents running child callbacks as ordinary 2xx progress', () => {
    for (const pathname of ['/api/n8n/node-execute', '/api/n8n/media-execute']) {
      const operation = document.paths[pathname].post
      const request = operation.requestBody.content['application/json'].schema
      const responses = operation.responses
      expect(request.required).toContain('executionOwner')
      expect(request.properties.executionOwner.pattern)
        .toBe('^n8n-execution:[A-Za-z0-9._:-]{1,100}$')
      if (pathname === '/api/n8n/node-execute') {
        expect(request.properties.finalizeParent.description).toContain('only when nodeKey')
        expect(request.properties.finalizeParent.description).toContain('reviewer')
      }
      expect(responses).not.toHaveProperty('202')
      expect(responses['503'].description).toMatch(/retry/i)
    }
  })

  it('uses a strict scheduler schema only for release readiness', () => {
    const readiness = document.components.schemas.N8nReleaseReadiness
    expect(readiness.properties.database.properties.latestMigration.enum)
      .toEqual(['059_director_evidence_projection_receipts'])
    expect(readiness.properties.scheduler.$ref)
      .toBe('#/components/schemas/N8nReleaseSchedulerLeadershipStatus')
    expect(readiness.properties.projection.required).toEqual(expect.arrayContaining([
      'deliveredWithoutValidReceipt',
      'outOfScopeOutbox',
      'outOfScopeExtraction',
    ]))
    expect(document.components.schemas.N8nReleaseSchedulerLeadershipStatus.properties.state.enum)
      .toEqual(['leader', 'follower', 'inactive'])
    expect(document.paths['/api/scheduler'].get.responses['200'].content['application/json']
      .schema.properties.leadership.$ref)
      .toBe('#/components/schemas/SchedulerLeadershipStatus')
  })

  it('marks the unsafe pre-ownership execution callback as legacy-only', () => {
    const operation = document.paths['/api/n8n/execute'].post
    expect(operation.deprecated).toBe(true)
    expect(operation.summary).toContain('legacy-v1')
    expect(operation.description).toContain('non-slot legacy runtime')
    expect(operation.description).toContain('must use claim plus node-execute/media-execute')
  })
})
