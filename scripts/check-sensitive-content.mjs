#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  lstatSync, readFileSync, realpathSync,
} from 'node:fs'
import {
  basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanHighConfidenceSensitiveValues } from './lib/sensitive-value-scanner.mjs'

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ALLOWLIST_SCHEMA = 'video-autoworker-sensitive-content-source-allowlist/v1'
const REPORT_SCHEMA = 'video-autoworker-sensitive-content-scan/v1'
const SHA256 = /^[a-f0-9]{64}$/u
const GIT_COMMIT = /^[a-f0-9]{40}$/u
const MAX_FILE_BYTES = 32 * 1024 * 1024
const moduleRequire = createRequire(import.meta.url)

const CODE_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.jsx', '.json', '.jsonc', '.mjs', '.mts', '.ts', '.tsx',
])
const ASSIGNMENT_TEXT_EXTENSIONS = new Set([
  '.bash', '.env', '.example', '.sample', '.sh', '.template', '.yaml', '.yml', '.zsh',
])
const SENSITIVE_FIELD_NAMES = new Set([
  'authorization', 'credential', 'privatekey', 'signingkey',
])
const SENSITIVE_FIELD_SUFFIXES = Object.freeze([
  'accesstoken', 'apikey', 'apisecret', 'appsecret', 'authtoken', 'clientsecret',
  'gatewaypassword', 'gatewaytoken', 'password', 'passwd', 'pwd', 'refreshtoken',
  'secret', 'sessionsecret', 'token',
])
const SAFE_REFERENCE_LITERALS = new Set([
  'environment', 'execreference', 'inlineconfig', 'keychain', 'none', 'password',
  'secretref', 'token',
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedRepositoryPath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) {
    throw new Error('sensitive_scan_path_invalid')
  }
  const normalized = posix.normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('sensitive_scan_path_invalid')
  }
  return normalized
}

function physicalDirectory(pathname, label) {
  const absolute = resolve(pathname)
  const stat = lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}_unsafe`)
  }
  return absolute
}

function safeWorktreeFile(root, member) {
  const normalized = normalizedRepositoryPath(member)
  const pathname = resolve(root, ...normalized.split('/'))
  const boundary = relative(root, pathname)
  if (!boundary || boundary === '..' || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) {
    throw new Error('sensitive_scan_path_outside_root')
  }
  const stat = lstatSync(pathname)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('sensitive_scan_source_file_unsafe')
  const physicalRoot = realpathSync.native(root)
  const physicalPath = realpathSync.native(pathname)
  const physicalBoundary = relative(physicalRoot, physicalPath)
  if (!physicalBoundary || physicalBoundary === '..'
    || physicalBoundary.startsWith(`..${sep}`) || isAbsolute(physicalBoundary)) {
    throw new Error('sensitive_scan_source_file_outside_physical_root')
  }
  if (stat.size > MAX_FILE_BYTES) throw new Error('sensitive_scan_file_too_large')
  return readFileSync(pathname)
}

function gitOutput(repositoryRoot, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function resolveGitCommit(repositoryRoot, revision) {
  const commit = gitOutput(repositoryRoot, ['rev-parse', '--verify', `${revision}^{commit}`]).trim()
  if (!GIT_COMMIT.test(commit)) throw new Error('sensitive_scan_commit_invalid')
  return commit
}

function gitCommitMembers(repositoryRoot, commit) {
  const tree = gitOutput(repositoryRoot, ['ls-tree', '-r', '-z', '--full-tree', commit], 'buffer')
  const members = []
  for (const record of tree.toString('utf8').split('\0')) {
    if (!record) continue
    const match = /^(\d+)\s+blob\s+[a-f0-9]+\t(.+)$/u.exec(record)
    if (!match || !['100644', '100755'].includes(match[1])) continue
    members.push(normalizedRepositoryPath(match[2]))
  }
  return members.sort()
}

function gitCommitFile(repositoryRoot, commit, member) {
  const content = gitOutput(repositoryRoot, ['show', `${commit}:${member}`], 'buffer')
  if (content.length > MAX_FILE_BYTES) throw new Error('sensitive_scan_file_too_large')
  return content
}

function worktreeMembers(repositoryRoot) {
  const output = gitOutput(
    repositoryRoot,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    'buffer',
  )
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean)
    .map(normalizedRepositoryPath))].sort()
}

function locationForOffset(text, offset) {
  const prefix = text.slice(0, offset)
  const line = prefix.split('\n').length
  const previousBreak = prefix.lastIndexOf('\n')
  return { line, column: offset - previousBreak }
}

function finding(path, type, severity, value, position, location) {
  return {
    path,
    type,
    severity,
    position,
    line: location.line,
    column: location.column,
    fingerprint: sha256(value),
  }
}

function normalizedFieldName(value) {
  return String(value || '').replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function isSensitiveFieldName(value) {
  const raw = String(value || '').split('.').at(-1) || ''
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(raw)) return false
  const normalized = normalizedFieldName(raw)
  return SENSITIVE_FIELD_NAMES.has(normalized)
    || SENSITIVE_FIELD_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

function isSafeReferenceLiteral(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return true
  const normalized = normalizedFieldName(trimmed)
  if (SAFE_REFERENCE_LITERALS.has(normalized)) return true
  if (/^(?:0|1|false|no|null|off|on|read|true|undefined|write|yes)$/iu.test(trimmed)) {
    return true
  }
  return /^\$\{?[A-Z_][A-Z0-9_]*\}?$/u.test(trimmed)
    || /^\$\{\{\s*(?:env|secrets)\.[A-Z_][A-Z0-9_]*\s*\}\}$/u.test(trimmed)
    || /^(?:process\.env\.|env:|secretref:|keychain:|exec:)/iu.test(trimmed)
    || /^[A-Za-z0-9._-]+\.(?:json|pem\.ref|secret\.ref)$/iu.test(trimmed)
    || /^<[^>]+>$/u.test(trimmed)
    || /^\[(?:credential|redacted|secret)\]$/iu.test(trimmed)
}

function isStorageIdentifierLiteral(fieldName, value) {
  const rawField = String(fieldName || '')
  const rawValue = String(value || '')
  if (!/^STORAGE_[A-Z0-9_]+$/u.test(rawField)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(rawValue)) return false
  const valueParts = rawValue.split('-')
  const unscopedValue = valueParts.length > 2 ? valueParts.slice(1).join('-') : rawValue
  return normalizedFieldName(rawField).endsWith(normalizedFieldName(unscopedValue))
}

function isHeaderAliasLiteral(fieldName, value) {
  const rawField = String(fieldName || '')
  const rawValue = String(value || '')
  return /^x-[a-z0-9]+(?:-[a-z0-9]+)+$/iu.test(rawField)
    && /^[a-z][A-Za-z0-9]*$/u.test(rawValue)
    && normalizedFieldName(rawField).endsWith(normalizedFieldName(rawValue))
}

function isOpaqueCredentialLiteral(value) {
  const text = String(value || '')
  return /^[\x21-\x7e]{8,}$/u.test(text)
    && /[A-Za-z0-9]/u.test(text)
    && !(/^[a-z]+(?:-[a-z]+)+$/u.test(text) && text.length < 16)
}

function isTestFixturePath(pathname) {
  const normalized = `/${pathname.toLowerCase()}/`
  const name = basename(pathname).toLowerCase()
  return normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('/__tests__/')
    || name.includes('.test.')
    || name.endsWith('.test')
    || name.startsWith('test-')
    || name.includes('test-matrix')
    || pathname === 'scripts/take-screenshots.ts'
}

function isExplicitTestPlaceholder(pathname, value) {
  if (!isTestFixturePath(pathname)) return false
  const normalized = String(value || '').trim().toLowerCase()
  return normalized.includes('must-not-persist')
    || normalized.includes('must-not-leak')
    || normalized.includes('must-not-')
    || normalized.includes('never-emit')
    || normalized.includes('never-returned')
    || normalized.includes('not-returned')
    || normalized.includes('not-a-secret')
    || normalized.includes('screenshots')
    || normalized.includes('canary')
    || normalized.includes('e2e-')
    || normalized.includes('for-testing')
    || normalized.includes('isolated-observation')
    || normalized.includes('probe-token')
    || normalized.includes('secure-pass')
    || normalized.startsWith('hidden')
    || normalized === 'tenant_private'
    || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)
    || /(?:^|[-_])(fixture|mock|placeholder|synthetic)(?:[-_]|$)/u.test(normalized)
    || /^(?:admin|password|test|dummy|example)[-_a-z0-9!]*$/u.test(normalized)
    || /^(?:x|[a-z-]*password|[a-z-]*-token)$/u.test(normalized)
}

function contextualFinding(pathname, value, position, location, options = {}) {
  if (isSafeReferenceLiteral(value)
    || isStorageIdentifierLiteral(options.fieldName, value)
    || isHeaderAliasLiteral(options.fieldName, value)
    || (options.allowTestPlaceholders === true && isExplicitTestPlaceholder(pathname, value))) {
    return null
  }
  if (options.requireOpaqueCredential === true && !isOpaqueCredentialLiteral(value)) return null
  if (scanHighConfidenceSensitiveValues(value).length > 0) return null
  return finding(
    pathname,
    'hardcoded_credential',
    'critical',
    value,
    position,
    location,
  )
}

let typescriptCompiler
function loadTypescriptCompiler() {
  if (!typescriptCompiler) typescriptCompiler = moduleRequire('typescript')
  return typescriptCompiler
}

function staticPropertyName(ts, node) {
  if (!node) return null
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) {
    return node.expression.text
  }
  return null
}

function assignmentTargetName(ts, node) {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && node.argumentExpression
    && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
  return null
}

function staticStringValue(ts, node) {
  if (!node) return null
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function scanCodeAssignments(pathname, text, options) {
  const ts = loadTypescriptCompiler()
  const extension = extname(pathname).toLowerCase()
  const kind = extension === '.json' || extension === '.jsonc'
    ? ts.ScriptKind.JSON
    : extension.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(pathname, text, ts.ScriptTarget.Latest, true, kind)
  const findings = []

  const inspect = (name, initializer) => {
    if (!isSensitiveFieldName(name)) return
    const value = staticStringValue(ts, initializer)
    if (value === null) return
    const start = initializer.getStart(source)
    const point = source.getLineAndCharacterOfPosition(start)
    const match = contextualFinding(pathname, value, start, {
      line: point.line + 1,
      column: point.character + 1,
    }, { ...options, fieldName: name })
    if (match) findings.push(match)
  }

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      inspect(node.name.text, node.initializer)
    } else if (ts.isPropertyAssignment(node)) {
      inspect(staticPropertyName(ts, node.name), node.initializer)
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      inspect(assignmentTargetName(ts, node.left), node.right)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function scanLiteralAssignments(pathname, text, options) {
  const findings = []
  const pattern = /(?:^|[,{;\n]\s*)(?:export\s+)?(?:const\s+|let\s+|var\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(["'`])([^\n"'`]*?)\2(?=\s*(?:[,;}\n]|$))/gu
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (!isSensitiveFieldName(match[1]) || match[3].includes('${')) continue
    const valueOffset = match.index + match[0].lastIndexOf(match[3])
    const candidate = contextualFinding(
      pathname,
      match[3],
      valueOffset,
      locationForOffset(text, valueOffset),
      { ...options, fieldName: match[1] },
    )
    if (candidate) findings.push(candidate)
  }
  return findings
}

function scanTextAssignments(pathname, text, options) {
  const findings = []
  let offset = 0
  const extension = extname(pathname).toLowerCase()
  const delimiter = ['.yaml', '.yml'].includes(extension) ? '[:=]' : '='
  const assignmentPattern = new RegExp(
    `^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\\s*${delimiter}\\s*(.*?)\\s*$`,
    'u',
  )
  for (const line of text.split('\n')) {
    const match = assignmentPattern.exec(line)
    if (match && isSensitiveFieldName(match[1])) {
      let value = match[2].replace(/\s+#.*$/u, '').trim()
      if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      if (!value.includes('$') && !value.includes('`')) {
        const valueOffset = offset + Math.max(0, line.indexOf(match[2]))
        const candidate = contextualFinding(
          pathname,
          value,
          valueOffset,
          locationForOffset(text, valueOffset),
          { ...options, fieldName: match[1] },
        )
        if (candidate) findings.push(candidate)
      }
    }
    offset += line.length + 1
  }
  return findings
}

function supportsTextAssignmentScan(pathname) {
  const name = basename(pathname).toLowerCase()
  return ASSIGNMENT_TEXT_EXTENSIONS.has(extname(name))
    || name === '.env'
    || name.startsWith('.env.')
}

function isDependencyLockfile(pathname) {
  return [
    'bun.lock', 'bun.lockb', 'composer.lock', 'package-lock.json', 'pnpm-lock.yaml',
    'poetry.lock', 'uv.lock', 'yarn.lock',
  ].includes(basename(pathname).toLowerCase())
}

export function scanReleaseFile(pathname, content, options = {}) {
  if (!Buffer.isBuffer(content)) content = Buffer.from(content)
  if (content.length > MAX_FILE_BYTES) throw new Error('sensitive_scan_file_too_large')
  const text = content.toString('utf8')
  const findings = scanHighConfidenceSensitiveValues(content.toString('latin1')).map(match => {
    const location = locationForOffset(content.toString('latin1'), match.position)
    return finding(pathname, match.type, match.severity, match.value, match.position, location)
  })

  if (options.contextual !== false && !content.includes(0)) {
    const extension = extname(pathname).toLowerCase()
    if (CODE_EXTENSIONS.has(extension) && !pathname.startsWith('messages/')) {
      findings.push(...(
        options.useTypescript === false
          ? scanLiteralAssignments(pathname, text, options)
          : scanCodeAssignments(pathname, text, options)
      ))
    } else if (supportsTextAssignmentScan(pathname)) {
      findings.push(...scanTextAssignments(pathname, text, options))
    }
  }
  return findings
}

function loadAllowlist(content) {
  let value
  try {
    value = JSON.parse(content.toString('utf8'))
  } catch {
    throw new Error('sensitive_scan_allowlist_invalid')
  }
  if (value?.schema !== SOURCE_ALLOWLIST_SCHEMA || !Array.isArray(value.entries)) {
    throw new Error('sensitive_scan_allowlist_invalid')
  }
  const entries = new Map()
  for (const entry of value.entries) {
    const path = normalizedRepositoryPath(entry?.path)
    const type = entry?.type
    const fingerprint = entry?.fingerprint
    const occurrences = entry?.occurrences
    const reason = entry?.reason
    if (!isTestFixturePath(path) || typeof type !== 'string' || !type
      || typeof fingerprint !== 'string' || !SHA256.test(fingerprint)
      || !Number.isSafeInteger(occurrences) || occurrences <= 0
      || typeof reason !== 'string' || reason.trim().length < 12) {
      throw new Error('sensitive_scan_allowlist_invalid')
    }
    const key = `${path}\0${type}\0${fingerprint}`
    if (entries.has(key)) throw new Error('sensitive_scan_allowlist_duplicate')
    entries.set(key, { ...entry, path })
  }
  return entries
}

function applySourceAllowlist(findings, entries) {
  const counts = new Map()
  for (const item of findings) {
    const key = `${item.path}\0${item.type}\0${item.fingerprint}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  for (const [key, entry] of entries) {
    if ((counts.get(key) || 0) !== entry.occurrences) {
      throw new Error(`sensitive_scan_allowlist_stale:${entry.path}:${entry.type}`)
    }
  }
  return findings.filter(item => !entries.has(
    `${item.path}\0${item.type}\0${item.fingerprint}`,
  ))
}

function publicFinding(item) {
  return {
    path: item.path,
    type: item.type,
    severity: item.severity,
    line: item.line,
    column: item.column,
  }
}

function finalizeReport(report, findings) {
  const publicFindings = findings.map(publicFinding)
  const result = {
    schema: REPORT_SCHEMA,
    ok: publicFindings.length === 0,
    ...report,
    findings: publicFindings,
  }
  if (publicFindings.length > 0) {
    const error = new Error('sensitive_content_detected')
    error.report = result
    throw error
  }
  return result
}

export function scanSourceSensitiveContent(options = {}) {
  const repositoryRoot = physicalDirectory(options.repositoryRoot || MODULE_ROOT, 'sensitive_source_root')
  const revision = options.commit || null
  const commit = revision ? resolveGitCommit(repositoryRoot, revision) : null
  const members = commit
    ? gitCommitMembers(repositoryRoot, commit)
    : worktreeMembers(repositoryRoot)
  const readMember = member => commit
    ? gitCommitFile(repositoryRoot, commit, member)
    : safeWorktreeFile(repositoryRoot, member)
  const findings = []
  let bytesScanned = 0
  for (const member of members) {
    const content = readMember(member)
    bytesScanned += content.length
    findings.push(...scanReleaseFile(member, content, {
      contextual: !isDependencyLockfile(member),
      allowTestPlaceholders: true,
    }))
  }

  const allowlistPath = options.allowlistPath
    ? normalizedRepositoryPath(options.allowlistPath)
    : null
  const allowlist = allowlistPath ? loadAllowlist(readMember(allowlistPath)) : new Map()
  const remaining = applySourceAllowlist(findings, allowlist)
  return finalizeReport({
    mode: commit ? 'source-commit' : 'source-worktree',
    commit,
    filesScanned: members.length,
    bytesScanned,
    allowlistEntries: allowlist.size,
  }, remaining)
}

function parsedStandaloneManifest(root) {
  const pathname = join(root, 'release-manifest.json')
  const stat = lstatSync(pathname)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    throw new Error('sensitive_scan_release_manifest_unsafe')
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(pathname, 'utf8'))
  } catch {
    throw new Error('sensitive_scan_release_manifest_invalid')
  }
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.files)) {
    throw new Error('sensitive_scan_release_manifest_invalid')
  }
  return { pathname, manifest }
}

function isStandaloneDependency(member) {
  return member.startsWith('node_modules/')
    || member.startsWith('.next/node_modules/')
    || /^\.next\/server\/chunks\/(?:ssr\/)?[^/]*node_modules__pnpm_/u.test(member)
    || /^\.next\/server\/chunks\/(?:ssr\/)?[^/]*_next_dist_/u.test(member)
}

function isCompiledMessageCatalog(member) {
  return /^\.next\/server\/chunks\/(?:ssr\/)?messages_[^/]+_json_/u.test(member)
}

export function scanStandaloneSensitiveContent(rootPath) {
  const root = physicalDirectory(rootPath || resolve('.next/standalone'), 'sensitive_standalone_root')
  const { pathname: manifestPath, manifest } = parsedStandaloneManifest(root)
  const findings = []
  let bytesScanned = 0
  for (const declared of manifest.files) {
    const member = normalizedRepositoryPath(declared?.path)
    if (typeof declared?.sha256 !== 'string' || !SHA256.test(declared.sha256)) {
      throw new Error('sensitive_scan_release_manifest_invalid')
    }
    const content = safeWorktreeFile(root, member)
    if (sha256(content) !== declared.sha256) throw new Error('sensitive_scan_artifact_digest_mismatch')
    bytesScanned += content.length
    findings.push(...scanReleaseFile(member, content, {
      contextual: !isStandaloneDependency(member) && !isCompiledMessageCatalog(member),
      requireOpaqueCredential: member.startsWith('.next/'),
      useTypescript: false,
    }))
  }
  const manifestContent = readFileSync(manifestPath)
  bytesScanned += manifestContent.length
  findings.push(...scanReleaseFile('release-manifest.json', manifestContent, { contextual: false }))
  return finalizeReport({
    mode: 'standalone',
    commit: null,
    filesScanned: manifest.files.length + 1,
    bytesScanned,
    allowlistEntries: 0,
  }, findings)
}

function parseArguments(argv) {
  const [mode, ...rest] = argv
  if (!['source', 'standalone'].includes(mode)) throw new Error('sensitive_scan_arguments_invalid')
  const values = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!['--repository-root', '--commit', '--allowlist', '--root'].includes(key)
      || value === undefined || value.startsWith('--') || values.has(key)) {
      throw new Error('sensitive_scan_arguments_invalid')
    }
    values.set(key, value)
  }
  if (mode === 'source' && values.has('--root')) throw new Error('sensitive_scan_arguments_invalid')
  if (mode === 'standalone' && [...values.keys()].some(key => key !== '--root')) {
    throw new Error('sensitive_scan_arguments_invalid')
  }
  return { mode, values }
}

function sanitizedError(error) {
  if (error?.report) return error.report
  return {
    schema: REPORT_SCHEMA,
    ok: false,
    error: error instanceof Error ? error.message : 'sensitive_scan_failed',
  }
}

const invokedPath = process.argv[1] ? realpathSync.native(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const { mode, values } = parseArguments(process.argv.slice(2))
    const result = mode === 'source'
      ? scanSourceSensitiveContent({
        repositoryRoot: values.get('--repository-root') || MODULE_ROOT,
        commit: values.get('--commit') || null,
        allowlistPath: values.get('--allowlist') || null,
      })
      : scanStandaloneSensitiveContent(values.get('--root') || resolve('.next/standalone'))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify(sanitizedError(error))}\n`)
    process.exitCode = 1
  }
}
