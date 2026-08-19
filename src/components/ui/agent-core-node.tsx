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
      <div className="relative z-10 flex h-16 w-16 flex-col items-center justify-center rounded-full border-2 border-primary bg-card">
        <span className="font-mono text-xs font-bold tracking-widest text-primary">
          {label}
        </span>
        {agentCount > 0 && (
          <span className="mt-0.5 font-mono text-[10px] text-primary/70">
            {agentCount}
          </span>
        )}
      </div>
    </div>
  )
}

export const AgentCoreNode = memo(AgentCoreNodeInner)
