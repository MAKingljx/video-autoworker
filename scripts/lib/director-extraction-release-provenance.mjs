import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

export const DIRECTOR_EXTRACTION_PROVENANCE_NAME = 'release-provenance.json'
export const STANDALONE_ARTIFACT_CONTENT_SCHEMA =
  'video-autoworker-standalone-artifact-content/v1'
export const STANDALONE_PROVENANCE_SCHEMA =
  'video-autoworker-standalone-provenance/v2'
export const STANDALONE_BUILD_SOURCE_ANCHOR_SCHEMA =
  'video-autoworker-standalone-build-source-anchor/v1'

const SHA256 = /^[a-f0-9]{64}$/u
const GIT_COMMIT = /^[a-f0-9]{40}$/u
const SOURCE_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
])
const INDEX_CANDIDATES = Object.freeze(SOURCE_EXTENSIONS.map(extension => `index${extension}`))
const moduleRequire = createRequire(import.meta.url)
let typescriptCompiler
const liveBuildSourceAnchors = new WeakSet()

function loadTypescriptCompiler() {
  if (typescriptCompiler) return typescriptCompiler
  try {
    typescriptCompiler = moduleRequire('typescript')
  } catch {
    throw new Error('director_extraction_source_parser_unavailable')
  }
  return typescriptCompiler
}

// These are the explicit build and runtime entry points. Every local static
// import reachable from a source entry is discovered recursively; the final
// closure is never maintained as a hand-picked shallow list.
export const DIRECTOR_EXTRACTION_SOURCE_ROOTS = Object.freeze([
  'next.config.js',
  'openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/build-standalone.mjs',
  'scripts/lib/director-extraction-release-provenance.mjs',
  'src/app/api/n8n/director-extraction/route.ts',
  'src/lib/scheduler.ts',
].sort())

function fileSha256(pathname) {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex')
}

function gitOutput(repositoryRoot, args) {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function normalizedRepositoryPath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) {
    throw new Error('director_extraction_source_path_invalid')
  }
  const normalized = posix.normalize(path)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('director_extraction_source_path_outside_repository')
  }
  return normalized
}

function localStaticSpecifiers(contents, sourcePath) {
  if (!SOURCE_EXTENSIONS.includes(extname(sourcePath))) return []
  const ts = loadTypescriptCompiler()
  const sourceFile = ts.createSourceFile(
    sourcePath,
    contents.toString('utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`director_extraction_source_parse_invalid:${sourcePath}`)
  }
  const specifiers = []
  const createRequireNames = new Set(['createRequire'])
  const loaderNames = new Set(['require'])
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !['node:module', 'module'].includes(statement.moduleSpecifier.text)
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName || element.name).text === 'createRequire') {
        createRequireNames.add(element.name.text)
      }
    }
  }
  const collectLoaders = (node) => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer) {
      if (ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && createRequireNames.has(node.initializer.expression.text)) {
        loaderNames.add(node.name.text)
      } else if (ts.isIdentifier(node.initializer) && loaderNames.has(node.initializer.text)) {
        loaderNames.add(node.name.text)
      }
    }
    ts.forEachChild(node, collectLoaders)
  }
  collectLoaders(sourceFile)

  const addLoaderSpecifier = (node) => {
    const argument = node.arguments[0]
    if (!argument || !ts.isStringLiteralLike(argument)) {
      throw new Error(`director_extraction_source_dynamic_dependency_unresolved:${sourcePath}`)
    }
    const value = argument.text
    if (value.startsWith('.') || value.startsWith('@/') || value.startsWith('/')) {
      specifiers.push(value)
    }
  }
  const visit = (node) => {
    let moduleSpecifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      moduleSpecifier = node.moduleSpecifier
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      moduleSpecifier = node.moduleReference.expression
    }
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      const value = moduleSpecifier.text
      if (value.startsWith('.') || value.startsWith('@/') || value.startsWith('/')) {
        specifiers.push(value)
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addLoaderSpecifier(node)
      } else if (ts.isIdentifier(node.expression) && loaderNames.has(node.expression.text)) {
        addLoaderSpecifier(node)
      } else if (ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'resolve'
        && ts.isIdentifier(node.expression.expression)
        && loaderNames.has(node.expression.expression.text)) {
        addLoaderSpecifier(node)
      } else if (ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'require'
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'module') {
        addLoaderSpecifier(node)
      } else if (ts.isIdentifier(node.expression)
        && createRequireNames.has(node.expression.text)
        && (!ts.isVariableDeclaration(node.parent)
          || node.parent.initializer !== node
          || !ts.isIdentifier(node.parent.name))) {
        throw new Error(`director_extraction_source_create_require_unresolved:${sourcePath}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...new Set(specifiers)].sort()
}

function dependencyBasePath(importerPath, specifier) {
  if (specifier.startsWith('/')) {
    throw new Error(`director_extraction_source_dependency_outside_repository:${importerPath}`)
  }
  const unresolved = specifier.startsWith('@/')
    ? `src/${specifier.slice(2)}`
    : posix.join(posix.dirname(importerPath), specifier)
  return normalizedRepositoryPath(unresolved)
}

function dependencyCandidates(basePath) {
  const extension = extname(basePath)
  if (extension) {
    const candidates = [basePath]
    if (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
      const stem = basePath.slice(0, -extension.length)
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`)
    }
    return [...new Set(candidates)]
  }
  return [
    ...SOURCE_EXTENSIONS.map(candidateExtension => `${basePath}${candidateExtension}`),
    ...INDEX_CANDIDATES.map(candidate => posix.join(basePath, candidate)),
  ]
}

function resolveLocalDependency(reader, importerPath, specifier) {
  const basePath = dependencyBasePath(importerPath, specifier)
  for (const candidate of dependencyCandidates(basePath)) {
    if (reader.has(candidate)) return candidate
  }
  throw new Error(`director_extraction_source_dependency_unresolved:${importerPath}`)
}

function buildRecursiveSourceClosure(reader, roots = DIRECTOR_EXTRACTION_SOURCE_ROOTS) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('director_extraction_source_roots_invalid')
  }
  const pending = [...new Set(roots.map(normalizedRepositoryPath))].sort()
  const contentsByPath = new Map()
  while (pending.length > 0) {
    const sourcePath = pending.shift()
    if (contentsByPath.has(sourcePath)) continue
    const contents = reader.read(sourcePath)
    contentsByPath.set(sourcePath, contents)
    for (const specifier of localStaticSpecifiers(contents, sourcePath)) {
      const dependency = resolveLocalDependency(reader, sourcePath, specifier)
      if (!contentsByPath.has(dependency) && !pending.includes(dependency)) pending.push(dependency)
    }
    pending.sort()
  }
  const files = [...contentsByPath].sort(([left], [right]) => left.localeCompare(right))
    .map(([path, contents]) => ({
      path,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }))
  return { algorithm: 'sha256', files }
}

function filesystemReader(repositoryRoot) {
  const canonicalRoot = realpathSync(repositoryRoot)
  const checkedPath = (sourcePath) => {
    const normalized = normalizedRepositoryPath(sourcePath)
    const pathname = resolve(canonicalRoot, ...normalized.split('/'))
    const relativePath = relative(canonicalRoot, pathname)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error('director_extraction_source_path_outside_repository')
    }
    return pathname
  }
  return {
    has(sourcePath) {
      try {
        const pathname = checkedPath(sourcePath)
        const stat = lstatSync(pathname)
        if (stat.isSymbolicLink()) {
          throw new Error('director_extraction_source_symlink_forbidden')
        }
        return stat.isFile()
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
        throw error
      }
    },
    read(sourcePath) {
      const pathname = checkedPath(sourcePath)
      const stat = lstatSync(pathname)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('director_extraction_source_file_invalid')
      }
      const canonicalPath = realpathSync(pathname)
      const relativePath = relative(canonicalRoot, canonicalPath)
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('director_extraction_source_path_outside_repository')
      }
      return readFileSync(canonicalPath)
    },
  }
}

function gitCommitReader(repositoryRoot, commit) {
  if (typeof commit !== 'string' || !GIT_COMMIT.test(commit)) {
    throw new Error('director_extraction_source_commit_invalid')
  }
  const tree = execFileSync('git', ['-C', repositoryRoot, 'ls-tree', '-r', '-z', commit], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  })
  const modes = new Map()
  for (const record of tree.toString('utf8').split('\0')) {
    if (!record) continue
    const match = /^(\d+)\s+blob\s+[a-f0-9]+\t(.+)$/u.exec(record)
    if (match) modes.set(match[2], match[1])
  }
  return {
    has(sourcePath) {
      return modes.has(normalizedRepositoryPath(sourcePath))
    },
    read(sourcePath) {
      const normalized = normalizedRepositoryPath(sourcePath)
      const mode = modes.get(normalized)
      if (mode !== '100644' && mode !== '100755') {
        throw new Error('director_extraction_source_git_member_invalid')
      }
      return execFileSync('git', ['-C', repositoryRoot, 'show', `${commit}:${normalized}`], {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      })
    },
  }
}

export function sourceClosure(repositoryRoot, roots = DIRECTOR_EXTRACTION_SOURCE_ROOTS) {
  return buildRecursiveSourceClosure(filesystemReader(repositoryRoot), roots)
}

export function sourceClosureForGitCommit(
  repositoryRoot,
  commit,
  roots = DIRECTOR_EXTRACTION_SOURCE_ROOTS,
) {
  return buildRecursiveSourceClosure(gitCommitReader(repositoryRoot, commit), roots)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sourceClosureDigest(closure) {
  return createHash('sha256').update(canonicalJson(closure)).digest('hex')
}

export function createStandaloneBuildSourceAnchor(
  repositoryRoot,
  options = {},
) {
  const gitCommit = gitOutput(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const gitStatus = gitOutput(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (!gitCommit || !GIT_COMMIT.test(gitCommit) || gitStatus === null) {
    throw new Error('standalone_build_source_unavailable')
  }
  const gitDirty = gitStatus !== ''
  if (gitDirty && options.allowDirty !== true) throw new Error('standalone_build_source_not_clean')
  const closure = gitDirty
    ? sourceClosure(repositoryRoot)
    : sourceClosureForGitCommit(repositoryRoot, gitCommit)
  const anchor = {
    schema: STANDALONE_BUILD_SOURCE_ANCHOR_SCHEMA,
    gitCommit,
    gitDirty,
    sourceClosure: closure,
    sourceClosureSha256: sourceClosureDigest(closure),
    buildNonce: randomBytes(32).toString('hex'),
  }
  liveBuildSourceAnchors.add(anchor)
  return anchor
}

function verifiedBuildSourceAnchor(repositoryRoot, anchor) {
  if (!anchor || typeof anchor !== 'object' || !liveBuildSourceAnchors.has(anchor)
    || anchor.schema !== STANDALONE_BUILD_SOURCE_ANCHOR_SCHEMA
    || typeof anchor.gitCommit !== 'string' || !GIT_COMMIT.test(anchor.gitCommit)
    || typeof anchor.gitDirty !== 'boolean'
    || typeof anchor.buildNonce !== 'string' || !SHA256.test(anchor.buildNonce)
    || typeof anchor.sourceClosureSha256 !== 'string'
    || !SHA256.test(anchor.sourceClosureSha256)
    || sourceClosureDigest(anchor.sourceClosure) !== anchor.sourceClosureSha256) return null
  const gitCommit = gitOutput(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const gitStatus = gitOutput(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (gitCommit !== anchor.gitCommit || gitStatus === null
    || (gitStatus !== '') !== anchor.gitDirty) return null
  let expectedClosure
  try {
    expectedClosure = anchor.gitDirty
      ? sourceClosure(repositoryRoot)
      : sourceClosureForGitCommit(repositoryRoot, gitCommit)
  } catch {
    return null
  }
  return canonicalJson(expectedClosure) === canonicalJson(anchor.sourceClosure)
    ? anchor
    : null
}

export function buildStandaloneArtifactContentBinding(contentManifest) {
  if (!contentManifest
    || contentManifest.schema !== STANDALONE_ARTIFACT_CONTENT_SCHEMA
    || contentManifest.algorithm !== 'sha256'
    || !Array.isArray(contentManifest.directories)
    || !Array.isArray(contentManifest.files)
    || !Array.isArray(contentManifest.symlinks)) {
    throw new Error('standalone_artifact_content_manifest_invalid')
  }
  // The caller builds this manifest after sanitization and omits both
  // attestation files. Keeping that member set non-self-referential lets the
  // provenance and release manifest independently carry the same digest.
  return {
    schema: STANDALONE_ARTIFACT_CONTENT_SCHEMA,
    algorithm: 'sha256',
    digest: createHash('sha256')
      .update(JSON.stringify(contentManifest))
      .digest('hex'),
    directories: contentManifest.directories.length,
    files: contentManifest.files.length,
    symlinks: contentManifest.symlinks.length,
  }
}

export function isStandaloneArtifactContentBinding(value) {
  return Boolean(value
    && value.schema === STANDALONE_ARTIFACT_CONTENT_SCHEMA
    && value.algorithm === 'sha256'
    && typeof value.digest === 'string' && SHA256.test(value.digest)
    && Number.isSafeInteger(value.directories) && value.directories >= 0
    && Number.isSafeInteger(value.files) && value.files >= 0
    && Number.isSafeInteger(value.symlinks) && value.symlinks >= 0)
}

/**
 * @param {string} repositoryRoot
 * @param {object} artifactContent
 * @param {ReturnType<typeof createStandaloneBuildSourceAnchor> | null} [buildSourceAnchor]
 */
export function buildDirectorExtractionProvenance(
  repositoryRoot,
  artifactContent,
  buildSourceAnchor = null,
) {
  if (!isStandaloneArtifactContentBinding(artifactContent)) {
    throw new Error('standalone_artifact_content_binding_invalid')
  }
  const verifiedAnchor = verifiedBuildSourceAnchor(repositoryRoot, buildSourceAnchor)
  const gitCommit = verifiedAnchor?.gitCommit || null
  let closure
  try {
    closure = verifiedAnchor
      ? verifiedAnchor.sourceClosure
      : sourceClosure(repositoryRoot)
  } catch {
    // Non-repository fixture builds remain auditable as local artifacts, but
    // can never satisfy the release-readiness verifier.
    closure = { algorithm: 'sha256', files: [] }
  }
  return {
    schema: STANDALONE_PROVENANCE_SCHEMA,
    gitCommit,
    gitDirty: verifiedAnchor?.gitDirty ?? true,
    buildSourceAnchor: verifiedAnchor ? {
      schema: verifiedAnchor.schema,
      gitCommit: verifiedAnchor.gitCommit,
      gitDirty: verifiedAnchor.gitDirty,
      sourceClosureSha256: verifiedAnchor.sourceClosureSha256,
      buildNonce: verifiedAnchor.buildNonce,
    } : null,
    sourceClosure: closure,
    artifactContent,
  }
}

/**
 * @param {string} repositoryRoot
 * @param {string} artifactRoot
 * @param {object} artifactContent
 * @param {ReturnType<typeof createStandaloneBuildSourceAnchor> | null} [buildSourceAnchor]
 */
export function writeDirectorExtractionProvenance(
  repositoryRoot,
  artifactRoot,
  artifactContent,
  buildSourceAnchor = null,
) {
  const provenance = buildDirectorExtractionProvenance(
    repositoryRoot,
    artifactContent,
    buildSourceAnchor,
  )
  if (buildSourceAnchor && typeof buildSourceAnchor === 'object') {
    liveBuildSourceAnchors.delete(buildSourceAnchor)
  }
  writeFileSync(
    join(artifactRoot, DIRECTOR_EXTRACTION_PROVENANCE_NAME),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { mode: 0o600 },
  )
  return provenance
}
