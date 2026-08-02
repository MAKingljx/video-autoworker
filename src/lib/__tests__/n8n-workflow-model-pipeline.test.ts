import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface WorkflowNode {
  name: string
  type: string
  parameters?: Record<string, unknown>
}

describe('bundled n8n model pipeline', () => {
  const workflowPath = resolve(process.cwd(), 'ops/n8n/workflows/aiworker-task-intake.json')
  const workflow = JSON.parse(readFileSync(workflowPath, 'utf8')) as {
    id: string
    name: string
    nodes: WorkflowNode[]
    connections: Record<string, unknown>
  }

  it('keeps the stable workflow ID and three ordered model nodes', () => {
    expect(workflow.id).toBe('aiworker-task-intake-v1')
    expect(workflow.name).toBe('AI-worker Model Pipeline v2')
    const modelNodes = workflow.nodes.filter(node =>
      node.type === 'n8n-nodes-base.httpRequest'
      && JSON.stringify(node.parameters).includes('/api/n8n/node-execute'))
    expect(modelNodes.map(node => node.name)).toEqual([
      'Planner Model Node',
      'Executor Model Node',
      'Reviewer Model Node',
    ])
    expect(JSON.stringify(modelNodes[2].parameters)).toContain('finalizeParent: true')
  })

  it('references the inbound shared secret without embedding a credential', () => {
    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain("headers['x-aiworker-webhook-secret']")
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/)
    expect(serialized).not.toContain('DASHSCOPE_API_KEY')
  })
})
