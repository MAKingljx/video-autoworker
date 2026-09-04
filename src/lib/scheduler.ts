import { getDatabase, logAuditEvent } from './db'
import { syncAgentsFromConfig } from './agent-sync'
import { config, ensureDirExists } from './config'
import { join, dirname } from 'path'
import { readdirSync, statSync, unlinkSync } from 'fs'
import { logger } from './logger'
import { processWebhookRetries } from './webhooks'
import { syncClaudeSessions } from './claude-sessions'
import { pruneGatewaySessionsOlderThan, getAgentLiveStatuses } from './openclaw-session-source'
import { eventBus } from './event-bus'
import { syncSkillsFromDisk } from './skill-sync'
import { syncLocalAgents } from './local-agent-sync'
import { dispatchAssignedTasks, runAegisReviews, requeueStaleTasks, autoRouteInboxTasks } from './task-dispatch'
import { spawnRecurringTasks } from './recurring-tasks'
import { drainN8nMediaCleanupDebts } from './n8n-media-cleanup'
import { drainDirectorEvidenceOutbox } from './director-evidence-outbox'
import { drainDirectorExtractionJobs } from './director-extraction-service'
import {
  acquireOrRenewSchedulerLeadership,
  createSchedulerHolderId,
  getSchedulerRuntimeEligibility,
  isMultiInstanceSchedulerRuntime,
  relinquishSchedulerLeadership,
  renewSchedulerLeadership,
  type SchedulerLeadershipResult,
} from './scheduler-leader'

const BACKUP_DIR = join(dirname(config.dbPath), 'backups')

interface ScheduledTask {
  name: string
  intervalMs: number
  lastRun: number | null
  nextRun: number
  enabled: boolean
  running: boolean
  lastResult?: { ok: boolean; message: string; timestamp: number }
}

const tasks: Map<string, ScheduledTask> = new Map()
const SCHEDULER_TASK_IDS = new Set([
  'auto_backup',
  'auto_cleanup',
  'media_cleanup_debt',
  'director_evidence_outbox',
  'agent_heartbeat',
  'webhook_retry',
  'claude_session_scan',
  'skill_sync',
  'local_agent_sync',
  'gateway_agent_sync',
  'task_dispatch',
  'aegis_review',
  'recurring_task_spawn',
  'stale_task_requeue',
])
let tickInterval: ReturnType<typeof setInterval> | null = null
let leadershipHeartbeatInterval: ReturnType<typeof setInterval> | null = null
const schedulerHolderId = createSchedulerHolderId()
const runningJobIds = new Set<string>()
let tickRunning = false
let schedulerStopping = false
let heldLeaseRevision: number | null = null

export type SchedulerLeadershipStatus = {
  state: 'unknown' | 'leader' | 'follower' | 'inactive' | 'unavailable'
  leaseExpiresAt: number | null
  leaseExpired: boolean
  observedAt: number
  reason: string
  routerGeneration: number | null
  activeJobs: number
}

let leadershipStatus: SchedulerLeadershipStatus = {
  state: 'unknown',
  leaseExpiresAt: null,
  leaseExpired: false,
  observedAt: Math.floor(Date.now() / 1000),
  reason: 'not_initialized',
  routerGeneration: null,
  activeJobs: 0,
}

const LEADERSHIP_HEARTBEAT_MS = 5_000

function publishLeadershipStatus(
  next: Omit<SchedulerLeadershipStatus, 'leaseExpired' | 'observedAt' | 'activeJobs'>,
): void {
  const observedAt = Math.floor(Date.now() / 1000)
  const previousState = leadershipStatus.state
  leadershipStatus = {
    ...next,
    leaseExpired: next.leaseExpiresAt !== null && next.leaseExpiresAt <= observedAt,
    observedAt,
    activeJobs: runningJobIds.size,
  }
  if (next.state !== previousState) {
    if (next.state === 'leader') {
      logger.info('Built-in scheduler leadership acquired')
    } else if (next.state === 'follower') {
      logger.info('Built-in scheduler is standing by behind another process')
    } else if (next.state === 'inactive') {
      logger.info('Built-in scheduler is passive because this router slot is inactive')
    }
  }
}

function recordLeaseResult(
  result: SchedulerLeadershipResult,
  reason: string,
  routerGeneration: number | null,
): boolean {
  heldLeaseRevision = result.isLeader && result.mode === 'lease' ? result.revision : null
  publishLeadershipStatus({
    state: result.isLeader ? 'leader' : 'follower',
    leaseExpiresAt: result.leaseExpiresAt,
    reason,
    routerGeneration,
  })
  return result.isLeader
}

function releaseHeldLeadership(reason: string, routerGeneration: number | null): boolean {
  try {
    if (heldLeaseRevision !== null) {
      relinquishSchedulerLeadership(getDatabase(), {
        holderId: schedulerHolderId,
        revision: heldLeaseRevision,
      })
    }
    heldLeaseRevision = null
    publishLeadershipStatus({
      state: 'inactive',
      leaseExpiresAt: null,
      reason,
      routerGeneration,
    })
    return true
  } catch (err) {
    logger.warn({ err }, 'Built-in scheduler lease release failed; heartbeat will retry')
    publishLeadershipStatus({
      state: 'unavailable',
      leaseExpiresAt: leadershipStatus.leaseExpiresAt,
      reason: 'lease_release_unavailable',
      routerGeneration,
    })
    return false
  }
}

/**
 * Reconcile router eligibility and the SQLite lease. While a job is running,
 * the old slot keeps renewing even after an atomic router switch. It releases
 * only after its final local job settles, preventing planned handoff overlap.
 */
function reconcileSchedulerLeadership(): boolean {
  const eligibility = getSchedulerRuntimeEligibility()
  try {
    if (heldLeaseRevision !== null) {
      if (!eligibility.eligible && runningJobIds.size === 0) {
        releaseHeldLeadership(eligibility.reason, eligibility.generation)
        return false
      }

      const renewed = renewSchedulerLeadership(getDatabase(), {
        holderId: schedulerHolderId,
        revision: heldLeaseRevision,
      })
      const isLeader = recordLeaseResult(
        renewed,
        eligibility.eligible ? eligibility.reason : 'draining_running_jobs',
        eligibility.generation,
      )
      // An inactive slot may retain and renew the lease only so its already
      // running jobs can drain without overlapping the new slot. Renewal is
      // not permission to start another scheduled or manually triggered job.
      return isLeader && eligibility.eligible
    }

    if (!eligibility.eligible) {
      publishLeadershipStatus({
        state: 'inactive',
        leaseExpiresAt: null,
        reason: eligibility.reason,
        routerGeneration: eligibility.generation,
      })
      return false
    }

    const result = acquireOrRenewSchedulerLeadership(getDatabase(), {
      holderId: schedulerHolderId,
      allowMissingTableForSingleInstance: !isMultiInstanceSchedulerRuntime(),
    })
    return recordLeaseResult(result, eligibility.reason, eligibility.generation)
  } catch (err) {
    if (leadershipStatus.state !== 'unavailable') {
      logger.warn({ err }, 'Built-in scheduler leadership unavailable; scheduler work is disabled')
    }
    publishLeadershipStatus({
      state: 'unavailable',
      leaseExpiresAt: leadershipStatus.leaseExpiresAt,
      reason: 'lease_unavailable',
      routerGeneration: eligibility.generation,
    })
    return false
  }
}

export function getSchedulerLeadershipStatus(): SchedulerLeadershipStatus {
  const now = Math.floor(Date.now() / 1000)
  return {
    ...leadershipStatus,
    leaseExpired: leadershipStatus.leaseExpiresAt !== null
      && leadershipStatus.leaseExpiresAt <= now,
    activeJobs: runningJobIds.size,
  }
}

function finishSchedulerStopIfIdle(): void {
  if (!schedulerStopping || runningJobIds.size > 0) return
  if (!releaseHeldLeadership('scheduler_stopped', leadershipStatus.routerGeneration)) return
  if (leadershipHeartbeatInterval) {
    clearInterval(leadershipHeartbeatInterval)
    leadershipHeartbeatInterval = null
  }
}

function heartbeatSchedulerLeadership(): void {
  if (schedulerStopping && runningJobIds.size === 0) {
    finishSchedulerStopIfIdle()
    return
  }
  reconcileSchedulerLeadership()
}

async function runTrackedSchedulerJob(
  taskId: string,
  work: () => Promise<{ ok: boolean; message: string }>,
): Promise<{ ok: boolean; message: string }> {
  if (runningJobIds.has(taskId)) {
    return { ok: false, message: `Scheduler task already running: ${taskId}` }
  }
  runningJobIds.add(taskId)
  try {
    return await work()
  } finally {
    runningJobIds.delete(taskId)
    if (schedulerStopping) finishSchedulerStopIfIdle()
    else reconcileSchedulerLeadership()
  }
}

function startNonBlockingScheduledTask(
  taskId: string,
  task: ScheduledTask,
  startedAt: number,
): void {
  task.running = true
  void runTrackedSchedulerJob(taskId, () => executeScheduledTask(taskId))
    .then((result) => {
      task.lastResult = { ...result, timestamp: startedAt }
    })
    .catch((err: unknown) => {
      task.lastResult = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        timestamp: startedAt,
      }
    })
    .finally(() => {
      task.running = false
      task.lastRun = startedAt
      task.nextRun = startedAt + task.intervalMs
    })
}

/** Check if a setting is enabled (reads from settings table, falls back to default) */
function isSettingEnabled(key: string, defaultValue: boolean): boolean {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (row) return row.value === 'true'
    return defaultValue
  } catch {
    return defaultValue
  }
}

function getSettingNumber(key: string, defaultValue: number): number {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (row) return parseInt(row.value) || defaultValue
    return defaultValue
  } catch {
    return defaultValue
  }
}

/** Run a database backup */
async function runBackup(): Promise<{ ok: boolean; message: string }> {
  ensureDirExists(BACKUP_DIR)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const backupPath = join(BACKUP_DIR, `mc-backup-${timestamp}.db`)

  try {
    const db = getDatabase()
    await db.backup(backupPath)

    const stat = statSync(backupPath)
    logAuditEvent({
      action: 'auto_backup',
      actor: 'scheduler',
      detail: { path: backupPath, size: stat.size },
    })

    // Prune old backups
    const maxBackups = getSettingNumber('general.backup_retention_count', 10)
    try {
      const files = readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('mc-backup-') && f.endsWith('.db'))
        .map(f => ({ name: f, mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)

      for (const file of files.slice(maxBackups)) {
        unlinkSync(join(BACKUP_DIR, file.name))
      }
    } catch {
      // Best-effort pruning
    }

    const sizeKB = Math.round(stat.size / 1024)
    return { ok: true, message: `Backup created (${sizeKB}KB)` }
  } catch (err: any) {
    return { ok: false, message: `Backup failed: ${err.message}` }
  }
}

/** Run data cleanup based on retention settings */
async function runCleanup(): Promise<{ ok: boolean; message: string }> {
  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    const ret = config.retention
    let totalDeleted = 0

    const targets = [
      { table: 'activities', column: 'created_at', days: ret.activities },
      { table: 'audit_log', column: 'created_at', days: ret.auditLog },
      { table: 'notifications', column: 'created_at', days: ret.notifications },
      { table: 'pipeline_runs', column: 'created_at', days: ret.pipelineRuns },
    ]

    for (const { table, column, days } of targets) {
      if (days <= 0) continue
      const cutoff = now - days * 86400
      try {
        const res = db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff)
        totalDeleted += res.changes
      } catch {
        // Table might not exist
      }
    }

    // Clean token usage file
    if (ret.tokenUsage > 0) {
      try {
        const { readFile, writeFile } = require('fs/promises')
        const raw = await readFile(config.tokensPath, 'utf-8')
        const data = JSON.parse(raw)
        const cutoffMs = Date.now() - ret.tokenUsage * 86400000
        const kept = data.filter((r: any) => r.timestamp >= cutoffMs)
        const removed = data.length - kept.length

        if (removed > 0) {
          await writeFile(config.tokensPath, JSON.stringify(kept, null, 2))
          totalDeleted += removed
        }
      } catch {
        // No token file
      }
    }

    if (ret.gatewaySessions > 0) {
      const sessionCleanup = pruneGatewaySessionsOlderThan(ret.gatewaySessions)
      totalDeleted += sessionCleanup.deleted
    }

    if (totalDeleted > 0) {
      logAuditEvent({
        action: 'auto_cleanup',
        actor: 'scheduler',
        detail: { total_deleted: totalDeleted },
      })
    }

    return { ok: true, message: `Cleaned ${totalDeleted} stale record${totalDeleted === 1 ? '' : 's'}` }
  } catch (err: any) {
    return { ok: false, message: `Cleanup failed: ${err.message}` }
  }
}

/** Retry only durable, terminal-state-bound media cleanup obligations. */
async function runMediaCleanupDebtJanitor(): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await drainN8nMediaCleanupDebts(getDatabase(), { limit: 20 })
    if (result.scanned > 0) {
      try {
        logAuditEvent({
          action: 'n8n_media_cleanup_debt_retry',
          actor: 'scheduler',
          detail: result,
        })
      } catch {
        // Cleanup results are already durable; audit failure does not retry them.
      }
    }
    return {
      ok: result.rejected === 0,
      message: `Media cleanup debts: ${result.cleaned} cleared, ${result.pending} pending, ${result.rejected} rejected`,
    }
  } catch (err: any) {
    return { ok: false, message: `Media cleanup debt janitor failed: ${err.message}` }
  }
}

/** Project evidence, then advance the same task-run extraction chain. */
async function runDirectorEvidenceAndExtractionDrain(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const nowSeconds = Math.floor(Date.now() / 1_000)
  let evidence: Awaited<ReturnType<typeof drainDirectorEvidenceOutbox>> | null = null
  let extraction: Awaited<ReturnType<typeof drainDirectorExtractionJobs>> | null = null
  let evidenceFailed = false
  let extractionFailed = false
  try {
    evidence = await drainDirectorEvidenceOutbox(db, { limit: 20, nowSeconds })
    if (evidence.scanned > 0) {
      try {
        logAuditEvent({
          action: 'n8n_director_evidence_projection',
          actor: 'scheduler',
          detail: evidence,
        })
      } catch {
        // Projection state is already durable; audit failure must not replay it.
      }
    }
  } catch {
    evidenceFailed = true
  }
  try {
    extraction = await drainDirectorExtractionJobs(db, { limit: 5, nowSeconds })
    if (extraction.processed > 0 || extraction.reviewsChecked > 0) {
      try {
        logAuditEvent({
          action: 'n8n_director_extraction_drain',
          actor: 'scheduler',
          detail: extraction,
        })
      } catch {
        // Extraction receipts are already durable; audit failure must not replay them.
      }
    }
  } catch {
    extractionFailed = true
  }
  const evidenceMessage = evidence
    ? `${evidence.delivered} delivered, ${evidence.pending} pending, ${evidence.conflict} conflict`
    : 'failed'
  const extractionMessage = extraction
    ? `${extraction.processed} processed, ${extraction.resumed} resumed, ${extraction.failed} failed`
    : 'failed'
  return {
    ok: !evidenceFailed && !extractionFailed
      && evidence?.conflict === 0 && extraction?.failed === 0,
    message: `Director evidence: ${evidenceMessage} | extraction: ${extractionMessage}`,
  }
}

/** Check agent liveness - mark agents offline if not seen recently */
async function runHeartbeatCheck(): Promise<{ ok: boolean; message: string }> {
  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    const timeoutMinutes = getSettingNumber('general.agent_timeout_minutes', 10)
    const threshold = now - timeoutMinutes * 60

    // Find agents that are not offline but haven't been seen recently
    const staleAgents = db.prepare(`
      SELECT id, name, status, last_seen FROM agents
      WHERE status != 'offline' AND (last_seen IS NULL OR last_seen < ?)
    `).all(threshold) as Array<{ id: number; name: string; status: string; last_seen: number | null }>

    if (staleAgents.length === 0) {
      return { ok: true, message: 'All agents healthy' }
    }

    // Mark stale agents as offline
    const markOffline = db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?')
    const logActivity = db.prepare(`
      INSERT INTO activities (type, entity_type, entity_id, actor, description)
      VALUES ('agent_status_change', 'agent', ?, 'heartbeat', ?)
    `)

    const names: string[] = []
    db.transaction(() => {
      for (const agent of staleAgents) {
        markOffline.run('offline', now, agent.id)
        logActivity.run(agent.id, `Agent "${agent.name}" marked offline (no heartbeat for ${timeoutMinutes}m)`)
        names.push(agent.name)

        // Create notification for each stale agent
        try {
          db.prepare(`
            INSERT INTO notifications (recipient, type, title, message, source_type, source_id)
            VALUES ('system', 'heartbeat', ?, ?, 'agent', ?)
          `).run(
            `Agent offline: ${agent.name}`,
            `Agent "${agent.name}" was marked offline after ${timeoutMinutes} minutes without heartbeat`,
            agent.id
          )
        } catch { /* notification creation failed */ }
      }
    })()

    logAuditEvent({
      action: 'heartbeat_check',
      actor: 'scheduler',
      detail: { marked_offline: names },
    })

    return { ok: true, message: `Marked ${staleAgents.length} agent(s) offline: ${names.join(', ')}` }
  } catch (err: any) {
    return { ok: false, message: `Heartbeat check failed: ${err.message}` }
  }
}

/** Sync live agent statuses from gateway session files into the DB */
async function syncAgentLiveStatuses(): Promise<number> {
  const liveStatuses = getAgentLiveStatuses()
  if (liveStatuses.size === 0) return 0

  const db = getDatabase()
  const agents = db.prepare('SELECT id, name, config FROM agents').all() as Array<{
    id: number; name: string; config: string | null
  }>

  const update = db.prepare('UPDATE agents SET status = ?, last_seen = ?, last_activity = ?, updated_at = ? WHERE id = ?')
  let refreshed = 0

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  db.transaction(() => {
    for (const agent of agents) {
      // Match by agent name or openclawId from config
      let openclawId: string | null = null
      if (agent.config) {
        try {
          const cfg = JSON.parse(agent.config)
          if (typeof cfg.openclawId === 'string' && cfg.openclawId.trim()) {
            openclawId = cfg.openclawId.trim()
          }
        } catch { /* ignore */ }
      }

      const candidates = [openclawId, agent.name].filter(Boolean).map(s => normalize(s!))
      let matched: { status: 'active' | 'idle' | 'offline'; lastActivity: number; channel: string } | undefined

      for (const [sessionAgent, info] of liveStatuses) {
        if (candidates.includes(normalize(sessionAgent))) {
          matched = info
          break
        }
      }

      if (!matched || matched.status === 'offline') continue

      const now = Math.floor(Date.now() / 1000)
      const activity = `Gateway session (${matched.channel || 'unknown'})`
      update.run(matched.status, now, activity, now, agent.id)
      refreshed++

      eventBus.broadcast('agent.status_changed', {
        id: agent.id,
        name: agent.name,
        status: matched.status,
        last_seen: now,
        last_activity: activity,
      })
    }
  })()

  return refreshed
}

async function executeScheduledTask(
  taskId: string,
  source: 'manual' | 'scheduled' = 'scheduled',
): Promise<{ ok: boolean; message: string }> {
  if (taskId === 'auto_backup') return runBackup()
  if (taskId === 'auto_cleanup') return runCleanup()
  if (taskId === 'media_cleanup_debt') return runMediaCleanupDebtJanitor()
  if (taskId === 'director_evidence_outbox') return runDirectorEvidenceAndExtractionDrain()
  if (taskId === 'agent_heartbeat') return runHeartbeatCheck()
  if (taskId === 'webhook_retry') return processWebhookRetries()
  if (taskId === 'claude_session_scan') return syncClaudeSessions()
  if (taskId === 'skill_sync') return syncSkillsFromDisk()
  if (taskId === 'local_agent_sync') return syncLocalAgents()
  if (taskId === 'gateway_agent_sync') {
    return syncAgentsFromConfig(source).then(async (result) => {
      const refreshed = await syncAgentLiveStatuses()
      return {
        ok: true,
        message: `Gateway sync: ${result.created} created, ${result.updated} updated, ${result.synced} total | Live status: ${refreshed} refreshed`,
      }
    })
  }
  if (taskId === 'task_dispatch') {
    return autoRouteInboxTasks().then(async (routeResult) => {
      const dispatchResult = await dispatchAssignedTasks()
      const parts = [routeResult.message, dispatchResult.message]
        .filter(message => message && !message.includes('No '))
      return {
        ok: routeResult.ok && dispatchResult.ok,
        message: parts.join(' | ') || 'No tasks to route or dispatch',
      }
    })
  }
  if (taskId === 'aegis_review') return runAegisReviews()
  if (taskId === 'recurring_task_spawn') return spawnRecurringTasks()
  if (taskId === 'stale_task_requeue') return requeueStaleTasks()
  return { ok: false, message: `Unknown task: ${taskId}` }
}

const DAILY_MS = 24 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000
const TICK_MS = 60 * 1000 // Check every minute

/** Initialize the scheduler */
export function initScheduler() {
  if (tickInterval || leadershipHeartbeatInterval) return // Already running or draining
  schedulerStopping = false

  // Register tasks
  const now = Date.now()
  // Stagger the initial runs: backup at ~3 AM, cleanup at ~4 AM (relative to process start)
  const msUntilNextBackup = getNextDailyMs(3)
  const msUntilNextCleanup = getNextDailyMs(4)

  tasks.set('auto_backup', {
    name: 'Auto Backup',
    intervalMs: DAILY_MS,
    lastRun: null,
    nextRun: now + msUntilNextBackup,
    enabled: true,
    running: false,
  })

  tasks.set('auto_cleanup', {
    name: 'Auto Cleanup',
    intervalMs: DAILY_MS,
    lastRun: null,
    nextRun: now + msUntilNextCleanup,
    enabled: true,
    running: false,
  })

  tasks.set('media_cleanup_debt', {
    name: 'Media Cleanup Debt Janitor',
    intervalMs: FIVE_MINUTES_MS,
    lastRun: null,
    nextRun: now + FIVE_MINUTES_MS,
    enabled: true,
    running: false,
  })

  // Keep the historical task ID as a settings/API compatibility alias.
  tasks.set('director_evidence_outbox', {
    name: 'Director Evidence and Extraction Drain',
    intervalMs: TICK_MS,
    lastRun: null,
    nextRun: now + TICK_MS,
    enabled: true,
    running: false,
  })

  tasks.set('agent_heartbeat', {
    name: 'Agent Heartbeat Check',
    intervalMs: FIVE_MINUTES_MS,
    lastRun: null,
    nextRun: now + FIVE_MINUTES_MS,
    enabled: true,
    running: false,
  })

  tasks.set('webhook_retry', {
    name: 'Webhook Retry',
    intervalMs: TICK_MS, // Every 60s, matching scheduler tick resolution
    lastRun: null,
    nextRun: now + TICK_MS,
    enabled: true,
    running: false,
  })

  tasks.set('claude_session_scan', {
    name: 'Claude Session Scan',
    intervalMs: TICK_MS, // Every 60s — lightweight file stat checks
    lastRun: null,
    nextRun: now + 5_000, // First scan 5s after startup
    enabled: true,
    running: false,
  })

  tasks.set('skill_sync', {
    name: 'Skill Sync',
    intervalMs: TICK_MS, // Every 60s — lightweight file stat checks
    lastRun: null,
    nextRun: now + 10_000, // First scan 10s after startup
    enabled: true,
    running: false,
  })

  tasks.set('local_agent_sync', {
    name: 'Local Agent Sync',
    intervalMs: TICK_MS, // Every 60s — lightweight dir scan
    lastRun: null,
    nextRun: now + 15_000, // First scan 15s after startup
    enabled: true,
    running: false,
  })

  tasks.set('gateway_agent_sync', {
    name: 'Gateway Agent Sync',
    intervalMs: TICK_MS, // Every 60s — re-read openclaw.json
    lastRun: null,
    nextRun: now + 20_000, // First scan 20s after startup (after local sync)
    enabled: true,
    running: false,
  })

  tasks.set('task_dispatch', {
    name: 'Task Dispatch',
    intervalMs: TICK_MS, // Every 60s — check for assigned tasks to dispatch
    lastRun: null,
    nextRun: now + 10_000, // First check 10s after startup
    enabled: true,
    running: false,
  })

  tasks.set('aegis_review', {
    name: 'Aegis Quality Review',
    intervalMs: TICK_MS, // Every 60s — check for tasks awaiting review
    lastRun: null,
    nextRun: now + 30_000, // First check 30s after startup (after dispatch)
    enabled: true,
    running: false,
  })

  tasks.set('recurring_task_spawn', {
    name: 'Recurring Task Spawn',
    intervalMs: TICK_MS, // Every 60s — check for recurring tasks due
    lastRun: null,
    nextRun: now + 20_000, // First check 20s after startup
    enabled: true,
    running: false,
  })

  tasks.set('stale_task_requeue', {
    name: 'Stale Task Requeue',
    intervalMs: TICK_MS, // Every 60s — check for stale in_progress tasks
    lastRun: null,
    nextRun: now + 25_000, // First check 25s after startup
    enabled: true,
    running: false,
  })

  // Heartbeat is independent from the 60-second scheduling tick so a long
  // asynchronous job keeps its lease during a planned router handoff.
  leadershipHeartbeatInterval = setInterval(
    heartbeatSchedulerLeadership,
    LEADERSHIP_HEARTBEAT_MS,
  )

  // Startup work is subject to the same cross-process lease as periodic work.
  if (reconcileSchedulerLeadership()) {
    void runTrackedSchedulerJob('startup_agent_sync', async () => {
      try {
        const result = await syncAgentsFromConfig('startup')
        return {
          ok: true,
          message: `Startup agent sync: ${result.created} created, ${result.updated} updated`,
        }
      } catch (err) {
        logger.warn({ err }, 'Agent auto-sync failed')
        return { ok: false, message: 'Agent auto-sync failed' }
      }
    })
  }

  // Start the tick loop
  tickInterval = setInterval(tick, TICK_MS)
  logger.info('Scheduler initialized - backup at ~3AM, cleanup at ~4AM, media cleanup debt and heartbeat every 5m, webhook/claude/skill/local-agent/gateway-agent sync every 60s')
}

/** Calculate ms until next occurrence of a given hour (UTC) */
function getNextDailyMs(hour: number): number {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now.getTime()
}

/** Check and run due tasks */
async function tick() {
  if (tickRunning || schedulerStopping) return
  tickRunning = true

  try {
    if (!reconcileSchedulerLeadership()) return
    const now = Date.now()

    for (const [id, task] of tasks) {
      if (task.running || runningJobIds.has(id) || now < task.nextRun) continue

      // Check if this task is enabled in settings (heartbeat is always enabled)
      const settingKey = id === 'auto_backup' ? 'general.auto_backup'
        : id === 'auto_cleanup' ? 'general.auto_cleanup'
        : id === 'media_cleanup_debt' ? 'general.media_cleanup_debt'
        : id === 'director_evidence_outbox' ? 'general.director_evidence_outbox'
        : id === 'webhook_retry' ? 'webhooks.retry_enabled'
        : id === 'claude_session_scan' ? 'general.claude_session_scan'
        : id === 'skill_sync' ? 'general.skill_sync'
        : id === 'local_agent_sync' ? 'general.local_agent_sync'
        : id === 'gateway_agent_sync' ? 'general.gateway_agent_sync'
        : id === 'task_dispatch' ? 'general.task_dispatch'
        : id === 'aegis_review' ? 'general.aegis_review'
        : id === 'recurring_task_spawn' ? 'general.recurring_task_spawn'
        : id === 'stale_task_requeue' ? 'general.stale_task_requeue'
        : 'general.agent_heartbeat'
      const defaultEnabled = id === 'media_cleanup_debt' || id === 'director_evidence_outbox' || id === 'agent_heartbeat' || id === 'webhook_retry' || id === 'claude_session_scan' || id === 'skill_sync' || id === 'local_agent_sync' || id === 'gateway_agent_sync' || id === 'task_dispatch' || id === 'aegis_review' || id === 'recurring_task_spawn' || id === 'stale_task_requeue'
      if (!isSettingEnabled(settingKey, defaultEnabled)) continue

      // Re-read router state and renew between every job. An old slot never
      // begins another job after it observes that the router selected its peer.
      if (!reconcileSchedulerLeadership()) break

      // Director evidence or extraction may wait on Feishu longer than a scheduler tick.
      // Keep it under the normal active-job lease/drain lifecycle, but do not
      // hold up heartbeat checks, webhook retries, or task dispatch behind it.
      if (id === 'director_evidence_outbox') {
        startNonBlockingScheduledTask(id, task, now)
        continue
      }

      task.running = true
      try {
        const result = await runTrackedSchedulerJob(id, () => executeScheduledTask(id))
        task.lastResult = { ...result, timestamp: now }
      } catch (err: any) {
        task.lastResult = { ok: false, message: err.message, timestamp: now }
      } finally {
        task.running = false
        task.lastRun = now
        task.nextRun = now + task.intervalMs
      }
    }
  } finally {
    tickRunning = false
  }
}

/** Get scheduler status (for API) */
export function getSchedulerStatus() {
  const result: Array<{
    id: string
    name: string
    enabled: boolean
    lastRun: number | null
    nextRun: number
    running: boolean
    lastResult?: { ok: boolean; message: string; timestamp: number }
  }> = []

  for (const [id, task] of tasks) {
    const settingKey = id === 'auto_backup' ? 'general.auto_backup'
      : id === 'auto_cleanup' ? 'general.auto_cleanup'
      : id === 'media_cleanup_debt' ? 'general.media_cleanup_debt'
      : id === 'director_evidence_outbox' ? 'general.director_evidence_outbox'
      : id === 'webhook_retry' ? 'webhooks.retry_enabled'
      : id === 'claude_session_scan' ? 'general.claude_session_scan'
      : id === 'skill_sync' ? 'general.skill_sync'
      : id === 'local_agent_sync' ? 'general.local_agent_sync'
      : id === 'gateway_agent_sync' ? 'general.gateway_agent_sync'
      : id === 'task_dispatch' ? 'general.task_dispatch'
      : id === 'aegis_review' ? 'general.aegis_review'
      : id === 'recurring_task_spawn' ? 'general.recurring_task_spawn'
      : id === 'stale_task_requeue' ? 'general.stale_task_requeue'
      : 'general.agent_heartbeat'
    const defaultEnabled = id === 'media_cleanup_debt' || id === 'director_evidence_outbox' || id === 'agent_heartbeat' || id === 'webhook_retry' || id === 'claude_session_scan' || id === 'skill_sync' || id === 'local_agent_sync' || id === 'gateway_agent_sync' || id === 'task_dispatch' || id === 'aegis_review' || id === 'recurring_task_spawn' || id === 'stale_task_requeue'
    result.push({
      id,
      name: task.name,
      enabled: isSettingEnabled(settingKey, defaultEnabled),
      lastRun: task.lastRun,
      nextRun: task.nextRun,
      running: task.running,
      lastResult: task.lastResult,
    })
  }

  return result
}

/** Manually trigger a scheduled task */
export async function triggerTask(taskId: string): Promise<{ ok: boolean; message: string }> {
  if (!SCHEDULER_TASK_IDS.has(taskId)) return { ok: false, message: `Unknown task: ${taskId}` }
  if (schedulerStopping || !reconcileSchedulerLeadership()) {
    return { ok: false, message: 'Built-in scheduler is passive on this application instance' }
  }
  return runTrackedSchedulerJob(taskId, () => executeScheduledTask(taskId, 'manual'))
}

/** Stop the scheduler */
export function stopScheduler() {
  schedulerStopping = true
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
  finishSchedulerStopIfIdle()
}
