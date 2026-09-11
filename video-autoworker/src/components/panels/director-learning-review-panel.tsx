'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

const REVIEW_ENDPOINT = '/api/n8n/director-extraction/review'

type ReviewDecision = 'approve' | 'reject'
type ReviewOutcome = 'completed' | 'conflict' | 'unknown'
type CandidateDecision = 'pending' | 'approved' | 'rejected' | 'unknown'
type DirectorLearningCandidateKind =
  | 'material_observation'
  | 'person_profile'
  | 'story_node'
  | 'story_relation'
  | 'material_judgment'
  | 'narrative_proposal'
  | 'director_case'
  | 'technique'

export interface DirectorLearningCandidate {
  candidateId: string
  kind: DirectorLearningCandidateKind
  title: string
  summary: string
  rationale: string
  confidence: number | null
  decision?: CandidateDecision
}

export interface DirectorLearningReview {
  reviewId: string
  reviewRevision: number
  workName: string
  phase: 'perception' | 'understanding' | 'judgment' | 'case' | 'technique'
  progress: number | null
  progressKnown: boolean
  pendingCount: number
  candidates: DirectorLearningCandidate[]
}

interface ReviewListResponse {
  ok: boolean
  action: 'list'
  reviews: DirectorLearningReview[]
  error?: string
}

interface ReviewMutationResponse {
  ok: boolean
  action: 'prepare' | 'confirm' | 'cancel'
  outcome?: ReviewOutcome
  batchId?: string
  confirmationCode?: string
  count?: number
  message?: string
  error?: string
}

interface PendingConfirmation {
  review: DirectorLearningReview
  decision: ReviewDecision
  candidateIds: string[]
  titles: string[]
  requestId: string
  batchId: string
  confirmationCode: string
  count: number
  state: 'ready' | 'uncertain' | 'confirmed'
}

interface Feedback {
  tone: 'success' | 'warning'
  message: string
}

const PHASE_LABELS: Record<DirectorLearningReview['phase'], string> = {
  perception: '素材感知',
  understanding: '人物与故事理解',
  judgment: '导演判断',
  case: '导演案例',
  technique: '技法提炼',
}

const KIND_LABELS: Record<DirectorLearningCandidateKind, string> = {
  material_observation: '素材证据',
  person_profile: '人物档案',
  story_node: '故事节点',
  story_relation: '故事关系',
  material_judgment: '素材判断',
  narrative_proposal: '叙事方案',
  director_case: '导演案例',
  technique: '导演技法',
}

const KIND_ORDER = Object.keys(KIND_LABELS) as DirectorLearningCandidateKind[]

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `review-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function messageFrom(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const message = typeof record.message === 'string' ? record.message : record.error
    if (typeof message === 'string' && message.trim()) {
      const normalized = message.trim()
      if (!/^[A-Za-z0-9_:-]{1,200}$/u.test(normalized)) return normalized
    }
  }
  return fallback
}

function confidenceLabel(value: number | null): string {
  if (value === null) return '未记录'
  if (!Number.isFinite(value)) return '未记录'
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function decisionLabel(value: CandidateDecision | undefined): string | null {
  if (!value || value === 'pending') return null
  if (value === 'approved') return '已批准'
  if (value === 'rejected') return '已驳回'
  return '结果待确认'
}

export function DirectorLearningReviewPanel({
  onPendingCountChange,
}: {
  onPendingCountChange?: (count: number) => void
}) {
  const [reviews, setReviews] = useState<DirectorLearningReview[]>([])
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [requiresReadback, setRequiresReadback] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const requestSequence = useRef(0)
  const preparingRef = useRef(false)
  const submittingRef = useRef(false)
  const confirmationRef = useRef<HTMLDivElement>(null)

  const loadReviews = useCallback(async (quiet = false, unlockOnSuccess = false) => {
    const sequence = ++requestSequence.current
    if (quiet) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const response = await fetch(REVIEW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ action: 'list' }),
      })
      const body = await response.json().catch(() => null) as ReviewListResponse | null
      if (!response.ok || !body?.ok || body.action !== 'list' || !Array.isArray(body.reviews)) {
        throw new Error(messageFrom(body, '无法读取学习审核列表'))
      }
      if (sequence !== requestSequence.current) return
      const nextReviews = body.reviews
      setReviews(nextReviews)
      setRequiresReadback(false)
      if (unlockOnSuccess) setConfirmation(null)
      const pending = nextReviews.reduce((sum, review) => sum + Math.max(0, review.pendingCount), 0)
      onPendingCountChange?.(pending)
      setSelectedReviewId(current => (
        current && nextReviews.some(review => review.reviewId === current)
          ? current
          : nextReviews[0]?.reviewId || null
      ))
    } catch (loadError) {
      if (sequence !== requestSequence.current) return
      setError(loadError instanceof Error ? loadError.message : '无法读取学习审核列表')
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [onPendingCountChange])

  useEffect(() => {
    void loadReviews()
  }, [loadReviews])

  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus()
  }, [confirmation])

  const selectedReview = useMemo(
    () => reviews.find(review => review.reviewId === selectedReviewId) || reviews[0] || null,
    [reviews, selectedReviewId],
  )

  const groups = useMemo(() => {
    const candidates = selectedReview?.candidates || []
    return KIND_ORDER.map(kind => ({
      kind,
      title: KIND_LABELS[kind],
      candidates: candidates.filter(item => item.kind === kind),
    })).filter(group => group.candidates.length > 0)
  }, [selectedReview?.candidates])

  const prepareReview = async (
    review: DirectorLearningReview,
    decision: ReviewDecision,
    candidates: DirectorLearningCandidate[],
  ) => {
    if (preparingRef.current || submittingRef.current || confirmation
      || requiresReadback || candidates.length === 0) return
    const requestId = createRequestId()
    const candidateIds = candidates.map(candidate => candidate.candidateId)
    preparingRef.current = true
    setPreparing(true)
    setFeedback(null)
    setError(null)
    try {
      const response = await fetch(REVIEW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'prepare', requestId, reviewId: review.reviewId,
          reviewRevision: review.reviewRevision, decision, candidateIds,
        }),
      })
      const body = await response.json().catch(() => null) as ReviewMutationResponse | null
      if (!response.ok || !body?.ok || body.action !== 'prepare'
        || typeof body.batchId !== 'string' || !body.batchId
        || typeof body.confirmationCode !== 'string' || !body.confirmationCode
        || body.count !== candidateIds.length) {
        const outcome = body?.outcome || (response.status === 409 ? 'conflict' : 'unknown')
        setFeedback({
          tone: 'warning',
          message: outcome === 'conflict'
            ? messageFrom(body, '候选已发生变化，本次没有进入确认。请刷新后重新审核。')
            : messageFrom(body, '暂时无法固定审核批次。请刷新后再试。'),
        })
        setRequiresReadback(true)
        return
      }
      setRequiresReadback(false)
      setConfirmation({
        review, decision, candidateIds, requestId,
        titles: candidates.map(candidate => candidate.title),
        batchId: body.batchId, confirmationCode: body.confirmationCode,
        count: body.count, state: 'ready',
      })
    } catch {
      setFeedback({ tone: 'warning', message: '暂时无法固定审核批次。请刷新后再试。' })
      setRequiresReadback(true)
    } finally {
      preparingRef.current = false
      setPreparing(false)
    }
  }

  const confirmReview = async () => {
    if (!confirmation || submittingRef.current) return
    const current = confirmation
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch(REVIEW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'confirm',
          requestId: current.requestId,
          reviewId: current.review.reviewId,
          reviewRevision: current.review.reviewRevision,
          decision: current.decision,
          candidateIds: current.candidateIds,
          batchId: current.batchId,
          confirmationCode: current.confirmationCode,
          count: current.count,
        }),
      })
      const body = await response.json().catch(() => null) as ReviewMutationResponse | null
      const outcome: ReviewOutcome = body?.outcome
        || (response.status === 409 ? 'conflict' : 'unknown')
      if (outcome === 'completed' && response.ok && body?.ok) {
        setFeedback({
          tone: 'success',
          message: body.message || `已${current.decision === 'approve' ? '批准' : '驳回'} ${current.candidateIds.length} 条候选，并完成回读。`,
        })
        setConfirmation({ ...current, state: 'confirmed' })
        await loadReviews(true, true)
        return
      }
      if (outcome === 'conflict') {
        setFeedback({
          tone: 'warning',
          message: messageFrom(body, '候选已发生变化，本次没有继续写入。请刷新后重新审核。'),
        })
        setConfirmation(null)
        await loadReviews(true, true)
        return
      }
      setFeedback({
        tone: 'warning',
        message: messageFrom(body, '审核结果暂时无法确认。请先刷新回读，不要重复提交。'),
      })
      setConfirmation({ ...current, state: 'uncertain' })
    } catch {
      setFeedback({
        tone: 'warning',
        message: '审核结果暂时无法确认。请先刷新回读，不要重复提交。',
      })
      setConfirmation({ ...current, state: 'uncertain' })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const cancelConfirmation = useCallback(async () => {
    const current = confirmation
    if (!current || current.state !== 'ready' || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    let cancelKnown = false
    try {
      const response = await fetch(REVIEW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cancel',
          batchId: current.batchId,
          confirmationCode: current.confirmationCode,
        }),
      })
      const body = await response.json().catch(() => null) as ReviewMutationResponse | null
      cancelKnown = response.ok && body?.ok === true && body.action === 'cancel'
    } catch {
      // Closing a local confirmation never claims that the persisted batch was cancelled.
    } finally {
      setConfirmation(null)
      if (!cancelKnown) {
        setFeedback({ tone: 'warning', message: '取消结果暂时无法确认。请刷新后再继续审核。' })
        setRequiresReadback(true)
      }
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [confirmation])

  useEffect(() => {
    if (!confirmation || confirmation.state !== 'ready') return undefined
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submittingRef.current) return
      event.preventDefault()
      void cancelConfirmation()
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [cancelConfirmation, confirmation])

  return (
    <section className="@container min-h-[32rem] rounded-lg border border-border bg-card" aria-label="学习审核">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">学习审核</h2>
          <p className="mt-1 text-xs text-muted-foreground">在平台内复核提炼候选；选择操作并确认后才会提交。</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadReviews(true, Boolean(confirmation) || requiresReadback)}
          disabled={loading || refreshing || preparing || submitting || confirmation?.state === 'ready'}
        >
          {refreshing ? '刷新中...' : '刷新'}
        </Button>
      </div>

      {feedback && (
        <div
          role="status"
          className={`mx-4 mt-4 rounded-md border px-3 py-2 text-sm ${
            feedback.tone === 'success'
              ? 'border-success/25 bg-success/10 text-success'
              : 'border-warning/30 bg-warning/10 text-warning'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {error && (
        <div role="alert" className="mx-4 mt-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {confirmation && (
        <div
          ref={confirmationRef}
          role="dialog"
          tabIndex={-1}
          aria-label={`确认${confirmation.decision === 'approve' ? '批准' : '驳回'}候选`}
          className="mx-4 mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4 outline-none focus:ring-2 focus:ring-primary/25"
        >
          <h3 className="text-sm font-semibold text-foreground">
            确认{confirmation.decision === 'approve' ? '批准' : '驳回'} {confirmation.candidateIds.length} 条候选？
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {confirmation.titles.slice(0, 3).join('、')}
            {confirmation.titles.length > 3 ? ` 等 ${confirmation.titles.length} 条` : ''}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {confirmation.state === 'ready'
              ? '批次已固定。系统会在确认时再次核对审核版本；候选已变化时将停止。'
              : confirmation.state === 'confirmed'
                ? '审核已提交，正在等待列表回读。回读完成前不会接受新的审核操作。'
                : '上次确认结果暂时未知。请使用同一批次继续核对，或刷新当前状态。'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void confirmReview()} disabled={submitting || refreshing}>
              {submitting
                ? '提交中...'
                : confirmation.state === 'ready'
                  ? `确认${confirmation.decision === 'approve' ? '批准' : '驳回'}`
                  : '继续核对'}
            </Button>
            {confirmation.state === 'ready' ? (
              <Button variant="outline" size="sm" onClick={() => void cancelConfirmation()} disabled={submitting}>取消</Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void loadReviews(true, true)} disabled={submitting || refreshing}>
                {refreshing ? '刷新中...' : '刷新'}
              </Button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="px-5 py-12 text-center text-sm text-muted-foreground">正在读取待审核内容...</div>
      ) : reviews.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <h3 className="text-sm font-semibold text-foreground">暂无待审核候选</h3>
          <p className="mt-1 text-xs text-muted-foreground">新的学习阶段完成后会出现在这里。</p>
        </div>
      ) : (
        <div className="grid min-h-0 grid-cols-1 @4xl:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="border-b border-border p-3 @4xl:border-b-0 @4xl:border-r" aria-label="待审核作品">
            <div className="space-y-2">
              {reviews.map(review => (
                <button
                  key={review.reviewId}
                  type="button"
                  aria-pressed={review.reviewId === selectedReview?.reviewId}
                  onClick={() => {
                    if (preparing || submitting || confirmation || requiresReadback) return
                    setSelectedReviewId(review.reviewId)
                    setFeedback(null)
                  }}
                  disabled={preparing || submitting || Boolean(confirmation) || requiresReadback}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${
                    review.reviewId === selectedReview?.reviewId
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-border bg-background/30 hover:border-primary/20 hover:bg-background/60'
                  }`}
                >
                  <p className="truncate text-sm font-medium text-foreground">{review.workName}</p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{PHASE_LABELS[review.phase]}</span>
                    <span>{review.pendingCount} 条待审核</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          {selectedReview && (
            <div className="min-w-0 p-3.5 md:p-4">
              <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-foreground">{selectedReview.workName}</h3>
                    <span className="rounded border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{PHASE_LABELS[selectedReview.phase]}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    真实进度：{selectedReview.progressKnown && selectedReview.progress !== null ? `${selectedReview.progress}%` : '暂不可确定'} · 待审核 {selectedReview.pendingCount} 条
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void prepareReview(
                    selectedReview,
                    'approve',
                    selectedReview.candidates.filter(candidate => !candidate.decision || candidate.decision === 'pending'),
                  )}
                  disabled={preparing || submitting || Boolean(confirmation) || requiresReadback
                    || selectedReview.pendingCount === 0}
                >
                  {preparing ? '准备中...' : '全部批准'}
                </Button>
              </div>

              <div className="mt-4 space-y-5">
                {groups.map(group => (
                  <section key={group.kind} aria-label={group.title}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-foreground">{group.title}</h4>
                      <span className="text-xs text-muted-foreground">{group.candidates.length} 条</span>
                    </div>
                    <div className="grid gap-3 xl:grid-cols-2">
                      {group.candidates.map(candidate => {
                        const reviewedLabel = decisionLabel(candidate.decision)
                        const pending = !candidate.decision || candidate.decision === 'pending'
                        return (
                          <article key={candidate.candidateId} className="rounded-lg border border-border bg-background/35 p-4">
                            <div className="flex items-start justify-between gap-3">
                              <h5 className="text-sm font-semibold leading-5 text-foreground">{candidate.title}</h5>
                              <span className="flex-none rounded border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
                                置信度 {confidenceLabel(candidate.confidence)}
                              </span>
                            </div>
                            <div className="mt-3 space-y-3 text-sm leading-6">
                              <div>
                                <p className="text-xs text-muted-foreground">摘要</p>
                                <p className="mt-0.5 whitespace-pre-wrap text-foreground">{candidate.summary}</p>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground">判断依据</p>
                                <p className="mt-0.5 whitespace-pre-wrap text-foreground/85">{candidate.rationale}</p>
                              </div>
                            </div>
                            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                              {reviewedLabel ? (
                                <span className="text-xs text-muted-foreground">{reviewedLabel}</span>
                              ) : (
                                <>
                                  <Button
                                    size="xs"
                                    onClick={() => void prepareReview(selectedReview, 'approve', [candidate])}
                                    disabled={preparing || submitting || Boolean(confirmation)
                                      || requiresReadback || !pending}
                                    aria-label={`批准：${candidate.title}`}
                                  >
                                    批准
                                  </Button>
                                  <Button
                                    variant="destructive"
                                    size="xs"
                                    onClick={() => void prepareReview(selectedReview, 'reject', [candidate])}
                                    disabled={preparing || submitting || Boolean(confirmation)
                                      || requiresReadback || !pending}
                                    aria-label={`驳回：${candidate.title}`}
                                  >
                                    驳回
                                  </Button>
                                </>
                              )}
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
