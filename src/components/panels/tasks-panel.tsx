'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { TaskBoardPanel } from '@/components/panels/task-board-panel'
import { TaskRunsPanel } from '@/components/panels/task-runs-panel'

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">任务中心</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            任务链展示自动化运行记录；协作任务保留原有团队看板。
          </p>
        </div>
        <div className="inline-flex w-fit rounded-md border border-border bg-secondary p-1" role="tablist" aria-label="任务视图">
          <ViewTab active={view === 'runs'} onClick={() => selectView('runs')}>任务链</ViewTab>
          <ViewTab active={view === 'collaboration'} onClick={() => selectView('collaboration')}>协作任务</ViewTab>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'runs' ? <TaskRunsPanel /> : <TaskBoardPanel />}
      </div>
    </div>
  )
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
