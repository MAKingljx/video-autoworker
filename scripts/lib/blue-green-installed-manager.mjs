#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyInstalledExecveAdapter } from '../../ops/recovery/install-blue-green-execve-adapter.mjs'

const INSTALLATION_SCHEMA = 'video-autoworker-blue-green-launchd/v2'
const ADAPTER_SCHEMA = 'video-autoworker-blue-green-execve-adapter/v2'
const MANAGER_RELATIVE_PATH = 'scripts/manage-blue-green-services.sh'
const SLOT_LAUNCHER_RELATIVE_PATH = 'scripts/start-standalone-slot.sh'
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u

function fail(message) { throw new Error(`blue-green installed manager resolution failed: ${message}`) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function normalized(pathname, label) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname || /[\u0000-\u001f\u007f]/u.test(pathname)) {
    fail(`${label} must be one normalized absolute path`)
  }
  return pathname
}

function safeEntry(pathname, label, kind, mode = null) {
  normalized(pathname, label)
  let cursor = parse(pathname).root
  for (const part of relative(cursor, pathname).split('/').filter(Boolean)) {
    cursor = join(cursor, part)
    const component = lstatSync(cursor)
    if (component.isSymbolicLink()) fail(`${label} traverses a symlink`)
  }
  const entry = lstatSync(pathname)
  if ((kind === 'file' && !entry.isFile()) || (kind === 'directory' && !entry.isDirectory())) {
    fail(`${label} type is invalid`)
  }
  if (entry.uid !== process.getuid()) fail(`${label} owner is invalid`)
  const actualMode = entry.mode & 0o777
  if (mode === null ? (actualMode & 0o022) !== 0 : actualMode !== mode) fail(`${label} mode is invalid`)
  return entry
}

function readInstallation(pathname) {
  safeEntry(pathname, 'blue-green installation', 'file', 0o600)
  const bytes = readFileSync(pathname)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('blue-green installation is invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('blue-green installation is invalid')
  }
  return { bytes, sha256: sha256(bytes), value }
}

function gitOutput(root, args, options = {}) {
  try {
    return execFileSync('/usr/bin/git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
    })
  } catch { fail(`Git binding failed for ${MANAGER_RELATIVE_PATH}`) }
}

function verifyManagerGitBinding(sourceRoot, expectedCommit) {
  normalized(sourceRoot, 'manager source root')
  if (!COMMIT.test(expectedCommit)) fail('manager source commit is invalid')
  safeEntry(sourceRoot, 'manager source root', 'directory')
  if (realpathSync(sourceRoot) !== sourceRoot) fail('manager source root is not physical')
  const head = gitOutput(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (head !== expectedCommit) fail('manager source HEAD changed')
  if (gitOutput(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']).trim()) {
    fail('manager source worktree is not clean')
  }
  const pathname = join(sourceRoot, MANAGER_RELATIVE_PATH)
  safeEntry(pathname, 'installed blue-green manager', 'file', 0o755)
  if (realpathSync(pathname) !== pathname) fail('installed blue-green manager is not physical')
  const tree = gitOutput(sourceRoot, ['ls-tree', expectedCommit, '--', MANAGER_RELATIVE_PATH]).trim()
  if (!/^100755 blob [a-f0-9]{40}\tscripts\/manage-blue-green-services\.sh$/u.test(tree)) {
    fail('installed blue-green manager Git mode is invalid')
  }
  const committed = gitOutput(sourceRoot, ['show', `${expectedCommit}:${MANAGER_RELATIVE_PATH}`], {
    encoding: null,
  })
  const digest = sha256(readFileSync(pathname))
  if (sha256(committed) !== digest) fail('installed blue-green manager differs from its Git binding')
  return { path: pathname, sha256: digest, sourceCommit: expectedCommit }
}

function rootForBoundLauncher(pathname) {
  normalized(pathname, 'adapted slot launcher')
  const suffix = `/${SLOT_LAUNCHER_RELATIVE_PATH}`
  if (!pathname.endsWith(suffix)) fail('adapted slot launcher path is invalid')
  return pathname.slice(0, -suffix.length)
}

export function assertInstallationSnapshot(pathname, expectedSha256) {
  if (!SHA256.test(expectedSha256)) fail('installation snapshot digest is invalid')
  const current = readInstallation(pathname)
  if (current.sha256 !== expectedSha256) fail('blue-green installation changed during the operation')
  return true
}

export function resolveInstalledBlueGreenManager({
  deploymentProjectRoot,
  runDir,
  releasesDir,
  launchAgentsDir,
}) {
  for (const [label, pathname] of Object.entries({
    deploymentProjectRoot, runDir, releasesDir, launchAgentsDir,
  })) normalized(pathname, label)
  const installationPath = join(runDir, 'supervisor/installation.json')
  const snapshot = readInstallation(installationPath)
  const installation = snapshot.value
  if (installation.schema !== INSTALLATION_SCHEMA || installation.runDir !== runDir
    || installation.releasesDir !== releasesDir || installation.launchAgentsDir !== launchAgentsDir) {
    fail('installation does not match the requested runtime')
  }

  let manager
  let mode
  if (installation.projectRoot === deploymentProjectRoot) {
    const head = gitOutput(deploymentProjectRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
    manager = verifyManagerGitBinding(deploymentProjectRoot, head)
    mode = 'same-project'
  } else {
    const compatibility = installation.recoveryCompatibility
    if (compatibility?.schema !== ADAPTER_SCHEMA || !COMMIT.test(compatibility.sourceCommit || '')
      || !COMMIT.test(compatibility.adapterCommit || '')) {
      fail('cross-project installation lacks an exact execve adapter binding')
    }
    const adapterSourceRoot = rootForBoundLauncher(compatibility.slotRuntime?.launcher?.path || '')
    const proof = verifyInstalledExecveAdapter({
      sourceRoot: installation.projectRoot,
      expectedCommit: compatibility.sourceCommit,
      adapterSourceRoot,
      expectedAdapterCommit: compatibility.adapterCommit,
      installationPath,
      launchAgentsDir,
    })
    if (proof.installation.path !== installationPath || proof.installation.sha256 !== snapshot.sha256) {
      fail('verified execve installation differs from the opened snapshot')
    }
    manager = verifyManagerGitBinding(installation.projectRoot, compatibility.sourceCommit)
    mode = 'adapted-historical'
  }
  assertInstallationSnapshot(installationPath, snapshot.sha256)
  return {
    schema: 'video-autoworker-blue-green-installed-manager/v1',
    mode,
    manager,
    installation: { path: installationPath, sha256: snapshot.sha256 },
  }
}

function parseResolveArguments(argv) {
  if (argv.shift() !== 'resolve') fail('expected resolve')
  const names = new Set(['--project-root', '--run-dir', '--releases-dir', '--launch-agents-dir'])
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!names.has(name) || !value || Object.hasOwn(values, name)) fail('arguments are invalid')
    values[name] = value
  }
  if (Object.keys(values).length !== names.size) fail('arguments are incomplete')
  return {
    deploymentProjectRoot: values['--project-root'],
    runDir: values['--run-dir'],
    releasesDir: values['--releases-dir'],
    launchAgentsDir: values['--launch-agents-dir'],
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'assert-installation') {
    if (argv.length !== 3) fail('assert-installation arguments are invalid')
    assertInstallationSnapshot(argv[1], argv[2])
    return
  }
  const result = resolveInstalledBlueGreenManager(parseResolveArguments([...argv]))
  process.stdout.write(`${result.manager.path}\n${result.installation.path}\n${result.installation.sha256}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
