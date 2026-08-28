'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { TaskBoardPanel } from '@/components/panels/task-board-panel'
import { TaskRunsPanel } from '@/components/panels/task-runs-panel'
import { WorkspaceSplitLayout } from '@/components/ui/workspace-split-layout'

type TaskView = 'runs' | 'collaboration'

export function TasksPanel() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const view: TaskView = searchParams.get('taskView') === 'collaboration' ? 'collaboration' : 'runs'

  const selectView = (nextView: TaskView) => {
    const params = new URLSearchParams(searchParams.toString())
    if (nextView === 'runs') {
      params.delete('taskView')
      params.delete('taskId')
    } else {
      params.set('taskView', 'collaboration')
    }
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname)
  }

  return (
    <div className="p-3 md:p-4">
      <WorkspaceSplitLayout
        title="任务中心"
        navigationLabel="任务视图"
        items={[
          { id: 'runs', label: '任务链' },
          { id: 'collaboration', label: '协作任务' },
        ]}
        activeItem={view}
        onSelect={selectView}
        className="@4xl:h-[calc(100dvh-5.5rem)]"
        contentClassName="@4xl:overflow-hidden"
      >
        {view === 'runs' ? <TaskRunsPanel /> : <TaskBoardPanel />}
      </WorkspaceSplitLayout>
    </div>
  )
}
