import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const pluginRoot = resolve(repositoryRoot, 'openclaw-plugins/aiworker-video-command')
const libRoot = resolve(pluginRoot, 'lib')

const currentModules = [
  'director-work-policy.js',
  'dispatch-identity.js',
  'duplicate-confirmation-store.js',
  'json-command.js',
  'qwen-before-dispatch.js',
  'qwen-video-classifier.js',
  'scheduler-runner.js',
  'stable-message-key.js',
  'task-chain-tool.js',
  'video-path-policy.js',
]

async function reachablePluginFiles() {
  const seen = new Set()
  async function visit(pathname) {
    if (seen.has(pathname)) return
    seen.add(pathname)
    const source = await readFile(pathname, 'utf8')
    const imports = source.matchAll(/(?:from\s+|import\s*\()["'](\.\.?\/[^"')\s;]+)/gu)
    for (const match of imports) {
      const target = resolve(dirname(pathname), match[1])
      if (target.startsWith(pluginRoot)) await visit(target)
    }
  }
  await visit(resolve(pluginRoot, 'index.js'))
  return [...seen].map(pathname => relative(pluginRoot, pathname)).sort()
}

describe('single current video task chain layout', () => {
  it('keeps every runtime module reachable from the one plugin entry', async () => {
    const modules = (await readdir(libRoot)).filter(name => name.endsWith('.js')).sort()
    expect(modules).toEqual(currentModules)
    expect(await reachablePluginFiles()).toEqual([
      'index.js',
      ...currentModules.map(name => `lib/${name}`),
    ].sort())
  })

  it('keeps one generic plugin lifecycle script and no version-specific upgrade entries', async () => {
    const scripts = await readdir(resolve(repositoryRoot, 'scripts'))
    const lifecycle = scripts
      .filter(name => /(?:install|upgrade|activate|enable|rollback)-aiworker-video-(?:command|release)/u.test(name))
      .sort()
    expect(lifecycle).toEqual(['install-aiworker-video-command-plugin.sh'])
  })

  it('ships only the current runtime validator inside the plugin package', async () => {
    expect((await readdir(resolve(pluginRoot, 'scripts'))).sort()).toEqual([
      'validate-runtime-inspection.mjs',
    ])
  })
})
