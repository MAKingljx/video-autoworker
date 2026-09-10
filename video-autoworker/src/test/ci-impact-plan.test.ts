// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(process.cwd(), 'scripts/ci-impact-plan.mjs')
const roots: string[] = []
const customHeavy = 'src/test/custom-heavy.test.ts'
const partitions = ['regular', customHeavy]

function write(pathname: string, value: string) {
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 })
  writeFileSync(pathname, value)
}

function git(root: string, ...args: string[]) {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function commit(root: string, message: string) {
  git(root, 'add', '.')
  git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

function fixture(prefixed = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-impact-plan-')))
  roots.push(root)
  const gitRoot = join(root, 'repository')
  const productRoot = prefixed ? join(gitRoot, 'video-autoworker') : gitRoot
  mkdirSync(productRoot, { recursive: true, mode: 0o700 })
  write(join(productRoot, 'package.json'), '{"name":"video-autoworker"}\n')
  write(join(productRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  write(join(productRoot, 'next.config.js'), 'export default {}\n')
  write(join(productRoot, 'scripts/run-root-vitest.mjs'),
    `process.stdout.write(${JSON.stringify(`${JSON.stringify({ partitions })}\n`)})\n`)
  write(join(productRoot, customHeavy), 'export {}\n')
  git(gitRoot, 'init', '-b', 'main')
  git(gitRoot, 'config', 'user.name', 'CI Impact Test')
  git(gitRoot, 'config', 'user.email', 'ci-impact@example.invalid')
  git(gitRoot, 'config', 'commit.gpgSign', 'false')
  const base = commit(gitRoot, 'base')
  return { root, gitRoot, productRoot, base }
}

function run(productRoot: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: productRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return {
    ...result,
    json: result.status === 0 ? JSON.parse(result.stdout) : null,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CI impact plan', () => {
  it('selects docs mode only for ordinary root and product documentation', () => {
    const entry = fixture(true)
    write(join(entry.gitRoot, 'README.md'), 'root docs\n')
    write(join(entry.productRoot, 'docs/architecture.md'), 'product docs\n')
    const head = commit(entry.gitRoot, 'docs')

    expect(run(entry.productRoot, ['--base', entry.base, '--head', head]).json)
      .toMatchObject({
        mode: 'docs', base: entry.base, head, reasons: ['documentation_only'],
        changedCount: 2, rootPartitions: [], runIntegration: false, runPluginTests: false,
      })
  })

  it('selects targeted mode for ordinary UI source and requests integration', () => {
    const entry = fixture(true)
    write(join(entry.productRoot, 'src/app/page.tsx'), 'export default function Page(){return null}\n')
    const head = commit(entry.gitRoot, 'ui')

    expect(run(entry.productRoot, ['--base', entry.base]).json)
      .toMatchObject({
        mode: 'targeted', head, rootPartitions: ['regular'],
        runIntegration: true, runPluginTests: false,
      })
  })

  it('keeps an ordinary app and component change targeted through the import graph', () => {
    const entry = fixture(true)
    write(join(entry.productRoot, 'src/app/page.tsx'), 'export { Card } from "../components/card"\n')
    write(join(entry.productRoot, 'src/components/card.tsx'), 'export const Card = () => null\n')
    write(join(entry.productRoot, customHeavy), 'export const changed = true\n')
    const head = commit(entry.gitRoot, 'cross-directory UI')

    expect(run(entry.productRoot, ['--base', entry.base, '--head', head]).json)
      .toMatchObject({
        mode: 'targeted', rootPartitions: ['regular'],
        runIntegration: true, runPluginTests: false,
      })
  })

  it('ignores caller Git discovery overrides', () => {
    const entry = fixture()
    write(join(entry.productRoot, 'src/components/card.tsx'), 'export const Card = () => null\n')
    const head = commit(entry.gitRoot, 'component')

    expect(run(entry.productRoot, ['--base', entry.base, '--head', head], {
      GIT_DIR: join(entry.root, 'attacker.git'),
      GIT_WORK_TREE: join(entry.root, 'attacker-worktree'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: join(entry.root, 'attacker-hooks'),
    }).json).toMatchObject({ mode: 'targeted', head })
  })

  it('uses the root runner plan for a directly changed heavy test', () => {
    const entry = fixture()
    write(join(entry.productRoot, customHeavy), 'export const changed = true\n')
    const head = commit(entry.gitRoot, 'heavy test')

    expect(run(entry.productRoot, ['--base', entry.base, '--head', head]).json)
      .toMatchObject({
        mode: 'targeted', rootPartitions: [customHeavy],
        runIntegration: false, runPluginTests: false,
      })
    const source = readFileSync(script, 'utf8')
    expect(source).toContain("'--print-plan'")
    expect(source).not.toContain('aiworker-task-flow-installer.test.ts')
  })

  it.each([
    ['root CI', '.github/workflows/ci.yml', 'name: CI\n'],
    ['runtime skill', 'openclaw-skills/example/SKILL.md', '# Runtime skill\n'],
    ['skill inside docs', 'docs/examples/SKILL.md', '# Runtime skill\n'],
    ['executable inside docs', 'docs/examples/check.ts', 'export {}\n'],
    ['build config', 'package.json', '{"name":"video-autoworker","version":"2.0.0"}\n'],
    ['unknown product path', 'config/unknown.txt', 'unknown\n'],
    ['security source', 'src/lib/auth/session.ts', 'export {}\n'],
    ['authorization source', 'src/app/api/authorization/route.ts', 'export {}\n'],
    ['state outbox source', 'src/lib/outbox/director-evidence.ts', 'export {}\n'],
  ])('selects full mode for %s changes', (_label, relativePath, contents) => {
    const entry = fixture(true)
    const target = relativePath.startsWith('.github/')
      ? join(entry.gitRoot, relativePath)
      : join(entry.productRoot, relativePath)
    write(target, contents)
    const head = commit(entry.gitRoot, 'safety change')

    expect(run(entry.productRoot, ['--base', entry.base, '--head', head]).json)
      .toMatchObject({
        mode: 'full', rootPartitions: partitions,
        runIntegration: true, runPluginTests: true,
      })
  })

  it('forces full when the base is missing or the caller requests it', () => {
    const entry = fixture()
    write(join(entry.productRoot, 'docs/change.md'), 'docs\n')
    const head = commit(entry.gitRoot, 'docs')

    expect(run(entry.productRoot, ['--head', head]).json).toMatchObject({
      mode: 'full', reasons: ['base_missing'], rootPartitions: partitions,
    })
    expect(run(entry.productRoot, [
      '--base', entry.base, '--head', head, '--force-full',
    ]).json).toMatchObject({
      mode: 'full', reasons: ['force_full'], rootPartitions: partitions,
    })
  })

  it('selects full when history changes from the flat product tree to the prefix', () => {
    const entry = fixture()
    mkdirSync(join(entry.gitRoot, 'video-autoworker'), { mode: 0o700 })
    for (const member of ['package.json', 'pnpm-lock.yaml', 'next.config.js', 'scripts', 'src']) {
      git(entry.gitRoot, 'mv', member, `video-autoworker/${member}`)
    }
    const head = commit(entry.gitRoot, 'prefix product tree')
    const productRoot = join(entry.gitRoot, 'video-autoworker')

    expect(run(productRoot, ['--base', entry.base, '--head', head]).json).toMatchObject({
      mode: 'full', reasons: ['git_source_layout_changed'], rootPartitions: partitions,
    })
  })
})
