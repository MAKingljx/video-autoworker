#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gitSourceEnvironment,
  resolveGitCommitProductPrefix,
  resolveGitSourceLayout,
} from './lib/git-source-layout.mjs'

const COMMIT = /^[a-f0-9]{40}$/u
const PLUGIN_SUITES = Object.freeze(['video-command', 'director-brain', 'task-flow'])

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
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    env: gitSourceEnvironment(),
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

function needsBrowser(paths) {
  return paths.some(pathname => (
    pathname.startsWith('public/')
    || pathname.startsWith('messages/')
    || pathname.startsWith('src/components/')
    || pathname.startsWith('src/styles/')
    || (pathname.startsWith('src/app/') && !pathname.startsWith('src/app/api/'))
    || /\.(?:css|scss|sass|less)$/u.test(pathname)
  ))
}

function unique(values) {
  return [...new Set(values)]
}

function fullPlan({ base, head, reasons, changedCount, partitions }) {
  return {
    mode: 'full', base, head, reasons: unique(reasons), changedCount,
    rootPartitions: partitions,
    relatedFiles: [],
    testFiles: [],
    pluginSuites: [...PLUGIN_SUITES],
    runIntegration: true,
    runBrowserTests: true,
    runPluginTests: true,
  }
}

function unknownTargetedPlan({ base, head, reason }) {
  return {
    mode: 'targeted', base, head, reasons: [reason], changedCount: 0,
    rootPartitions: ['regular'], relatedFiles: [],
    testFiles: [], pluginSuites: [],
    runIntegration: true, runBrowserTests: false, runPluginTests: false,
  }
}

export function createCiImpactPlan({ productRoot = process.cwd(), ...options } = {}) {
  const partitions = loadRootPlan(productRoot)
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
      partitions,
    }) : unknownTargetedPlan({
      base: options.base || null,
      head: options.head || 'HEAD',
      reason: 'head_or_layout_unknown_requires_build_static',
    })
  }
  let base
  if (!options.base) {
    return options.forceFull
      ? fullPlan({ base: null, head, reasons: ['force_full', 'base_missing'], changedCount: 0, partitions })
      : unknownTargetedPlan({ base: null, head, reason: 'base_missing_requires_build_static' })
  }
  try {
    base = resolveCommit(layout.gitRoot, options.base)
  } catch {
    return options.forceFull ? fullPlan({
      base: options.base, head, reasons: ['base_unavailable'], changedCount: 0, partitions,
    }) : unknownTargetedPlan({
      base: options.base, head, reason: 'base_unknown_requires_build_static',
    })
  }
  let basePrefix
  let headPrefix
  try {
    basePrefix = resolveGitCommitProductPrefix(layout.gitRoot, base)
    headPrefix = resolveGitCommitProductPrefix(layout.gitRoot, head)
  } catch {
    return options.forceFull ? fullPlan({
      base, head, reasons: ['commit_layout_unavailable'], changedCount: 0, partitions,
    }) : unknownTargetedPlan({
      base, head, reason: 'commit_layout_unknown_requires_build_static',
    })
  }
  const baseTrees = commitTrees(layout.gitRoot, base, basePrefix)
  const headTrees = commitTrees(layout.gitRoot, head, headPrefix)
  const productPaths = changedLogicalPaths(baseTrees.product, headTrees.product)
  const repositoryPaths = changedLogicalPaths(baseTrees.repository, headTrees.repository)
  const changedCount = productPaths.length + repositoryPaths.length
  if (options.forceFull) {
    return fullPlan({
      base, head, reasons: ['force_full'], changedCount, partitions,
    })
  }
  const layoutChanged = basePrefix !== headPrefix
  if (changedCount === 0 && !layoutChanged) {
    return {
      mode: 'docs', base, head, reasons: ['no_changes'], changedCount: 0,
      rootPartitions: [], relatedFiles: [],
      testFiles: [], pluginSuites: [],
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
      runIntegration: false, runBrowserTests: false, runPluginTests: false,
    }
  }
  const relatedFiles = productPaths.filter(isProductionSource)
  const testFiles = productPaths.filter(isTestFile)
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
    pluginSuites,
    runIntegration: layoutChanged || relatedFiles.length > 0
      || reasons.includes('unknown_requires_build_static'),
    runBrowserTests: needsBrowser(productPaths),
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
