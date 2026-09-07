// Only the random session whose absence was verified before this test may be removed.
export async function cleanupOwnedSyntheticSession({
  sessionKey, agentId, ownershipVerified, expectedSessionId, readEntry, deleteSession,
}) {
  const prefix = `agent:${agentId}:codex-postdeploy-`
  if (agentId !== 'second-original' || ownershipVerified !== true
    || typeof sessionKey !== 'string' || !sessionKey.startsWith(prefix)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(sessionKey.slice(prefix.length))) {
    throw new Error('synthetic_session_ownership_invalid')
  }
  const entry = await readEntry()
  if (entry == null) return { activeSessionAbsent: true, deleted: false, alreadyAbsent: true, archivedTranscriptCount: null }
  if (typeof entry.sessionId !== 'string' || !entry.sessionId
    || (expectedSessionId && entry.sessionId !== expectedSessionId)
    || !Number.isFinite(entry.updatedAt) || entry.updatedAt < 0) {
    throw new Error('synthetic_session_identity_changed')
  }
  const parameters = {
    key: sessionKey, agentId, deleteTranscript: true,
    expectedSessionId: entry.sessionId, expectedSessionUpdatedAt: entry.updatedAt,
    emitLifecycleHooks: false,
  }
  if (typeof entry.lifecycleRevision === 'string' && entry.lifecycleRevision) {
    parameters.expectedLifecycleRevision = entry.lifecycleRevision
  }
  let result
  try { result = await deleteSession(parameters) } catch {
    // A lost response must not cause another delete. Prove absence independently.
    if (await readEntry() == null) {
      return { activeSessionAbsent: true, deleted: null, responseLost: true, archivedTranscriptCount: null }
    }
    throw new Error('synthetic_session_cleanup_failed')
  }
  if (result?.ok !== true || result.key !== sessionKey || result.deleted !== true
    || !Array.isArray(result.archived) || result.archived.some(value => typeof value !== 'string')) {
    throw new Error('synthetic_session_cleanup_receipt_invalid')
  }
  if (await readEntry() != null) throw new Error('synthetic_session_cleanup_incomplete')
  return { activeSessionAbsent: true, deleted: true, archivedTranscriptCount: result.archived.length }
}
