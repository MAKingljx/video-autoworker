'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { reorderPipelineSteps } from '@/lib/pipeline-editor'

interface WorkflowTemplate {
  id: number
  name: string
  model: string
}

interface PipelineStep {
  template_id: number
  template_name?: string
  on_failure: 'stop' | 'continue'
}

interface Pipeline {
  id: number
  name: string
  description: string | null
  steps: PipelineStep[]
  use_count: number
  last_used_at: number | null
  runs: { total: number; completed: number; failed: number; running: number }
}

interface RunStepState {
  step_index: number
  template_id: number
  template_name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  spawn_id: string | null
  started_at: number | null
  completed_at: number | null
  error: string | null
}

interface PipelineRun {
  id: number
  pipeline_id: number
  pipeline_name?: string
  status: string
  current_step: number
  steps_snapshot: RunStepState[]
  started_at: number | null
  completed_at: number | null
  triggered_by: string
  created_at: number
}

export function PipelineTab() {
  const t = useTranslations('pipeline')
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [runs, setRuns] = useState<PipelineRun[]>([])

  // Form state
  const [formMode, setFormMode] = useState<'hidden' | 'create' | 'edit'>('hidden')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formSteps, setFormSteps] = useState<PipelineStep[]>([])

  // UI state
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [spawning, setSpawning] = useState<number | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [draggedStepIndex, setDraggedStepIndex] = useState<number | null>(null)
  const [dragOverStepIndex, setDragOverStepIndex] = useState<number | null>(null)

  const fetchData = useCallback(async () => {
    const [tRes, pRes, rRes] = await Promise.all([
      fetch('/api/workflows').then(r => r.json()).catch(() => ({ templates: [] })),
      fetch('/api/pipelines').then(r => r.json()).catch(() => ({ pipelines: [] })),
      fetch('/api/pipelines/run?limit=10').then(r => r.json()).catch(() => ({ runs: [] })),
    ])
    setTemplates(tRes.templates || [])
    setPipelines(pRes.pipelines || [])
    setRuns(rRes.runs || [])
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Clear result after 3s
  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(null), 3000)
    return () => clearTimeout(timer)
  }, [result])

  const closeForm = () => {
    setFormMode('hidden')
    setEditingId(null)
    setFormName('')
    setFormDesc('')
    setFormSteps([])
  }

  const addStep = (templateId: number) => {
    const t = templates.find(t => t.id === templateId)
    if (!t) return
    setFormSteps(s => [...s, { template_id: templateId, template_name: t.name, on_failure: 'stop' }])
  }

  const removeStep = (index: number) => {
    setFormSteps(s => s.filter((_, i) => i !== index))
  }

  const moveStep = (index: number, dir: -1 | 1) => {
    setFormSteps(steps => reorderPipelineSteps(steps, index, index + dir))
  }

  const finishStepDrag = () => {
    setDraggedStepIndex(null)
    setDragOverStepIndex(null)
  }

  const savePipeline = async () => {
    if (!formName || formSteps.length < 2) return
    try {
      const payload = {
        ...(formMode === 'edit' ? { id: editingId } : {}),
        name: formName,
        description: formDesc || null,
        steps: formSteps.map(s => ({ template_id: s.template_id, on_failure: s.on_failure })),
      }
      const res = await fetch('/api/pipelines', {
        method: formMode === 'edit' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        closeForm()
        fetchData()
        setResult({ ok: true, text: formMode === 'edit' ? 'Pipeline updated' : 'Pipeline created' })
      } else {
        const data = await res.json()
        setResult({ ok: false, text: data.error || 'Failed' })
      }
    } catch {
      setResult({ ok: false, text: 'Network error' })
    }
  }

  const startEdit = (p: Pipeline) => {
    setFormMode('edit')
    setEditingId(p.id)
    setFormName(p.name)
    setFormDesc(p.description || '')
    setFormSteps(p.steps)
  }

  const deletePipeline = async (id: number) => {
    await fetch(`/api/pipelines?id=${id}`, { method: 'DELETE' })
    if (expandedId === id) setExpandedId(null)
    fetchData()
  }

  const runPipeline = async (id: number) => {
    setSpawning(id)
    try {
      const res = await fetch('/api/pipelines/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', pipeline_id: id }),
      })
      const data = await res.json()
      if (res.ok) {
        setResult({ ok: true, text: `Pipeline started (run #${data.run?.id})` })
        fetchData()
      } else {
        setResult({ ok: false, text: data.error || 'Failed to start' })
      }
    } catch {
      setResult({ ok: false, text: 'Network error' })
    } finally {
      setSpawning(null)
    }
  }

  const advanceRun = async (runId: number, success: boolean) => {
    try {
      await fetch('/api/pipelines/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'advance', run_id: runId, success }),
      })
      fetchData()
    } catch { /* ignore */ }
  }

  const cancelRun = async (runId: number) => {
    try {
      await fetch('/api/pipelines/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', run_id: runId }),
      })
      fetchData()
    } catch { /* ignore */ }
  }

  // Active runs (running pipelines shown at top)
  const activeRuns = runs.filter(r => r.status === 'running')

  return (
    <div className="space-y-3">
      {/* Result message */}
      {result && (
        <div className={`text-xs px-2 py-1 rounded ${result.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
          {result.text}
        </div>
      )}

      {/* Active runs banner */}
      {activeRuns.length > 0 && (
        <div className="space-y-2">
          {activeRuns.map(run => (
            <ActiveRunCard key={run.id} run={run} onAdvance={advanceRun} onCancel={cancelRun} />
          ))}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t('pipelineCount', { count: pipelines.length })}</span>
        <Button
          onClick={() => formMode !== 'hidden' ? closeForm() : setFormMode('create')}
          variant="link"
          size="xs"
        >
          {formMode !== 'hidden' ? t('cancel') : t('newPipeline')}
        </Button>
      </div>

      {/* Create/Edit form */}
      {formMode !== 'hidden' && (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-sm font-medium text-foreground">{formMode === 'edit' ? t('editPipeline') : t('newPipeline')}</span>
              <p className="mt-0.5 text-2xs text-muted-foreground">从模板添加节点，拖动卡片调整任务执行顺序。</p>
            </div>
            <span className="rounded-full bg-secondary px-2 py-1 text-2xs text-muted-foreground">{formSteps.length} 个节点</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder={t('pipelineNamePlaceholder')}
              className="h-9 w-full rounded-md border border-border bg-secondary px-3 text-sm text-foreground"
            />
            <input
              value={formDesc}
              onChange={e => setFormDesc(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
              className="h-9 w-full rounded-md border border-border bg-secondary px-3 text-sm text-foreground"
            />
          </div>

          {/* Step builder */}
          <div className="space-y-3 rounded-xl border border-border/70 bg-background/45 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">执行画布</span>
              <span className="text-2xs text-muted-foreground">拖动节点可排序；箭头按钮用于键盘操作</span>
            </div>
            {formSteps.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
                从下方选择工作流模板，添加第一个节点。
              </div>
            ) : (
              <div className="flex items-stretch gap-2 overflow-x-auto pb-2">
                {formSteps.map((step, i) => (
                  <div key={`${step.template_id}-${i}`} className="flex items-center gap-2 shrink-0">
                    <div
                      draggable
                      onDragStart={event => {
                        setDraggedStepIndex(i)
                        setDragOverStepIndex(i)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragOver={event => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        setDragOverStepIndex(i)
                      }}
                      onDrop={event => {
                        event.preventDefault()
                        if (draggedStepIndex !== null) {
                          setFormSteps(steps => reorderPipelineSteps(steps, draggedStepIndex, i))
                        }
                        finishStepDrag()
                      }}
                      onDragEnd={finishStepDrag}
                      className={`w-60 cursor-grab rounded-xl border bg-card p-3 shadow-sm transition-all active:cursor-grabbing ${
                        dragOverStepIndex === i && draggedStepIndex !== i
                          ? 'border-primary ring-2 ring-primary/20'
                          : 'border-border'
                      } ${draggedStepIndex === i ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-xs font-bold text-primary">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-foreground">{step.template_name || `Template #${step.template_id}`}</p>
                          <p className="mt-0.5 text-[10px] text-muted-foreground">模板 #{step.template_id}</p>
                        </div>
                        <span className="select-none text-sm tracking-[-2px] text-muted-foreground" title="拖动节点">⋮⋮</span>
                      </div>
                      <label className="mt-3 block text-2xs text-muted-foreground">
                        失败策略
                        <select
                          value={step.on_failure}
                          onChange={event => setFormSteps(steps => steps.map((item, index) => index === i
                            ? { ...item, on_failure: event.target.value as 'stop' | 'continue' }
                            : item))}
                          className="mt-1 h-7 w-full rounded border border-border bg-secondary px-2 text-xs text-foreground"
                        >
                          <option value="stop">{t('stopOnFail')}</option>
                          <option value="continue">{t('continueOnFail')}</option>
                        </select>
                      </label>
                      <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2">
                        <div className="flex gap-1">
                          <Button onClick={() => moveStep(i, -1)} disabled={i === 0} variant="ghost" size="icon-xs" title="向前移动">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M13 8H3M7 4L3 8l4 4" /></svg>
                          </Button>
                          <Button onClick={() => moveStep(i, 1)} disabled={i === formSteps.length - 1} variant="ghost" size="icon-xs" title="向后移动">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
                          </Button>
                        </div>
                        <Button onClick={() => removeStep(i)} variant="ghost" size="xs" className="text-red-400 hover:text-red-300">删除</Button>
                      </div>
                    </div>
                    {i < formSteps.length - 1 && (
                      <svg viewBox="0 0 24 14" fill="none" className="h-4 w-7 shrink-0 text-primary/60">
                        <path d="M1 7h19M16 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add step dropdown */}
            <select
              onChange={e => { if (e.target.value) { addStep(parseInt(e.target.value)); e.target.value = '' } }}
              className="h-9 w-full rounded-md border border-border bg-secondary px-3 text-xs text-muted-foreground"
              defaultValue=""
            >
              <option value="" disabled>{t('addStepPlaceholder')}</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({t.model})</option>
              ))}
            </select>
          </div>

          <div className="flex justify-end border-t border-border pt-3">
            <Button
              onClick={savePipeline}
              disabled={!formName || formSteps.length < 2}
              size="xs"
            >
              {formMode === 'edit' ? t('update') : t('savePipeline')}
            </Button>
          </div>
        </div>
      )}

      {/* Pipeline list */}
      {pipelines.length === 0 && formMode === 'hidden' ? (
        <div className="text-center py-4">
          <p className="text-sm text-muted-foreground mb-2">{t('noPipelines')}</p>
          <p className="text-xs text-muted-foreground">{t('noPipelinesHint')}</p>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {pipelines.map(p => (
            <div key={p.id} className="rounded-md bg-secondary/30 hover:bg-secondary/50 transition-smooth group">
              <div className="flex items-center gap-2 p-2">
                <Button
                  variant="ghost"
                  onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                  className="flex-1 min-w-0 text-left h-auto p-0 rounded-none"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">{p.name}</span>
                    <span className="text-2xs text-muted-foreground">{p.steps.length} steps</span>
                    {p.use_count > 0 && <span className="text-2xs text-muted-foreground">{p.use_count}x</span>}
                    {p.runs.running > 0 && (
                      <span className="text-2xs px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 animate-pulse">running</span>
                    )}
                  </div>
                  {/* Mini step visualization */}
                  <div className="flex items-center gap-0.5 mt-1">
                    {p.steps.map((s, i) => (
                      <div key={i} className="flex items-center gap-0.5">
                        <span className="text-2xs px-1 py-0.5 rounded bg-secondary text-muted-foreground truncate max-w-[80px]">
                          {s.template_name}
                        </span>
                        {i < p.steps.length - 1 && (
                          <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-2.5 h-2.5 text-muted-foreground/50 shrink-0">
                            <path d="M2 4h4M5 2l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                    ))}
                  </div>
                </Button>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-smooth shrink-0">
                  <Button
                    onClick={() => runPipeline(p.id)}
                    disabled={spawning === p.id}
                    size="xs"
                  >
                    {spawning === p.id ? '...' : 'Run'}
                  </Button>
                  <Button onClick={() => startEdit(p)} variant="secondary" size="icon-xs" title="Edit">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                      <path d="M11.5 1.5l3 3-9 9H2.5v-3z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Button>
                  <Button onClick={() => deletePipeline(p.id)} variant="destructive" size="icon-xs" title="Delete">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </Button>
                </div>
              </div>

              {/* Expanded: pipeline visualization + recent runs */}
              {expandedId === p.id && (
                <div className="px-3 pb-3 border-t border-border/50 mt-1 pt-2 space-y-3">
                  {/* Full pipeline visualization */}
                  <PipelineViz steps={p.steps} />

                  {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}

                  {/* Recent runs for this pipeline */}
                  <div>
                    <span className="text-2xs text-muted-foreground">
                      Runs: {p.runs.total} total, {p.runs.completed} completed, {p.runs.failed} failed
                    </span>
                    {runs.filter(r => r.pipeline_id === p.id).slice(0, 3).map(run => (
                      <div key={run.id} className="mt-1 p-2 rounded bg-secondary/50 text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium">Run #{run.id}</span>
                          <RunStatusBadge status={run.status} />
                        </div>
                        <RunStepsViz steps={run.steps_snapshot} />
                        {run.status === 'running' && (
                          <div className="flex gap-1 mt-1.5">
                            <Button onClick={() => advanceRun(run.id, true)} variant="success" size="xs" className="bg-green-500/20 text-green-400 hover:bg-green-500/30 h-6 text-2xs">
                              Mark Step Done
                            </Button>
                            <Button onClick={() => advanceRun(run.id, false)} variant="destructive" size="xs" className="bg-red-500/20 text-red-400 hover:bg-red-500/30 h-6 text-2xs">
                              Mark Step Failed
                            </Button>
                            <Button onClick={() => cancelRun(run.id)} variant="secondary" size="xs" className="h-6 text-2xs">
                              Cancel
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Full step visualization with boxes and arrows */
function PipelineViz({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-1 shrink-0">
          <div className="flex flex-col items-center gap-0.5">
            <div className="px-2 py-1.5 rounded-md border border-border bg-secondary text-xs font-medium text-foreground whitespace-nowrap">
              {s.template_name || `Step ${i + 1}`}
            </div>
            {s.on_failure === 'continue' && (
              <span className="text-2xs text-amber-400">continue on fail</span>
            )}
          </div>
          {i < steps.length - 1 && (
            <svg viewBox="0 0 20 12" fill="none" className="w-5 h-3 text-muted-foreground/60 shrink-0">
              <path d="M0 6h16M13 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      ))}
    </div>
  )
}

/** Run steps visualization with colored status dots */
function RunStepsViz({ steps }: { steps: RunStepState[] }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-1 shrink-0">
          <div className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              s.status === 'completed' ? 'bg-green-500' :
              s.status === 'running' ? 'bg-amber-500 animate-pulse' :
              s.status === 'failed' ? 'bg-red-500' :
              s.status === 'skipped' ? 'bg-gray-500' : 'bg-gray-600'
            }`} />
            <span className={`text-2xs whitespace-nowrap ${
              s.status === 'running' ? 'text-foreground font-medium' : 'text-muted-foreground'
            }`}>
              {s.template_name}
            </span>
          </div>
          {i < steps.length - 1 && (
            <svg viewBox="0 0 8 8" className="w-2 h-2 text-muted-foreground/40 shrink-0">
              <path d="M1 4h6M5 2l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      ))}
    </div>
  )
}

function RunStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: 'bg-amber-500/20 text-amber-400',
    completed: 'bg-green-500/20 text-green-400',
    failed: 'bg-red-500/20 text-red-400',
    cancelled: 'bg-gray-500/20 text-gray-400',
    pending: 'bg-primary/15 text-primary',
  }
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded-full ${styles[status] || 'bg-secondary text-muted-foreground'}`}>
      {status}
    </span>
  )
}

/** Active run card shown at top of pipeline tab */
function ActiveRunCard({ run, onAdvance, onCancel }: {
  run: PipelineRun
  onAdvance: (id: number, success: boolean) => void
  onCancel: (id: number) => void
}) {
  return (
    <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-xs font-medium text-foreground">
            {run.pipeline_name || `Pipeline #${run.pipeline_id}`} — Run #{run.id}
          </span>
        </div>
        <span className="text-2xs text-muted-foreground">
          Step {run.current_step + 1}/{run.steps_snapshot.length}
        </span>
      </div>
      <RunStepsViz steps={run.steps_snapshot} />
      <div className="flex gap-1 mt-2">
        <Button onClick={() => onAdvance(run.id, true)} variant="success" size="xs" className="bg-green-500/20 text-green-400 hover:bg-green-500/30 h-6 text-2xs">
          Step Done
        </Button>
        <Button onClick={() => onAdvance(run.id, false)} variant="destructive" size="xs" className="bg-red-500/20 text-red-400 hover:bg-red-500/30 h-6 text-2xs">
          Step Failed
        </Button>
        <Button onClick={() => onCancel(run.id)} variant="secondary" size="xs" className="h-6 text-2xs ml-auto">
          Cancel
        </Button>
      </div>
    </div>
  )
}
