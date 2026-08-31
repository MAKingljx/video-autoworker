import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('n8n rolling and callback OpenAPI contract', () => {
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
      .toEqual(['056_n8n_parent_execution_claims'])
    expect(readiness.properties.scheduler.$ref)
      .toBe('#/components/schemas/N8nReleaseSchedulerLeadershipStatus')
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
