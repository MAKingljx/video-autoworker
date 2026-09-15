import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  executeDirectorBrainOperation,
  loadDirectorBrainSchema,
} from '../lib/feishu-director-brain.mjs'
import {
  createDirectorBrainApplicationService,
  createDirectorBrainTool,
  DIRECTOR_BRAIN_APPLICATION_PROTOCOL,
  DIRECTOR_BRAIN_APPLICATION_SERVICE_URL,
} from '../../openclaw-plugins/aiworker-director-brain/lib/director-brain-tool.js'

/** Build synthetic tool results through the installed contracts, without network or writes. */
export async function buildProjectCacheFixture() {
  const schema = await loadDirectorBrainSchema()
  const catalog = {
    tables: Object.fromEntries(schema.tables.map(table => [
      table.key, { name: table.name, tableId: `fixture-${table.key}` },
    ])),
  }
  const context = { schema, catalog }
  const workId = 'WORK-CACHE-FIXTURE-001'
  const stableId = 'STORY-CACHE-FIXTURE-001'
  const record = {
    record_id: 'fixture-record-not-returned',
    fields: {
      '节点名称': '当前主要冲突',
      '节点 ID': stableId,
      '项目 ID': schema.projectId,
      '作品 ID': workId,
      '节点类型': '转折',
      '节点内容': '当前主要冲突是信任。',
      '证据 ID': 'EVIDENCE-CACHE-FIXTURE-001',
      '置信度': 0.93,
      '状态': '已确认',
      '版本': 'v0.2.0',
      '来源': 'isolated-cache-fixture',
      '审核人': '隔离测试',
      '审核时间': Date.parse('2026-09-15T00:00:00+08:00'),
      '审核原因': '仅用于隔离缓存验收',
      '更新时间': Date.parse('2026-09-15T00:00:00+08:00'),
    },
  }
  let readCount = 0
  let requestCount = 0
  let noStoreCount = 0
  const dependencies = {
    connect: async () => context,
    findExact: async ({ table, tableId, stableId: requestedId }) => {
      assert.equal(table.key, 'story_nodes')
      assert.equal(tableId, catalog.tables.story_nodes.tableId)
      assert.equal(requestedId, stableId)
      readCount += 1
      // Each call reads the current fixture, never an earlier returned object.
      return [structuredClone(record)]
    },
  }
  const applicationService = createDirectorBrainApplicationService({
    fetchImpl: async (url, init) => {
      assert.equal(url, DIRECTOR_BRAIN_APPLICATION_SERVICE_URL)
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.equal(init.cache, 'no-store')
      requestCount += 1
      noStoreCount += 1
      const { protocol, command, input } = JSON.parse(init.body)
      assert.equal(protocol, DIRECTOR_BRAIN_APPLICATION_PROTOCOL)
      assert.equal(command, 'operate')
      assert.deepEqual(input, { action: 'get', table: 'story_nodes', workId, stableId })
      const result = await executeDirectorBrainOperation(input, { dependencies })
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    },
  })
  const tool = createDirectorBrainTool({
    context: { agentId: 'second-original' },
    service: operation => applicationService('operate', operation),
  })
  const cases = []
  async function readCase(label, expectedTerm, expectedReviewed) {
    const result = await tool.execute('fixture-read', {
      action: 'get', table: 'story_nodes', workId, stableId,
    })
    const toolResult = JSON.parse(result.content[0].text)
    assert.equal(toolResult.action, 'get')
    assert.equal(toolResult.found, true)
    assert.equal(toolResult.record.reviewed, expectedReviewed)
    cases.push({ label, expectedTerm, expectedReviewed, toolResult })
  }

  await readCase('v1', '信任', true)
  await readCase('v1_repeat', '信任', true)
  // Only the isolated source record changes; static prompt material can stay identical.
  record.fields['节点内容'] = '当前主要冲突是资源分配。'
  record.fields['版本'] = 'v0.2.1'
  record.fields['更新时间'] += 1_000
  await readCase('v2', '资源分配', true)
  await readCase('v2_repeat', '资源分配', true)
  record.fields['状态'] = '候选'
  await readCase('candidate', '资源分配', false)

  assert.equal(readCount, cases.length)
  assert.equal(requestCount, cases.length)
  return { cases, readCount, noStoreVerified: noStoreCount === cases.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(await buildProjectCacheFixture())}\n`)
}
