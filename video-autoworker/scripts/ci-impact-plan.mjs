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

function changedPaths(gitRoot, base, head) {
  const raw = git(gitRoot, ['diff', '--name-only', '-z', base, head], { encoding: 'buffer' })
  return raw.toString('utf8').split('\0').filter(Boolean)
}

function productRelativePath(pathname, productPrefix) {
  if (!productPrefix) return pathname
  return pathname.startsWith(productPrefix) ? pathname.slice(productPrefix.length) : null
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

function fullReason(pathname) {
  if (pathname === '.gitignore' || pathname.startsWith('.github/')) return 'git_or_ci_changed'
  if (isRuntimeSkill(pathname) || pathname.startsWith('openclaw-plugins/')) {
    return 'runtime_plugin_or_skill_changed'
  }
  if (pathname.startsWith('scripts/') || pathname.startsWith('ops/')
    || pathname.startsWith('runtime/') || pathname.startsWith('migrations/')) {
    return 'release_or_runtime_safety_changed'
  }
  if (/^(?:package\.json|pnpm-lock\.yaml|next\.config\.[cm]?[jt]s|tsconfig(?:\.[^.]+)?\.json|eslint\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|playwright[^/]*\.config\.[cm]?[jt]s|openapi\.json)$/u.test(pathname)) {
    return 'dependency_or_build_config_changed'
  }
  if (/(?:^|\/)(?:auth(?:entication|orization)?|security|permissions?|credentials?|secrets?|tokens?|sessions?|rbac|acl|crypto|signatures?|webhooks?|database|db|migrations?|state|storage|persistence|queues?|scheduler|leases?|outbox|recovery|runtime|deploy(?:ment)?|releases?|provenance|integrity|fencing|locks?)(?:\/|\.|-|_)/iu.test(pathname)
    || /(?:^|\/)(?:schema\.sql|middleware\.[cm]?[jt]s)$/u.test(pathname)) {
    return 'state_or_security_changed'
  }
  return null
}

function isOrdinaryProductPath(pathname, heavyPartitions) {
  return heavyPartitions.has(pathname)
    || pathname.startsWith('src/')
    || pathname.startsWith('tests/')
    || pathname.startsWith('public/')
    || pathname.startsWith('messages/')
}

function needsIntegration(paths) {
  return paths.some(pathname => (
    pathname.startsWith('public/')
    || pathname.startsWith('messages/')
    || (pathname.startsWith('src/')
      && !/(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.test\.[cm]?[jt]sx?$/u.test(pathname))
  ))
}

function unique(values) {
  return [...new Set(values)]
}

function fullPlan({ base, head, reasons, changedCount, partitions }) {
  return {
    mode: 'full', base, head, reasons: unique(reasons), changedCount,
    rootPartitions: partitions,
    runIntegration: true,
    runPluginTests: true,
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
    return fullPlan({
      base: options.base || null,
      head: options.head || 'HEAD',
      reasons: ['head_or_layout_unavailable'],
      changedCount: 0,
      partitions,
    })
  }
  let base
  if (!options.base) {
    return fullPlan({ base: null, head, reasons: ['base_missing'], changedCount: 0, partitions })
  }
  try {
    base = resolveCommit(layout.gitRoot, options.base)
  } catch {
    return fullPlan({
      base: options.base, head, reasons: ['base_unavailable'], changedCount: 0, partitions,
    })
  }
  let basePrefix
  let headPrefix
  try {
    basePrefix = resolveGitCommitProductPrefix(layout.gitRoot, base)
    headPrefix = resolveGitCommitProductPrefix(layout.gitRoot, head)
  } catch {
    return fullPlan({
      base, head, reasons: ['commit_layout_unavailable'], changedCount: 0, partitions,
    })
  }
  const changed = changedPaths(layout.gitRoot, base, head)
  if (options.forceFull) {
    return fullPlan({
      base, head, reasons: ['force_full'], changedCount: changed.length, partitions,
    })
  }
  if (basePrefix !== headPrefix) {
    return fullPlan({
      base, head, reasons: ['git_source_layout_changed'], changedCount: changed.length, partitions,
    })
  }
  if (changed.length === 0) {
    return {
      mode: 'docs', base, head, reasons: ['no_changes'], changedCount: 0,
      rootPartitions: [], runIntegration: false, runPluginTests: false,
    }
  }

  const heavyPartitions = new Set(partitions.slice(1))
  const productPaths = []
  const reasons = []
  let docsOnly = true
  for (const pathname of changed) {
    const productPath = productRelativePath(pathname, headPrefix)
    const policyPath = productPath === null ? pathname : productPath
    if (isRuntimeSkill(policyPath)) {
      docsOnly = false
      reasons.push('runtime_plugin_or_skill_changed')
      continue
    }
    if (isDocumentation(policyPath)) continue
    if (productPath === null) {
      docsOnly = false
      reasons.push('repository_root_runtime_changed')
      continue
    }
    productPaths.push(productPath)
    docsOnly = false
    const reason = fullReason(productPath)
    if (reason) reasons.push(reason)
    else if (!isOrdinaryProductPath(productPath, heavyPartitions)) reasons.push('unknown_path_changed')
  }
  if (reasons.length > 0) {
    return fullPlan({ base, head, reasons, changedCount: changed.length, partitions })
  }
  if (docsOnly && productPaths.every(isDocumentation)) {
    return {
      mode: 'docs', base, head, reasons: ['documentation_only'], changedCount: changed.length,
      rootPartitions: [], runIntegration: false, runPluginTests: false,
    }
  }

  const directlyChangedHeavy = partitions.slice(1).filter(pathname => productPaths.includes(pathname))
  const hasNonHeavyChange = productPaths.some(pathname => !heavyPartitions.has(pathname))
  return {
    mode: 'targeted', base, head, reasons: ['ordinary_product_change'],
    changedCount: changed.length,
    rootPartitions: hasNonHeavyChange ? ['regular'] : directlyChangedHeavy,
    runIntegration: needsIntegration(productPaths),
    runPluginTests: false,
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
