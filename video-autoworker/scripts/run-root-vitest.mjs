#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const repositoryRoot = process.cwd()
const vitestCli = resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs')
const heavyRootTests = [
  'src/lib/__tests__/aiworker-task-flow-installer.test.ts',
  'src/lib/__tests__/aiworker-video-lane-supervisor.test.ts',
  'src/lib/__tests__/aiworker-director-brain-installer.test.ts',
  'src/lib/__tests__/director-video-release-readiness-script.test.ts',
  'src/lib/__tests__/openclaw-runtime-convergence-installer.test.ts',
  'src/test/legacy-media-orphan-reconcile.test.ts',
]

if (new Set(heavyRootTests).size !== heavyRootTests.length) {
  throw new Error('Root Vitest partition contains a duplicate heavy test file')
}
await Promise.all(heavyRootTests.map(pathname => access(resolve(repositoryRoot, pathname))))

const regularInvocation = [
  'run',
  ...heavyRootTests.flatMap(testFile => ['--exclude', testFile]),
]
const heavyInvocations = heavyRootTests.map(testFile => [
  'run',
  '--maxWorkers=1',
  '--no-file-parallelism',
  testFile,
])

// CI uses separate runners for these same verified partitions. Local execution
// keeps the complete sequential run unless one exact partition is requested.
const partitionFlag = process.argv.indexOf('--partition')
const selectedPartition = partitionFlag < 0 ? null : process.argv[partitionFlag + 1]
if (partitionFlag >= 0 && (
  process.argv.lastIndexOf('--partition') !== partitionFlag
  || !['regular', ...heavyRootTests].includes(selectedPartition)
)) {
  throw new Error('Root Vitest partition must be regular or one declared heavy test file')
}
const impactFlag = process.argv.indexOf('--impact-plan')
const impactPath = impactFlag < 0 ? null : process.argv[impactFlag + 1]
if (impactFlag >= 0 && (selectedPartition !== 'regular' || !impactPath || process.argv.lastIndexOf('--impact-plan') !== impactFlag)) {
  throw new Error('Impact-plan selection requires the regular partition and one plan')
}

if (process.argv.includes('--print-plan')) {
  process.stdout.write(`${JSON.stringify({
    partitions: ['regular', ...heavyRootTests], regularInvocation, heavyInvocations,
  }, null, 2)}\n`)
  process.exit(0)
}

await access(vitestCli)

async function collectTestFiles(args) {
  return new Promise((resolveCollection, rejectCollection) => {
    const stdout = []
    const stderr = []
    const child = spawn(process.execPath, [vitestCli, ...args], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => stdout.push(String(chunk)))
    child.stderr.on('data', chunk => stderr.push(String(chunk)))
    child.once('error', rejectCollection)
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        rejectCollection(new Error(
          signal
            ? `Vitest collection terminated by ${signal}`
            : `Vitest collection exited with code ${code}: ${stderr.join('')}`,
        ))
        return
      }
      resolveCollection(stdout.join('').split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(pathname => resolve(repositoryRoot, pathname)))
    })
  })
}

async function verifyPartition() {
  const allFiles = await collectTestFiles(['list', '--filesOnly'])
  const regularFiles = await collectTestFiles([
    'list',
    '--filesOnly',
    ...heavyRootTests.flatMap(testFile => ['--exclude', testFile]),
  ])
  const heavyFiles = []
  for (const testFile of heavyRootTests) {
    const collected = await collectTestFiles(['list', '--filesOnly', testFile])
    const expected = resolve(repositoryRoot, testFile)
    if (collected.length !== 1 || collected[0] !== expected) {
      throw new Error(`Heavy Vitest partition did not resolve exactly once: ${testFile}`)
    }
    heavyFiles.push(...collected)
  }

  const allSet = new Set(allFiles)
  const partitionMembership = new Map()
  for (const pathname of [...regularFiles, ...heavyFiles]) {
    partitionMembership.set(pathname, (partitionMembership.get(pathname) ?? 0) + 1)
  }
  const missing = allFiles.filter(pathname => !partitionMembership.has(pathname))
  const duplicate = [...partitionMembership]
    .filter(([, count]) => count !== 1)
    .map(([pathname]) => pathname)
  const unexpected = [...partitionMembership.keys()].filter(pathname => !allSet.has(pathname))
  if (missing.length > 0 || duplicate.length > 0 || unexpected.length > 0) {
    throw new Error(`Invalid root Vitest partition: ${JSON.stringify({ missing, duplicate, unexpected })}`)
  }
  return {
    all: allFiles.length,
    regular: regularFiles.length,
    heavy: heavyFiles.length,
  }
}

if (process.argv.includes('--verify-partition')) {
  const partition = await verifyPartition()
  process.stdout.write(`${JSON.stringify(partition)}\n`)
  process.exit(0)
}

async function runVitest(args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [vitestCli, ...args], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }
      rejectRun(new Error(
        signal
          ? `Vitest partition terminated by ${signal}`
          : `Vitest partition exited with code ${code}`,
      ))
    })
  })
}

if (selectedPartition === 'regular') {
  if (impactPath) {
    const plan = JSON.parse(readFileSync(impactPath, 'utf8'))
    if (plan.mode !== 'targeted' || !Array.isArray(plan.relatedFiles) || !Array.isArray(plan.testFiles)) {
      throw new Error('Invalid targeted impact plan')
    }
    const resolveMember = member => {
      if (typeof member !== 'string' || isAbsolute(member) || member.includes('\\')) {
        throw new Error('Invalid related source path')
      }
      const absolute = resolve(repositoryRoot, member)
      if (relative(repositoryRoot, absolute).startsWith('..')) throw new Error('Related source is outside product')
      return absolute
    }
    const related = plan.relatedFiles.map(resolveMember)
    const direct = plan.testFiles.map(resolveMember)
    if (!related.length && !direct.length) {
      process.stdout.write('No changed production module needs an import-graph test run; retain scoped static/build and functional acceptance.\n')
      process.exit(0)
    }
    const { createVitest } = await import('vitest/node')
    const selected = new Set()
    if (related.length) {
      const context = await createVitest('test', { root: repositoryRoot, related, watch: false })
      try { for (const spec of await context.listFiles([])) selected.add(spec[1]) }
      finally { await context.close() }
    }
    if (direct.length) {
      const context = await createVitest('test', { root: repositoryRoot, watch: false })
      try { for (const spec of await context.listFiles(direct)) selected.add(spec[1]) }
      finally { await context.close() }
    }
    const files = [...selected]
    process.stdout.write(`${JSON.stringify({ selection: 'changed_production_dependencies', sourceFiles: related.length, testFiles: files.length })}\n`)
    if (files.length) await runVitest(['run', '--maxWorkers=1', '--no-file-parallelism', ...files])
    else process.stdout.write('No associated automated test was found; functional acceptance remains required.\n')
    process.exit(0)
  }
  await runVitest(regularInvocation)
} else if (selectedPartition) {
  await runVitest(heavyInvocations[heavyRootTests.indexOf(selectedPartition)])
} else {
  await runVitest(regularInvocation)
  for (const invocation of heavyInvocations) {
    await runVitest(invocation)
  }
}
