import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/** Explicit selection must never fall back to the no-argument full suite. */
export function parseRootVitestArguments(args, heavyTests) {
  const result = { partition: null, impactPath: null, printPlan: false, verifyPartition: false, files: [] }
  const seen = new Set()
  let filesOnly = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--' && !filesOnly) { filesOnly = true; continue }
    if (!filesOnly && arg.startsWith('--')) {
      if (!['--partition', '--impact-plan', '--print-plan', '--verify-partition'].includes(arg)) {
        throw new Error(`Unknown root Vitest argument: ${arg}`)
      }
      if (seen.has(arg)) throw new Error(`Duplicate root Vitest argument: ${arg}`)
      seen.add(arg)
      if (arg === '--print-plan') result.printPlan = true
      else if (arg === '--verify-partition') result.verifyPartition = true
      else {
        const value = args[++index]
        if (!value || value.startsWith('-')) throw new Error(`Missing root Vitest argument value: ${arg}`)
        if (arg === '--partition') result.partition = value
        else result.impactPath = value
      }
    } else {
      if (!arg || arg.startsWith('-')) throw new Error(`Invalid root Vitest test path: ${arg}`)
      result.files.push(arg)
    }
  }
  if (result.partition && !['regular', ...heavyTests].includes(result.partition)) {
    throw new Error('Root Vitest partition must be regular or one declared heavy test file')
  }
  if (result.impactPath && result.partition !== 'regular') {
    throw new Error('Impact-plan selection requires the regular partition and one plan')
  }
  if (result.files.length && (result.partition || result.impactPath || result.verifyPartition)) {
    throw new Error('Explicit test files cannot be combined with partition, impact-plan, or verify-partition')
  }
  if (result.verifyPartition && (result.partition || result.impactPath || result.printPlan)) {
    throw new Error('Verify-partition cannot be combined with another selection or print-plan')
  }
  if (filesOnly && !result.files.length) throw new Error('Explicit root Vitest test selection is empty')
  return result
}

export async function resolveExplicitRootTests(files, repositoryRoot) {
  const lexicalRoot = resolve(repositoryRoot)
  const root = await realpath(lexicalRoot)
  const selected = new Set()
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0')) {
      throw new Error('Invalid explicit root Vitest test path')
    }
    const lexical = resolve(lexicalRoot, file)
    const lexicalName = relative(lexicalRoot, lexical)
    if (!isAbsolute(file) && (!lexicalName || lexicalName === '..' || lexicalName.startsWith('../') || isAbsolute(lexicalName))) {
      throw new Error('Explicit root Vitest test is outside product')
    }
    const actual = await realpath(lexical)
    const name = relative(root, actual)
    if (!name || name === '..' || name.startsWith('../') || isAbsolute(name)) {
      throw new Error('Explicit root Vitest test resolves outside product')
    }
    if (!/^src\/.+\.test\.tsx?$/.test(name) || !(await stat(actual)).isFile()) {
      throw new Error(`Explicit root Vitest path is not a root test file: ${file}`)
    }
    selected.add(name)
  }
  if (!selected.size) throw new Error('Explicit root Vitest test selection is empty')
  return [...selected].sort()
}

export function assertExactRootTestCollection(expected, collected, repositoryRoot) {
  const expectedSet = new Set(expected.map(file => resolve(repositoryRoot, file)))
  const collectedSet = new Set(collected.map(file => resolve(repositoryRoot, file)))
  if (!expectedSet.size || collectedSet.size !== expectedSet.size
    || [...expectedSet].some(file => !collectedSet.has(file))) {
    throw new Error('Explicit root Vitest collection did not match the requested files exactly')
  }
}
