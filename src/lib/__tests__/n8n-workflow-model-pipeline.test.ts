import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface WorkflowNode {
  name: string
  type: string
  parameters?: Record<string, unknown>
  continueOnFail?: boolean
  onError?: string
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
      expect(JSON.stringify(node.parameters))
        .toContain("executionOwner: 'n8n-execution:' + $workflow.id + ':' + $execution.id")
      expect(node).toMatchObject({ retryOnFail: true, maxTries: 5, waitBetweenTries: 5000 })
    }
    expect(JSON.stringify(modelNodes[2].parameters)).toContain('finalizeParent: true')
  })

  it('references the inbound shared secret without embedding a credential', () => {
    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain("headers['x-aiworker-webhook-secret']")
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/)
    expect(serialized).not.toContain('DASHSCOPE_API_KEY')
  })

  it('claims the parent before responding and terminates duplicate deliveries before Planner', () => {
    const names = workflow.nodes.map(node => node.name)
    expect(names).toEqual(expect.arrayContaining([
      'Claim Task',
      'Continue Only If Claimed',
      'Build Duplicate Claim Result',
      'Return Duplicate Claim',
    ]))
    expect(workflow.connections['AI-worker Webhook']).toEqual({
      main: [[{ node: 'Claim Task', type: 'main', index: 0 }]],
    })
    expect(workflow.connections['Continue Only If Claimed']).toEqual({
      main: [
        [{ node: 'Build Observable Result', type: 'main', index: 0 }],
        [{ node: 'Build Duplicate Claim Result', type: 'main', index: 0 }],
      ],
    })
    expect(workflow.connections['Return Duplicate Claim']).toBeUndefined()
    expect(JSON.stringify(workflow.nodes.find(node => node.name === 'Claim Task')?.parameters))
      .toContain("executionOwner: 'n8n-execution:' + $workflow.id + ':' + $execution.id")
    expect(JSON.stringify(workflow.nodes.find(node => node.name === 'Build Observable Result')?.parameters))
      .toContain("$('AI-worker Webhook').item.json.body")
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
    expect(workflow.name).toBe('AI-worker Segmented Video Analysis v2')
    const names = workflow.nodes.map(node => node.name)
    expect(names).toEqual(expect.arrayContaining([
      'Claim Video Task',
      'Continue Only If Claimed',
      'Build Duplicate Claim Result',
      'Return Duplicate Claim',
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
    const claimNode = workflow.nodes.find(node => node.name === 'Claim Video Task')
    expect(JSON.stringify(claimNode?.parameters)).toContain('30000')
    expect(JSON.stringify(claimNode?.parameters)).toContain("executionOwner: 'n8n-execution:' + $workflow.id + ':' + $execution.id")
    expect(claimNode).not.toHaveProperty('continueOnFail')
    expect(claimNode).not.toHaveProperty('onError')
    expect(workflow.connections['AI-worker Video Webhook'].main[0][0].node).toBe('Claim Video Task')
    expect(workflow.connections['Claim Video Task']).toEqual({
      main: [[{ node: 'Continue Only If Claimed', type: 'main', index: 0 }]],
    })
    expect(workflow.connections['Continue Only If Claimed']).toEqual({
      main: [
        [{ node: 'Build Video Accepted Result', type: 'main', index: 0 }],
        [{ node: 'Build Duplicate Claim Result', type: 'main', index: 0 }],
      ],
    })
    expect(workflow.connections['Build Video Accepted Result'].main[0][0].node).toBe('Return Video Accepted')
    expect(workflow.connections['Build Duplicate Claim Result'].main[0][0].node).toBe('Return Duplicate Claim')
    expect(workflow.connections['Return Duplicate Claim']).toBeUndefined()
    const claimGuard = workflow.nodes.find(node => node.name === 'Continue Only If Claimed')
    expect(JSON.stringify(claimGuard?.parameters)).toContain('$json.claimed')
    const mediaNodes = workflow.nodes.filter(node =>
      node.type === 'n8n-nodes-base.httpRequest' && node.name !== 'Claim Video Task')
    expect(mediaNodes.map(node => node.name)).toEqual([
      'Prepare Video',
      'Analyze Audio Stateless',
      'Analyze Frames Stateless',
      'Merge Video Result',
    ])
    for (const node of mediaNodes) {
      expect(JSON.stringify(node.parameters)).toContain('14400000')
      expect(JSON.stringify(node.parameters))
        .toContain("executionOwner: 'n8n-execution:' + $workflow.id + ':' + $execution.id")
      expect(node).toMatchObject({ retryOnFail: true, maxTries: 5, waitBetweenTries: 5000 })
    }
  })

  it('uses only the authenticated media callback and declares stateless stages', () => {
    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain('body.routing.mediaCallbackUrl')
    expect(serialized).toContain('body.routing.claimCallbackUrl')
    expect(serialized).toContain('body.routing.claimScope.workspaceId')
    expect(serialized).toContain("stage: 'audio'")
    expect(serialized).toContain("stage: 'vision'")
    expect(serialized).toContain("stage: 'finalize'")
    expect(serialized).toContain("headers['x-aiworker-webhook-secret']")
    expect(serialized).not.toContain('/api/n8n/node-execute')
    expect(serialized).not.toContain('127.0.0.1:3017')
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/)
  })
})
