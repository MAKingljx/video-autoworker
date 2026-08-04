import { describe, expect, it } from 'vitest'
import { reorderPipelineSteps } from '@/lib/pipeline-editor'

describe('pipeline editor ordering', () => {
  it('moves a dragged step without mutating the original array', () => {
    const steps = ['plan', 'execute', 'review']
    expect(reorderPipelineSteps(steps, 0, 2)).toEqual(['execute', 'review', 'plan'])
    expect(steps).toEqual(['plan', 'execute', 'review'])
  })

  it('keeps the original order for invalid moves', () => {
    const steps = ['plan', 'execute']
    expect(reorderPipelineSteps(steps, -1, 1)).toBe(steps)
    expect(reorderPipelineSteps(steps, 0, 0)).toBe(steps)
  })
})
