import { readFile, writeFile } from 'node:fs/promises'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function uniqueStrings(value, label) {
  assert(Array.isArray(value), `${label} must be an array.`)
  assert(value.every(item => typeof item === 'string' && item.trim()), `${label} must contain non-empty strings.`)
  assert(new Set(value).size === value.length, `${label} must not contain duplicates.`)
  return value
}

function readToolIds(report, label) {
  assert(report && typeof report === 'object' && !Array.isArray(report), `${label} must be an object.`)
  assert(Array.isArray(report.groups), `${label}.groups must be an array.`)
  const ids = report.groups.flatMap(group => {
    assert(Array.isArray(group?.tools), `${label} group tools must be an array.`)
    return group.tools.map(tool => tool?.id)
  })
  return new Set(uniqueStrings(ids, `${label} tool IDs`))
}

function codingProfileIds(catalog) {
  assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'tools.catalog must be an object.')
  assert(Array.isArray(catalog.groups), 'tools.catalog.groups must be an array.')
  const ids = catalog.groups.flatMap(group => {
    assert(Array.isArray(group?.tools), 'tools.catalog group tools must be an array.')
    return group.tools
      .filter(tool => Array.isArray(tool?.defaultProfiles) && tool.defaultProfiles.includes('coding'))
      .map(tool => tool.id)
  })
  return new Set(uniqueStrings(ids, 'coding profile tool IDs'))
}

function targetAgent(config, agentId) {
  assert(Array.isArray(config?.agents?.list), 'agents.list must be an array.')
  const matches = config.agents.list.filter(agent => agent?.id === agentId)
  assert(matches.length === 1, `${agentId} must exist exactly once.`)
  assert(matches[0]?.tools && typeof matches[0].tools === 'object' && !Array.isArray(matches[0].tools), `${agentId}.tools must be an object.`)
  return matches[0]
}

function assertNoOtherGrant(config, agentId, toolId) {
  for (const agent of config.agents.list) {
    if (agent?.id === agentId) continue
    for (const key of ['allow', 'alsoAllow']) {
      const value = agent?.tools?.[key]
      if (value === undefined) continue
      assert(!uniqueStrings(value, `other agent tools.${key}`).includes(toolId), `another agent grants ${toolId}.`)
    }
  }
  for (const key of ['allow', 'alsoAllow']) {
    const value = config?.tools?.[key]
    if (value === undefined) continue
    assert(!uniqueStrings(value, `global tools.${key}`).includes(toolId), `global tools.${key} grants ${toolId}.`)
  }
}

export function buildDirectToolAccessCandidate(config, effective, catalog, { agentId, toolId }) {
  const target = targetAgent(config, agentId)
  const legacyAllow = uniqueStrings(target.tools.allow, `${agentId}.tools.allow`)
  assert(!legacyAllow.includes(toolId), `${agentId}.tools.allow already grants ${toolId}.`)
  assert(target.tools.alsoAllow === undefined, `${agentId}.tools.alsoAllow must be unset before migration.`)
  assertNoOtherGrant(config, agentId, toolId)

  const baseline = readToolIds(effective, 'tools.effective')
  assert(!baseline.has(toolId), `${toolId} is already effective.`)
  const coding = codingProfileIds(catalog)
  for (const tool of baseline) {
    assert(coding.has(tool), `current effective tool ${tool} is not in the coding profile.`)
  }

  const candidate = structuredClone(config)
  const candidateTools = targetAgent(candidate, agentId).tools
  delete candidateTools.allow
  candidateTools.profile = 'coding'
  candidateTools.alsoAllow = [toolId]
  candidateTools.deny = [...coding].filter(tool => !baseline.has(tool)).sort()
  return candidate
}

export function validateCandidateAgainstBaseline(candidate, legacyConfig, effective, catalog, { agentId, toolId }) {
  const expected = buildDirectToolAccessCandidate(legacyConfig, effective, catalog, { agentId, toolId })
  assert(JSON.stringify(candidate) === JSON.stringify(expected), 'candidate config differs from the exact profile-plus-deny transformation.')
}

async function readJson(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'))
}

async function main() {
  const [mode, legacyPath, effectivePath, catalogPath, agentId, toolId, outputPath] = process.argv.slice(2)
  if (!['build', 'validate'].includes(mode) || !legacyPath || !effectivePath || !catalogPath || !agentId || !toolId) {
    throw new Error('Usage: direct-tool-access-policy.mjs <build|validate> <legacy-config> <effective> <catalog> <agent-id> <tool-id> [candidate-output]')
  }
  const legacy = await readJson(legacyPath)
  const effective = await readJson(effectivePath)
  const catalog = await readJson(catalogPath)
  if (mode === 'build') {
    if (!outputPath) throw new Error('build requires a candidate output path.')
    const candidate = buildDirectToolAccessCandidate(legacy, effective, catalog, { agentId, toolId })
    await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 })
    return
  }
  if (!outputPath) throw new Error('validate requires a candidate path.')
  const candidate = await readJson(outputPath)
  validateCandidateAgainstBaseline(candidate, legacy, effective, catalog, { agentId, toolId })
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
