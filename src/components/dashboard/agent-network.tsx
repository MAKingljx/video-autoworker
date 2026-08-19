'use client'

import { useCallback, useEffect, useState, useMemo } from 'react'
import {
  ReactFlow,
  Node,
  Edge,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  BackgroundVariant,
  Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Agent, Session } from '@/types'
import { sessionToAgent, generateNodePosition } from '@/lib/utils'
import { AgentCoreNode } from '@/components/ui/agent-core-node'

interface AgentNetworkProps {
  agents: Agent[]
  sessions: Session[]
}

// SVG icons for agent types (16x16, stroke-based)
function CrownIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M2 12l1.5-7L6 8l2-5 2 5 2.5-3L14 12H2z" />
    </svg>
  )
}

function BotIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <rect x="3" y="5" width="10" height="8" rx="1.5" />
      <circle cx="6" cy="9" r="1" />
      <circle cx="10" cy="9" r="1" />
      <path d="M8 2v3M6 2h4" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5v3.5l2.5 2" />
    </svg>
  )
}

function GroupIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <circle cx="6" cy="5" r="2" />
      <circle cx="11" cy="5" r="2" />
      <path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4" />
      <path d="M13.5 13c0-2.2-1.5-4-3-4" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" />
      <path d="M9 1v4h4" />
    </svg>
  )
}

// Custom node component for agents
function AgentNode({ data }: { data: any }) {
  const { agent, status } = data

  const getStatusClasses = () => {
    switch (status) {
      case 'active': return 'border-primary/60'
      case 'idle': return 'border-border'
      case 'error': return 'border-destructive/60'
      default: return 'border-border'
    }
  }

  const getTypeIcon = () => {
    switch (agent.type) {
      case 'main': return <CrownIcon />
      case 'subagent': return <BotIcon />
      case 'cron': return <ClockIcon />
      case 'group': return <GroupIcon />
      default: return <FileIcon />
    }
  }

  const getRoleBadge = () => {
    switch (agent.type) {
      case 'main':
        return { label: 'LEAD', color: 'border-primary/25 bg-primary/10 text-primary' }
      case 'subagent':
        return { label: 'WORKER', color: 'border-border bg-secondary text-muted-foreground' }
      case 'cron':
        return { label: 'CRON', color: 'border-border bg-secondary text-muted-foreground' }
      default:
        return { label: 'SYSTEM', color: 'bg-muted text-muted-foreground border-border' }
    }
  }

  const roleBadge = getRoleBadge()
  const isWorking = status === 'active'

  return (
    <div className={`void-panel px-3 py-3 border-2 ${getStatusClasses()} min-w-[140px]`}>
      <div className="flex items-start justify-between">
        <span className="text-primary">
          {getTypeIcon()}
        </span>
        {isWorking && (
          <span className="rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 font-mono text-xs font-bold text-success">
            WORKING
          </span>
        )}
      </div>

      <div className="mt-2">
        <div className="flex items-center space-x-1 mb-1">
          <div className="font-medium text-foreground text-sm truncate">
            {agent.name}
          </div>
          <span className={`px-1.5 py-0.5 text-xs font-bold font-mono border rounded-full ${roleBadge.color}`}>
            {roleBadge.label}
          </span>
        </div>

        <div className="text-xs font-mono text-muted-foreground truncate">
          {(typeof agent.model === 'string' ? agent.model : '').split('/').pop() || 'unknown'}
        </div>

        {agent.session && (
          <div className="text-xs font-mono text-muted-foreground/70 mt-1 truncate">
            {agent.session.key.split(':').pop()}
          </div>
        )}
      </div>
    </div>
  )
}

const nodeTypes = {
  agent: AgentNode,
  core: AgentCoreNode,
}

export function AgentNetwork({ agents, sessions }: AgentNetworkProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  // Convert sessions to nodes and edges
  const { nodeData, edgeData } = useMemo(() => {
    const agentList = sessions.map(sessionToAgent)
    
    // Add CORE hub node at center
    const coreNode: Node = {
      id: '__core__',
      type: 'core',
      position: { x: 0, y: 0 },
      data: { label: 'CORE', agentCount: agentList.length },
      style: { background: 'transparent', border: 'none' },
    }

    const agentNodes: Node[] = agentList.map((agent, index) => ({
      id: agent.id,
      type: 'agent',
      position: generateNodePosition(index, agentList.length),
      data: {
        agent,
        status: agent.status,
        label: agent.name
      },
      style: {
        background: 'transparent',
        border: 'none',
      }
    }))

    const nodes = [coreNode, ...agentNodes]

    // Create edges — all agents connect to CORE, plus hierarchical edges
    const edges: Edge[] = []
    const primaryStroke = 'hsl(var(--primary))'
    const primaryDimStroke = 'hsl(var(--primary) / 0.35)'
    const secondaryStroke = 'hsl(var(--border))'

    const mainAgents = agentList.filter(a => a.type === 'main')
    const subagents = agentList.filter(a => a.type === 'subagent')
    const cronAgents = agentList.filter(a => a.type === 'cron')

    // Connect all agents to CORE hub
    agentList.forEach(agent => {
      edges.push({
        id: `core-${agent.id}`,
        source: '__core__',
        target: agent.id,
        animated: agent.status === 'active',
        style: {
          stroke: agent.status === 'active' ? primaryStroke : primaryDimStroke,
          strokeWidth: 1.5,
        },
        type: 'smoothstep',
      })
    })

    // Connect main agents to subagents
    mainAgents.forEach(main => {
      subagents.forEach(sub => {
        edges.push({
          id: `${main.id}-${sub.id}`,
          source: main.id,
          target: sub.id,
          animated: sub.status === 'active',
          style: {
            stroke: primaryStroke,
            strokeWidth: 2,
          },
          type: 'smoothstep'
        })
      })

      // Connect main agents to cron jobs
      cronAgents.forEach(cron => {
        edges.push({
          id: `${main.id}-${cron.id}`,
          source: main.id,
          target: cron.id,
          animated: false,
          style: {
            stroke: secondaryStroke,
            strokeWidth: 1,
            strokeDasharray: '5,5',
          },
          type: 'smoothstep'
        })
      })
    })

    return { nodeData: nodes, edgeData: edges }
  }, [sessions])

  useEffect(() => {
    setNodes(nodeData)
    setEdges(edgeData)
  }, [nodeData, edgeData, setNodes, setEdges])

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  )

  if (sessions.length === 0) {
    return (
      <div className="void-panel h-96 flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2 h-10 w-10 text-primary/40">
            <circle cx="4" cy="4" r="2" />
            <circle cx="12" cy="4" r="2" />
            <circle cx="4" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <path d="M6 4h4M4 6v4M12 6v4M6 12h4" />
          </svg>
          <p>No agent network to display</p>
          <p className="text-xs mt-1">Agent connections will appear here</p>
        </div>
      </div>
    )
  }

  return (
    <div className="void-panel">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">Agent Network</h3>
        <p className="text-sm text-muted-foreground">
          Visual representation of agent relationships
        </p>
      </div>

      <div className="h-96">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          className="bg-transparent"
        >
          <Controls
            style={{
              background: 'hsl(var(--surface-1))',
              border: '1px solid hsl(var(--surface-3))',
              borderRadius: '10px',
            }}
          />
          <Background
            variant={BackgroundVariant.Dots}
            gap={40}
            size={0.6}
            color="hsl(var(--primary) / 0.12)"
          />
        </ReactFlow>
      </div>
    </div>
  )
}
