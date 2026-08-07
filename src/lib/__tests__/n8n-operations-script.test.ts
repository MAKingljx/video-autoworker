import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('n8n operations runtime', () => {
  it('provides an overridable 8 GiB Node heap default to CLI and service processes', () => {
    const common = readFileSync(resolve(process.cwd(), 'ops/n8n/lib/common.sh'), 'utf8')
    const environmentTemplate = readFileSync(resolve(process.cwd(), 'ops/n8n/.env.example'), 'utf8')

    expect(common).toContain('override_node_options="${NODE_OPTIONS:-}"')
    expect(common).toContain('NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"')
    expect(common).toContain('export N8N_NODE_BIN N8N_NPM_BIN NODE_OPTIONS N8N_USER_FOLDER')
    expect(environmentTemplate).toContain('NODE_OPTIONS="--max-old-space-size=8192"')
  })

  it('consumes workflow listings before exact matching to avoid n8n EPIPE failures', () => {
    const importer = readFileSync(resolve(process.cwd(), 'scripts/n8n-import-workflows.sh'), 'utf8')

    expect(importer).toContain('listed_workflow_ids="$("$N8N_NODE_BIN"')
    expect(importer).toContain('active_workflow_ids="$("$N8N_NODE_BIN"')
    expect(importer).not.toMatch(/list:workflow[^\n]*\|\s*grep\s+-Fq/)
  })
})
