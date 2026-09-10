function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function layout(config) {
  object(config, 'OpenClaw config')
  const agents = config.agents === undefined ? {} : object(config.agents, 'agents')
  if (Object.hasOwn(agents, 'entries') && Object.hasOwn(agents, 'list')) {
    throw new Error('agents.entries and agents.list must not coexist')
  }
  return { agents, legacy: Object.hasOwn(agents, 'list') }
}

function validateIds(agents) {
  const seen = new Set()
  for (const entry of agents) {
    object(entry, 'agent entry')
    if (typeof entry.id !== 'string' || !/^[a-z0-9_][a-z0-9_-]{0,63}$/iu.test(entry.id)) {
      throw new Error('agent entry id is invalid')
    }
    const normalized = entry.id.toLowerCase()
    if (seen.has(normalized)) throw new Error('agent entry ids must be unique')
    seen.add(normalized)
  }
  return agents
}

/** Normalize the 9.2 keyed layout and historical list without changing the source. */
export function readOpenClawAgentEntries(config) {
  const { agents, legacy } = layout(config)
  if (legacy) {
    if (!Array.isArray(agents.list)) throw new Error('agents.list must be an array')
    return validateIds(agents.list.map(entry => ({ ...object(entry, 'agent entry') })))
  }
  const entries = agents.entries === undefined ? {} : object(agents.entries, 'agents.entries')
  return validateIds(Object.entries(entries).map(([id, value]) => {
    const entry = object(value, 'agents.entries entry')
    if (Object.hasOwn(entry, 'id')) throw new Error('agents.entries identity must be its key')
    return { ...entry, id }
  }))
}

/** Preserve the existing layout; newly created configurations use the 9.2 layout. */
export function writeOpenClawAgentEntries(config, entries) {
  const { legacy } = layout(config)
  readOpenClawAgentEntries(config)
  if (!Array.isArray(entries)) throw new Error('agent entries must be an array')
  validateIds(entries)
  if (!legacy && entries.length === 0) {
    throw new Error('agents.entries must contain at least one configured agent')
  }
  config.agents ??= {}
  if (legacy) {
    config.agents.list = entries.map(entry => ({ ...entry }))
  } else {
    config.agents.entries = Object.fromEntries(entries.map(({ id, ...entry }) => [id, entry]))
  }
}
