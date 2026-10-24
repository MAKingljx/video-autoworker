import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { assertCiTrackedSourceBoundary, createCiImpactPlan, IMAGE_COMPONENT_PYTHON_TESTS,
  selectImagePythonTests } from './ci-impact-plan.mjs'
import { gitSourceEnvironment } from './lib/git-source-layout.mjs'

const SCRIPT = fileURLToPath(new URL('./ci-impact-plan.mjs', import.meta.url))
const env = gitSourceEnvironment()
delete env.GIT_OBJECT_DIRECTORY
delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES

function fixture(layout = 'nested') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworker-image-ci-')))
  const product = layout === 'nested' ? join(root, 'video-autoworker') : root
  const prefix = layout === 'nested' ? 'video-autoworker/' : ''
  const git = args => execFileSync('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  function write(member, content = 'fixture\n', repository = false) {
    const file = join(repository ? root : product, member)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  mkdirSync(product, { recursive: true })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'CI fixture'])
  git(['config', 'user.email', 'ci-fixture@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  write('package.json', JSON.stringify({ name: 'video-autoworker', packageManager: 'pnpm@10.0.0' }))
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write('next.config.js', 'export default {}\n')
  write('.nvmrc', '22\n')
  // The selector's root-plan input is a standard-library fixture. No Vitest,
  // Next dependencies or production data are installed in this real Git repo.
  write('scripts/run-root-vitest.mjs', 'console.log(JSON.stringify({partitions:["regular","heavy.test.ts"]}))\n')
  write('tests/smoke.spec.ts', 'export const smoke = true\n')
  write('src/lib/ordinary.ts', 'export const value = 1\n')
  for (const member of IMAGE_COMPONENT_PYTHON_TESTS) write(member, '# fixture suite member\n')
  write('openclaw-plugins/aiworker-image-command/test/image.test.mjs', 'export {}\n')
  function commit(label) {
    git(['add', '--all'])
    git(['commit', '-q', '-m', label])
    return git(['rev-parse', 'HEAD'])
  }
  const base = commit('base fixture')
  return { root, product, prefix, base, git, write, commit,
    plan(options = {}) { return createCiImpactPlan({ productRoot: product, base, head: 'HEAD', ...options }) },
    close() { rmSync(root, { recursive: true, force: true }) },
  }
}

for (const layout of ['flat', 'nested']) {
  test(`${layout}: image source changes select one independent component with nonempty suites`, () => {
    const f = fixture(layout)
    try {
      f.write('src/image_generation/protected_cover.py', '# changed protected renderer\n')
      f.write('docs/operations/2026/2026-10-24.md', '本次图片组件记录\n')
      f.commit('image renderer')
      const plan = f.plan()
      assert.equal(plan.mode, 'image-component')
      assert.equal(plan.runImageTests, true)
      assert.equal(plan.runIntegration, false)
      assert.equal(plan.runBrowserTests, false)
      assert.deepEqual(plan.rootPartitions, [])
      assert.deepEqual(plan.relatedFiles, [])
      assert.deepEqual(plan.pluginSuites, ['image-command'])
      assert.deepEqual(selectImagePythonTests(plan), [...IMAGE_COMPONENT_PYTHON_TESTS])
    } finally { f.close() }
  })

  test(`${layout}: documentation-only and no-change behavior stays lightweight`, () => {
    const f = fixture(layout)
    try {
      assert.equal(f.plan().mode, 'docs')
      f.write('docs/qwen-cover-design-runbook.md', '仅文档变化\n')
      f.commit('documentation')
      const plan = f.plan()
      assert.equal(plan.mode, 'docs')
      assert.equal(plan.runImageTests, false)
      assert.equal(plan.runIntegration, false)
      assert.deepEqual(plan.imagePythonTests, [])
    } finally { f.close() }
  })

  test(`${layout}: image and Next code retains ordinary targeted verification`, () => {
    const f = fixture(layout)
    try {
      f.write('src/image_generation/service.py', '# image source\n')
      f.write('src/lib/ordinary.ts', 'export const value = 2\n')
      f.commit('mixed implementation')
      const plan = f.plan()
      assert.equal(plan.mode, 'targeted')
      assert.equal(plan.runIntegration, true)
      assert.equal(plan.runImageTests, true)
      assert.ok(plan.relatedFiles.includes('src/lib/ordinary.ts'))
      assert.ok(!plan.relatedFiles.includes('src/image_generation/service.py'))
      assert.ok(plan.pluginSuites.includes('image-command'))
      assert.ok(selectImagePythonTests(plan).length > 0)
    } finally { f.close() }
  })

  test(`${layout}: unknown files and missing base cannot lower the existing fallback`, () => {
    const f = fixture(layout)
    try {
      f.write('unknown-runtime-contract.bin', 'unknown\n')
      f.commit('unknown implementation')
      const plan = f.plan()
      assert.equal(plan.mode, 'targeted')
      assert.equal(plan.runIntegration, true)
      assert.equal(plan.runImageTests, true)
      assert.ok(plan.reasons.includes('unknown_requires_build_static'))
      const missingBase = f.plan({ base: undefined })
      assert.equal(missingBase.mode, 'targeted')
      assert.equal(missingBase.runIntegration, true)
      assert.equal(missingBase.runImageTests, true)
    } finally { f.close() }
  })

  test(`${layout}: shared CI files never classify themselves as image-only`, () => {
    const f = fixture(layout)
    try {
      f.write('scripts/ci-impact-plan.mjs', '// shared CI selector changed\n')
      f.write('.github/workflows/quality-gate.yml', 'name: fixture\n', true)
      f.commit('CI controls')
      const plan = f.plan()
      assert.equal(plan.mode, 'targeted')
      assert.equal(plan.runIntegration, true)
      assert.equal(plan.runImageTests, true)
    } finally { f.close() }
  })

  test(`${layout}: force-full includes image Python and Node suites`, () => {
    const f = fixture(layout)
    try {
      const plan = f.plan({ forceFull: true })
      assert.equal(plan.mode, 'full')
      assert.equal(plan.runIntegration, true)
      assert.equal(plan.runBrowserTests, true)
      assert.equal(plan.runImageTests, true)
      assert.ok(plan.pluginSuites.includes('image-command'))
      assert.ok(selectImagePythonTests(plan).length > 0)
    } finally { f.close() }
  })
}

test('each owned image entry and runtime instruction selects image component without Next', () => {
  for (const member of ['openclaw-plugins/aiworker-image-command/lib/image-command-tool.js',
    'scripts/install-aiworker-image-service.py', 'scripts/install-openclaw-image-studio.py',
    'scripts/aiworker-image-service.py', 'scripts/aiworker-qwen-cover.py',
    'scripts/aiworker-image-ocr.swift', 'scripts/extract-cover-reference.py',
    'ops/openclaw-image-studio/AGENTS.md', 'ops/image-generation/service/service.template.json',
    'tests/test_protected_cover.py']) {
    const f = fixture()
    try { f.write(member, 'changed fixture\n');f.commit('owned image input');assert.equal(f.plan().mode, 'image-component', member) }
    finally { f.close() }
  }
})

test('CLI emits the image plan using its real Git commit layout', () => {
  const f = fixture()
  try {
    f.write('src/image_generation/service.py', '# changed\n');f.commit('image source')
    const plan = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--base', f.base], {
      cwd: f.product, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }))
    assert.equal(plan.mode, 'image-component')
    assert.equal(plan.runImageTests, true)
  } finally { f.close() }
})

test('unclassified Python tests keep static/build fallback and add image checks', () => {
  const f = fixture()
  try {
    f.write('tests/test_new_unknown_component.py', '# not an approved image-only member\n')
    f.commit('unknown Python test')
    const plan = f.plan()
    assert.equal(plan.mode, 'targeted')
    assert.equal(plan.runIntegration, true)
    assert.equal(plan.runImageTests, true)
    assert.ok(plan.reasons.includes('unknown_requires_build_static'))
  } finally { f.close() }
})

test('unowned image configuration does not silently become isolated component scope', () => {
  const f = fixture()
  try {
    f.write('ops/image-generation/new-model/runtime.json', '{}\n')
    f.commit('unknown image runtime')
    const plan = f.plan()
    assert.equal(plan.mode, 'targeted')
    assert.equal(plan.runIntegration, true)
    assert.equal(plan.runImageTests, true)
  } finally { f.close() }
})

test('a generic runtime skill includes every supported plugin including image', () => {
  const f = fixture()
  try {
    f.write('openclaw-skills/new-runtime/SKILL.md', '# Runtime instructions\n')
    f.commit('runtime skill')
    const plan = f.plan()
    assert.deepEqual(plan.pluginSuites, ['video-command', 'director-brain', 'task-flow', 'image-command'])
    assert.equal(plan.runImageTests, true)
  } finally { f.close() }
})

test('empty, incomplete, duplicate and arbitrary image test selections fail closed', () => {
  for (const imagePythonTests of [[], IMAGE_COMPONENT_PYTHON_TESTS.slice(1),
    [...IMAGE_COMPONENT_PYTHON_TESTS, IMAGE_COMPONENT_PYTHON_TESTS[0]], ['../../private.py']]) {
    assert.throws(() => selectImagePythonTests({ runImageTests: true, imagePythonTests }), /ci_image_selection/u)
  }
  assert.throws(() => selectImagePythonTests({ runImageTests: false, imagePythonTests: [...IMAGE_COMPONENT_PYTHON_TESTS] }))
})

test('shared tracked-member boundary rejects private routing, state and model material', () => {
  assert.doesNotThrow(() => assertCiTrackedSourceBoundary(['video-autoworker/src/image_generation/service.py', 'README.md']))
  for (const member of ['video-autoworker/.PhoenixBrain/project.json', 'output/frame.png',
    'MEMORY.md', 'runtime/jobs.sqlite', 'model/weights.safetensors', '/absolute/path']) {
    assert.throws(() => assertCiTrackedSourceBoundary([member]), undefined, member)
  }
})
