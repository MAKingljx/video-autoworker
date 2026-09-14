// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { workerSourceClosureUnchanged, releaseAdmissionPolicy } from '../../scripts/lib/independent-worker-release.mjs'

const hash = (x: string) => createHash('sha256').update(x).digest('hex')
function manifest() {
  const runtime = { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, nodeAbi: process.versions.modules }
  const sources = ['src/workers/scheduler-worker.ts', 'src/lib/scheduler.ts', 'package.json', 'pnpm-lock.yaml', '.nvmrc', 'scripts/build-scheduler-worker.mjs']
    .map(path => ({ path, sha256: hash('verified source') }))
  const data = { runtime, sources, members: [] }
  return { schema: 'video-autoworker-scheduler-artifact/v1', ...data, contentSha256: hash(JSON.stringify(data)) }
}
describe('independent worker release dependency boundary', () => {
  it('reuses worker evidence only when every declared dependency is unchanged', () => {
    const value = manifest()
    expect(workerSourceClosureUnchanged(value, '/source', () => Buffer.from('verified source'))).toBe(true)
    expect(workerSourceClosureUnchanged(value, '/source', (path: string) =>
      Buffer.from(path.endsWith('scheduler.ts') ? 'changed implementation' : 'verified source'))).toBe(false)
  })
  it('rejects forged or incomplete dependency declarations', () => {
    const value = manifest()
    value.sources.pop()
    expect(() => workerSourceClosureUnchanged(value, '/source', () => Buffer.from('verified source')))
      .toThrow('release_worker_manifest_invalid')
    value.contentSha256 = hash(JSON.stringify({ runtime: value.runtime, sources: value.sources, members: value.members }))
    expect(() => workerSourceClosureUnchanged(value, '/source', () => Buffer.from('verified source')))
      .toThrow('release_worker_source_closure_incomplete')
  })
  it('does not infer compatibility when there is no live worker binding', () => {
    expect(releaseAdmissionPolicy({}, null)).toBe('drain-all')
  })
})
