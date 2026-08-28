import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceSplitLayout } from './workspace-split-layout'

describe('WorkspaceSplitLayout', () => {
  it('renders one navigation rail and one core content region', () => {
    const onSelect = vi.fn()

    const { container } = render(
      <WorkspaceSplitLayout
        title="任务中心"
        navigationLabel="任务视图"
        items={[
          { id: 'runs', label: '任务链', count: 12 },
          { id: 'collaboration', label: '协作任务' },
        ]}
        activeItem="runs"
        onSelect={onSelect}
        sidebarContent={<div>补充导航</div>}
      >
        <div>核心内容</div>
      </WorkspaceSplitLayout>,
    )

    expect(screen.getByRole('heading', { name: '任务中心' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '任务视图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '任务链 12' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('补充导航')).toBeInTheDocument()
    expect(screen.getByText('核心内容')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-workspace-sidebar]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-workspace-content]')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '协作任务' }))
    expect(onSelect).toHaveBeenCalledWith('collaboration')
  })
})
