import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
} from 'node:fs'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GIT_SOURCE_LAYOUT_SCHEMA = 'video-autoworker-git-source-layout/v1'
export const NESTED_PRODUCT_PREFIX = 'video-autoworker/'

const COMMIT = /^[a-f0-9]{40}$/u
const OBJECT_ID = /^[a-f0-9]{40,64}$/u
const ALLOWED_FILE_MODES = new Set(['100644', '100755'])
const PRODUCT_MARKERS = Object.freeze(['package.json', 'pnpm-lock.yaml', 'next.config.js'])
const GIT_ENVIRONMENT_KEYS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
])

export function gitSourceEnvironment(source = process.env) {
  const env = { ...source }
  for (const key of GIT_ENVIRONMENT_KEYS) delete env[key]
  return env
}

/** @returns {never} */
function fail(code) {
  throw new Error(`git_source_layout_${code}`)
}

function physicalDirectory(pathname, label) {
  if (typeof pathname !== 'string' || !pathname || !isAbsolute(pathname)) fail(`${label}_invalid`)
  const expected = resolve(pathname)
  let entry
  let physical
  try {
    entry = lstatSync(expected)
    physical = realpathSync.native(expected)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || physical !== expected) fail(`${label}_unsafe`)
  return physical
}

function git(gitRoot, args, options = {}) {
  try {
    return execFileSync('/usr/bin/git', ['-C', gitRoot, ...args], {
      encoding: options.encoding || 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
      env: gitSourceEnvironment(),
    })
  } catch {
    fail(options.errorCode || 'git_command_failed')
  }
}

function commitId(gitRoot, commit) {
  if (typeof commit !== 'string' || !commit.trim()) fail('commit_invalid')
  const resolved = git(gitRoot, ['rev-parse', '--verify', `${commit}^{commit}`], {
    errorCode: 'commit_invalid',
  }).trim()
  if (!COMMIT.test(resolved)) fail('commit_invalid')
  return resolved
}

export function normalizeProductRelativePath(pathname) {
  if (typeof pathname !== 'string' || !pathname || isAbsolute(pathname)
    || pathname.includes('\\')) fail('product_path_invalid')
  const normalized = posix.normalize(pathname)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')
    || normalized.startsWith(`${NESTED_PRODUCT_PREFIX}`)) fail('product_path_invalid')
  return normalized
}

export function productTreePath(productPrefix, productRelative) {
  if (productPrefix !== '' && productPrefix !== NESTED_PRODUCT_PREFIX) fail('prefix_invalid')
  return `${productPrefix}${normalizeProductRelativePath(productRelative)}`
}

function rawTreeEntry(gitRoot, commit, treePath) {
  const output = git(gitRoot, ['ls-tree', '-z', commit, '--', treePath], {
    encoding: 'buffer', errorCode: 'tree_read_failed',
  }).toString('utf8')
  const records = output.split('\0').filter(Boolean)
  if (records.length !== 1) return null
  const match = /^(\d+)\s+(\w+)\s+([a-f0-9]{40,64})\t(.+)$/u.exec(records[0])
  if (!match || match[4] !== treePath || !OBJECT_ID.test(match[3])) return null
  return { mode: match[1], type: match[2], objectId: match[3], treePath: match[4] }
}

function layoutPresent(gitRoot, commit, prefix) {
  const entries = PRODUCT_MARKERS.map(marker => rawTreeEntry(gitRoot, commit, `${prefix}${marker}`))
  if (entries.some(entry => !entry || entry.type !== 'blob' || !ALLOWED_FILE_MODES.has(entry.mode))) {
    return false
  }
  try {
    const packageJson = JSON.parse(git(gitRoot, ['show', `${commit}:${prefix}package.json`], {
      errorCode: 'package_marker_invalid',
    }))
    return packageJson?.name === 'video-autoworker'
  } catch {
    return false
  }
}

export function resolveGitCommitProductPrefix(gitRootValue, commitValue = 'HEAD') {
  const gitRoot = physicalDirectory(gitRootValue, 'git_root')
  const commit = commitId(gitRoot, commitValue)
  const flat = layoutPresent(gitRoot, commit, '')
  const nested = layoutPresent(gitRoot, commit, NESTED_PRODUCT_PREFIX)
  if (flat === nested) fail('commit_layout_ambiguous')
  return nested ? NESTED_PRODUCT_PREFIX : ''
}

export function resolveGitSourceLayout(productRootValue) {
  const productRoot = physicalDirectory(productRootValue, 'product_root')
  const discovered = git(productRoot, ['rev-parse', '--show-toplevel'], {
    errorCode: 'git_root_missing',
  }).trim()
  const gitRoot = physicalDirectory(discovered, 'git_root')
  const productFromGit = relative(gitRoot, productRoot)
  const productPrefix = productFromGit === ''
    ? ''
    : productFromGit === NESTED_PRODUCT_PREFIX.slice(0, -1)
      ? NESTED_PRODUCT_PREFIX
      : fail('physical_product_root_invalid')
  if (resolveGitCommitProductPrefix(gitRoot, 'HEAD') !== productPrefix) {
    fail('head_layout_mismatch')
  }
  return Object.freeze({ gitRoot, productRoot, productPrefix })
}

export function gitProductTreePath(gitRoot, commit, productRelative) {
  return productTreePath(
    resolveGitCommitProductPrefix(gitRoot, commit),
    productRelative,
  )
}

export function getGitProductFileEntry(gitRootValue, commitValue, productRelativeValue) {
  const gitRoot = physicalDirectory(gitRootValue, 'git_root')
  const commit = commitId(gitRoot, commitValue)
  const productRelative = normalizeProductRelativePath(productRelativeValue)
  const treePath = gitProductTreePath(gitRoot, commit, productRelative)
  const entry = rawTreeEntry(gitRoot, commit, treePath)
  if (!entry || entry.type !== 'blob' || !ALLOWED_FILE_MODES.has(entry.mode)) {
    fail('product_file_invalid')
  }
  return Object.freeze({
    productRelative,
    treePath,
    mode: entry.mode,
    objectId: entry.objectId,
  })
}

export function readGitProductFile(gitRootValue, commitValue, productRelativeValue) {
  const gitRoot = physicalDirectory(gitRootValue, 'git_root')
  const commit = commitId(gitRoot, commitValue)
  const entry = getGitProductFileEntry(gitRoot, commit, productRelativeValue)
  return /** @type {Buffer} */ (git(gitRoot, ['show', `${commit}:${entry.treePath}`], {
    encoding: 'buffer', errorCode: 'product_file_read_failed',
  }))
}

export function sha256GitProductFile(gitRoot, commit, productRelative) {
  return createHash('sha256')
    .update(readGitProductFile(gitRoot, commit, productRelative))
    .digest('hex')
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function hashPhysicalFile(pathname, objectFormat) {
  const before = lstatSync(pathname, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail('verification_file_unsafe')
  }
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!sameFileSnapshot(before, opened)) fail('verification_file_changed')
    const content = createHash('sha256')
    const object = createHash(objectFormat)
    object.update(`blob ${opened.size}\0`)
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      const chunk = buffer.subarray(0, bytes)
      content.update(chunk)
      object.update(chunk)
    }
    const after = fstatSync(descriptor, { bigint: true })
    const current = lstatSync(pathname, { bigint: true })
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, current)) {
      fail('verification_file_changed')
    }
    return Object.freeze({
      sha256: content.digest('hex'), objectId: object.digest('hex'),
      size: Number(after.size), mode: Number(after.mode & 0o7777n),
      dev: after.dev.toString(), ino: after.ino.toString(),
      mtimeNs: after.mtimeNs.toString(), ctimeNs: after.ctimeNs.toString(),
    })
  } finally { closeSync(descriptor) }
}

export function verifyGitProductFiles(productRootValue, commitValue, productRelatives) {
  if (!Array.isArray(productRelatives) || productRelatives.length < 1
    || productRelatives.length > 256) fail('verification_paths_invalid')
  const productRelativesNormalized = productRelatives.map(normalizeProductRelativePath)
  if (new Set(productRelativesNormalized).size !== productRelativesNormalized.length) {
    fail('verification_paths_duplicate')
  }
  const layout = resolveGitSourceLayout(productRootValue)
  const commit = commitId(layout.gitRoot, commitValue)
  if (commitId(layout.gitRoot, 'HEAD') !== commit) fail('head_commit_mismatch')
  const objectFormat = git(layout.gitRoot, ['rev-parse', '--show-object-format'], {
    errorCode: 'object_format_invalid',
  }).trim()
  if (!['sha1', 'sha256'].includes(objectFormat)) fail('object_format_invalid')
  const raw = git(layout.gitRoot, ['ls-tree', '-r', '-z', commit], {
    encoding: 'buffer', errorCode: 'tree_read_failed',
  }).toString('utf8')
  const tree = new Map()
  for (const row of raw.split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+(\w+)\s+([a-f0-9]{40,64})\t(.+)$/u.exec(row)
    if (!match) fail('tree_read_failed')
    tree.set(match[4], { mode: match[1], type: match[2], objectId: match[3] })
  }
  const files = []
  for (const productRelative of productRelativesNormalized) {
    const treePath = productTreePath(layout.productPrefix, productRelative)
    const expected = tree.get(treePath)
    if (!expected || expected.type !== 'blob' || !ALLOWED_FILE_MODES.has(expected.mode)) {
      fail(`verification_file_missing:${productRelative}`)
    }
    const snapshot = hashPhysicalFile(resolve(layout.productRoot, productRelative), objectFormat)
    if (snapshot.objectId !== expected.objectId) {
      fail(`verification_file_mismatch:${productRelative}`)
    }
    const executable = (snapshot.mode & 0o111) !== 0
    if ((expected.mode === '100755') !== executable) {
      fail(`verification_file_mode_mismatch:${productRelative}`)
    }
    files.push({ productRelative, treePath, gitMode: expected.mode,
      objectId: expected.objectId, ...snapshot })
  }
  assertCleanGitSource(layout.productRoot, commit)
  const payload = {
    schema: 'video-autoworker-git-source-verification/v1',
    gitRoot: layout.gitRoot,
    productRoot: layout.productRoot,
    productPrefix: layout.productPrefix,
    commit,
    objectFormat,
    files,
  }
  return Object.freeze({ ...payload,
    closureSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') })
}

/**
 * @param {string} productRoot
 * @param {string | null} [expectedCommit]
 */
export function assertCleanGitSource(productRoot, expectedCommit = null) {
  const layout = resolveGitSourceLayout(productRoot)
  const headCommit = commitId(layout.gitRoot, 'HEAD')
  const expected = expectedCommit === null ? headCommit : commitId(layout.gitRoot, expectedCommit)
  const firstStatus = git(layout.gitRoot, [
    'status', '--porcelain=v1', '--untracked-files=all',
  ], { errorCode: 'status_failed' })
  const finalHeadCommit = commitId(layout.gitRoot, 'HEAD')
  const finalStatus = git(layout.gitRoot, [
    'status', '--porcelain=v1', '--untracked-files=all',
  ], { errorCode: 'status_failed' })
  if (headCommit !== finalHeadCommit || finalHeadCommit !== expected) fail('head_commit_mismatch')
  if (firstStatus !== '' || finalStatus !== '') fail('worktree_not_clean')
  return Object.freeze({ ...layout, headCommit })
}

function usage() {
  return 'usage: git-source-layout.mjs <resolve|assert-clean|tree-path|verify-file|verify-files|show> ...'
}

function cli(argv) {
  const [command, productRoot, productRelative, commit = 'HEAD', expectedMode] = argv
  if (!command || !productRoot) fail('arguments_invalid')
  if (command === 'verify-files' && argv.length >= 4) {
    return verifyGitProductFiles(productRoot, productRelative, argv.slice(3))
  }
  if (command === 'resolve' && argv.length === 2) return resolveGitSourceLayout(productRoot)
  if (command === 'assert-clean' && argv.length >= 2 && argv.length <= 3) {
    return assertCleanGitSource(productRoot, argv[2] || null)
  }
  const layout = resolveGitSourceLayout(productRoot)
  if (command === 'tree-path' && argv.length >= 3 && argv.length <= 4) {
    return { treePath: gitProductTreePath(layout.gitRoot, commit, productRelative) }
  }
  if (command === 'verify-file' && argv.length >= 3 && argv.length <= 5) {
    const entry = getGitProductFileEntry(layout.gitRoot, commit, productRelative)
    if (expectedMode !== undefined && entry.mode !== expectedMode) fail('product_file_mode_mismatch')
    return { ...entry, sha256: sha256GitProductFile(layout.gitRoot, commit, productRelative) }
  }
  if (command === 'show' && argv.length >= 3 && argv.length <= 4) {
    process.stdout.write(readGitProductFile(layout.gitRoot, commit, productRelative))
    return null
  }
  fail('arguments_invalid')
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = cli(process.argv.slice(2))
    if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : usage()}\n`)
    process.exitCode = 1
  }
}
