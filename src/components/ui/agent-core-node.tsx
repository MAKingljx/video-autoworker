'use client'

import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'

interface CoreNodeData {
  label: string
  agentCount: number
}

/**
 * Central CORE orchestration node for the agent network graph.
 * Restrained concentric rings identify the Mission Control core.
 */
function AgentCoreNodeInner({ data }: NodeProps & { data: CoreNodeData }) {
  const { label = 'CORE', agentCount = 0 } = data ?? {}

  return (
    <div className="relative flex items-center justify-center w-[120px] h-[120px]">
      <div className="absolute inset-0 rounded-full border border-primary/15" />

      {/* Middle ring */}
      <div className="absolute inset-3 rounded-full border border-primary/25" />

      {/* Inner ring */}
      <div className="absolute inset-6 rounded-full border border-primary/35" />

      {/* Core circle */}
      <div className="relative z-10 w-16 h-16 rounded-full bg-card border-2 border-void-cyan glow-cyan flex flex-col items-center justify-center">
        <span className="font-mono text-xs font-bold tracking-widest text-void-cyan">
          {label}
        </span>
        {agentCount > 0 && (
          <span className="font-mono text-[10px] text-void-cyan/70 mt-0.5">
            {agentCount}
          </span>
        )}
      </div>
    </div>
  )
}

export const AgentCoreNode = memo(AgentCoreNodeInner)
