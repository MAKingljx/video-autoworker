import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  fingerprintPluginPayload,
  validateOfficialOpenClawPeerLink,
} from './aiworker-video-command-upgrade-policy.mjs'

const PLUGIN_BACKUP_NAME = /^upgrade-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u
const TASK_FLOW_BACKUP_NAME = /^[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u
const RELEASE_TRANSACTION_NAME = /^rollback-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u
const GIT_SHA = /^[a-f0-9]{40}$/u
const execFileAsync = promisify(execFile)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function modeOf(fileStat) {
  return fileStat.mode & 0o7777
}

async function optionalLstat(pathname) {
  try {
    return await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function assertNormalizedAbsolute(pathname, label) {
  assert(typeof pathname === 'string' && pathname.length > 0, `${label} is required.`)
  assert(!/[\u0000-\u001f\u007f]/u.test(pathname), `${label} must not contain control characters.`)
  assert(isAbsolute(pathname) && resolve(pathname) === pathname, `${label} must be a normalized absolute path.`)
}

async function assertRealPath(pathname, expectedKind, label, expectedMode) {
  assertNormalizedAbsolute(pathname, label)
  const entry = await lstat(pathname)
  const kindMatches = expectedKind === 'directory' ? entry.isDirectory() : entry.isFile()
  assert(kindMatches && !entry.isSymbolicLink(), `${label} must be a real ${expectedKind}.`)
  assert(await realpath(pathname) === pathname, `${label} must not resolve through a symlink.`)
  if (expectedMode !== undefined) {
    assert(modeOf(entry) === expectedMode, `${label} must have mode ${expectedMode.toString(8)}.`)
  }
  return entry
}

async function assertDirectChild(root, candidate, familyPattern, label) {
  await assertRealPath(root, 'directory', `${label} root`, 0o700)
  await assertRealPath(candidate, 'directory', label, 0o700)
  assert(dirname(candidate) === root, `${label} must be a direct child of its approved root.`)
  assert(familyPattern.test(basename(candidate)), `${label} name is outside its approved family.`)
}

async function readJson(pathname, label) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(pathname, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be a JSON object.`)
  return parsed
}

async function assertRegularFile(pathname, label, expectedMode) {
  const entry = await lstat(pathname)
  assert(entry.isFile() && !entry.isSymbolicLink(), `${label} must be a regular file.`)
  if (expectedMode !== undefined) {
    assert(modeOf(entry) === expectedMode, `${label} must have mode ${expectedMode.toString(8)}.`)
  }
  return entry
}

async function collectEntries(root, { allowedSymlink = null } = {}) {
  const output = []

  async function visit(pathname, relativePath) {
    const entry = await lstat(pathname)
    if (entry.isSymbolicLink()) {
      assert(allowedSymlink && await allowedSymlink(pathname, relativePath), `Symlinks are forbidden in rollback state: ${relativePath}`)
      const target = await readlink(pathname)
      output.push({
        relativePath,
        kind: 'symlink',
        mode: modeOf(entry),
        digest: createHash('sha256').update(target).digest('hex'),
      })
      return
    }
    if (entry.isDirectory()) {
      output.push({ relativePath, kind: 'directory', mode: modeOf(entry), digest: '-' })
      const names = await readdir(pathname)
      // Keep traversal deterministic; manifestText performs the installer's
      // required global byte-order sort after the safety walk is complete.
      names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      for (const name of names) {
        await visit(join(pathname, name), relativePath === '.' ? `./${name}` : `${relativePath}/${name}`)
      }
      return
    }
    assert(entry.isFile(), `Unsupported filesystem object in rollback state: ${relativePath}`)
    const digest = createHash('sha256').update(await readFile(pathname)).digest('hex')
    output.push({ relativePath, kind: 'file', mode: modeOf(entry), digest })
  }

  await visit(root, '.')
  return output
}

function manifestText(entries, excludedRelativePath = null) {
  const globallyByteSorted = entries
    .filter(entry => entry.relativePath !== excludedRelativePath)
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.relativePath),
      Buffer.from(right.relativePath),
    ))
  return `${globallyByteSorted
    .map(entry => `${entry.relativePath}\t${entry.kind}\t${entry.mode.toString(8)}\t${entry.digest}`)
    .join('\n')}\n`
}

async function treeFingerprint(pathname) {
  const entry = await optionalLstat(pathname)
  if (!entry) return 'absent'
  assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Fingerprint target must be a real directory or absent.')
  const hash = createHash('sha256')
  for (const item of await collectEntries(pathname)) {
    hash.update(`${item.relativePath}\0${item.kind}\0${item.mode}\0${item.digest}\0`)
  }
  return hash.digest('hex')
}

async function pluginContentFingerprint(pathname, referencePath = null) {
  const peer = await validateOfficialOpenClawPeerLink(pathname)
  if (referencePath) {
    await validateOfficialOpenClawPeerLink(referencePath, {
      expectedLinkText: peer.linkText,
      expectedRealPath: peer.realPath,
    })
  }
  return fingerprintPluginPayload(pathname)
}

export async function fingerprintAuditedPreviousPlugin(pathname, {
  expectedPeerLinkText,
  expectedPeerRealPath,
} = {}) {
  const peer = await validateOfficialOpenClawPeerLink(pathname, {
    expectedLinkText: expectedPeerLinkText,
    expectedRealPath: expectedPeerRealPath,
  })
  return {
    schemaVersion: 1,
    fingerprint: await fingerprintPluginPayload(pathname, { omitTopLevelNodeModules: true }),
    peer,
  }
}

async function fileFingerprint(pathname) {
  const entry = await optionalLstat(pathname)
  if (!entry) return 'absent'
  assert(entry.isFile() && !entry.isSymbolicLink(), 'Fingerprint target must be a regular file or absent.')
  return createHash('sha256')
    .update(`${modeOf(entry)}\0`)
    .update(await readFile(pathname))
    .digest('hex')
}

function parseTaskState(raw) {
  const lines = raw.split(/\r?\n/u).filter(Boolean)
  assert(lines.length === 4 && lines[0] === 'version=1', 'Task-flow backup STATE must use the exact version-1 shape.')
  const expectedKeys = ['skill_present', 'agents_present', 'memory_present']
  const state = {}
  for (const [index, key] of expectedKeys.entries()) {
    const match = new RegExp(`^${key}=([01])$`, 'u').exec(lines[index + 1])
    assert(match, `Task-flow backup STATE has an invalid ${key} value.`)
    state[key] = match[1] === '1'
  }
  return state
}

async function validateTaskStateShape(stateDir, state) {
  const shapes = [
    ['aiworker-task-flow', 'skill_present', 'directory'],
    ['AGENTS.md', 'agents_present', 'file'],
    ['MEMORY.md', 'memory_present', 'file'],
  ]
  for (const [name, key, kind] of shapes) {
    const payloadPath = join(stateDir, name)
    const absentPath = join(stateDir, `${name}.absent`)
    const payload = await optionalLstat(payloadPath)
    const absent = await optionalLstat(absentPath)
    if (state[key]) {
      assert(payload && !payload.isSymbolicLink(), `Task-flow backup ${name} is missing or unsafe.`)
      assert(kind === 'directory' ? payload.isDirectory() : payload.isFile(), `Task-flow backup ${name} has the wrong type.`)
      assert(!absent, `Task-flow backup ${name} has a conflicting absent marker.`)
    } else {
      assert(!payload, `Task-flow backup ${name} conflicts with its STATE absent flag.`)
      assert(absent?.isFile() && !absent.isSymbolicLink() && absent.size === 0, `Task-flow backup ${name}.absent is invalid.`)
    }
  }
}

async function assertTaskStateLocation(stateDir, label) {
  const stateRoot = dirname(stateDir)
  if (TASK_FLOW_BACKUP_NAME.test(basename(stateDir))) {
    await assertDirectChild(stateRoot, stateDir, TASK_FLOW_BACKUP_NAME, label)
    return
  }
  assert(basename(stateDir) === 'task-current', `${label} has an unsupported directory name.`)
  assert(RELEASE_TRANSACTION_NAME.test(basename(stateRoot)), `${label} must belong to a named release rollback transaction.`)
  await assertRealPath(dirname(stateRoot), 'directory', `${label} transaction root`, 0o700)
  await assertRealPath(stateRoot, 'directory', `${label} transaction`, 0o700)
  await assertRealPath(stateDir, 'directory', label, 0o700)
  assert(dirname(stateRoot) !== stateRoot, `${label} transaction path is invalid.`)
}

export function validateApprovedSha(value) {
  assert(typeof value === 'string' && GIT_SHA.test(value), 'Approved Git SHA must be an explicit lowercase 40-character commit id.')
  return value
}

async function runCanonicalGit(repositoryRoot, args, failureMessage) {
  try {
    return await execFileAsync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    })
  } catch {
    throw new Error(failureMessage)
  }
}

async function validateBackupSourceCommit({ repositoryRoot, sourceCommit, approvedSha }) {
  assert(typeof sourceCommit === 'string' && GIT_SHA.test(sourceCommit), 'Plugin rollback source commit is invalid.')
  if (sourceCommit === approvedSha) return 'target'
  await assertRealPath(repositoryRoot, 'directory', 'Canonical rollback repository')
  const topLevel = (await runCanonicalGit(
    repositoryRoot,
    ['rev-parse', '--show-toplevel'],
    'Canonical rollback repository is not a readable Git worktree.',
  )).stdout.trim()
  assertNormalizedAbsolute(topLevel, 'Canonical Git top-level')
  assert(
    await realpath(topLevel) === repositoryRoot,
    'Rollback repository path is not the canonical Git top-level.',
  )
  for (const [commit, label] of [[sourceCommit, 'Backup source'], [approvedSha, 'Approved target']]) {
    await runCanonicalGit(
      repositoryRoot,
      ['cat-file', '-e', `${commit}^{commit}`],
      `${label} commit object is missing from the canonical repository.`,
    )
  }
  await runCanonicalGit(
    repositoryRoot,
    ['merge-base', '--is-ancestor', sourceCommit, approvedSha],
    'Plugin rollback source commit is not the approved target or its ancestor.',
  )
  return 'ancestor'
}

async function validateCanonicalPluginSource({ repositoryRoot, pluginSourcePath, sourcePluginFingerprint }) {
  await assertRealPath(repositoryRoot, 'directory', 'Canonical rollback repository')
  await assertRealPath(pluginSourcePath, 'directory', 'Canonical plugin source')
  const sourceRelativePath = relative(repositoryRoot, pluginSourcePath)
  assert(
    sourceRelativePath.length > 0
      && sourceRelativePath !== '..'
      && !sourceRelativePath.startsWith(`..${sep}`)
      && !isAbsolute(sourceRelativePath),
    'Canonical plugin source must be contained by the rollback repository.',
  )
  assert(
    await fingerprintPluginPayload(pluginSourcePath) === sourcePluginFingerprint,
    'Canonical plugin source no longer matches the rollback backup payload fingerprint.',
  )
}

export async function validateRollbackBackupProvenance({
  repositoryRoot,
  pluginSourcePath,
  sourceCommit,
  approvedSha,
  sourcePluginFingerprint,
}) {
  validateApprovedSha(approvedSha)
  assert(/^[a-f0-9]{64}$/u.test(sourcePluginFingerprint), 'Approved source plugin payload fingerprint is invalid.')
  const sourceCommitRelation = await validateBackupSourceCommit({ repositoryRoot, sourceCommit, approvedSha })
  await validateCanonicalPluginSource({ repositoryRoot, pluginSourcePath, sourcePluginFingerprint })
  return { schemaVersion: 1, sourceCommit, sourceCommitRelation, approvedSha, sourcePluginFingerprint }
}

export async function validatePluginRollbackBackup({
  backupRoot,
  backupDir,
  approvedSha,
  installedPluginPath,
  repositoryRoot,
  pluginSourcePath,
  pluginId = 'aiworker-video-command',
  oldVersion = '0.2.0',
}) {
  validateApprovedSha(approvedSha)
  assertNormalizedAbsolute(installedPluginPath, 'Installed plugin path')
  await assertDirectChild(backupRoot, backupDir, PLUGIN_BACKUP_NAME, 'Plugin rollback backup')
  const previousPlugin = join(backupDir, 'previous-plugin')
  const installedPeer = await validateOfficialOpenClawPeerLink(installedPluginPath)
  await validateOfficialOpenClawPeerLink(previousPlugin, {
    expectedLinkText: installedPeer.linkText,
    expectedRealPath: installedPeer.realPath,
  })
  await collectEntries(backupDir, {
    allowedSymlink: async (linkPath, relativePath) =>
      relativePath === './previous-plugin/node_modules/openclaw'
      && linkPath === join(previousPlugin, 'node_modules', 'openclaw'),
  })

  const requiredMode600 = [
    '.verified',
    'openclaw-current.json',
    'pre-0.2-openclaw.json',
    'pre-0.2-effective-tools.json',
    'current-0.2-effective-tools.json',
    'install-index-old.json',
    'owner-sender-policy.json',
    'source-commit.txt',
    'source-plugin-payload-sha256.txt',
    'previous-plugin-payload-sha256.txt',
  ]
  for (const name of requiredMode600) {
    await assertRegularFile(join(backupDir, name), `Plugin rollback backup ${name}`, 0o600)
  }
  const verified = await stat(join(backupDir, '.verified'))
  assert(verified.size === 0, 'Plugin rollback .verified marker must be empty.')
  assert(!await optionalLstat(join(backupDir, '.active-rollback-source.json')), 'Plugin rollback backup is already an active rollback source.')

  const sourceCommit = (await readFile(join(backupDir, 'source-commit.txt'), 'utf8')).trim()
  const sourcePluginFingerprint = (await readFile(
    join(backupDir, 'source-plugin-payload-sha256.txt'),
    'utf8',
  )).trim()
  assert(/^[a-f0-9]{64}$/u.test(sourcePluginFingerprint), 'Approved source plugin payload fingerprint is invalid.')
  let sourceCommitRelation
  if (repositoryRoot !== undefined || pluginSourcePath !== undefined) {
    const provenance = await validateRollbackBackupProvenance({
      repositoryRoot,
      pluginSourcePath,
      sourceCommit,
      approvedSha,
      sourcePluginFingerprint,
    })
    sourceCommitRelation = provenance.sourceCommitRelation
  } else {
    sourceCommitRelation = await validateBackupSourceCommit({ repositoryRoot, sourceCommit, approvedSha })
  }
  const previousPluginFingerprint = (await readFile(
    join(backupDir, 'previous-plugin-payload-sha256.txt'),
    'utf8',
  )).trim()
  assert(/^[a-f0-9]{64}$/u.test(previousPluginFingerprint), 'Audited previous-plugin payload fingerprint is invalid.')

  const previousEntry = await lstat(previousPlugin)
  assert(previousEntry.isDirectory() && !previousEntry.isSymbolicLink(), 'Plugin rollback previous-plugin must be a real directory.')
  const packageJson = await readJson(join(previousPlugin, 'package.json'), 'rollback package.json')
  const pluginManifest = await readJson(join(previousPlugin, 'openclaw.plugin.json'), 'rollback plugin manifest')
  assert(packageJson.version === oldVersion, `Rollback plugin package must be ${oldVersion}.`)
  assert(pluginManifest.id === pluginId, 'Rollback plugin manifest id mismatch.')
  assert(
    isDeepStrictEqual(pluginManifest?.activation?.onCapabilities, ['hook', 'tool']),
    'Rollback plugin must retain the known 0.2 hook-and-tool capability shape.',
  )
  assert(
    isDeepStrictEqual(pluginManifest?.contracts?.tools, ['aiworker_analyze_video']),
    'Rollback plugin must retain the known 0.2 optional tool contract.',
  )
  const currentPreviousPlugin = await fingerprintAuditedPreviousPlugin(previousPlugin, {
    expectedPeerLinkText: installedPeer.linkText,
    expectedPeerRealPath: installedPeer.realPath,
  })
  assert(
    currentPreviousPlugin.fingerprint === previousPluginFingerprint,
    'Rollback previous-plugin payload changed after its audited backup fingerprint was created.',
  )

  const oldIndex = await readJson(join(backupDir, 'install-index-old.json'), 'backed-up 0.2 install index')
  assert(oldIndex.source === 'path', 'Backed-up 0.2 index source must be path.')
  assert(oldIndex.version === oldVersion, `Backed-up plugin index must be ${oldVersion}.`)
  assert(oldIndex.installPath === installedPluginPath, 'Backed-up plugin index installPath mismatch.')
  assertNormalizedAbsolute(oldIndex.sourcePath, 'Backed-up plugin index sourcePath')
  assert(typeof oldIndex.installedAt === 'string' && Number.isFinite(Date.parse(oldIndex.installedAt)), 'Backed-up plugin index timestamp is invalid.')

  return {
    schemaVersion: 1,
    approvedSha,
    sourceCommit,
    sourceCommitRelation,
    sourcePluginFingerprint,
    backupDir,
    previousPlugin,
    previousPluginFingerprint,
    configFingerprint: await fileFingerprint(join(backupDir, 'openclaw-current.json')),
    oldIndex,
  }
}

export async function validateTaskFlowRollbackBackup({ backupRoot, backupDir }) {
  await assertDirectChild(backupRoot, backupDir, TASK_FLOW_BACKUP_NAME, 'Task-flow rollback backup')
  const statePath = join(backupDir, 'STATE')
  const manifestPath = join(backupDir, 'MANIFEST.sha256')
  await assertRegularFile(statePath, 'Task-flow rollback STATE', 0o600)
  await assertRegularFile(manifestPath, 'Task-flow rollback manifest', 0o600)
  const entries = await collectEntries(backupDir)
  const expectedManifest = await readFile(manifestPath, 'utf8')
  assert(
    expectedManifest === manifestText(entries, './MANIFEST.sha256'),
    'Task-flow rollback manifest does not match the complete backup payload.',
  )
  const state = parseTaskState(await readFile(statePath, 'utf8'))
  await validateTaskStateShape(backupDir, state)
  return {
    schemaVersion: 1,
    backupDir,
    state,
    manifestSha256: createHash('sha256').update(expectedManifest).digest('hex'),
  }
}

export async function snapshotTaskFlowState({ workspaceRoot, destination }) {
  await assertRealPath(workspaceRoot, 'directory', 'Task-flow workspace')
  assertNormalizedAbsolute(destination, 'Task-flow transaction snapshot')
  assert(dirname(destination) !== destination, 'Task-flow transaction snapshot path is invalid.')
  assert(!await optionalLstat(destination), 'Task-flow transaction snapshot must not already exist.')
  await mkdir(destination, { mode: 0o700 })
  await chmod(destination, 0o700)

  const sources = [
    ['skills/aiworker-task-flow', 'aiworker-task-flow', 'skill_present', 'directory'],
    ['AGENTS.md', 'AGENTS.md', 'agents_present', 'file'],
    ['MEMORY.md', 'MEMORY.md', 'memory_present', 'file'],
  ]
  const state = {}
  for (const [sourceRelative, targetName, stateKey, kind] of sources) {
    const source = join(workspaceRoot, sourceRelative)
    const entry = await optionalLstat(source)
    if (!entry) {
      state[stateKey] = false
      await writeFile(join(destination, `${targetName}.absent`), '', { mode: 0o600, flag: 'wx' })
      continue
    }
    assert(!entry.isSymbolicLink(), `Current task-flow ${sourceRelative} must not be a symlink.`)
    assert(kind === 'directory' ? entry.isDirectory() : entry.isFile(), `Current task-flow ${sourceRelative} has the wrong type.`)
    if (kind === 'directory') await collectEntries(source)
    state[stateKey] = true
    await cp(source, join(destination, targetName), { recursive: kind === 'directory', preserveTimestamps: true, errorOnExist: true })
  }
  const stateText = `version=1\nskill_present=${state.skill_present ? 1 : 0}\nagents_present=${state.agents_present ? 1 : 0}\nmemory_present=${state.memory_present ? 1 : 0}\n`
  await writeFile(join(destination, 'STATE'), stateText, { mode: 0o600, flag: 'wx' })
  const entries = await collectEntries(destination)
  await writeFile(join(destination, 'MANIFEST.sha256'), manifestText(entries), { mode: 0o600, flag: 'wx' })
  await assertTaskStateLocation(destination, 'Task-flow transaction snapshot')
  const entriesAfterWrite = await collectEntries(destination)
  assert(
    await readFile(join(destination, 'MANIFEST.sha256'), 'utf8') === manifestText(entriesAfterWrite, './MANIFEST.sha256'),
    'Task-flow transaction snapshot manifest self-check failed.',
  )
  return {
    schemaVersion: 1,
    backupDir: destination,
    state,
  }
}

async function replacePathFromState({ source, target, present, kind, stagingRoot }) {
  const targetEntry = await optionalLstat(target)
  assert(!targetEntry?.isSymbolicLink(), `Rollback target must not be a symlink: ${target}`)
  if (targetEntry) {
    assert(kind === 'directory' ? targetEntry.isDirectory() : targetEntry.isFile(), `Rollback target has an unexpected type: ${target}`)
  }
  const staged = join(stagingRoot, basename(target))
  if (present) {
    await cp(source, staged, { recursive: kind === 'directory', preserveTimestamps: true, errorOnExist: true })
  }
  if (targetEntry) await rm(target, { recursive: kind === 'directory', force: false })
  if (present) await rename(staged, target)
}

export async function restoreTaskFlowState({ workspaceRoot, stateDir, stagingRoot }) {
  await assertRealPath(workspaceRoot, 'directory', 'Task-flow workspace')
  assertNormalizedAbsolute(stagingRoot, 'Task-flow rollback staging path')
  assert(dirname(stagingRoot) === workspaceRoot, 'Task-flow rollback staging must be a direct child of the workspace.')
  assert(!await optionalLstat(stagingRoot), 'Task-flow rollback staging path must not already exist.')

  await assertTaskStateLocation(stateDir, 'Task-flow rollback state')
  const state = parseTaskState(await readFile(join(stateDir, 'STATE'), 'utf8'))
  await validateTaskStateShape(stateDir, state)
  const entries = await collectEntries(stateDir)
  assert(
    await readFile(join(stateDir, 'MANIFEST.sha256'), 'utf8') === manifestText(entries, './MANIFEST.sha256'),
    'Task-flow rollback state changed after validation.',
  )

  await mkdir(stagingRoot, { mode: 0o700 })
  await chmod(stagingRoot, 0o700)
  try {
    const skillsRoot = join(workspaceRoot, 'skills')
    const skillsEntry = await optionalLstat(skillsRoot)
    assert(skillsEntry?.isDirectory() && !skillsEntry.isSymbolicLink(), 'Workspace skills root must be a real directory.')
    await replacePathFromState({
      source: join(stateDir, 'aiworker-task-flow'),
      target: join(skillsRoot, 'aiworker-task-flow'),
      present: state.skill_present,
      kind: 'directory',
      stagingRoot,
    })
    await replacePathFromState({
      source: join(stateDir, 'AGENTS.md'),
      target: join(workspaceRoot, 'AGENTS.md'),
      present: state.agents_present,
      kind: 'file',
      stagingRoot,
    })
    await replacePathFromState({
      source: join(stateDir, 'MEMORY.md'),
      target: join(workspaceRoot, 'MEMORY.md'),
      present: state.memory_present,
      kind: 'file',
      stagingRoot,
    })
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
  await assertTaskFlowStateMatches({ workspaceRoot, stateDir })
}

export async function assertTaskFlowStateMatches({ workspaceRoot, stateDir }) {
  await assertRealPath(workspaceRoot, 'directory', 'Task-flow workspace')
  const state = parseTaskState(await readFile(join(stateDir, 'STATE'), 'utf8'))
  const comparisons = [
    ['skills/aiworker-task-flow', 'aiworker-task-flow', 'skill_present', 'directory'],
    ['AGENTS.md', 'AGENTS.md', 'agents_present', 'file'],
    ['MEMORY.md', 'MEMORY.md', 'memory_present', 'file'],
  ]
  for (const [currentRelative, backupName, stateKey, kind] of comparisons) {
    const current = join(workspaceRoot, currentRelative)
    const expected = join(stateDir, backupName)
    const currentEntry = await optionalLstat(current)
    if (!state[stateKey]) {
      assert(!currentEntry, `Current ${currentRelative} should be absent after rollback.`)
      continue
    }
    assert(currentEntry && !currentEntry.isSymbolicLink(), `Current ${currentRelative} is missing or unsafe after rollback.`)
    if (kind === 'directory') {
      assert(await treeFingerprint(current) === await treeFingerprint(expected), `Current ${currentRelative} does not exactly match the rollback state.`)
    } else {
      assert(await fileFingerprint(current) === await fileFingerprint(expected), `Current ${currentRelative} does not exactly match the rollback state.`)
    }
  }
}

export function validateSafeEquivalentIndex({ oldIndex, currentIndex, expectedSourcePath, installedPluginPath }) {
  assertNormalizedAbsolute(expectedSourcePath, 'Active rollback sourcePath')
  assertNormalizedAbsolute(installedPluginPath, 'Installed plugin path')
  for (const [record, label] of [[oldIndex, 'Backed-up index'], [currentIndex, 'Current index']]) {
    assert(record && typeof record === 'object' && !Array.isArray(record), `${label} must be an object.`)
    assert(record.source === 'path', `${label} source must be path.`)
    assert(record.version === '0.2.0', `${label} version must be 0.2.0.`)
    assert(record.installPath === installedPluginPath, `${label} installPath mismatch.`)
    assert(typeof record.installedAt === 'string' && Number.isFinite(Date.parse(record.installedAt)), `${label} installedAt is invalid.`)
  }
  assert(currentIndex.sourcePath === expectedSourcePath, 'Current 0.2 index must point to the explicit verified backup payload.')
  return {
    schemaVersion: 1,
    kind: 'safe-semantic-0.2-index-restoration',
    oldSourcePath: oldIndex.sourcePath,
    activeSourcePath: currentIndex.sourcePath,
    byteIdentical: isDeepStrictEqual(oldIndex, currentIndex),
  }
}

export async function fingerprintPath(pathname) {
  const entry = await optionalLstat(pathname)
  if (!entry) return 'absent'
  if (entry.isDirectory() && !entry.isSymbolicLink()) return treeFingerprint(pathname)
  if (entry.isFile() && !entry.isSymbolicLink()) return fileFingerprint(pathname)
  throw new Error('Fingerprint path must be a regular file, real directory, or absent.')
}

export async function fingerprintPluginContent(pathname, referencePath = null) {
  return pluginContentFingerprint(pathname, referencePath)
}
