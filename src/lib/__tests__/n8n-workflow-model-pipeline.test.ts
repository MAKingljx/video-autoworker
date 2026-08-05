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
      && JSON.stringify(node.parameters).includes('body.routing.nodeCallbackUrl'))
    expect(modelNodes.map(node => node.name)).toEqual([
      'Planner Model Node',
      'Executor Model Node',
      'Reviewer Model Node',
    ])
    for (const node of modelNodes) {
      expect(JSON.stringify(node.parameters)).toContain('body.routing.nodeCallbackUrl')
      expect(JSON.stringify(node.parameters)).not.toContain('127.0.0.1:3017')
    }
    expect(JSON.stringify(modelNodes[2].parameters)).toContain('finalizeParent: true')
  })

  it('references the inbound shared secret without embedding a credential', () => {
    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain("headers['x-aiworker-webhook-secret']")
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/)
    expect(serialized).not.toContain('DASHSCOPE_API_KEY')
  })
})

describe('bundled stateless video pipeline', () => {
  const workflowPath = resolve(process.cwd(), 'ops/n8n/workflows/aiworker-video-analysis.json')
  const workflow = JSON.parse(readFileSync(workflowPath, 'utf8')) as {
    id: string
    name: string
    nodes: WorkflowNode[]
    connections: Record<string, any>
  }

  it('prepares once, runs independent audio and vision branches, then merges', () => {
    expect(workflow.id).toBe('aiworker-video-analysis-v1')
    expect(workflow.name).toBe('AI-worker Stateless Video Analysis v1')
    const names = workflow.nodes.map(node => node.name)
    expect(names).toEqual(expect.arrayContaining([
      'Prepare Video',
      'Analyze Audio Stateless',
      'Analyze Frames Stateless',
      'Wait For Both Workers',
      'Merge Video Result',
    ]))
    expect(workflow.connections['Prepare Video'].main[0]).toEqual([
      { node: 'Analyze Audio Stateless', type: 'main', index: 0 },
      { node: 'Analyze Frames Stateless', type: 'main', index: 0 },
    ])
    expect(workflow.connections['Analyze Audio Stateless'].main[0][0].index).toBe(0)
    expect(workflow.connections['Analyze Frames Stateless'].main[0][0].index).toBe(1)
  })

  it('uses only the authenticated media callback and declares stateless stages', () => {
    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain('body.routing.mediaCallbackUrl')
    expect(serialized).toContain("stage: 'audio'")
    expect(serialized).toContain("stage: 'vision'")
    expect(serialized).toContain("stage: 'finalize'")
    expect(serialized).toContain("headers['x-aiworker-webhook-secret']")
    expect(serialized).not.toContain('/api/n8n/node-execute')
    expect(serialized).not.toContain('127.0.0.1:3017')
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/)
  })
})
