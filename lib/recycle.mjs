import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

import { queueAgeSeconds } from './queue.mjs'
import { acquireRecycleLock } from './recycle-lock.mjs'
import { countLoadedForRecycle, scanRecycleState } from './recycle-scan.mjs'
import { readBackgroundProcesses, readDurableQueue, readManagedService, restartManagedAppServer } from './recycle-service.mjs'

export const DEFAULT_MIN_LOADED = 10
const QUIET_MS = 10 * 60_000
const MAX_POLL_GAP_MS = 6 * 60_000
const COOLDOWN_MS = 60 * 60_000
const SCAN_BUDGET_MS = 7_000
const READINESS_BUDGET_MS = 20_000
const MAX_STATE_BYTES = 4096

const skipped = (reason, details) => ({ outcome: 'skipped', reason, ...details })
const errorText = error => error.message.toString().split('\n')[0]

function readState(path, now) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o077) || st.size > MAX_STATE_BYTES) {
      throw new Error('recycle state file is not private or exceeds the size limit')
    }
    const state = JSON.parse(readFileSync(fd, 'utf8'))
    const time = value => Number.isSafeInteger(value) && value >= 0 && value <= now
    if (state?.version !== 1 || (state.lastAttempt !== undefined && !time(state.lastAttempt)) ||
        (state.quiet !== undefined && (!time(state.quiet?.since) || !time(state.quiet?.seen) ||
          state.quiet.since > state.quiet.seen || typeof state.quiet.key !== 'string'))) {
      throw new Error('recycle state file has invalid values')
    }
    return state
  } finally {
    closeSync(fd)
  }
}

function saveState(path, state) {
  const temp = path + '.' + randomUUID()
  writeFileSync(temp, JSON.stringify({ ...state, version: 1 }) + '\n', { flag: 'wx', mode: 0o600 })
  renameSync(temp, path)
}

function quietSample(previous, key, now) {
  const continuous = previous?.key === key && now - previous.seen <= MAX_POLL_GAP_MS
  return { key, since: continuous ? previous.since : now, seen: now }
}

async function waitForNewServer(socket, before, { readService, env, retryDelay }) {
  const deadline = Date.now() + READINESS_BUDGET_MS
  while (Date.now() < deadline) {
    try {
      const generation = (await readService(socket, env)).generation
      if (generation && generation !== before) {
        const count = await countLoadedForRecycle(socket, { env, budgetMs: Math.min(2000, Math.max(1, deadline - Date.now())) })
        if (generation === (await readService(socket, env)).generation) return count
      }
    } catch {
      // systemd completes startup before the socket can answer.
    }
    await sleep(retryDelay)
  }
  throw new Error('new app-server generation did not answer before the readiness deadline')
}

function queueReport({ pending_count, entries }, now) {
  return {
    pending_count,
    truncated: entries.length < pending_count,
    entries: entries.map(({ thread_id, submission_id, created_at_ms }) => ({
      thread_id, submission_id, age_seconds: queueAgeSeconds(created_at_ms, now),
    })),
  }
}

async function sample({ socket, env, minLoaded }, lease, deps) {
  try {
    const activity = lease.activity()
    const service = await deps.readService(socket, env)
    if (!service?.generation) throw new Error('app-server generation is unavailable')
    const snapshot = await scanRecycleState(socket, {
      minLoaded, env, budgetMs: SCAN_BUDGET_MS, readQueue: () => deps.readDurableQueue(service, { env }),
    })
    const { allowed, background } = await deps.readBackgroundProcesses({ ...service, codexHome: snapshot.codexHome })
    const counts = {
      loaded_before: snapshot.count, allowed_processes: allowed,
      ...(background.length ? { background_processes: background } : {}),
      ...(snapshot.queue ? { queue: queueReport(snapshot.queue, Date.now()) } : {}),
    }
    if (snapshot.reason) return skipped(snapshot.reason, counts)
    if (background.length) return skipped('background-processes', counts)
    if (service.generation !== (await deps.readService(socket, env)).generation) {
      throw new Error('app-server changed during the scan')
    }
    if (activity !== lease.activity()) return skipped('delivery-activity', counts)
    return { key: JSON.stringify([service.generation, snapshot.signature, activity]), generation: service.generation, ...counts }
  } catch (error) {
    return skipped('scan-unavailable', { error: errorText(error) })
  }
}

async function restartAndMeasure(options, sample, statePath, deps) {
  const { socket, env } = options
  const counts = { loaded_before: sample.loaded_before, queue: sample.queue }
  const lastAttempt = deps.clock()
  saveState(statePath, { lastAttempt })
  try {
    await deps.restart(env)
  } catch (error) {
    return { outcome: 'failed', reason: 'restart-failed', ...counts, loaded_after: null, error: errorText(error) }
  }
  try {
    const after = await waitForNewServer(socket, sample.generation, { ...deps, env })
    return { outcome: 'recycled', ...counts, loaded_after: after }
  } catch (error) {
    return { outcome: 'failed', reason: 'readiness-failed', ...counts, loaded_after: null, error: errorText(error) }
  }
}

async function observeQuiet(options, poll, deps) {
  const { socket, env, dryRun } = options
  const now = deps.clock()
  const state = readState(poll.statePath, now)
  const save = quiet => saveState(poll.statePath, { lastAttempt: state.lastAttempt, quiet })
  if (state.lastAttempt !== undefined && now - state.lastAttempt < COOLDOWN_MS) return skipped('cooldown')

  const observed = await sample(options, poll, deps)
  if (observed.reason) {
    save()
    return observed
  }
  const quiet = quietSample(state.quiet, observed.key, now)
  save(quiet)
  const counts = { loaded_before: observed.loaded_before, allowed_processes: observed.allowed_processes, queue: observed.queue }
  if (now - quiet.since < QUIET_MS) return skipped('quiet-period', { ...counts, quiet_seconds: Math.floor((now - quiet.since) / 1000) })
  if (dryRun) return { outcome: 'dry-run', reason: 'eligible', ...counts }

  const exclusive = await acquireRecycleLock(socket, { mode: 'exclusive', env })
  if (!exclusive) {
    save()
    return skipped('delivery-in-flight', counts)
  }
  try {
    const final = await sample(options, exclusive, deps)
    if (final.key !== observed.key) {
      save()
      return final.reason ? final : skipped('activity-changed', { loaded_before: final.loaded_before, queue: final.queue })
    }
    return await restartAndMeasure(options, final, poll.statePath, deps)
  } finally {
    exclusive.close()
  }
}

export async function recycleIfIdle({ socket, env = process.env, dryRun = false, minLoaded = DEFAULT_MIN_LOADED }, {
  clock = () => Math.floor(uptime() * 1000),
  readService = readManagedService,
  readBackgroundProcesses: inspectProcesses = readBackgroundProcesses,
  readDurableQueue: inspectQueue = readDurableQueue,
  restart = restartManagedAppServer,
  retryDelay = 200,
} = {}) {
  if (process.platform !== 'linux') throw new Error('recycle requires Linux and a managed systemd user service')
  if (!Number.isSafeInteger(minLoaded) || minLoaded < 1) throw new Error('minimum loaded threads must be a positive integer')
  // Polls serialize their state writes without obstructing delivery.
  const poll = await acquireRecycleLock(socket, { mode: 'poll', env })
  if (!poll) return skipped('poll-in-progress')
  try {
    return await observeQuiet({ socket, env, dryRun, minLoaded }, poll, {
      clock, readService, readBackgroundProcesses: inspectProcesses, readDurableQueue: inspectQueue, restart, retryDelay,
    })
  } finally {
    poll.close()
  }
}
