// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { partitionTargetedTests } from '../../scripts/lib/targeted-test-partition.mjs'

describe('targeted heavy test isolation', () => {
  it('runs only selected heavy suites in separate processes without duplicating ordinary tests', () => {
    const heavy = ['src/a.test.ts', 'src/b.test.ts']
    const result = partitionTargetedTests(['/product/src/a.test.ts', '/product/src/c.test.ts', '/product/src/c.test.ts'], '/product', heavy)
    expect(result.regularFiles).toEqual(['src/c.test.ts'])
    expect(result.heavyFiles).toEqual(['src/a.test.ts'])
    expect(result.invocations).toHaveLength(2)
    expect(result.invocations[1]).toContain('--testTimeout=30000')
    expect(result.invocations.flat()).not.toContain('src/b.test.ts')
  })
  it('does not turn empty or outside selections into a passing run', () => {
    expect(() => partitionTargetedTests([], '/product', [])).toThrow('targeted_test_selection_empty')
    expect(() => partitionTargetedTests(['/outside/a.test.ts'], '/product', [])).toThrow('targeted_test_outside_product')
  })
})
