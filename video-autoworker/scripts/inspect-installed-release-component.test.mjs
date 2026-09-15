import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { inspectInstalledReleaseComponent } from './verify-director-video-release-readiness.mjs'
import { renderManagedMarkdownSection } from './lib/render-managed-markdown-section.mjs'

const canonical = resolve(new URL('..', import.meta.url).pathname)
async function privateCopy(source, target) {
  await cp(source, target, { recursive: true })
  async function secure(path) {
    await chmod(path, 0o700)
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.isDirectory()) await secure(join(path, item.name))
      else await chmod(join(path, item.name), 0o600)
    }
  }
  await secure(target)
}
async function fixture(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'component-inspect-')))
  const repositoryRoot = join(root, 'source'), profileStateRoot = join(root, 'profile'), workspaceRoot = join(root, 'workspace')
  for (const pathname of [repositoryRoot, profileStateRoot, workspaceRoot]) await mkdir(pathname, { mode: 0o700 })
  await privateCopy(join(canonical, 'openclaw-skills/aiworker-task-flow'), join(repositoryRoot, 'openclaw-skills/aiworker-task-flow'))
  await privateCopy(join(canonical, 'openclaw-skills/aiworker-director-brain'), join(repositoryRoot, 'openclaw-skills/aiworker-director-brain'))
  await privateCopy(join(canonical, 'openclaw-plugins/aiworker-director-brain'), join(repositoryRoot, 'openclaw-plugins/aiworker-director-brain'))
  const taskSource = join(repositoryRoot, 'openclaw-skills/aiworker-task-flow')
  const taskTarget = join(workspaceRoot, 'skills/aiworker-task-flow')
  await mkdir(taskTarget, { recursive: true, mode: 0o700 })
  await cp(join(taskSource, 'SKILL.md'), join(taskTarget, 'SKILL.md'))
  for (const dir of ['lib', 'scripts']) await privateCopy(join(taskSource, dir), join(taskTarget, dir))
  for (const [file, templateFile, sectionId, legacyHeadings] of [
    ['AGENTS.md', 'WORKSPACE_VIDEO_RULES.md', 'video-rules', ['## Video Learning Pipeline Rule', '## Video Analysis Task Flow Rule']],
    ['MEMORY.md', 'WORKSPACE_VIDEO_MEMORY.md', 'video-memory', ['## Current AI-worker Video Analysis Memory']],
  ]) await writeFile(join(workspaceRoot, file), renderManagedMarkdownSection({ current: '用户私人说明保持原样。\n', template: await readFile(join(taskSource, templateFile), 'utf8'), sectionId, legacyHeadings }), { mode: 0o600 })
  const directorSource = join(repositoryRoot, 'openclaw-plugins/aiworker-director-brain')
  const directorTarget = join(profileStateRoot, 'extensions/aiworker-director-brain')
  await mkdir(directorTarget, { recursive: true, mode: 0o700 })
  for (const file of ['index.js', 'package.json', 'openclaw.plugin.json']) await cp(join(directorSource, file), join(directorTarget, file))
  await privateCopy(join(directorSource, 'lib'), join(directorTarget, 'lib'))
  await privateCopy(join(repositoryRoot, 'openclaw-skills/aiworker-director-brain'), join(workspaceRoot, 'skills/aiworker-director-brain'))
  const config = { plugins: { entries: { 'aiworker-director-brain': { enabled: true, hooks: { allowConversationAccess: true }, config: { releaseReady: true, targetAgentId: 'second-original' } } } }, agents: { list: [{ id: 'second-original', tools: { alsoAllow: ['aiworker_director_brain'] } }] } }
  await writeFile(join(profileStateRoot, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 })
  const inspect = component => inspectInstalledReleaseComponent({ component, repositoryRoot, profileStateRoot, workspaceRoot })
  try { await callback({ root, repositoryRoot, profileStateRoot, workspaceRoot, taskSource, taskTarget, directorSource, directorTarget, inspect, config }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('unchanged task flow reuses exact payload plus managed sections, without mutating private text', async () => fixture(async ({ inspect, workspaceRoot }) => {
  const before = await readFile(join(workspaceRoot, 'AGENTS.md'), 'utf8')
  const first = inspect('taskFlow')
  assert.equal(first.matches, true); assert.match(first.fingerprint, /^[a-f0-9]{64}$/u)
  assert.deepEqual(inspect('taskFlow'), first)
  assert.equal(await readFile(join(workspaceRoot, 'AGENTS.md'), 'utf8'), before)
  await writeFile(join(workspaceRoot, 'AGENTS.md'), before.replace('用户私人说明保持原样。', '用户私人说明独立更新。'), { mode: 0o600 })
  const second = inspect('taskFlow')
  assert.equal(second.matches, true); assert.notEqual(second.fingerprint, first.fingerprint)
}))

test('managed-template-only change requires installation even when every skill file matches', async () => fixture(async ({ inspect, taskSource }) => {
  const before = inspect('taskFlow')
  const path = join(taskSource, 'WORKSPACE_VIDEO_RULES.md')
  await writeFile(path, (await readFile(path, 'utf8')) + '\n新规则：按片段读取。\n', { mode: 0o600 })
  const after = inspect('taskFlow')
  assert.equal(after.matches, false); assert.equal(after.reason, 'managed_sections_changed')
  assert.notEqual(after.fingerprint, before.fingerprint)
}))

test('components are independent and older compatible director payload never passes as current source', async () => fixture(async ({ inspect, directorTarget, directorSource, config, profileStateRoot }) => {
  const taskBefore = inspect('taskFlow'), directorBefore = inspect('directorBrain')
  assert.equal(directorBefore.matches, true)
  await writeFile(join(directorSource, 'index.js'), (await readFile(join(directorSource, 'index.js'), 'utf8')) + '\n// source update\n', { mode: 0o600 })
  assert.equal(inspect('directorBrain').matches, false)
  assert.deepEqual(inspect('taskFlow'), taskBefore)
  await cp(join(directorSource, 'index.js'), join(directorTarget, 'index.js'))
  assert.equal(inspect('directorBrain').matches, true)
  config.plugins.entries['aiworker-director-brain'].config.releaseReady = false
  await writeFile(join(profileStateRoot, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 })
  assert.equal(inspect('directorBrain').reason, 'component_config_changed')
  assert.deepEqual(inspect('taskFlow'), taskBefore)
}))

test('unsafe targets and source templates throw instead of being treated as content drift', async () => fixture(async ({ inspect, workspaceRoot, taskTarget, taskSource }) => {
  const agents = join(workspaceRoot, 'AGENTS.md')
  await rm(agents); await symlink(join(taskSource, 'WORKSPACE_VIDEO_RULES.md'), agents)
  assert.throws(() => inspect('taskFlow'), /symlink/u)
  await rm(agents); await writeFile(agents, '', { mode: 0o600 })
  await chmod(join(taskTarget, 'SKILL.md'), 0o666)
  assert.throws(() => inspect('taskFlow'), /unsafe/u)
  await chmod(join(taskTarget, 'SKILL.md'), 0o600)
  await writeFile(join(taskSource, 'WORKSPACE_VIDEO_RULES.md'), 'invalid source template', { mode: 0o600 })
  assert.throws(() => inspect('taskFlow'), /template must start/u)
}))

test('video inspection checks exact payload, required config and only the managed SDK symlink', async () => fixture(async ({ root, repositoryRoot, profileStateRoot, config, inspect }) => {
  const source = join(repositoryRoot, 'openclaw-plugins/aiworker-video-command')
  await privateCopy(join(canonical, 'openclaw-plugins/aiworker-video-command'), source)
  const target = join(profileStateRoot, 'extensions/aiworker-video-command')
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const file of ['index.js', 'package.json', 'openclaw.plugin.json']) await cp(join(source, file), join(target, file))
  for (const dir of ['lib', 'scripts']) await privateCopy(join(source, dir), join(target, dir))
  const managedNode = join(root, 'managed-node'), sdk = join(managedNode, 'lib/node_modules/openclaw')
  await mkdir(sdk, { recursive: true, mode: 0o700 })
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }), { mode: 0o600 })
  await mkdir(join(target, 'node_modules'), { mode: 0o700 })
  await symlink(sdk, join(target, 'node_modules/openclaw'))
  config.plugins.entries['aiworker-video-command'] = { enabled: true, llm: { allowAgentIdOverride: true }, config: { releaseReady: true } }
  config.agents.list[0].tools.alsoAllow.push('aiworker_analyze_video')
  await writeFile(join(profileStateRoot, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 })
  const keys = ['NODE_ENV', 'AIWORKER_OPENCLAW_RUNTIME_TEST_MODE', 'AIWORKER_TEST_OPENCLAW_MANAGED_NODE_ROOT']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { NODE_ENV: 'test', AIWORKER_OPENCLAW_RUNTIME_TEST_MODE: '1', AIWORKER_TEST_OPENCLAW_MANAGED_NODE_ROOT: managedNode })
  try {
    const first = inspect('videoCommand')
    assert.equal(first.matches, true)
    config.plugins.entries['aiworker-director-brain'].config.releaseReady = false
    await writeFile(join(profileStateRoot, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 })
    assert.deepEqual(inspect('videoCommand'), first)
    config.plugins.entries['aiworker-video-command'].config.releaseReady = false
    await writeFile(join(profileStateRoot, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 })
    assert.equal(inspect('videoCommand').reason, 'component_config_changed')
    await symlink(join(target, 'index.js'), join(target, 'unsafe.js'))
    assert.throws(() => inspect('videoCommand'), /symlink/u)
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}))
