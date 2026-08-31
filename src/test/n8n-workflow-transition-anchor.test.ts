import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const anchor = resolve(projectRoot, 'scripts/n8n-workflow-transition-anchor.mjs')
const importer = resolve(projectRoot, 'scripts/n8n-import-workflows.sh')
const verifier = resolve(projectRoot, 'scripts/verify-n8n-blue-green-workflows.mjs')
const targetCommit = 'a'.repeat(40)
const oldCommit = targetCommit
const workflowDescriptors = [
  { id: 'aiworker-task-intake-v1', source: 'aiworker-task-intake.json', backup: 'aiworker-task-intake-v1.json' },
  { id: 'aiworker-video-analysis-v1', source: 'aiworker-video-analysis.json', backup: 'aiworker-video-analysis-v1.json' },
]
const runtimeSourcePaths = [
  'scripts/n8n-start.sh',
  'scripts/n8n-stop.sh',
  'scripts/n8n-status.sh',
  'scripts/n8n-import-workflows.sh',
  'scripts/n8n-maintenance-lock.mjs',
  'scripts/n8n-workflow-transition-anchor.mjs',
  'scripts/n8n-backup-managed-workflows.mjs',
  'scripts/n8n-restore-managed-workflows.sh',
  'ops/n8n/.env.example',
  'ops/n8n/lib/common.sh',
  'ops/n8n/package.json',
  'ops/n8n/package-lock.json',
  'ops/n8n/workflows/aiworker-task-intake.json',
  'ops/n8n/workflows/aiworker-video-analysis.json',
]
const cleanup: Array<() => void> = []

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [
      key,
      canonicalize((value as Record<string, unknown>)[key]),
    ]))
  }
  return value
}
const canonicalJson = (value: unknown) => JSON.stringify(canonicalize(value))
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const semantic = (value: Record<string, unknown>) => ({
  id: value.id,
  name: value.name,
  nodes: value.nodes,
  connections: value.connections,
  settings: value.settings,
  staticData: value.staticData ?? null,
  pinData: value.pinData ?? null,
  nodeGroups: Array.isArray(value.nodeGroups) ? value.nodeGroups : [],
})

type Fixture = ReturnType<typeof createFixture>

function run(...args: string[]) {
  return spawnSync(process.execPath, [anchor, ...args], { encoding: 'utf8' })
}

function runAtFailpoint(name: string, ...args: string[]) {
  return spawnSync(process.execPath, [anchor, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', AIWORKER_TEST_TRANSITION_FAILPOINT: name },
  })
}

function runAtTime(now: number, ...args: string[]) {
  return spawnSync(process.execPath, [anchor, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', AIWORKER_TEST_TRANSITION_NOW: String(now) },
  })
}

async function waitForOutput(child: ReturnType<typeof spawn>, expected: string) {
  await new Promise<void>((resolvePromise, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('child output timeout')), 5_000)
    child.stdout?.on('data', value => {
      output += String(value)
      if (output.includes(expected)) {
        clearTimeout(timer)
        resolvePromise()
      }
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (!output.includes(expected)) reject(new Error(`child exited before ready: ${code}`))
    })
  })
}

function writeControlled(pathname: string, source: string, mode = 0o600) {
  writeFileSync(pathname, source, { mode })
  chmodSync(pathname, mode)
}

function rewriteRollbackManifest(fixture: Fixture, mutate: (value: Record<string, any>) => void) {
  const pathname = join(fixture.rollbackPackage, 'manifest.json')
  chmodSync(fixture.rollbackPackage, 0o700)
  chmodSync(pathname, 0o600)
  const value = JSON.parse(readFileSync(pathname, 'utf8'))
  mutate(value)
  writeControlled(pathname, `${canonicalJson(value)}\n`, 0o400)
  chmodSync(fixture.rollbackPackage, 0o500)
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-transition-anchor-')))
  cleanup.push(() => {
    spawnSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
  })
  chmodSync(root, 0o700)
  const state = join(root, 'transition')
  mkdirSync(state, { mode: 0o700 })
  const database = join(root, 'database.sqlite')
  writeControlled(database, 'sqlite-before-transition\n')

  const runtimeRoot = join(root, 'n8n-releases', targetCommit)
  mkdirSync(join(runtimeRoot, 'ops/n8n/workflows'), { recursive: true, mode: 0o700 })
  mkdirSync(join(runtimeRoot, 'ops/n8n/node_modules/n8n'), { recursive: true, mode: 0o700 })
  chmodSync(runtimeRoot, 0o700)
  writeControlled(join(runtimeRoot, 'SOURCE_COMMIT'), `${targetCommit}\n`)
  const targets = workflowDescriptors.map(descriptor => {
    const sourcePath = resolve(projectRoot, 'ops/n8n/workflows', descriptor.source)
    const targetPath = join(runtimeRoot, 'ops/n8n/workflows', descriptor.source)
    copyFileSync(sourcePath, targetPath)
    chmodSync(targetPath, 0o600)
    const source = readFileSync(targetPath, 'utf8')
    const value = JSON.parse(source)
    return { ...descriptor, path: targetPath, source, sourceSha256: sha256(source), semanticSha256: sha256(canonicalJson(semantic(value))) }
  })
  for (const pathname of runtimeSourcePaths) {
    const destination = join(runtimeRoot, pathname)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(resolve(projectRoot, pathname), destination)
    chmodSync(destination, pathname.startsWith('scripts/') || pathname === 'ops/n8n/lib/common.sh' ? 0o700 : 0o600)
  }
  const runtimeManifest = `${runtimeSourcePaths.map(pathname =>
    `${sha256(readFileSync(join(runtimeRoot, pathname)))}  ${pathname}`).join('\n')}\n`
  writeControlled(join(runtimeRoot, 'RUNTIME_SOURCE_SHA256SUMS'), runtimeManifest)
  writeControlled(join(runtimeRoot, 'ops/n8n/node_modules/n8n/package.json'), '{"name":"n8n","version":"2.31.6"}\n')
  writeControlled(join(runtimeRoot, 'SOURCE_MANIFEST'), [
    'source_origin=test',
    `source_commit=${targetCommit}`,
    'package_lock_sha256=' + '1'.repeat(64),
    `workflow_sha256=${targets[0].sourceSha256}`,
    `video_workflow_sha256=${targets[1].sourceSha256}`,
    `runtime_source_manifest_sha256=${sha256(runtimeManifest)}`,
    'n8n_version=2.31.6',
    'built_at=2026-08-31T00:00:00Z',
    '',
  ].join('\n'))

  const rollbackPackage = join(root, 'rollback-package')
  mkdirSync(rollbackPackage, { mode: 0o700 })
  const reports = targets.map((target, index) => {
    const original = JSON.parse(target.source)
    const value = { ...semantic(original), active: false, versionId: String(original.versionId) }
    const source = `${canonicalJson(value)}\n`
    const file = join(rollbackPackage, target.backup)
    writeControlled(file, source, 0o400)
    const selectedVersionId = String(value.versionId)
    return {
      id: target.id,
      file: target.backup,
      active: index === 0,
      origin: index === 0 ? 'published' : 'current',
      currentVersionId: selectedVersionId,
      activeVersionId: index === 0 ? selectedVersionId : null,
      selectedVersionId,
      bytes: Buffer.byteLength(source),
      fileSha256: sha256(source),
      semanticSha256: sha256(canonicalJson(semantic(value))),
    }
  })
  const rollbackManifest = {
    schema: 'video-autoworker-n8n-managed-workflow-backup/v1',
    createdAt: Math.floor(Date.now() / 1000),
    source: {
      sourceCommit: oldCommit,
      n8nVersion: '2.31.6',
      databaseFileName: 'database.sqlite',
      databaseIdentity: (() => {
        const entry = statSync(database, { bigint: true })
        return {
          dev: `0x${entry.dev.toString(16)}`,
          ino: entry.ino.toString(),
          bytes: Number(entry.size),
          mtimeNs: entry.mtimeNs.toString(),
        }
      })(),
      quickCheck: 'ok',
    },
    workflows: reports,
    combinedSha256: sha256(reports.map(report => [
      report.id,
      report.active ? 'active' : 'inactive',
      report.fileSha256,
      report.semanticSha256,
    ].join(':')).join('\n')),
  }
  writeControlled(join(rollbackPackage, 'manifest.json'), `${canonicalJson(rollbackManifest)}\n`, 0o400)
  chmodSync(rollbackPackage, 0o500)

  const appReleaseRoot = join(root, 'app-releases', `${targetCommit}-runtime`, 'standalone')
  mkdirSync(appReleaseRoot, { recursive: true, mode: 0o700 })
  const appManifest = join(appReleaseRoot, 'release-manifest.json')
  writeControlled(appManifest, '{"schema":"video-autoworker-release-manifest/v1"}\n', 0o400)

  return {
    root,
    state,
    database,
    runtimeRoot,
    rollbackPackage,
    targets,
    appReleaseRoot,
    appManifest,
    intent: join(state, 'upgrade-intent.json'),
    confirmation: join(state, 'current-confirmation.json'),
    capability: join(state, 'import-capability.json'),
    token: join(state, 'operator-token'),
    journal: join(state, 'journal'),
    liveReport: join(state, 'live-report.json'),
    attestation: join(state, 'transition-attestation.json'),
  }
}

function prepare(fixture: Fixture) {
  return run(
    'prepare-intent',
    '--upgrade-id', '11111111-1111-4111-8111-111111111111',
    '--database', fixture.database,
    '--rollback-package', fixture.rollbackPackage,
    '--runtime-root', fixture.runtimeRoot,
    '--target-commit', targetCommit,
    '--slot', 'blue',
    '--release-id', `${targetCommit}-runtime`,
    '--application-release-root', fixture.appReleaseRoot,
    '--output', fixture.intent,
  )
}

function confirm(fixture: Fixture) {
  writeControlled(fixture.token, `${'c'.repeat(64)}\n`, 0o400)
  return run(
    'current-confirm',
    '--intent', fixture.intent,
    '--confirmation-token-file', fixture.token,
    '--confirmation-receipt-id', '22222222-2222-4222-8222-222222222222',
    '--confirmation-output', fixture.confirmation,
    '--capability-output', fixture.capability,
  )
}

function claim(fixture: Fixture) {
  return run(
    'claim-import',
    '--intent', fixture.intent,
    '--confirmation', fixture.confirmation,
    '--confirmation-token-file', fixture.token,
    '--capability', fixture.capability,
    '--journal-dir', fixture.journal,
  )
}

function claimArguments(fixture: Fixture) {
  return [
    'claim-import',
    '--intent', fixture.intent,
    '--confirmation', fixture.confirmation,
    '--confirmation-token-file', fixture.token,
    '--capability', fixture.capability,
    '--journal-dir', fixture.journal,
  ]
}

function journalCommand(fixture: Fixture, command: string, ...extra: string[]) {
  return run(
    command,
    '--intent', fixture.intent,
    '--confirmation', fixture.confirmation,
    '--journal-dir', fixture.journal,
    ...extra,
  )
}

function createLiveReport(fixture: Fixture) {
  const runtimeIdentitySha256 = 'd'.repeat(64)
  const workflows = fixture.targets.map((target, index) => {
    const value = JSON.parse(target.source)
    return {
      id: target.id,
      sourceVersionId: String(value.versionId),
      sourceSha256: target.sourceSha256,
      publishedVersionId: `published-version-${index + 1}`,
      sha256: target.semanticSha256,
    }
  })
  const report = {
    schema: 'video-autoworker-n8n-workflow-compatibility/v2',
    protocol: 'slot-v1-execution-owner-v1',
    sourceCommit: targetCommit,
    databasePath: fixture.database,
    runtimeIdentitySha256,
    workflows,
    combinedSha256: sha256([
      targetCommit,
      runtimeIdentitySha256,
      ...workflows.map(item => [
        item.id,
        item.sourceVersionId,
        item.sourceSha256,
        item.publishedVersionId,
        item.sha256,
      ].join(':')),
    ].join('\n')),
  }
  writeControlled(fixture.liveReport, `${JSON.stringify(report)}\n`, 0o400)
}

function reachAttestationReady(fixture: Fixture) {
  const prepared = prepare(fixture)
  expect(prepared.status, prepared.stderr).toBe(0)
  expect(confirm(fixture).status).toBe(0)
  expect(claim(fixture).status).toBe(0)
  expect(journalCommand(fixture, 'begin-mutation').status).toBe(0)
  for (const target of fixture.targets) {
    expect(journalCommand(fixture, 'verify-target', '--id', target.id).status).toBe(0)
    const recorded = journalCommand(fixture, 'record-workflow', '--id', target.id)
    expect(recorded.status, recorded.stderr).toBe(0)
  }
  createLiveReport(fixture)
}

function attestationArguments(fixture: Fixture) {
  return [
    'attest-transition',
    '--intent', fixture.intent,
    '--confirmation', fixture.confirmation,
    '--journal-dir', fixture.journal,
    '--live-report', fixture.liveReport,
    '--verifier', verifier,
    '--output', fixture.attestation,
  ]
}

function reachCommitted(fixture: Fixture) {
  reachAttestationReady(fixture)
  const attested = run(...attestationArguments(fixture))
  expect(attested.status, `${attested.stdout}\n${attested.stderr}`).toBe(0)
}

afterEach(() => {
  for (const remove of cleanup.splice(0)) remove()
})

describe('n8n workflow transition dual anchor producer', () => {
  it('orders file and directory fsync around every transition namespace mutation', () => {
    const source = readFileSync(anchor, 'utf8')
    const body = (name: string, next: string) => source.slice(
      source.indexOf(`function ${name}(`),
      source.indexOf(`function ${next}(`),
    )
    const immutable = body('writeImmutable', 'parseArguments')
    expect(immutable.indexOf('fchmodSync(descriptor, 0o400)'))
      .toBeLessThan(immutable.indexOf('fsyncSync(descriptor)'))
    expect(immutable.indexOf('fsyncSync(descriptor)'))
      .toBeLessThan(immutable.indexOf("fsyncDirectory(parentPath, 'immutable output parent', parent)"))

    const directory = body('createDirectoryDurable', 'renameDurable')
    expect(directory.indexOf('mkdirSync(pathname')).toBeLessThan(directory.indexOf('fsyncDirectory(pathname, label)'))
    expect(directory.indexOf('fsyncDirectory(pathname, label)'))
      .toBeLessThan(directory.indexOf('fsyncDirectory(parentPath'))

    const rename = body('renameDurable', 'unlinkDurable')
    expect(rename.indexOf('renameSync(source, destination)'))
      .toBeLessThan(rename.indexOf('fsyncDirectory(destinationParentPath'))
    expect(rename.indexOf('fsyncDirectory(destinationParentPath'))
      .toBeLessThan(rename.indexOf('fsyncDirectory(sourceParentPath'))

    const unlink = body('unlinkDurable', 'writeImmutable')
    expect(unlink.indexOf('unlinkSync(pathname)'))
      .toBeLessThan(unlink.indexOf('fsyncDirectory(parentPath'))

    const claimBody = body('claimImport', 'beginMutation')
    expect(claimBody.indexOf("createDirectoryDurable(values['--journal-dir']"))
      .toBeLessThan(claimBody.indexOf("testFailpoint('after-journal-mkdir')"))
    expect(claimBody.lastIndexOf('renameDurable('))
      .toBeLessThan(claimBody.indexOf("testFailpoint('after-capability-consumed')"))
    expect(claimBody.lastIndexOf('appendEvent(')).toBeLessThan(claimBody.lastIndexOf('unlinkDurable('))
  })

  it('creates immutable intent, consumes current confirmation once, journals the upgrade, and verifies the deployed anchor', () => {
    const fixture = createFixture()
    reachCommitted(fixture)
    const verified = journalCommand(fixture, 'verify-transition', '--attestation', fixture.attestation)
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({ committed: true, upgradeId: '11111111-1111-4111-8111-111111111111' })
    expect(readdirSync(fixture.journal).filter(name => name.endsWith('.json'))).toHaveLength(7)
    for (const pathname of [fixture.intent, fixture.confirmation, fixture.attestation]) {
      const entry = statSync(pathname)
      expect(entry.mode & 0o777).toBe(0o400)
      expect(entry.nlink).toBe(1)
    }
    expect(() => statSync(fixture.capability)).toThrow()
    expect(() => statSync(fixture.token)).toThrow()

    const replay = claim(fixture)
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('committed workflow transition cannot be replayed')
  })

  it('rejects a database or target workflow mutation before the one-time import claim', () => {
    const databaseFixture = createFixture()
    const databasePrepared = prepare(databaseFixture)
    expect(databasePrepared.status, databasePrepared.stderr).toBe(0)
    expect(confirm(databaseFixture).status).toBe(0)
    writeControlled(databaseFixture.database, 'sqlite-mutated-before-claim\n')
    const databaseRejected = claim(databaseFixture)
    expect(databaseRejected.status).not.toBe(0)
    expect(databaseRejected.stderr).toContain('database family reference changed')

    const workflowFixture = createFixture()
    const workflowPrepared = prepare(workflowFixture)
    expect(workflowPrepared.status, workflowPrepared.stderr).toBe(0)
    expect(confirm(workflowFixture).status).toBe(0)
    writeFileSync(workflowFixture.targets[0].path, '{}\n')
    const workflowRejected = claim(workflowFixture)
    expect(workflowRejected.status).not.toBe(0)
    expect(workflowRejected.stderr).toMatch(/target workflow|target n8n runtime|runtime source member/)
  })

  it('rejects a rollback package from another commit, database snapshot, or symlink path', () => {
    const commitFixture = createFixture()
    rewriteRollbackManifest(commitFixture, value => {
      value.source.sourceCommit = 'b'.repeat(40)
    })
    const wrongCommit = prepare(commitFixture)
    expect(wrongCommit.status).not.toBe(0)
    expect(wrongCommit.stderr).toContain('source commit and n8n version must match')

    const databaseFixture = createFixture()
    rewriteRollbackManifest(databaseFixture, value => {
      value.source.databaseIdentity.ino = String(
        BigInt(value.source.databaseIdentity.ino) + BigInt(1),
      )
    })
    const wrongDatabase = prepare(databaseFixture)
    expect(wrongDatabase.status).not.toBe(0)
    expect(wrongDatabase.stderr).toContain('not a snapshot of the authoritative n8n database')

    const symlinkFixture = createFixture()
    const packageLink = join(symlinkFixture.root, 'rollback-package-link')
    symlinkSync(symlinkFixture.rollbackPackage, packageLink)
    const linked = run(
      'prepare-intent',
      '--upgrade-id', '11111111-1111-4111-8111-111111111111',
      '--database', symlinkFixture.database,
      '--rollback-package', packageLink,
      '--runtime-root', symlinkFixture.runtimeRoot,
      '--target-commit', targetCommit,
      '--slot', 'blue',
      '--release-id', `${targetCommit}-runtime`,
      '--application-release-root', symlinkFixture.appReleaseRoot,
      '--output', symlinkFixture.intent,
    )
    expect(linked.status).not.toBe(0)
    expect(linked.stderr).toContain('symbolic link')
  })

  it('rejects a rollback package created by another n8n version', () => {
    const fixture = createFixture()
    rewriteRollbackManifest(fixture, value => {
      value.source.n8nVersion = '2.31.5'
    })
    const rejected = prepare(fixture)
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('source commit and n8n version must match')
  })

  it('binds every runtime manifest member and the exact importer/anchor executables', () => {
    const fixture = createFixture()
    expect(prepare(fixture).status).toBe(0)
    const runtimeAnchor = join(fixture.runtimeRoot, 'scripts/n8n-workflow-transition-anchor.mjs')
    const runtimeImporter = join(fixture.runtimeRoot, 'scripts/n8n-import-workflows.sh')
    const trusted = spawnSync(process.execPath, [
      runtimeAnchor,
      'assert-tooling',
      '--intent', fixture.intent,
      '--importer', runtimeImporter,
    ], { encoding: 'utf8' })
    expect(trusted.status, trusted.stderr).toBe(0)
    chmodSync(runtimeImporter, 0o600)
    writeFileSync(runtimeImporter, '#!/bin/bash\nexit 0\n')
    chmodSync(runtimeImporter, 0o700)
    const drifted = spawnSync(process.execPath, [
      runtimeAnchor,
      'assert-tooling',
      '--intent', fixture.intent,
      '--importer', runtimeImporter,
    ], { encoding: 'utf8' })
    expect(drifted.status).not.toBe(0)
    expect(drifted.stderr).toContain('runtime source member changed')
  })

  it('recovers exact retries after crashes before and after atomic capability consumption', () => {
    for (const failpoint of ['after-journal-mkdir', 'after-capability-consumed']) {
      const fixture = createFixture()
      expect(prepare(fixture).status).toBe(0)
      expect(confirm(fixture).status).toBe(0)
      const interrupted = runAtFailpoint(failpoint, ...claimArguments(fixture))
      expect(interrupted.status).not.toBe(0)
      expect(interrupted.stderr).toContain(`test failpoint ${failpoint}`)
      const resumed = claim(fixture)
      expect(resumed.status, resumed.stderr).toBe(0)
      expect(JSON.parse(resumed.stdout)).toMatchObject({ resumed: true, nextState: 'MUTATING' })
      expect(readdirSync(fixture.journal).sort()).toEqual([
        '000001-CLAIMED.json',
        'capability.consumed.json',
      ])
      expect(() => statSync(fixture.capability)).toThrow()
      expect(() => statSync(fixture.token)).toThrow()
    }
  })

  it('requires a fresh confirmation before first MUTATING but treats it as history after mutation starts', () => {
    const before = createFixture()
    expect(prepare(before).status).toBe(0)
    expect(confirm(before).status).toBe(0)
    expect(claim(before).status).toBe(0)
    const receipt = JSON.parse(readFileSync(before.confirmation, 'utf8'))
    const expiredBegin = runAtTime(
      receipt.expiresAt + 1,
      'begin-mutation',
      '--intent', before.intent,
      '--confirmation', before.confirmation,
      '--journal-dir', before.journal,
    )
    expect(expiredBegin.status).not.toBe(0)
    expect(expiredBegin.stderr).toContain('current confirmation capability expired')

    const after = createFixture()
    expect(prepare(after).status).toBe(0)
    expect(confirm(after).status).toBe(0)
    expect(claim(after).status).toBe(0)
    expect(journalCommand(after, 'begin-mutation').status).toBe(0)
    const afterReceipt = JSON.parse(readFileSync(after.confirmation, 'utf8'))
    const continued = runAtTime(
      afterReceipt.expiresAt + 1,
      'verify-target',
      '--intent', after.intent,
      '--confirmation', after.confirmation,
      '--journal-dir', after.journal,
      '--id', after.targets[0].id,
    )
    expect(continued.status, continued.stderr).toBe(0)
  })

  it('rejects a normal process holding the authoritative database open', async () => {
    const fixture = createFixture()
    expect(prepare(fixture).status).toBe(0)
    expect(confirm(fixture).status).toBe(0)
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs')
      fs.openSync(process.argv[1], 'r')
      process.stdout.write('ready\\n')
      setInterval(() => {}, 1000)
    `, fixture.database], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await waitForOutput(holder, 'ready\n')
      const rejected = claim(fixture)
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain('authoritative n8n database family is still open')
    } finally {
      holder.kill('SIGTERM')
    }
  })

  it('resumes monotonically after VERIFIED and attestation crash windows', () => {
    for (const failpoint of ['after-verified', 'after-attestation']) {
      const fixture = createFixture()
      reachAttestationReady(fixture)
      const interrupted = runAtFailpoint(failpoint, ...attestationArguments(fixture))
      expect(interrupted.status).not.toBe(0)
      expect(interrupted.stderr).toContain(`test failpoint ${failpoint}`)
      const resumed = run(...attestationArguments(fixture))
      expect(resumed.status, resumed.stderr).toBe(0)
      expect(JSON.parse(resumed.stdout)).toMatchObject({ resumed: true })
      const verified = journalCommand(fixture, 'verify-transition', '--attestation', fixture.attestation)
      expect(verified.status, verified.stderr).toBe(0)
    }
  })

  it('rejects package, report, journal, permissions and symlink tampering', () => {
    const packageFixture = createFixture()
    const packagePrepared = prepare(packageFixture)
    expect(packagePrepared.status, packagePrepared.stderr).toBe(0)
    chmodSync(packageFixture.rollbackPackage, 0o700)
    chmodSync(join(packageFixture.rollbackPackage, 'manifest.json'), 0o600)
    writeFileSync(join(packageFixture.rollbackPackage, 'manifest.json'), '{}\n')
    chmodSync(join(packageFixture.rollbackPackage, 'manifest.json'), 0o400)
    chmodSync(packageFixture.rollbackPackage, 0o500)
    const packageRejected = confirm(packageFixture)
    expect(packageRejected.status).not.toBe(0)
    expect(packageRejected.stderr).toMatch(/rollback manifest|rollback package/)

    const reportFixture = createFixture()
    const reportPrepared = prepare(reportFixture)
    expect(reportPrepared.status, reportPrepared.stderr).toBe(0)
    expect(confirm(reportFixture).status).toBe(0)
    expect(claim(reportFixture).status).toBe(0)
    expect(journalCommand(reportFixture, 'begin-mutation').status).toBe(0)
    for (const target of reportFixture.targets) {
      const recorded = journalCommand(reportFixture, 'record-workflow', '--id', target.id)
      expect(recorded.status, recorded.stderr).toBe(0)
    }
    createLiveReport(reportFixture)
    chmodSync(reportFixture.liveReport, 0o600)
    const reportRejected = run(
      'attest-transition',
      '--intent', reportFixture.intent,
      '--confirmation', reportFixture.confirmation,
      '--journal-dir', reportFixture.journal,
      '--live-report', reportFixture.liveReport,
      '--verifier', verifier,
      '--output', reportFixture.attestation,
    )
    expect(reportRejected.status).not.toBe(0)
    expect(reportRejected.stderr).toContain('mode must be 400')

    const journalFixture = createFixture()
    reachCommitted(journalFixture)
    const event = readdirSync(journalFixture.journal).find(name => name.startsWith('000002-'))!
    chmodSync(join(journalFixture.journal, event), 0o600)
    writeFileSync(join(journalFixture.journal, event), '{}\n')
    chmodSync(join(journalFixture.journal, event), 0o400)
    expect(journalCommand(journalFixture, 'verify-transition', '--attestation', journalFixture.attestation).status).not.toBe(0)
  })

  it('creates one idempotent bootstrap claim sidecar and rejects a different retry', () => {
    const fixture = createFixture()
    reachCommitted(fixture)
    const claimPath = join(fixture.state, 'bootstrap-claim.json')
    const preparePath = join(fixture.root, 'bootstrap-attempt', 'prepare.json')
    mkdirSync(join(fixture.root, 'bootstrap-attempt'), { mode: 0o700 })
    const args = [
      'claim-bootstrap',
      '--intent', fixture.intent,
      '--confirmation', fixture.confirmation,
      '--journal-dir', fixture.journal,
      '--attestation', fixture.attestation,
      '--prepare-path', preparePath,
      '--slot', 'blue',
      '--release-id', `${targetCommit}-runtime`,
      '--release-root', fixture.appReleaseRoot,
      '--manifest-sha256', sha256(readFileSync(fixture.appManifest)),
      '--output', claimPath,
    ]
    const first = run(...args)
    expect(first.status, first.stderr).toBe(0)
    const second = run(...args)
    expect(second.status, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({
      resumed: true,
      bootstrapAttemptId: JSON.parse(first.stdout).bootstrapAttemptId,
    })
    writeControlled(preparePath, '{"schema":"video-autoworker-legacy-bootstrap-prepare/v1"}\n', 0o400)
    const afterPrepare = run(...args)
    expect(afterPrepare.status, afterPrepare.stderr).toBe(0)
    expect(JSON.parse(afterPrepare.stdout)).toMatchObject({ resumed: true })
    const changed = [...args]
    changed[changed.indexOf('--slot') + 1] = 'green'
    expect(run(...changed).status).not.toBe(0)
  })

  it('places authorization and MUTATING before every n8n workflow database mutation', () => {
    const source = readFileSync(importer, 'utf8')
    const claimIndex = source.indexOf('claim-import')
    const mutatingIndex = source.indexOf('begin-mutation')
    const unpublishIndex = source.indexOf('unpublish:workflow')
    const importIndex = source.indexOf('import:workflow')
    const publishIndex = source.indexOf('publish:workflow')
    expect(claimIndex).toBeGreaterThan(0)
    expect(mutatingIndex).toBeGreaterThan(claimIndex)
    expect(unpublishIndex).toBeGreaterThan(mutatingIndex)
    expect(importIndex).toBeGreaterThan(mutatingIndex)
    expect(publishIndex).toBeGreaterThan(mutatingIndex)
    expect(source).toContain('Refusing workflow mutation without a complete current-confirmed transition capability.')
  })
})
