// @vitest-environment node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildSchedulerWorker, workerBuildMemberKind, WORKER_RUNTIME_RESOURCES } from '../../scripts/build-scheduler-worker.mjs'
import { auditSchedulerWorkerArtifact } from '../../scripts/start-scheduler-worker.mjs'
import { workerSourceClosureUnchanged } from '../../scripts/lib/independent-worker-release.mjs'

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const stagingPrefix = '.next/scheduler-worker-build-fixture'

describe('scheduler worker build source boundary', () => {
  it('separates canonical source, node dependencies and this build output from other generated trees', () => {
    for (const source of [...WORKER_RUNTIME_RESOURCES, 'src/lib/scheduler.ts', 'scripts/build-scheduler-worker.mjs']) {
      expect(workerBuildMemberKind(source, stagingPrefix)).toBe('source')
    }
    expect(workerBuildMemberKind(`${stagingPrefix}/worker-runtime.cjs`, stagingPrefix)).toBe('compiled')
    expect(workerBuildMemberKind('node_modules/.pnpm/pino/node_modules/pino/lib/tools.js', stagingPrefix)).toBe('dependency')
    for (const generated of ['.next/standalone/ops/feishu-director-brain/schema.json',
      '.next/other-worker/worker-runtime.cjs', '.artifacts/worker/src/lib/schema.sql',
      'dist/schema.json', 'build/schema.json', 'out/schema.json',
      `${stagingPrefix}/source-receipts/receipt.json`]) {
      expect(workerBuildMemberKind(generated, stagingPrefix)).toBe('excluded')
    }
    expect(workerBuildMemberKind('scripts/output/schema.json', stagingPrefix)).toBe('source')
    expect(() => workerBuildMemberKind('../outside/schema.json', stagingPrefix)).toThrow('scheduler_worker_dependency_outside_product')
  })

  it('builds and runs without importing a pre-existing standalone schema into the worker source or artifact', async () => {
    const root = realpathSync(process.cwd())
    const shadow = join(root, '.next/standalone/ops/feishu-director-brain/schema.json')
    const createdDirectories: string[] = []
    const ensureDirectory = (directory: string) => {
      if (existsSync(directory)) return
      ensureDirectory(dirname(directory)); mkdirSync(directory); createdDirectories.push(directory)
    }
    const createdShadow = !existsSync(shadow)
    if (createdShadow) {
      ensureDirectory(dirname(shadow))
      writeFileSync(shadow, readFileSync(join(root, WORKER_RUNTIME_RESOURCES[0])), { flag: 'wx' })
    }
    const shadowBefore = sha(readFileSync(shadow))
    const scratchParent = resolve(root, '../output')
    mkdirSync(scratchParent, { recursive: true })
    const scratch = mkdtempSync(join(scratchParent, 'worker-build-check-'))
    const output = join(scratch, 'worker')
    try {
      await buildSchedulerWorker(output)
      const { manifest } = auditSchedulerWorkerArtifact(output)
      const sources = manifest.sources.map((member: { path: string }) => member.path)
      const members = manifest.members.map((member: { path: string }) => member.path)
      expect(sources).toEqual(expect.arrayContaining([...WORKER_RUNTIME_RESOURCES]))
      expect(members).toEqual(expect.arrayContaining([...WORKER_RUNTIME_RESOURCES,
        'worker-runtime.cjs', 'database-runtime.cjs', 'worker.cjs', 'prepare-database.cjs']))
      expect(sources.some((member: string) => member.startsWith('.next/') || member.endsWith('.cjs') && !member.startsWith('scripts/'))).toBe(false)
      expect(members.some((member: string) => member.startsWith('.next/') || member.includes('source-receipts/'))).toBe(false)
      expect(existsSync(join(output, '.next'))).toBe(false)
      expect(sha(readFileSync(shadow))).toBe(shadowBefore)
      for (const resource of WORKER_RUNTIME_RESOURCES) {
        expect(readFileSync(join(output, resource))).toEqual(readFileSync(join(root, resource)))
      }
      // A missing or independently rebuilt Web output cannot invalidate Worker source identity.
      const reads: string[] = []
      expect(workerSourceClosureUnchanged(manifest, root, (pathname: string) => {
        reads.push(pathname)
        if (pathname.includes('/.next/')) throw new Error('web_build_must_not_be_a_worker_source')
        return readFileSync(pathname)
      })).toBe(true)
      expect(reads).not.toContain(shadow)
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch }
      const { stdout } = await promisify(execFile)(process.execPath, ['scripts/test-scheduler-worker-runtime.mjs', '--artifact', output], {
        cwd: root, env, timeout: 120_000, maxBuffer: 1024 * 1024,
      })
      expect(stdout).toContain('# fail 0')
      expect(sha(readFileSync(shadow))).toBe(shadowBefore)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      if (createdShadow) rmSync(shadow)
      for (const directory of createdDirectories.reverse()) {
        if (readdirSync(directory).length === 0) rmdirSync(directory)
      }
    }
  }, 180_000)
})
