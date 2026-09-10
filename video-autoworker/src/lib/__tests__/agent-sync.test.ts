import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mcAgents = vi.hoisted(() => [] as Array<{ name: string; role: string; config: string }>)
const insertedAgents = vi.hoisted(() => [] as unknown[][])

vi.mock('@/lib/db', () => ({
  db_helpers: {},
  getDatabase: () => ({
    prepare: (sql: string) => {
      if (sql.includes('SELECT name, role, config FROM agents')) return { all: () => mcAgents }
      if (sql.includes('SELECT id, name, role, config, soul_content')) {
        return { get: (name: string) => mcAgents.find(agent => agent.name === name) }
      }
      if (sql.includes('INSERT INTO agents')) {
        return { run: (...values: unknown[]) => insertedAgents.push(values) }
      }
      if (sql.includes('UPDATE agents')) return { run: vi.fn() }
      throw new Error(`unexpected agent-sync SQL: ${sql}`)
    },
    transaction: (operation: () => void) => () => operation(),
  }),
  logAuditEvent: vi.fn(),
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn() },
}))

describe('removeAgentFromConfig', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    mcAgents.splice(0)
    insertedAgents.splice(0)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
  })

  it('removes matching agent entries by id and display name', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-agent-sync-'))
    const configPath = path.join(tempDir, 'openclaw.json')
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            list: [
              { id: 'jarv', name: 'jarv', identity: { name: 'jarv' } },
              { id: 'neo', identity: { name: 'Neo' } },
              { id: 'keep-me', name: 'keep-me', identity: { name: 'keep-me' } },
            ],
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    )

    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = tempDir

    const { removeAgentFromConfig } = await import('@/lib/agent-sync')
    const result = await removeAgentFromConfig({ id: 'neo', name: 'Neo' })

    expect(result.removed).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(parsed.agents.list).toEqual([
      { id: 'jarv', name: 'jarv', identity: { name: 'jarv' } },
      { id: 'keep-me', name: 'keep-me', identity: { name: 'keep-me' } },
    ])
  })

  it('is a no-op when no matching agent entry exists', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-agent-sync-'))
    const configPath = path.join(tempDir, 'openclaw.json')
    writeFileSync(
      configPath,
      JSON.stringify({ agents: { list: [{ id: 'keep-me', name: 'keep-me' }] } }, null, 2) + '\n',
      'utf-8',
    )

    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = tempDir

    const { removeAgentFromConfig } = await import('@/lib/agent-sync')
    const result = await removeAgentFromConfig({ id: 'missing', name: 'missing' })

    expect(result.removed).toBe(false)
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(parsed.agents.list).toEqual([{ id: 'keep-me', name: 'keep-me' }])
  })

  it('normalizes nested model.primary payloads when writing config', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-agent-sync-'))
    const configPath = path.join(tempDir, 'openclaw.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            {
              id: 'neo',
              model: {
                primary: {
                  primary: 'anthropic/claude-sonnet-4-20250514',
                },
                fallbacks: ['openai/codex-mini-latest', 'openai/codex-mini-latest'],
              },
            },
          ],
        },
      }, null, 2) + '\n',
      'utf-8',
    )

    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = tempDir

    const { writeAgentToConfig } = await import('@/lib/agent-sync')
    await writeAgentToConfig({
      id: 'neo',
      model: {
        primary: {
          primary: 'anthropic/claude-sonnet-4-20250514',
        },
        fallbacks: ['openrouter/anthropic/claude-sonnet-4'],
      },
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(parsed.agents.list[0].model).toEqual({
      primary: 'anthropic/claude-sonnet-4-20250514',
      fallbacks: ['openrouter/anthropic/claude-sonnet-4'],
    })
  })

  it('reads keyed OpenClaw 9.2 entries for scheduler sync and API previews', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-agent-sync-'))
    const configPath = path.join(tempDir, 'openclaw.json')
    writeFileSync(configPath, JSON.stringify({
      agents: {
        entries: {
          'second-original': {
            identity: { name: 'Second Original', theme: 'director' },
            model: { primary: 'local/model' },
          },
        },
      },
    }, null, 2) + '\n', 'utf8')
    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = tempDir

    const { previewSyncDiff, syncAgentsFromConfig } = await import('@/lib/agent-sync')
    await expect(previewSyncDiff()).resolves.toEqual({
      inConfig: 1,
      inMC: 0,
      newAgents: ['Second Original'],
      updatedAgents: [],
      onlyInMC: [],
    })
    await expect(syncAgentsFromConfig('startup')).resolves.toMatchObject({
      synced: 1,
      created: 1,
      updated: 0,
      agents: [{ id: 'second-original', name: 'Second Original', action: 'created' }],
    })
    expect(insertedAgents).toHaveLength(1)
    expect(JSON.parse(String(insertedAgents[0][5]))).toMatchObject({
      openclawId: 'second-original',
      model: { primary: 'local/model' },
    })
  })

  it('updates and removes keyed OpenClaw 9.2 entries without creating agents.list', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-agent-sync-'))
    const configPath = path.join(tempDir, 'openclaw.json')
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: { model: 'local/default' },
        entries: {
          'second-original': {
            identity: { name: 'Second Original' },
            model: { primary: 'local/old' },
          },
          worker: { identity: { name: 'Worker' } },
        },
      },
    }, null, 2) + '\n', 'utf8')
    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = tempDir

    const { removeAgentFromConfig, writeAgentToConfig } = await import('@/lib/agent-sync')
    await writeAgentToConfig({
      id: 'second-original',
      model: { primary: { primary: 'local/new' } },
    })
    let parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(parsed.agents.list).toBeUndefined()
    expect(parsed.agents.defaults).toEqual({ model: 'local/default' })
    expect(parsed.agents.entries['second-original']).toEqual({
      identity: { name: 'Second Original' },
      model: { primary: 'local/new' },
    })
    expect(parsed.agents.entries['second-original'].id).toBeUndefined()

    await expect(removeAgentFromConfig({ id: 'worker' })).resolves.toEqual({ removed: true })
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(parsed.agents.list).toBeUndefined()
    expect(Object.keys(parsed.agents.entries)).toEqual(['second-original'])
  })

  it('creates the keyed layout for a config without an existing agents layout', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-agent-sync-'))
    const configPath = path.join(tempDir, 'openclaw.json')
    writeFileSync(configPath, '{}\n', 'utf8')
    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = tempDir

    const { writeAgentToConfig } = await import('@/lib/agent-sync')
    await writeAgentToConfig({ id: 'new-agent', identity: { name: 'New Agent' } })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(parsed.agents).toEqual({
      entries: { 'new-agent': { identity: { name: 'New Agent' } } },
    })
  })
})
