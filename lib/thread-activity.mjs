import { lastTurnErrorText, readLastTurnError } from './thread-error.mjs'

export function threadCounts(threads) {
  const loaded = threads.filter(thread => thread.loaded !== false)
  const active = loaded.filter(thread => thread.status === 'active').length
  const idleThreads = loaded.filter(thread => thread.status === 'idle')
  const idle = idleThreads.length
  const idle_queued = idleThreads.filter(thread => thread.queued_count > 0).length
  const idle_queue_unknown = idleThreads.filter(thread => thread.queued_count == null).length
  return { live: loaded.length, active, idle, other: loaded.length - active - idle,
    idle_queued, idle_queue_unknown, client_attachment: 'unknown' }
}

export function threadActivityHint(threads) {
  const counts = threadCounts(threads)
  return `${counts.live} loaded: ${counts.active} working, ${counts.idle} idle, ${counts.other} other. ${idleQueueHint(counts)}. Client attachment is unknown. Idle age uses the latest terminal turn completion when available.`
}

export function idleQueueHint(counts) {
  return `${counts.idle_queued ?? 'unknown'} idle with queued work, ${counts.idle_queue_unknown ?? 'unknown'} idle with unknown queue depth`
}

export function threadStatusText(thread) {
  if (thread.status === 'systemError') return `systemError (${lastTurnErrorText(thread.last_turn_error)})`
  if (thread.status === 'idle' && thread.queued_count > 0) return 'idle (queued work)'
  if (thread.status !== 'active') return thread.status
  const waits = []
  if (thread.active_flags?.includes('waitingOnApproval')) waits.push('waiting on approval')
  if (thread.active_flags?.includes('waitingOnUserInput')) waits.push('waiting on user input')
  return `working${waits.length ? ` (${waits.join(', ')})` : ''}`
}

// Metadata updates do not prove when a turn ended. Missing completion times stay unknown.
export async function withThreadActivity(client, threads, { now = Date.now(), budgetMs = 1500 } = {}) {
  const deadlineMs = Date.now() + budgetMs
  return await Promise.all(threads.map(async thread => {
    const base = { ...thread, client_attachment: 'unknown', idle_age_seconds: null, idle_age_source: null, idle_age_error: null }
    if (thread.status === 'systemError') return { ...base, last_turn_error: await readLastTurnError(client, thread.id, { deadlineMs }) }
    if (!thread.loaded || thread.status !== 'idle') return base
    try {
      const page = await client.request('thread/turns/list', {
        threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
      }, { deadlineMs })
      const turn = Array.isArray(page?.data) && page.data.length === 1 ? page.data[0] : null
      if (!turn || !['completed', 'failed', 'interrupted'].includes(turn.status) ||
          !Number.isSafeInteger(turn.completedAt) || turn.completedAt <= 0 || turn.completedAt * 1000 > now) {
        return { ...base, idle_age_error: 'Latest terminal turn completion is unavailable.' }
      }
      return { ...base, idle_age_seconds: Math.floor(now / 1000) - turn.completedAt, idle_age_source: 'last-turn-completed-at' }
    } catch {
      return { ...base, idle_age_error: 'Latest terminal turn completion is unavailable.' }
    }
  }))
}
