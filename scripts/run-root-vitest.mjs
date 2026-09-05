#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const repositoryRoot = process.cwd()
const vitestCli = resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs')
const heavyRootTests = [
  'src/lib/__tests__/aiworker-task-flow-installer.test.ts',
  'src/lib/__tests__/aiworker-video-lane-supervisor.test.ts',
  'src/lib/__tests__/aiworker-director-brain-installer.test.ts',
  'src/lib/__tests__/openclaw-runtime-convergence-installer.test.ts',
  'src/test/legacy-media-orphan-reconcile.test.ts',
]

if (new Set(heavyRootTests).size !== heavyRootTests.length) {
  throw new Error('Root Vitest partition contains a duplicate heavy test file')
}
await Promise.all([vitestCli, ...heavyRootTests].map(pathname => access(resolve(repositoryRoot, pathname))))

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

if (process.argv.includes('--print-plan')) {
  process.stdout.write(`${JSON.stringify({ regularInvocation, heavyInvocations }, null, 2)}\n`)
  process.exit(0)
}

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

const partition = await verifyPartition()
if (process.argv.includes('--verify-partition')) {
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

await runVitest(regularInvocation)
for (const invocation of heavyInvocations) {
  await runVitest(invocation)
}
