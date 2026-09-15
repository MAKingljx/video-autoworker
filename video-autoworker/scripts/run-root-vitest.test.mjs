import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import { parseRootVitestArguments, resolveExplicitRootTests } from './lib/root-vitest-selection.mjs'

const product = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = join(product, 'scripts/run-root-vitest.mjs')
const planRead = spawnSync(process.execPath, [runner, '--print-plan'], { cwd: product, encoding: 'utf8' })
assert.equal(planRead.status, 0, planRead.stderr)
const heavy = JSON.parse(planRead.stdout).partitions.slice(1)
const regular = ['src/lib/__tests__/one.test.ts', 'src/lib/__tests__/two.test.ts']
let temp
let root

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'root-vitest-selection-'))
  root = join(temp, 'product')
  for (const name of [...heavy, ...regular]) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), '// fixture\n')
  }
  await mkdir(join(root, 'node_modules/vitest'), { recursive: true })
  // Run the real runner against a collector/process fixture, never real suites.
  await writeFile(join(root, 'node_modules/vitest/vitest.mjs'), `
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n')
const all = ${JSON.stringify([...heavy, ...regular])}
if (args[0] === 'list') {
  const excludes = args.flatMap((arg, i) => arg === '--exclude' ? [args[i + 1]] : [])
  const selected = args.filter((arg, i) => arg.endsWith('.test.ts') && args[i - 1] !== '--exclude')
  let files = (selected.length ? selected : all).filter(file => !excludes.includes(file))
  if (process.env.FIXTURE_COLLECTION === 'empty') files = []
  if (process.env.FIXTURE_COLLECTION === 'extra') files.push('src/lib/__tests__/unrequested.test.ts')
  process.stdout.write(files.join('\\n') + '\\n')
} else if (process.env.FIXTURE_RUN_FAIL === '1') process.exitCode = 1
`)
})
afterEach(async () => { await rm(temp, { recursive: true, force: true }) })

function run(args, environment = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...environment },
  })
}
async function calls() {
  return readFile(join(root, 'calls.jsonl'), 'utf8').then(text => text.trim().split('\n').map(JSON.parse)).catch(() => [])
}

test('direct files select exactly those files, deduplicate, and isolate heavy tests', async () => {
  const result = run([regular[0], `./${regular[0]}`, heavy[0]])
  assert.equal(result.status, 0, result.stderr)
  const invocations = (await calls()).filter(args => args[0] === 'run')
  assert.equal(invocations.length, 2)
  assert.deepEqual(invocations.flatMap(args => args.filter(arg => arg.endsWith('.test.ts'))).sort(), [regular[0], heavy[0]].sort())
  const isolated = invocations.find(args => args.includes(heavy[0]))
  assert.ok(isolated.includes('--no-file-parallelism'))
  assert.ok(isolated.includes('--testTimeout=30000'))
  assert.ok(!JSON.stringify(invocations).includes(regular[1]))
})

test('separator and an absolute path inside the root retain explicit selection', async () => {
  const result = run(['--', join(root, regular[0])])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual((await calls()).filter(args => args[0] === 'run')[0].filter(arg => arg.endsWith('.test.ts')), [regular[0]])
})

test('unknown, missing, duplicate, conflicting or empty CLI arguments never run a suite', async () => {
  for (const args of [
    ['--wat'], ['--partition'], ['--partition', 'unknown'],
    ['--print-plan', '--print-plan'], ['--'], [''],
    [regular[0], '--partition', 'regular'],
    [regular[0], '--verify-partition'],
    ['--verify-partition', '--print-plan'],
    ['--impact-plan', 'plan.json'],
  ]) {
    const result = run(args)
    assert.notEqual(result.status, 0, args.join(' '))
  }
  assert.deepEqual(await calls(), [])
})

test('missing files, directories, non-tests, lexical and symlink escape are rejected', async () => {
  await writeFile(join(temp, 'outside.test.ts'), '// outside')
  await writeFile(join(root, 'src/lib/source.ts'), '// source')
  await symlink(join(temp, 'outside.test.ts'), join(root, 'src/lib/escape.test.ts'))
  await mkdir(join(root, 'src/lib/directory.test.ts'))
  for (const file of ['src/lib/missing.test.ts', 'src/lib/directory.test.ts', 'src/lib/source.ts', '../outside.test.ts', join(temp, 'outside.test.ts'), 'src/lib/escape.test.ts']) {
    const result = run([file])
    assert.notEqual(result.status, 0, file)
  }
  assert.deepEqual(await calls(), [])
  await assert.rejects(resolveExplicitRootTests([], root), /selection is empty/)
})

test('empty or widened Vitest collection fails before test execution', async () => {
  for (const mode of ['empty', 'extra']) {
    const result = run([regular[0]], { FIXTURE_COLLECTION: mode })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /did not match the requested files exactly/)
  }
  assert.equal((await calls()).filter(args => args[0] === 'run').length, 0)
})

test('explicit plan reports scoped invocations without running tests', async () => {
  const result = run(['--print-plan', regular[0], heavy[0]])
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.selection, 'explicit_files')
  assert.equal(plan.invocations.length, 2)
  assert.deepEqual(await calls(), [])
})

test('existing regular, heavy, full and partition verification modes retain their behavior', async () => {
  for (const [args, expectedRuns] of [
    [['--partition', 'regular'], 1], [['--partition', heavy[0]], 1], [[], heavy.length + 1],
  ]) {
    const before = (await calls()).filter(args => args[0] === 'run').length
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal((await calls()).filter(args => args[0] === 'run').length - before, expectedRuns)
  }
  const verified = run(['--verify-partition'])
  assert.equal(verified.status, 0, verified.stderr)
  assert.deepEqual(JSON.parse(verified.stdout), { all: heavy.length + regular.length, regular: regular.length, heavy: heavy.length })
  assert.equal(parseRootVitestArguments(['--partition', 'regular', '--impact-plan', 'plan.json'], heavy).impactPath, 'plan.json')
})

test('explicit test failures cannot be reported as success', () => {
  const result = run([regular[0]], { FIXTURE_RUN_FAIL: '1' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Targeted test partition failed/)
})
