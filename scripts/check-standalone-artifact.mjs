#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FORBIDDEN_STANDALONE_NAMES = new Set([
  '.phoenixbrain',
  '.git',
  '.env',
  'test-catalog.json',
])

const FORBIDDEN_CREDENTIAL_NAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.ssh',
  'id_rsa',
  'id_ed25519',
])

const FORBIDDEN_CREDENTIAL_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']

const FORBIDDEN_DEVELOPMENT_DIRECTORY_NAMES = new Set([
  '.cache',
  '.playwright-cli',
  '.playwright-mcp',
  '.pytest_cache',
  '.tmp',
  '__pycache__',
  '__tests__',
  'coverage',
  'docs',
  'e2e-openclaw',
  'output',
  'playwright-report',
  'src',
  'src-tauri',
  'test',
  'test-results',
  'tests',
  'wiki',
])

const FORBIDDEN_COMPILED_OUTPUT_DIRECTORY_NAMES = new Set([
  '.cache',
  '.playwright-cli',
  '.playwright-mcp',
  '.pytest_cache',
  '.tmp',
  '__pycache__',
  'cache',
  'coverage',
  'output',
  'playwright-report',
  'test-results',
])

const FORBIDDEN_RUNTIME_FILE_SUFFIXES = [
  '.db',
  '.db-shm',
  '.db-wal',
  '.log',
  '.pid',
  '.sqlite',
  '.sqlite-shm',
  '.sqlite-wal',
  '.sqlite3',
  '.sqlite3-shm',
  '.sqlite3-wal',
  '.tsbuildinfo',
]

const FORBIDDEN_SOURCE_FILE_SUFFIXES = [
  '.cts',
  '.jsx',
  '.map',
  '.mts',
  '.nft.json',
  '.ts',
  '.tsx',
]

const ALLOWED_STANDALONE_ROOT_DIRECTORIES = new Set([
  '.next',
  'messages',
  'node_modules',
  'openclaw-plugins',
  'openclaw-skills',
  'ops',
  'public',
  'runtime',
  'scripts',
])

const ALLOWED_STANDALONE_ROOT_FILES = new Set([
  'openapi.json',
  'package.json',
  'release-manifest.json',
  'server.js',
])

const ALLOWED_NEXT_ROOT_DIRECTORIES = new Set([
  'node_modules',
  'server',
  'static',
])

const ALLOWED_NEXT_ROOT_FILES = new Set([
  'app-path-routes-manifest.json',
  'build-manifest.json',
  'build_id',
  'package.json',
  'prerender-manifest.json',
  'required-server-files.json',
  'routes-manifest.json',
])

const ALLOWED_STANDALONE_SCRIPT_PATHS = new Set([
  'scripts/feishu-director-brain.mjs',
  'scripts/install-aiworker-director-brain.sh',
  'scripts/verify-shared-runtime-install-gate.mjs',
  'scripts/lib/feishu-director-brain.mjs',
  'scripts/lib/runtime-safe-offline-queue.mjs',
  'scripts/lib/openclaw-secret-reference.mjs',
  'scripts/lib/shared-deployment-lock.mjs',
  'scripts/lib/shared-deployment-lock.sh',
])

const ALLOWED_STANDALONE_OPS_PATHS = new Set([
  'ops/feishu-director-brain/schema.json',
])

const ALLOWED_STANDALONE_PLUGIN_NAMES = new Set([
  'aiworker-director-brain',
  'aiworker-video-command',
])

const ALLOWED_STANDALONE_SKILL_NAMES = new Set([
  'aiworker-director-brain',
  'aiworker-task-flow',
])

const ALLOWED_SERVER_CHUNK_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.json',
  '.mjs',
  '.node',
  '.wasm',
])

const ALLOWED_FIRST_PARTY_RUNTIME_EXTENSIONS = new Set([
  '.js',
  '.json',
  '.md',
  '.mjs',
])

const REQUIRED_STANDALONE_FILES = [
  '.next/BUILD_ID',
  '.next/package.json',
  '.next/required-server-files.json',
  'openapi.json',
  'openclaw-plugins/aiworker-director-brain/index.js',
  'openclaw-plugins/aiworker-director-brain/lib/director-brain-tool.js',
  'openclaw-plugins/aiworker-director-brain/openclaw.plugin.json',
  'openclaw-plugins/aiworker-director-brain/package.json',
  'openclaw-skills/aiworker-director-brain/SKILL.md',
  'openclaw-skills/aiworker-task-flow/SKILL.md',
  'ops/feishu-director-brain/schema.json',
  'package.json',
  'runtime/schema.sql',
  'scripts/feishu-director-brain.mjs',
  'scripts/install-aiworker-director-brain.sh',
  'scripts/verify-shared-runtime-install-gate.mjs',
  'scripts/lib/feishu-director-brain.mjs',
  'scripts/lib/runtime-safe-offline-queue.mjs',
  'scripts/lib/openclaw-secret-reference.mjs',
  'scripts/lib/shared-deployment-lock.mjs',
  'scripts/lib/shared-deployment-lock.sh',
  'server.js',
]

const REQUIRED_STANDALONE_DIRECTORIES = [
  '.next/server',
  '.next/static',
  'messages',
  'node_modules/.pnpm',
  'public',
]

const RELEASE_MANIFEST_NAME = 'release-manifest.json'

function isAllowedPathOrDirectoryAncestor(pathname, allowedPaths, isDirectory) {
  if (allowedPaths.has(pathname)) return true
  return isDirectory && [...allowedPaths].some(allowed => allowed.startsWith(`${pathname}/`))
}

function isDeclaredStandalonePath(normalizedSegments, { isDirectory = false } = {}) {
  const rootName = normalizedSegments[0] || ''
  if (normalizedSegments.length === 1) {
    return isDirectory
      ? ALLOWED_STANDALONE_ROOT_DIRECTORIES.has(rootName)
      : ALLOWED_STANDALONE_ROOT_FILES.has(rootName)
  }

  if (rootName === '.next') {
    const nextMember = normalizedSegments[1]
    if (normalizedSegments.length === 2) {
      return isDirectory
        ? ALLOWED_NEXT_ROOT_DIRECTORIES.has(nextMember)
        : ALLOWED_NEXT_ROOT_FILES.has(nextMember)
    }
    return ALLOWED_NEXT_ROOT_DIRECTORIES.has(nextMember)
  }

  if (['messages', 'node_modules', 'public'].includes(rootName)) return true

  const pathname = normalizedSegments.join('/')
  if (rootName === 'scripts') {
    return isAllowedPathOrDirectoryAncestor(pathname, ALLOWED_STANDALONE_SCRIPT_PATHS, isDirectory)
  }
  if (rootName === 'ops') {
    return isAllowedPathOrDirectoryAncestor(pathname, ALLOWED_STANDALONE_OPS_PATHS, isDirectory)
  }
  if (rootName === 'runtime') {
    return pathname === 'runtime/schema.sql' && !isDirectory
  }

  if (rootName === 'openclaw-plugins') {
    const pluginName = normalizedSegments[1]
    if (!ALLOWED_STANDALONE_PLUGIN_NAMES.has(pluginName)) return false
    if (normalizedSegments.length === 2) return isDirectory
    const member = normalizedSegments[2]
    if (['index.js', 'openclaw.plugin.json', 'package.json'].includes(member)) {
      return normalizedSegments.length === 3 && !isDirectory
    }
    if (!['lib', 'scripts'].includes(member)) return false
    if (isDirectory) return true
    return normalizedSegments.length > 3
      && ALLOWED_FIRST_PARTY_RUNTIME_EXTENSIONS.has(extname(pathname).toLowerCase())
  }

  if (rootName === 'openclaw-skills') {
    const skillName = normalizedSegments[1]
    if (!ALLOWED_STANDALONE_SKILL_NAMES.has(skillName)) return false
    if (normalizedSegments.length === 2) return isDirectory
    const member = normalizedSegments[2]
    if (member === 'skill.md' || /^workspace_[a-z0-9_-]+\.md$/u.test(member)) {
      return normalizedSegments.length === 3 && !isDirectory
    }
    if (!['lib', 'scripts'].includes(member)) return false
    if (isDirectory) return true
    return normalizedSegments.length > 3
      && ALLOWED_FIRST_PARTY_RUNTIME_EXTENSIONS.has(extname(pathname).toLowerCase())
  }

  return false
}

export function isForbiddenStandaloneName(name) {
  const normalized = name.toLowerCase()
  return FORBIDDEN_STANDALONE_NAMES.has(normalized)
    || FORBIDDEN_CREDENTIAL_NAMES.has(normalized)
    || normalized.startsWith('.env')
    || FORBIDDEN_CREDENTIAL_EXTENSIONS.some(extension => normalized.endsWith(extension))
}

export function isForbiddenStandalonePath(relativePath, { isDirectory = false } = {}) {
  const segments = relativePath.split('/').filter(Boolean)
  const normalizedSegments = segments.map(segment => segment.toLowerCase())
  const name = normalizedSegments.at(-1) || ''
  if (isForbiddenStandaloneName(name)) return true
  if (!isDeclaredStandalonePath(normalizedSegments, { isDirectory })) return true
  if (!isDirectory && FORBIDDEN_SOURCE_FILE_SUFFIXES.some(suffix => name.endsWith(suffix))) return true

  // Third-party packages commonly ship source, tests, fixtures, logs, or sample
  // databases. They are part of the traced dependency tree, not leaked project
  // state. Source maps and source-language files remain forbidden everywhere.
  if (normalizedSegments.includes('node_modules')) return false
  const insideCompiledNext = normalizedSegments[0] === '.next'
  if (isDirectory && (
    FORBIDDEN_COMPILED_OUTPUT_DIRECTORY_NAMES.has(name)
    || (!insideCompiledNext && FORBIDDEN_DEVELOPMENT_DIRECTORY_NAMES.has(name))
  )) return true
  return !isDirectory && FORBIDDEN_RUNTIME_FILE_SUFFIXES.some(suffix => name.endsWith(suffix))
}

export async function findForbiddenStandaloneMembers(rootPath) {
  const root = resolve(rootPath)
  const forbidden = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathname = resolve(directory, entry.name)
      const member = relative(root, pathname).split('\\').join('/') || entry.name
      if (isForbiddenStandalonePath(member, { isDirectory: entry.isDirectory() })) {
        forbidden.push(member)
        continue
      }
      if (entry.isDirectory()) await visit(pathname)
    }
  }

  await visit(root)
  return forbidden.sort()
}

function isPathInside(parentPath, childPath, { allowSame = false } = {}) {
  const boundary = relative(parentPath, childPath)
  return (allowSame || boundary !== '')
    && !boundary.startsWith('..')
    && !isAbsolute(boundary)
}

export async function assertStandalonePhysicalRoot(rootPath) {
  const root = resolve(rootPath)
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('standalone_root_not_physical_directory')
  }
  return { root, physicalRoot: await realpath(root) }
}

async function assertSafeMutationPath(rootPath, pathname, label) {
  const { root, physicalRoot } = await assertStandalonePhysicalRoot(rootPath)
  const target = resolve(pathname)
  if (!isPathInside(root, target)) throw new Error(`${label}_boundary`)

  let existingParent = dirname(target)
  while (!(await lstat(existingParent).catch(() => null))) {
    const parent = dirname(existingParent)
    if (parent === existingParent) throw new Error(`${label}_parent_missing`)
    existingParent = parent
  }
  const physicalParent = await realpath(existingParent)
  if (!isPathInside(physicalRoot, physicalParent, { allowSame: true })) {
    throw new Error(`${label}_physical_boundary`)
  }
}

async function listDirectPackageLinks(nodeModulesPath) {
  const links = []
  const entries = await readdir(nodeModulesPath, { withFileTypes: true })
  for (const entry of entries) {
    const pathname = resolve(nodeModulesPath, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(pathname)
      continue
    }
    if (!entry.isDirectory() || !entry.name.startsWith('@')) continue
    const scopedEntries = await readdir(pathname, { withFileTypes: true })
    for (const scopedEntry of scopedEntries) {
      if (scopedEntry.isSymbolicLink()) links.push(resolve(pathname, scopedEntry.name))
    }
  }
  return links
}

export async function repairStandalonePnpmLinks(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const projectRoot = resolve(projectRootPath)
  const sourceStore = resolve(projectRoot, 'node_modules/.pnpm')
  const outputStore = resolve(root, 'node_modules/.pnpm')
  const unsafeLinks = await findUnsafeStandaloneLinks(root)
  if (unsafeLinks.length > 0) {
    throw new Error(`standalone_unsafe_links:${unsafeLinks.join(',')}`)
  }

  const sourceStoreStat = await lstat(sourceStore).catch(() => null)
  if (!sourceStoreStat?.isDirectory() || sourceStoreStat.isSymbolicLink()) {
    throw new Error('standalone_pnpm_source_store_missing')
  }
  const outputStoreStat = await lstat(outputStore).catch(() => null)
  if (!outputStoreStat?.isDirectory() || outputStoreStat.isSymbolicLink()) {
    throw new Error('standalone_pnpm_output_store_missing')
  }

  const sourceStorePhysical = await realpath(sourceStore)
  const outputStorePhysical = await realpath(outputStore)
  const outputPackages = await readdir(outputStore, { withFileTypes: true })
  const repairedLinks = []

  for (const entry of outputPackages) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const sourcePackageModules = resolve(sourceStore, entry.name, 'node_modules')
    const outputPackageModules = resolve(outputStore, entry.name, 'node_modules')
    const sourceModulesStat = await lstat(sourcePackageModules).catch(() => null)
    if (!sourceModulesStat?.isDirectory() || sourceModulesStat.isSymbolicLink()) {
      throw new Error(`standalone_pnpm_source_package_missing:${entry.name}`)
    }
    const outputModulesStat = await lstat(outputPackageModules).catch(() => null)
    if (!outputModulesStat?.isDirectory() || outputModulesStat.isSymbolicLink()) {
      throw new Error(`standalone_pnpm_output_package_missing:${entry.name}`)
    }

    for (const sourceLink of await listDirectPackageLinks(sourcePackageModules)) {
      const packageRelativePath = relative(sourcePackageModules, sourceLink)
      const outputLink = resolve(outputPackageModules, packageRelativePath)
      const linkTarget = await readlink(sourceLink)
      const linkIdentity = `${entry.name}/node_modules/${packageRelativePath}`.split('\\').join('/')
      if (isAbsolute(linkTarget)) {
        throw new Error(`standalone_pnpm_absolute_link:${linkIdentity}`)
      }

      const sourceTarget = resolve(dirname(sourceLink), linkTarget)
      const outputTarget = resolve(dirname(outputLink), linkTarget)
      const sourceTargetStat = await stat(sourceTarget).catch(() => null)
      if (!sourceTargetStat) {
        throw new Error(`standalone_pnpm_source_target_missing:${linkIdentity}`)
      }
      const outputTargetStat = await stat(outputTarget).catch(() => null)
      if (!outputTargetStat) {
        throw new Error(`standalone_pnpm_output_target_missing:${linkIdentity}`)
      }
      const sourceTargetPhysical = await realpath(sourceTarget)
      const outputTargetPhysical = await realpath(outputTarget)
      if (
        !isPathInside(sourceStorePhysical, sourceTargetPhysical)
        || !isPathInside(outputStorePhysical, outputTargetPhysical)
      ) {
        throw new Error(`standalone_pnpm_link_boundary:${linkIdentity}`)
      }

      const existing = await lstat(outputLink).catch(() => null)
      if (!(existing?.isSymbolicLink() && await readlink(outputLink) === linkTarget)) {
        await assertSafeMutationPath(root, outputLink, 'standalone_pnpm_link')
        if (existing) await rm(outputLink, { recursive: true, force: true })
        await mkdir(dirname(outputLink), { recursive: true })
        await symlink(linkTarget, outputLink)
        repairedLinks.push(relative(root, outputLink).split('\\').join('/'))
      }

      const verified = await lstat(outputLink).catch(() => null)
      if (!verified?.isSymbolicLink() || await readlink(outputLink) !== linkTarget) {
        throw new Error(`standalone_pnpm_link_verification_failed:${linkIdentity}`)
      }
      if (!(await stat(outputLink).catch(() => null))) {
        throw new Error(`standalone_pnpm_link_broken:${linkIdentity}`)
      }
    }
  }

  return repairedLinks.sort()
}

async function sha256(pathname) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

function assertGeneratedChild(root, pathname, label) {
  const boundary = relative(root, pathname)
  if (!boundary || boundary.startsWith('..') || isAbsolute(boundary)) {
    throw new Error(`${label}_boundary`)
  }
}

async function copyVerifiedRuntimeTree(sourcePath, destinationPath, options) {
  const source = resolve(sourcePath)
  const destination = resolve(destinationPath)
  const sourceStat = await lstat(source).catch(() => null)
  if (!sourceStat?.isDirectory()) throw new Error(`${options.label}_missing`)

  await assertSafeMutationPath(options.root, destination, options.label)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  let copiedFiles = 0

  async function visit(sourceDirectory, destinationDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    for (const entry of entries) {
      const sourceMember = resolve(sourceDirectory, entry.name)
      const member = relative(source, sourceMember).split('\\').join('/')
      const destinationMember = resolve(destinationDirectory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`${options.label}_source_symlink:${member}`)
      if (entry.isDirectory()) {
        await mkdir(destinationMember, { recursive: true })
        await visit(sourceMember, destinationMember)
        continue
      }
      if (!entry.isFile()) throw new Error(`${options.label}_source_type:${member}`)

      const decision = options.select(member)
      if (decision === 'skip') continue
      if (decision !== 'copy') throw new Error(`${options.label}_extension:${member}`)
      await cp(sourceMember, destinationMember, { force: true })
      if (await sha256(sourceMember) !== await sha256(destinationMember)) {
        throw new Error(`${options.label}_digest:${member}`)
      }
      copiedFiles += 1
    }
  }

  await visit(source, destination)
  if (copiedFiles === 0) throw new Error(`${options.label}_empty`)
  return copiedFiles
}

export async function syncStandaloneSchema(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const root = resolve(rootPath)
  const projectRoot = resolve(projectRootPath)
  const source = resolve(projectRoot, 'src/lib/schema.sql')
  const destination = resolve(root, 'runtime/schema.sql')
  const sourceStat = await lstat(source).catch(() => null)
  if (!sourceStat?.isFile() || sourceStat.size === 0) {
    throw new Error('standalone_runtime_schema_missing')
  }
  await assertSafeMutationPath(root, destination, 'standalone_runtime_schema')
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { force: true })
  const destinationStat = await lstat(destination).catch(() => null)
  if (!destinationStat?.isFile() || destinationStat.size === 0) {
    throw new Error('standalone_runtime_schema_empty')
  }
  if (await sha256(source) !== await sha256(destination)) {
    throw new Error('standalone_runtime_schema_digest')
  }
  return relative(root, destination).split('\\').join('/')
}

export async function syncStandaloneStaticAssets(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const root = resolve(rootPath)
  const source = resolve(projectRootPath, '.next/static')
  const destination = resolve(root, '.next/static')
  assertGeneratedChild(root, destination, 'standalone_static')
  return copyVerifiedRuntimeTree(source, destination, {
    label: 'standalone_static',
    root,
    select: member => member.toLowerCase().endsWith('.map') ? 'skip' : 'copy',
  })
}

export async function syncStandalonePublicAssets(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const root = resolve(rootPath)
  const source = resolve(projectRootPath, 'public')
  const destination = resolve(root, 'public')
  assertGeneratedChild(root, destination, 'standalone_public')
  return copyVerifiedRuntimeTree(source, destination, {
    label: 'standalone_public',
    root,
    select: member => member.toLowerCase().endsWith('.map') ? 'skip' : 'copy',
  })
}

export async function syncStandaloneMessages(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const root = resolve(rootPath)
  const source = resolve(projectRootPath, 'messages')
  const destination = resolve(root, 'messages')
  assertGeneratedChild(root, destination, 'standalone_messages')
  return copyVerifiedRuntimeTree(source, destination, {
    label: 'standalone_messages',
    root,
    select: member => member.toLowerCase().endsWith('.map') ? 'skip' : 'copy',
  })
}

export async function syncStandaloneServerChunks(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const root = resolve(rootPath)
  const projectRoot = resolve(projectRootPath)
  const source = resolve(projectRoot, '.next/server/chunks')
  const destination = resolve(root, '.next/server/chunks')
  assertGeneratedChild(root, destination, 'standalone_server_chunks')
  return copyVerifiedRuntimeTree(source, destination, {
    label: 'standalone_server_chunks',
    root,
    select: (member) => {
      if (member.toLowerCase().endsWith('.map')) return 'skip'
      return ALLOWED_SERVER_CHUNK_EXTENSIONS.has(extname(member).toLowerCase()) ? 'copy' : 'reject'
    },
  })
}

export async function findUnsafeStandaloneLinks(rootPath) {
  const { root, physicalRoot } = await assertStandalonePhysicalRoot(rootPath)
  const unsafe = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathname = resolve(directory, entry.name)
      const member = relative(root, pathname).split('\\').join('/') || entry.name
      if (entry.isSymbolicLink()) {
        const target = await readlink(pathname)
        const physicalTarget = await realpath(pathname).catch(() => null)
        if (
          !member.split('/').map(segment => segment.toLowerCase()).includes('node_modules')
          || isAbsolute(target)
          || !physicalTarget
          || !isPathInside(physicalRoot, physicalTarget)
        ) unsafe.push(member)
        continue
      }
      if (entry.isDirectory()) await visit(pathname)
    }
  }

  await visit(root)
  return unsafe.sort()
}

function parseStandaloneServerConfig(source) {
  const prefix = 'const nextConfig = '
  const suffix = '\n\nprocess.env.__NEXT_PRIVATE_STANDALONE_CONFIG'
  const prefixIndex = source.indexOf(prefix)
  if (prefixIndex < 0) throw new Error('standalone_server_config_missing')
  const jsonStart = prefixIndex + prefix.length
  const suffixIndex = source.indexOf(suffix, jsonStart)
  if (suffixIndex < 0) throw new Error('standalone_server_config_terminator_missing')
  try {
    return {
      config: JSON.parse(source.slice(jsonStart, suffixIndex)),
      jsonStart,
      suffixIndex,
    }
  } catch {
    throw new Error('standalone_server_config_invalid')
  }
}

function assertRuntimeOnlyServerConfig(config) {
  const forbiddenKeys = [
    'distDirRoot',
    'outputFileTracingExcludes',
    'outputFileTracingIncludes',
    'outputFileTracingRoot',
    'turbopack',
  ]
  const leaked = forbiddenKeys.filter(key => Object.hasOwn(config, key))
  if (leaked.length > 0) {
    throw new Error(`standalone_server_build_config:${leaked.join(',')}`)
  }
}

export async function sanitizeStandaloneServerConfig(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const projectRoot = resolve(projectRootPath)
  const serverPath = resolve(root, 'server.js')
  const serverStat = await lstat(serverPath).catch(() => null)
  if (!serverStat?.isFile() || serverStat.isSymbolicLink() || serverStat.size === 0) {
    throw new Error('standalone_server_missing')
  }
  const source = await readFile(serverPath, 'utf8')
  const parsed = parseStandaloneServerConfig(source)
  for (const key of [
    'distDirRoot',
    'outputFileTracingExcludes',
    'outputFileTracingIncludes',
    'outputFileTracingRoot',
    'turbopack',
  ]) delete parsed.config[key]
  assertRuntimeOnlyServerConfig(parsed.config)

  const sanitized = `${source.slice(0, parsed.jsonStart)}${JSON.stringify(parsed.config)}${source.slice(parsed.suffixIndex)}`
  const physicalProjectRoot = await realpath(projectRoot).catch(() => projectRoot)
  if (sanitized.includes(projectRoot) || sanitized.includes(physicalProjectRoot)) {
    throw new Error('standalone_server_build_root_leak')
  }
  await assertSafeMutationPath(root, serverPath, 'standalone_server')
  await writeFile(serverPath, sanitized)
  return 'server.js'
}

export async function assertStandaloneServerConfigSanitized(rootPath = resolve('.next/standalone')) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const serverPath = resolve(root, 'server.js')
  const serverStat = await lstat(serverPath).catch(() => null)
  if (!serverStat?.isFile() || serverStat.isSymbolicLink() || serverStat.size === 0) {
    throw new Error('standalone_server_missing')
  }
  const source = await readFile(serverPath, 'utf8')
  const { config } = parseStandaloneServerConfig(source)
  assertRuntimeOnlyServerConfig(config)
  return true
}

function parseRequiredServerFiles(source) {
  let payload
  try {
    payload = JSON.parse(source)
  } catch {
    throw new Error('standalone_required_server_files_invalid')
  }
  if (!payload || typeof payload !== 'object' || !payload.config || typeof payload.config !== 'object') {
    throw new Error('standalone_required_server_files_invalid')
  }
  return payload
}

export async function sanitizeStandaloneRequiredServerFiles(
  rootPath = resolve('.next/standalone'),
  projectRootPath = resolve(rootPath, '..', '..'),
) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const projectRoot = resolve(projectRootPath)
  const pathname = resolve(root, '.next/required-server-files.json')
  const fileStat = await lstat(pathname).catch(() => null)
  if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size === 0) {
    throw new Error('standalone_required_server_files_missing')
  }
  const payload = parseRequiredServerFiles(await readFile(pathname, 'utf8'))
  for (const key of [
    'distDirRoot',
    'outputFileTracingExcludes',
    'outputFileTracingIncludes',
    'outputFileTracingRoot',
    'turbopack',
  ]) delete payload.config[key]
  assertRuntimeOnlyServerConfig(payload.config)
  payload.appDir = '.'
  const sanitized = `${JSON.stringify(payload, null, 2)}\n`
  const physicalProjectRoot = await realpath(projectRoot).catch(() => projectRoot)
  if (sanitized.includes(projectRoot) || sanitized.includes(physicalProjectRoot)) {
    throw new Error('standalone_required_server_files_build_root_leak')
  }
  await assertSafeMutationPath(root, pathname, 'standalone_required_server_files')
  await writeFile(pathname, sanitized)
  return '.next/required-server-files.json'
}

export async function assertStandaloneRequiredServerFilesSanitized(
  rootPath = resolve('.next/standalone'),
) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const pathname = resolve(root, '.next/required-server-files.json')
  const fileStat = await lstat(pathname).catch(() => null)
  if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size === 0) {
    throw new Error('standalone_required_server_files_missing')
  }
  const payload = parseRequiredServerFiles(await readFile(pathname, 'utf8'))
  assertRuntimeOnlyServerConfig(payload.config)
  if (payload.appDir !== '.') throw new Error('standalone_required_server_files_app_dir')
  return true
}

export async function assertRequiredStandaloneMembers(rootPath = resolve('.next/standalone')) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  for (const member of REQUIRED_STANDALONE_FILES) {
    const memberStat = await lstat(resolve(root, member)).catch(() => null)
    if (!memberStat?.isFile() || memberStat.isSymbolicLink() || memberStat.size === 0) {
      throw new Error(`standalone_required_file_missing:${member}`)
    }
  }
  for (const member of REQUIRED_STANDALONE_DIRECTORIES) {
    const pathname = resolve(root, member)
    const memberStat = await lstat(pathname).catch(() => null)
    if (!memberStat?.isDirectory() || memberStat.isSymbolicLink()) {
      throw new Error(`standalone_required_directory_missing:${member}`)
    }
    if ((await readdir(pathname)).length === 0) {
      throw new Error(`standalone_required_directory_empty:${member}`)
    }
  }
  return true
}

async function collectStandaloneManifestMembers(rootPath) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const directories = []
  const files = []
  const symlinks = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathname = resolve(directory, entry.name)
      const member = relative(root, pathname).split('\\').join('/')
      if (member === RELEASE_MANIFEST_NAME) continue
      if (entry.isSymbolicLink()) {
        symlinks.push({ path: member, target: await readlink(pathname) })
        continue
      }
      if (entry.isDirectory()) {
        directories.push(member)
        await visit(pathname)
        continue
      }
      if (!entry.isFile()) throw new Error(`standalone_unsupported_member_type:${member}`)
      const fileStat = await lstat(pathname)
      files.push({ path: member, bytes: fileStat.size, sha256: await sha256(pathname) })
    }
  }

  await visit(root)
  directories.sort()
  files.sort((left, right) => left.path.localeCompare(right.path))
  symlinks.sort((left, right) => left.path.localeCompare(right.path))
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    directories,
    files,
    symlinks,
  }
}

export async function writeStandaloneReleaseManifest(rootPath = resolve('.next/standalone')) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  await assertRequiredStandaloneMembers(root)
  const manifestPath = resolve(root, RELEASE_MANIFEST_NAME)
  const existing = await lstat(manifestPath).catch(() => null)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('standalone_release_manifest_unsafe_type')
  }
  await assertSafeMutationPath(root, manifestPath, 'standalone_release_manifest')
  const manifest = await collectStandaloneManifestMembers(root)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path: RELEASE_MANIFEST_NAME, files: manifest.files.length, symlinks: manifest.symlinks.length }
}

export async function verifyStandaloneReleaseManifest(rootPath = resolve('.next/standalone')) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const manifestPath = resolve(root, RELEASE_MANIFEST_NAME)
  const manifestStat = await lstat(manifestPath).catch(() => null)
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size === 0) {
    throw new Error('standalone_release_manifest_missing')
  }
  let declared
  try {
    declared = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error('standalone_release_manifest_invalid')
  }
  const actual = await collectStandaloneManifestMembers(root)
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error('standalone_release_manifest_mismatch')
  }
  return { files: actual.files.length, symlinks: actual.symlinks.length }
}

async function findBuildRootLeaks(rootPath, projectRootPath) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const projectRoot = resolve(projectRootPath)
  const physicalProjectRoot = await realpath(projectRoot).catch(() => projectRoot)
  const needles = [...new Set([projectRoot, physicalProjectRoot])].map(value => Buffer.from(value))
  const leaked = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathname = resolve(directory, entry.name)
      const member = relative(root, pathname).split('\\').join('/')
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (member === 'node_modules' || member === '.next/node_modules') continue
        await visit(pathname)
        continue
      }
      if (!entry.isFile() || member === RELEASE_MANIFEST_NAME) continue
      const content = await readFile(pathname)
      if (needles.some(needle => content.includes(needle))) leaked.push(member)
    }
  }

  await visit(root)
  return leaked.sort()
}

export async function sanitizeStandaloneArtifact(rootPath = resolve('.next/standalone')) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const projectRoot = resolve(root, '..', '..')
  const unsafeBeforeMutation = await findUnsafeStandaloneLinks(root)
  if (unsafeBeforeMutation.length > 0) {
    throw new Error(`standalone_unsafe_links:${unsafeBeforeMutation.join(',')}`)
  }
  const sanitizedServer = await sanitizeStandaloneServerConfig(root, projectRoot)
  const sanitizedRequiredServerFiles = await sanitizeStandaloneRequiredServerFiles(root, projectRoot)
  const copiedServerChunks = await syncStandaloneServerChunks(root)
  const copiedStaticAssets = await syncStandaloneStaticAssets(root)
  const copiedPublicAssets = await syncStandalonePublicAssets(root)
  const copiedMessages = await syncStandaloneMessages(root)
  const copiedRuntimeSchema = await syncStandaloneSchema(root)
  const repairedLinks = await repairStandalonePnpmLinks(root)
  const forbidden = await findForbiddenStandaloneMembers(root)
  for (const member of forbidden) {
    const pathname = resolve(root, member)
    const boundary = relative(root, pathname)
    if (!boundary || boundary.startsWith('..') || isAbsolute(boundary)) {
      throw new Error(`standalone_sanitize_boundary_violation:${member}`)
    }
    await assertSafeMutationPath(root, pathname, 'standalone_sanitize')
    await rm(pathname, { recursive: true, force: true })
  }
  const unsafeLinks = await findUnsafeStandaloneLinks(root)
  if (unsafeLinks.length > 0) {
    throw new Error(`standalone_unsafe_links:${unsafeLinks.join(',')}`)
  }
  await assertRequiredStandaloneMembers(root)
  const buildRootLeaks = await findBuildRootLeaks(root, projectRoot)
  if (buildRootLeaks.length > 0) {
    throw new Error(`standalone_build_root_leaks:${buildRootLeaks.join(',')}`)
  }
  const releaseManifest = await writeStandaloneReleaseManifest(root)
  return {
    ok: true,
    root,
    copiedServerChunks,
    copiedStaticAssets,
    copiedPublicAssets,
    copiedMessages,
    copiedRuntimeSchema,
    sanitizedServer,
    sanitizedRequiredServerFiles,
    releaseManifest,
    repairedPnpmLinks: repairedLinks.length,
    removedMembers: forbidden,
  }
}

export async function auditStandaloneArtifact(rootPath = resolve('.next/standalone')) {
  const { root } = await assertStandalonePhysicalRoot(rootPath)
  const forbidden = await findForbiddenStandaloneMembers(root)
  if (forbidden.length > 0) {
    throw new Error(`standalone_forbidden_members:${forbidden.join(',')}`)
  }
  const unsafeLinks = await findUnsafeStandaloneLinks(root)
  if (unsafeLinks.length > 0) {
    throw new Error(`standalone_unsafe_links:${unsafeLinks.join(',')}`)
  }
  await assertRequiredStandaloneMembers(root)
  await assertStandaloneServerConfigSanitized(root)
  await assertStandaloneRequiredServerFilesSanitized(root)
  await verifyStandaloneReleaseManifest(root)
  return { ok: true, root, forbiddenMembers: 0 }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    const command = process.argv[2]
    const rootPath = command?.startsWith('--') ? process.argv[3] : command
    const result = command === '--sanitize'
      ? await sanitizeStandaloneArtifact(rootPath)
      : command === '--write-manifest'
        ? await writeStandaloneReleaseManifest(rootPath)
        : await auditStandaloneArtifact(rootPath)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    process.exitCode = 1
  }
}
