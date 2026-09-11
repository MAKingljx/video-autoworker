// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  NESTED_PRODUCT_PREFIX,
  assertCleanGitSource,
  getGitProductFileEntry,
  gitProductTreePath,
  normalizeProductRelativePath,
  productTreePath,
  readGitProductFile,
  resolveGitCommitProductPrefix,
  resolveGitSourceLayout,
  sha256GitProductFile,
  verifyGitProductFiles,
} from '../../scripts/lib/git-source-layout.mjs'

const roots: string[] = []
const helper = resolve('scripts/lib/git-source-layout.mjs')
const bootstrap = resolve('scripts/lib/git-source-layout.sh')

function git(root: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function write(root: string, pathname: string, contents: string): void {
  const target = join(root, pathname)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function flatRepository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-source-layout-')))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Git Source Layout Test')
  git(root, 'config', 'user.email', 'layout@example.invalid')
  git(root, 'config', 'commit.gpgSign', 'false')
  write(root, 'package.json', '{"name":"video-autoworker","version":"1.0.0"}\n')
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write(root, 'next.config.js', 'export default {}\n')
  write(root, 'src/value.ts', 'export const value = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'flat product')
  return { root, flatCommit: git(root, 'rev-parse', 'HEAD') }
}

function migrateNested(root: string): string {
  const productRoot = join(root, 'video-autoworker')
  mkdirSync(productRoot)
  for (const name of ['package.json', 'pnpm-lock.yaml', 'next.config.js', 'src']) {
    renameSync(join(root, name), join(productRoot, name))
  }
  write(productRoot, 'scripts/lib/git-source-layout.mjs', readFileSync(helper, 'utf8'))
  write(productRoot, 'scripts/lib/git-source-layout.sh', readFileSync(bootstrap, 'utf8'))
  write(root, 'AGENTS.md', '# Public workspace rules\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'nest product under workspace root')
  return productRoot
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shared Git product source layout', () => {
  it('resolves and reads the current flat product with one strict identity', () => {
    const { root, flatCommit } = flatRepository()
    expect(resolveGitSourceLayout(root)).toEqual({
      gitRoot: root, productRoot: root, productPrefix: '',
    })
    expect(resolveGitCommitProductPrefix(root, flatCommit)).toBe('')
    expect(gitProductTreePath(root, flatCommit, 'src/value.ts')).toBe('src/value.ts')
    expect(getGitProductFileEntry(root, flatCommit, 'src/value.ts')).toMatchObject({
      productRelative: 'src/value.ts', treePath: 'src/value.ts', mode: '100644',
    })
    expect(readGitProductFile(root, flatCommit, 'src/value.ts').toString())
      .toBe('export const value = 1\n')
    expect(sha256GitProductFile(root, flatCommit, 'src/value.ts')).toBe(
      createHash('sha256').update(readFileSync(join(root, 'src/value.ts'))).digest('hex'),
    )
    expect(assertCleanGitSource(root, flatCommit)).toMatchObject({ headCommit: flatCommit })
  })

  it('keeps old flat commits readable from a clean nested product checkout', () => {
    const { root, flatCommit } = flatRepository()
    const productRoot = migrateNested(root)
    const nestedCommit = git(root, 'rev-parse', 'HEAD')
    expect(resolveGitSourceLayout(productRoot)).toEqual({
      gitRoot: root, productRoot, productPrefix: NESTED_PRODUCT_PREFIX,
    })
    expect(resolveGitCommitProductPrefix(root, flatCommit)).toBe('')
    expect(resolveGitCommitProductPrefix(root, nestedCommit)).toBe(NESTED_PRODUCT_PREFIX)
    expect(gitProductTreePath(root, flatCommit, 'src/value.ts')).toBe('src/value.ts')
    expect(gitProductTreePath(root, nestedCommit, 'src/value.ts'))
      .toBe('video-autoworker/src/value.ts')
    expect(readGitProductFile(root, flatCommit, 'src/value.ts').toString())
      .toBe(readGitProductFile(root, nestedCommit, 'src/value.ts').toString())
    expect(getGitProductFileEntry(
      root, nestedCommit, 'scripts/lib/git-source-layout.mjs',
    )).toMatchObject({
      treePath: 'video-autoworker/scripts/lib/git-source-layout.mjs',
      mode: '100644',
    })
    expect(() => getGitProductFileEntry(
      root, flatCommit, 'scripts/lib/git-source-layout.mjs',
    )).toThrow('git_source_layout_product_file_invalid')
    expect(() => execFileSync('/bin/bash', [
      '-c', 'source "$1" && assert_git_source_layout_helper_bootstrap "$2" "$3"',
      'git-source-layout-test', join(productRoot, 'scripts/lib/git-source-layout.sh'),
      productRoot, process.execPath,
    ], { stdio: 'pipe' })).not.toThrow()
    write(productRoot, 'scripts/lib/git-source-layout.mjs', `${readFileSync(helper, 'utf8')}\n`)
    expect(() => execFileSync('/bin/bash', [
      '-c', 'source "$1" && assert_git_source_layout_helper_bootstrap "$2" "$3"',
      'git-source-layout-test', join(productRoot, 'scripts/lib/git-source-layout.sh'),
      productRoot, process.execPath,
    ], { stdio: 'pipe' })).toThrow()

    write(root, 'root-untracked.txt', 'dirty\n')
    expect(() => assertCleanGitSource(productRoot)).toThrow('git_source_layout_worktree_not_clean')
  })

  it('bootstraps the committed helper in a flat product checkout', () => {
    const { root } = flatRepository()
    write(root, 'scripts/lib/git-source-layout.mjs', readFileSync(helper, 'utf8'))
    write(root, 'scripts/lib/git-source-layout.sh', readFileSync(bootstrap, 'utf8'))
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'add layout helper')

    expect(() => execFileSync('/bin/bash', [
      '-c', 'source "$1" && assert_git_source_layout_helper_bootstrap "$2" "$3"',
      'git-source-layout-test', join(root, 'scripts/lib/git-source-layout.sh'),
      root, process.execPath,
    ], { stdio: 'pipe' })).not.toThrow()
  })

  it('ignores caller Git discovery and configuration overrides', () => {
    const { root, flatCommit } = flatRepository()
    const previous = Object.fromEntries([
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    ].map(key => [key, process.env[key]]))
    try {
      process.env.GIT_DIR = join(root, 'attacker.git')
      process.env.GIT_WORK_TREE = join(root, 'attacker-worktree')
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = join(root, 'attacker-hooks')
      expect(resolveGitSourceLayout(root)).toEqual({
        gitRoot: root, productRoot: root, productPrefix: '',
      })
      expect(readGitProductFile(root, flatCommit, 'src/value.ts').toString())
        .toBe('export const value = 1\n')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      delete process.env.GIT_CONFIG_KEY_0
      delete process.env.GIT_CONFIG_VALUE_0
    }
  })

  it('rejects ambiguous identities and unsafe product-relative paths', () => {
    const { root } = flatRepository()
    for (const name of ['package.json', 'pnpm-lock.yaml', 'next.config.js']) {
      write(root, `video-autoworker/${name}`, readFileSync(join(root, name), 'utf8'))
    }
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'ambiguous layout')
    expect(() => resolveGitCommitProductPrefix(root, 'HEAD'))
      .toThrow('git_source_layout_commit_layout_ambiguous')
    for (const pathname of ['', '.', '..', '../secret', '/absolute', 'a\\b', 'video-autoworker/src/a.ts']) {
      expect(() => normalizeProductRelativePath(pathname)).toThrow('git_source_layout_product_path_invalid')
    }
    expect(() => productTreePath('other/', 'src/a.ts'))
      .toThrow('git_source_layout_prefix_invalid')
  })

  it('exposes strict JSON CLI output without weakening file mode checks', () => {
    const { root, flatCommit } = flatRepository()
    const resolveResult = JSON.parse(execFileSync(process.execPath, [helper, 'resolve', root], {
      encoding: 'utf8',
    }))
    expect(resolveResult).toEqual({ gitRoot: root, productRoot: root, productPrefix: '' })
    const fileResult = JSON.parse(execFileSync(process.execPath, [
      helper, 'verify-file', root, 'src/value.ts', flatCommit, '100644',
    ], { encoding: 'utf8' }))
    expect(fileResult).toMatchObject({ treePath: 'src/value.ts', mode: '100644' })
    expect(() => execFileSync(process.execPath, [
      helper, 'verify-file', root, 'src/value.ts', flatCommit, '100755',
    ], { stdio: 'pipe' })).toThrow()
  })

  it('batch-verifies one clean source closure and rejects content or mode drift', () => {
    const { root, flatCommit } = flatRepository()
    const paths = ['package.json', 'pnpm-lock.yaml', 'next.config.js', 'src/value.ts']
    const bundle = verifyGitProductFiles(root, flatCommit, paths)
    expect(bundle).toMatchObject({
      schema: 'video-autoworker-git-source-verification/v1',
      productRoot: root,
      commit: flatCommit,
      files: paths.map(productRelative => ({ productRelative, gitMode: '100644' })),
      closureSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    const cli = JSON.parse(execFileSync(process.execPath, [
      helper, 'verify-files', root, flatCommit, ...paths,
    ], { encoding: 'utf8' }))
    expect(cli.closureSha256).toBe(bundle.closureSha256)

    write(root, 'src/value.ts', 'export const value = 2\n')
    expect(() => verifyGitProductFiles(root, flatCommit, paths))
      .toThrow('git_source_layout_verification_file_mismatch:src/value.ts')
    write(root, 'src/value.ts', 'export const value = 1\n')
    chmodSync(join(root, 'src/value.ts'), 0o755)
    expect(() => verifyGitProductFiles(root, flatCommit, paths))
      .toThrow('git_source_layout_verification_file_mode_mismatch:src/value.ts')
  })
})
