import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
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
  return 'usage: git-source-layout.mjs <resolve|assert-clean|tree-path|verify-file|show> ...'
}

function cli(argv) {
  const [command, productRoot, productRelative, commit = 'HEAD', expectedMode] = argv
  if (!command || !productRoot) fail('arguments_invalid')
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
