// Read-only Git and immutable build-source proof shared by artifact auditing
// and runtime readiness. No OpenClaw configuration, installation or upgrade code.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertCanonicalMainlineGitSource } from './canonical-release-source.mjs'
import { MAX_APPLICATION_RELEASE_MANIFEST_BYTES } from './application-release-manifest-contract.mjs'
import {
  DIRECTOR_EXTRACTION_PROVENANCE_NAME,
  isStandaloneArtifactContentBinding,
  sourceClosureForGitCommit,
  STANDALONE_BUILD_SOURCE_ANCHOR_SCHEMA,
  STANDALONE_PROVENANCE_SCHEMA,
  standaloneProvenanceSchemaForGitCommit,
} from './director-extraction-release-provenance.mjs'
import {
  DIRECTOR_PROJECTION_PROTOCOL,
  DIRECTOR_PROJECTION_PROTOCOL_DIGEST,
  directorProjectionCompatibilitySha256,
  loadDirectorProjectionContractCompatibility,
} from './director-projection-contract-compatibility.mjs'
import { gitSourceEnvironment, resolveGitSourceLayout } from './git-source-layout.mjs'

const SHA256 = /^[a-f0-9]{64}$/u
const GIT_COMMIT = /^[a-f0-9]{40}$/u
const RELEASE_ID = /^([a-f0-9]{7,40})(?:-runtime)?$/u

function fail(message) {
  throw new Error(`director_video_release_not_ready:${message}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

function fileSha256(pathname) {
  return sha256(readFileSync(pathname))
}

function safeFile(pathname, label) {
  let entry
  try {
    entry = lstatSync(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o6022) !== 0) {
    fail(`${label}_unsafe`)
  }
  return entry
}

function safeApplicationReleaseManifest(pathname, label) {
  const entry = safeFile(pathname, label)
  if (entry.size <= 0 || entry.size > MAX_APPLICATION_RELEASE_MANIFEST_BYTES) {
    fail(`${label}_size_invalid`)
  }
  return entry
}

function parsedJsonObject(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function gitOutput(repositoryRoot, args) {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitSourceEnvironment(),
    }).trim()
  } catch {
    fail('git_identity_invalid')
  }
}

function gitSucceeds(repositoryRoot, args) {
  try {
    execFileSync('git', ['-C', repositoryRoot, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: gitSourceEnvironment(),
    })
    return true
  } catch {
    return false
  }
}

export function assertRepositoryRelease(repositoryRoot, releaseId, mode = 'head') {
  const match = RELEASE_ID.exec(releaseId)
  if (!match) fail('release_id_invalid')
  if (!['head', 'ancestor'].includes(mode)) fail('repository_release_mode_invalid')
  let gitRoot
  try {
    ;({ gitRoot } = resolveGitSourceLayout(repositoryRoot))
  } catch {
    fail('repository_source_layout_invalid')
  }
  const head = gitOutput(gitRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const resolved = gitOutput(gitRoot, ['rev-parse', '--verify', `${match[1]}^{commit}`])
  try { assertCanonicalMainlineGitSource(repositoryRoot, head) }
  catch (error) {
    if (error.message.includes('canonical_remote_mismatch')) fail('repository_remote_mismatch')
    fail('repository_release_mismatch')
  }
  const releaseAccepted = mode === 'head'
    ? resolved === head
    : gitSucceeds(gitRoot, ['merge-base', '--is-ancestor', resolved, head])
  if (!GIT_COMMIT.test(head) || !GIT_COMMIT.test(resolved) || !releaseAccepted) {
    fail('repository_release_mismatch')
  }
  return resolved
}

export function verifyDirectorExtractionReleaseProvenance({
  repositoryRoot,
  releaseRoot,
  commit,
  artifactContent = null,
}) {
  const provenancePath = join(releaseRoot, DIRECTOR_EXTRACTION_PROVENANCE_NAME)
  safeFile(provenancePath, 'app_release_provenance')
  const provenance = parsedJsonObject(readFileSync(provenancePath, 'utf8'))
  let writerSchema
  try { writerSchema = standaloneProvenanceSchemaForGitCommit(repositoryRoot, commit) }
  catch { fail('app_release_provenance_invalid') }
  const hasProjectionBinding = writerSchema === STANDALONE_PROVENANCE_SCHEMA
  if (!provenance
    || provenance.schema !== writerSchema
    || provenance.gitCommit !== commit
    || provenance.gitDirty !== false
    || provenance.buildSourceAnchor?.schema !== STANDALONE_BUILD_SOURCE_ANCHOR_SCHEMA
    || provenance.buildSourceAnchor?.gitCommit !== commit
    || provenance.buildSourceAnchor?.gitDirty !== false
    || typeof provenance.buildSourceAnchor?.sourceClosureSha256 !== 'string'
    || !SHA256.test(provenance.buildSourceAnchor.sourceClosureSha256)
    || typeof provenance.buildSourceAnchor?.buildNonce !== 'string'
    || !SHA256.test(provenance.buildSourceAnchor.buildNonce)
    || !isStandaloneArtifactContentBinding(provenance.artifactContent)) {
    fail('app_release_provenance_invalid')
  }
  let expectedClosure
  try {
    expectedClosure = sourceClosureForGitCommit(repositoryRoot, commit)
  } catch {
    fail('app_release_source_closure_unavailable')
  }
  if (canonicalJson(provenance.sourceClosure) !== canonicalJson(expectedClosure)) {
    fail('app_release_source_closure_mismatch')
  }
  if (provenance.buildSourceAnchor.sourceClosureSha256
    !== sha256(canonicalJson(expectedClosure))) {
    fail('app_release_build_source_anchor_mismatch')
  }
  const expectedProjectionProtocol = {
    descriptor: DIRECTOR_PROJECTION_PROTOCOL,
    digest: DIRECTOR_PROJECTION_PROTOCOL_DIGEST,
  }
  const expectedProjectionImplementation = {
    algorithm: 'sha256',
    schema: 'video-autoworker-director-projection-implementation/v1',
    sourceClosureSha256: sha256(canonicalJson(expectedClosure)),
  }
  if (hasProjectionBinding
    ? canonicalJson(provenance.projectionProtocol) !== canonicalJson(expectedProjectionProtocol)
      || canonicalJson(provenance.projectionImplementation) !== canonicalJson(expectedProjectionImplementation)
    : Object.hasOwn(provenance, 'projectionProtocol') || Object.hasOwn(provenance, 'projectionImplementation')) {
    fail('app_release_projection_protocol_binding_invalid')
  }
  const releaseManifestPath = join(releaseRoot, 'release-manifest.json')
  safeApplicationReleaseManifest(releaseManifestPath, 'app_release_manifest')
  const releaseManifest = parsedJsonObject(readFileSync(releaseManifestPath, 'utf8'))
  if (releaseManifest?.schemaVersion !== 2
    || !isStandaloneArtifactContentBinding(releaseManifest.artifactContent)
    || canonicalJson(releaseManifest.artifactContent)
      !== canonicalJson(provenance.artifactContent)
    || (artifactContent && canonicalJson(artifactContent)
      !== canonicalJson(provenance.artifactContent))
    || (hasProjectionBinding
      ? canonicalJson(releaseManifest.projectionProtocol) !== canonicalJson(expectedProjectionProtocol)
        || canonicalJson(releaseManifest.projectionImplementation) !== canonicalJson(expectedProjectionImplementation)
      : Object.hasOwn(releaseManifest, 'projectionProtocol') || Object.hasOwn(releaseManifest, 'projectionImplementation'))) {
    fail('app_release_artifact_content_binding_invalid')
  }
  const expectedCompatibility = loadDirectorProjectionContractCompatibility(repositoryRoot, {
    gitCommit: commit,
    optional: true,
  })
  if (canonicalJson(provenance.projectionContractCompatibility ?? null)
      !== canonicalJson(expectedCompatibility)
    || canonicalJson(releaseManifest.projectionContractCompatibility ?? null)
      !== canonicalJson(expectedCompatibility)
    || (expectedCompatibility
      ? provenance.projectionContractCompatibilitySha256
        !== directorProjectionCompatibilitySha256(expectedCompatibility)
        || releaseManifest.projectionContractCompatibilitySha256
          !== provenance.projectionContractCompatibilitySha256
      : provenance.projectionContractCompatibilitySha256 !== undefined
        || releaseManifest.projectionContractCompatibilitySha256 !== undefined)) {
    fail('app_release_projection_compatibility_binding_invalid')
  }
  const member = Array.isArray(releaseManifest?.files)
    ? releaseManifest.files.find(item => item?.path === DIRECTOR_EXTRACTION_PROVENANCE_NAME)
    : null
  if (!member || member.sha256 !== fileSha256(provenancePath)) {
    fail('app_release_provenance_not_manifested')
  }
  return {
    schema: provenance.schema,
    gitCommit: provenance.gitCommit,
    sourceFiles: expectedClosure.files.length,
    sha256: fileSha256(provenancePath),
    artifactContent: provenance.artifactContent,
    projectionProtocol: provenance.projectionProtocol,
    projectionImplementation: provenance.projectionImplementation,
    projectionContractCompatibility: expectedCompatibility,
    projectionContractCompatibilitySha256: expectedCompatibility
      ? directorProjectionCompatibilitySha256(expectedCompatibility)
      : null,
  }
}
