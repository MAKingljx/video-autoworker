#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gitSourceEnvironment,
  resolveGitCommitProductPrefix,
  resolveGitSourceLayout,
} from './lib/git-source-layout.mjs'

const COMMIT = /^[a-f0-9]{40}$/u
const PLUGIN_SUITES = Object.freeze(['video-command', 'director-brain', 'task-flow'])
const BUILD_CONFIG_FILES = Object.freeze([
  'package.json', '.nvmrc', 'next.config.js', 'next.config.mjs', 'next.config.ts',
  'tsconfig.json', 'scripts/build-standalone.mjs',
])

export function createBuildCacheDescriptor({
  productRoot = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  nodeAbi = process.versions.modules,
} = {}) {
  const physicalRoot = realpathSync.native(productRoot)
  const hashFile = member => {
    const pathname = resolve(physicalRoot, member)
    try {
      const entry = lstatSync(pathname)
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe')
      return createHash('sha256').update(readFileSync(pathname)).digest('hex')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new Error(`ci_build_cache_input_invalid:${member}`)
    }
  }
  const lockSha256 = hashFile('pnpm-lock.yaml')
  if (!lockSha256) throw new Error('ci_build_cache_lock_missing')
  const buildConfig = Object.fromEntries(BUILD_CONFIG_FILES.map(member => [member, hashFile(member)]))
  const packageValue = JSON.parse(readFileSync(resolve(physicalRoot, 'package.json'), 'utf8'))
  const packageManager = typeof packageValue.packageManager === 'string'
    ? packageValue.packageManager : 'pnpm-unspecified'
  const buildConfigSha256 = createHash('sha256')
    .update(JSON.stringify(buildConfig)).digest('hex')
  const payload = { os: platform, arch, nodeAbi, packageManager, lockSha256,
    buildConfigSha256 }
  return { ...payload,
    key: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
}

function parseArguments(argv) {
  const values = { head: 'HEAD', forceFull: false }
  let baseSeen = false
  let headSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--force-full') {
      if (values.forceFull) throw new Error('ci_impact_force_full_duplicate')
      values.forceFull = true
      continue
    }
    if (!['--base', '--head'].includes(flag) || index + 1 >= argv.length) {
      throw new Error('ci_impact_arguments_invalid')
    }
    if (flag === '--base' && baseSeen) {
      throw new Error('ci_impact_base_duplicate')
    }
    if (flag === '--head' && headSeen) {
      throw new Error('ci_impact_head_duplicate')
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('ci_impact_arguments_invalid')
    if (flag === '--base') {
      baseSeen = true
      values.base = value
    } else {
      headSeen = true
      values.head = value
    }
  }
  return values
}

function git(gitRoot, args, options = {}) {
  return execFileSync('/usr/bin/git', ['-C', gitRoot, ...args], {
    encoding: options.encoding || 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    env: gitSourceEnvironment(),
    input: typeof options.input === 'string' ? Buffer.from(options.input) : options.input,
  })
}

function resolveCommit(gitRoot, revision) {
  const commit = git(gitRoot, ['rev-parse', '--verify', `${revision}^{commit}`]).trim()
  if (!COMMIT.test(commit)) throw new Error('ci_impact_commit_invalid')
  return commit
}

function loadRootPlan(productRoot) {
  const raw = execFileSync(process.execPath, [
    resolve(productRoot, 'scripts/run-root-vitest.mjs'), '--print-plan',
  ], {
    cwd: productRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 4 * 1024 * 1024,
  })
  const plan = JSON.parse(raw)
  if (!Array.isArray(plan.partitions) || plan.partitions[0] !== 'regular'
    || plan.partitions.length < 2
    || plan.partitions.some(item => typeof item !== 'string' || !item)
    || new Set(plan.partitions).size !== plan.partitions.length) {
    throw new Error('ci_impact_root_plan_invalid')
  }
  return plan.partitions
}

function commitTrees(gitRoot, commit, productPrefix) {
  const raw = git(gitRoot, ['ls-tree', '-r', '-z', commit], { encoding: 'buffer' })
  const product = new Map()
  const repository = new Map()
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+(\w+)\s+([a-f0-9]{40,64})\t(.+)$/u.exec(record)
    if (!match) throw new Error('ci_impact_source_tree_invalid')
    const [, mode, type, objectId, treePath] = match
    const identity = `${mode}:${type}:${objectId}`
    if (!productPrefix || treePath.startsWith(productPrefix)) {
      const logicalPath = productPrefix ? treePath.slice(productPrefix.length) : treePath
      if (!logicalPath || product.has(logicalPath)) throw new Error('ci_impact_product_tree_invalid')
      product.set(logicalPath, identity)
    } else {
      repository.set(treePath, identity)
    }
  }
  return { product, repository }
}

function changedLogicalPaths(left, right) {
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter(pathname => left.get(pathname) !== right.get(pathname))
    .sort()
}

function isDocumentation(pathname) {
  if (pathname === 'README.md' || pathname === 'AGENTS.md') return true
  if (!pathname.startsWith('docs/')) return false
  return /\.(?:md|mdx|txt|png|jpe?g|gif|webp|svg|pdf)$/iu.test(pathname)
}

function isRuntimeSkill(pathname) {
  return pathname === 'SKILL.md' || pathname.startsWith('openclaw-skills/')
    || /(?:^|\/)SKILL\.md$/u.test(pathname)
}

function isTestOrFixture(pathname) {
  return /(?:^|\/)(?:__tests__|test|tests|fixtures)(?:\/|$)/u.test(pathname)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(pathname)
    || /^scripts\/test-/u.test(pathname)
}

function isTestFile(pathname) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(pathname)
    || /^scripts\/test-[^/]+\.test\.mjs$/u.test(pathname)
}

function pluginSuitesFor(paths) {
  const suites = new Set()
  for (const pathname of paths) {
    if (pathname.startsWith('openclaw-plugins/aiworker-video-command/')
      || pathname === 'scripts/install-aiworker-video-command-plugin.sh') {
      suites.add('video-command')
    }
    if (pathname.startsWith('openclaw-plugins/aiworker-director-brain/')
      || pathname.startsWith('openclaw-skills/aiworker-director-brain/')
      || pathname === 'scripts/install-aiworker-director-brain.sh') {
      suites.add('director-brain')
    }
    if (pathname.startsWith('openclaw-skills/aiworker-task-flow/')
      || pathname === 'scripts/install-aiworker-task-flow-skill.sh') {
      suites.add('task-flow')
    }
    if (isRuntimeSkill(pathname)
      && !pathname.startsWith('openclaw-plugins/aiworker-video-command/')
      && !pathname.startsWith('openclaw-plugins/aiworker-director-brain/')
      && !pathname.startsWith('openclaw-skills/aiworker-director-brain/')
      && !pathname.startsWith('openclaw-skills/aiworker-task-flow/')) {
      for (const suite of PLUGIN_SUITES) suites.add(suite)
    }
  }
  return PLUGIN_SUITES.filter(suite => suites.has(suite))
}

function isProductionSource(pathname) {
  return !isTestOrFixture(pathname)
    && /\.(?:cjs|js|jsx|mjs|cts|ts|tsx|mts|sh)$/u.test(pathname)
}

const BROWSER_SPEC = /^tests\/.*\.spec\.[cm]?[jt]sx?$/u
const BROWSER_UI_SMOKE = ['tests/dashboard-overview-layout.spec.ts', 'tests/login-flow.spec.ts', 'tests/i18n-language-switcher.spec.ts']
const BROWSER_FEATURES = [
  [/notifications/u, ['notifications']],
  [/(?:task-board|tasks-panel|task-runs)/u, ['tasks-crud', 'task-queue', 'task-regression', 'task-outcomes']],
  [/workspace-projects/u, ['projects-crud', 'project-agents']],
  [/gateway-config/u, ['gateway-config']],
  [/multi-gateway/u, ['gateway-connect', 'gateway-health-history']],
  [/cron-management/u, ['cron-operations']],
  [/webhook-panel/u, ['webhooks-crud']],
  [/alert-rules/u, ['alerts-crud']],
  [/github-sync/u, ['github-sync']],
  [/skills-panel/u, ['skills-crud', 'skills-registry']],
  [/user-management/u, ['user-management']],
  [/security-audit/u, ['security-audit', 'security-scan-api']],
  [/exec-approval/u, ['exec-approval-allowlist']],
  [/memory-(?:browser|graph)/u, ['memory-knowledge']],
  [/documents-panel/u, ['docs-knowledge']],
  [/channels-panel/u, ['channels-api']],
  [/(?:agent-cost|cost-tracker|token-dashboard)/u, ['agent-costs']],
  [/agent-comms/u, ['agent-comms']],
  [/session-details/u, ['session-controls', 'sessions-continue']],
  [/chat-page/u, ['chat-session-prefs']],
]

function isBrowserSurface(pathname) {
  return !isTestOrFixture(pathname) && (pathname.startsWith('public/') || pathname.startsWith('messages/')
    || pathname.startsWith('src/components/') || pathname.startsWith('src/styles/')
    || (pathname.startsWith('src/app/') && !pathname.startsWith('src/app/api/'))
    || /\.(?:css|scss|sass|less)$/u.test(pathname))
}

function listBrowserFiles(productRoot) {
  try {
    return readdirSync(resolve(productRoot, 'tests'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => posix.join('tests', posix.relative(resolve(productRoot, 'tests'), entry.parentPath || entry.path), entry.name))
      .filter(pathname => BROWSER_SPEC.test(pathname)).sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

// A single cat-file batch reads immutable source blobs; plan generation needs no dependency installation.
function readBrowserSources(gitRoot, tree) {
  const members = [...tree].filter(([member, identity]) => (
    /^(?:src|tests)\/.+\.[cm]?[jt]sx?$/u.test(member)
      && (!isTestOrFixture(member) || member.startsWith('tests/'))
      && identity.startsWith('100')
  ))
  if (!members.length) return new Map()
  const output = git(gitRoot, ['cat-file', '--batch'], {
    encoding: 'buffer', input: `${members.map(([, identity]) => identity.split(':').at(-1)).join('\n')}\n`,
  })
  let offset = 0
  const sources = new Map()
  for (const [member] of members) {
    const end = output.indexOf(10, offset)
    const match = /^[a-f0-9]+ blob (\d+)$/u.exec(output.subarray(offset, end).toString('utf8'))
    if (!match) throw new Error('ci_browser_source_invalid')
    const length = Number(match[1])
    offset = end + 1
    if (offset + length >= output.length) throw new Error('ci_browser_source_truncated')
    sources.set(member, output.subarray(offset, offset + length).toString('utf8'))
    offset += length + 1
  }
  return sources
}

/** Select changed specs, their helper dependants, API callers and the affected UI smoke/feature scopes. */
export function selectBrowserTests({ paths, sources }) {
  const available = [...sources.keys()].filter(member => BROWSER_SPEC.test(member)).sort()
  const selected = new Set()
  const reasons = new Set()
  const add = (files, reason) => {
    for (const member of files) if (available.includes(member)) selected.add(member)
    reasons.add(reason)
  }
  const reverse = new Map()
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']
  for (const [member, source] of sources) {
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu)
    for (const [, specifier] of imports) {
      const base = specifier.startsWith('@/') ? `src/${specifier.slice(2)}`
        : specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(member), specifier)) : null
      if (!base) continue
      const dependency = extensions.map(extension => `${base}${extension}`).find(candidate => sources.has(candidate) || paths.includes(candidate))
      if (!dependency) continue
      if (!reverse.has(dependency)) reverse.set(dependency, new Set())
      reverse.get(dependency).add(member)
    }
  }
  const affected = new Set(paths)
  for (const member of affected) for (const consumer of reverse.get(member) || []) affected.add(consumer)
  for (const member of affected) {
    if (BROWSER_SPEC.test(member)) add([member], paths.includes(member) ? 'changed_browser_test' : 'browser_dependency_changed')
    const route = /^src\/app(\/api\/.*?)\/route\.[jt]s$/u.exec(member)?.[1]
    if (route) {
      const prefix = route.split('/[')[0]
      const callers = new Set([...sources].filter(([file, source]) => file.startsWith('tests/') && source.includes(prefix)).map(([file]) => file))
      for (const caller of callers) for (const consumer of reverse.get(caller) || []) callers.add(consumer)
      add(available.filter(file => callers.has(file)), `api_scope:${prefix}`)
    }
    if (isBrowserSurface(member)) {
      add(BROWSER_UI_SMOKE, 'ui_smoke_scope')
      for (const [pattern, specs] of BROWSER_FEATURES) {
        if (pattern.test(member)) add(specs.map(name => `tests/${name}.spec.ts`), `ui_feature:${specs[0]}`)
      }
    }
  }
  if (paths.some(member => /^playwright(?:\.[^.]+)*\.config\.[cm]?[jt]s$/u.test(member)
    || member.startsWith('scripts/e2e-openclaw/') || member === 'tests/e2e-artifact-integrity.ts')) {
    add(available, 'browser_harness_changed')
  }
  if (!selected.size && paths.some(member => member.startsWith('tests/') && !BROWSER_SPEC.test(member))) {
    add(available, 'browser_helper_scope_unknown')
  }
  const requiresBrowser = paths.some(member => BROWSER_SPEC.test(member) && sources.has(member))
    || [...affected].some(isBrowserSurface)
    || reasons.has('browser_harness_changed')
    || reasons.has('browser_helper_scope_unknown')
  if (requiresBrowser && !selected.size) throw new Error('ci_browser_selection_empty')
  return { browserTestFiles: [...selected].sort(), browserReasons: [...reasons].sort() }
}

function unique(values) {
  return [...new Set(values)]
}

function fullPlan({ base, head, reasons, changedCount, partitions, buildCache, productRoot }) {
  const browserTestFiles = listBrowserFiles(productRoot)
  if (!browserTestFiles.length) throw new Error('ci_browser_selection_empty')
  return {
    mode: 'full', base, head, reasons: unique(reasons), changedCount,
    rootPartitions: partitions,
    relatedFiles: [],
    testFiles: [],
    browserTestFiles,
    browserReasons: ['explicit_full_suite'],
    pluginSuites: [...PLUGIN_SUITES],
    buildCache,
    runIntegration: true,
    runBrowserTests: true,
    runPluginTests: true,
  }
}

function unknownTargetedPlan({ base, head, reason, buildCache }) {
  return {
    mode: 'targeted', base, head, reasons: [reason], changedCount: 0,
    rootPartitions: ['regular'], relatedFiles: [],
    testFiles: [], pluginSuites: [],
    browserTestFiles: [], browserReasons: [],
    buildCache,
    runIntegration: true, runBrowserTests: false, runPluginTests: false,
  }
}

export function createCiImpactPlan({ productRoot = process.cwd(), ...options } = {}) {
  const partitions = loadRootPlan(productRoot)
  const buildCache = createBuildCacheDescriptor({ productRoot })
  let layout
  let head
  try {
    layout = resolveGitSourceLayout(productRoot)
    head = resolveCommit(layout.gitRoot, options.head || 'HEAD')
  } catch {
    return options.forceFull ? fullPlan({
      base: options.base || null,
      head: options.head || 'HEAD',
      reasons: ['head_or_layout_unavailable'],
      changedCount: 0,
      partitions, buildCache, productRoot,
    }) : unknownTargetedPlan({
      base: options.base || null,
      head: options.head || 'HEAD',
      reason: 'head_or_layout_unknown_requires_build_static', buildCache,
    })
  }
  let base
  if (!options.base) {
    return options.forceFull
      ? fullPlan({ base: null, head, reasons: ['force_full', 'base_missing'], changedCount: 0, partitions, buildCache, productRoot })
      : unknownTargetedPlan({ base: null, head, reason: 'base_missing_requires_build_static', buildCache })
  }
  try {
    base = resolveCommit(layout.gitRoot, options.base)
  } catch {
    return options.forceFull ? fullPlan({
      base: options.base, head, reasons: ['base_unavailable'], changedCount: 0, partitions, buildCache, productRoot,
    }) : unknownTargetedPlan({
      base: options.base, head, reason: 'base_unknown_requires_build_static', buildCache,
    })
  }
  let basePrefix
  let headPrefix
  try {
    basePrefix = resolveGitCommitProductPrefix(layout.gitRoot, base)
    headPrefix = resolveGitCommitProductPrefix(layout.gitRoot, head)
  } catch {
    return options.forceFull ? fullPlan({
      base, head, reasons: ['commit_layout_unavailable'], changedCount: 0, partitions, buildCache, productRoot,
    }) : unknownTargetedPlan({
      base, head, reason: 'commit_layout_unknown_requires_build_static', buildCache,
    })
  }
  const baseTrees = commitTrees(layout.gitRoot, base, basePrefix)
  const headTrees = commitTrees(layout.gitRoot, head, headPrefix)
  const productPaths = changedLogicalPaths(baseTrees.product, headTrees.product)
  const repositoryPaths = changedLogicalPaths(baseTrees.repository, headTrees.repository)
  const changedCount = productPaths.length + repositoryPaths.length
  if (options.forceFull) {
    return fullPlan({
      base, head, reasons: ['force_full'], changedCount, partitions, buildCache, productRoot,
    })
  }
  const layoutChanged = basePrefix !== headPrefix
  if (changedCount === 0 && !layoutChanged) {
    return {
      mode: 'docs', base, head, reasons: ['no_changes'], changedCount: 0,
      rootPartitions: [], relatedFiles: [],
      testFiles: [], pluginSuites: [],
      browserTestFiles: [], browserReasons: [],
      buildCache,
      runIntegration: false, runBrowserTests: false, runPluginTests: false,
    }
  }
  const docsOnly = !layoutChanged
    && [...productPaths, ...repositoryPaths].every(pathname => (
      !isRuntimeSkill(pathname) && isDocumentation(pathname)
    ))
  if (docsOnly) {
    return {
      mode: 'docs', base, head, reasons: ['documentation_only'], changedCount,
      rootPartitions: [], relatedFiles: [],
      testFiles: [], pluginSuites: [],
      browserTestFiles: [], browserReasons: [],
      buildCache,
      runIntegration: false, runBrowserTests: false, runPluginTests: false,
    }
  }
  const relatedFiles = productPaths.filter(isProductionSource)
  const testFiles = productPaths.filter(pathname => isTestFile(pathname) && !pathname.startsWith('tests/'))
  const browserSelection = selectBrowserTests({
    paths: productPaths, sources: readBrowserSources(layout.gitRoot, headTrees.product),
  })
  const pluginSuites = pluginSuitesFor(productPaths)
  const nonDocumentation = [...productPaths, ...repositoryPaths].filter(pathname => (
    isRuntimeSkill(pathname) || !isDocumentation(pathname)
  ))
  const onlyTestsOrFixtures = nonDocumentation.length > 0
    && nonDocumentation.every(pathname => isTestOrFixture(pathname))
  const knownProductInputs = productPaths.every(pathname => (
    isDocumentation(pathname) || isRuntimeSkill(pathname) || isTestOrFixture(pathname)
      || isProductionSource(pathname) || pathname.startsWith('public/')
      || pathname.startsWith('messages/')
  ))
  const reasons = [
    ...(layoutChanged ? ['git_source_layout_changed_without_content_drift'] : []),
    ...(relatedFiles.length ? ['production_source_changed'] : []),
    ...(onlyTestsOrFixtures ? ['test_or_fixture_only'] : []),
    ...(!knownProductInputs || repositoryPaths.some(pathname => !isDocumentation(pathname))
      ? ['unknown_requires_build_static'] : []),
  ]
  return {
    mode: 'targeted', base, head,
    reasons: unique(reasons.length ? reasons : ['targeted_change']),
    changedCount,
    rootPartitions: ['regular'],
    relatedFiles,
    testFiles,
    ...browserSelection,
    pluginSuites,
    buildCache,
    runIntegration: layoutChanged || relatedFiles.length > 0
      || browserSelection.browserTestFiles.length > 0 || reasons.includes('unknown_requires_build_static'),
    runBrowserTests: browserSelection.browserTestFiles.length > 0,
    runPluginTests: pluginSuites.length > 0,
  }
}

function main(argv) {
  const args = parseArguments(argv)
  const result = createCiImpactPlan({
    productRoot: realpathSync.native(process.cwd()),
    base: args.base,
    head: args.head,
    forceFull: args.forceFull,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'ci_impact_failed'}\n`)
    process.exitCode = 1
  }
}
