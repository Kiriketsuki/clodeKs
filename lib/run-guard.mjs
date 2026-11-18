import { readFileSync, readdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { memoryBytes, readHostResources } from './gate.mjs'

const MAX_TIMER_MS = 2147483647
const POLL_MS = 1000
const MAX_CONSECUTIVE_FAILURES = 3

export function parseRunLimits({ minMemavail, maxRss, maxMinutes } = {}) {
  const limits = {
    ...(minMemavail === undefined ? {} : { minMemavailBytes: memoryBytes(minMemavail, '--min-memavail') }),
    ...(maxRss === undefined ? {} : { maxRssBytes: memoryBytes(maxRss, '--max-rss') }),
  }
  if (maxMinutes !== undefined) {
    const maxMs = Number(maxMinutes) * 60000
    if (!/^\d+(?:\.\d+)?$/.test(maxMinutes) || !Number.isFinite(maxMs) || maxMs < 1 || maxMs > MAX_TIMER_MS) {
      throw new Error('--max-minutes needs positive minutes within the timer range')
    }
    return { ...limits, maxMs }
  }
  return Object.keys(limits).length ? limits : null
}

function procIdentity(text) {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (!/^[A-Za-z]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[2] ?? '') ||
      !/^\d+$/.test(fields[3] ?? '') || !/^\d+$/.test(fields[19] ?? '')) {
    throw new Error('resource guard cannot read process identity for RSS')
  }
  return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] }
}

// RSS counts each process in the run group. Shared resident pages can count more than once.
export function readGroupRss(group, { read = readFileSync, entries = () => readdirSync('/proc') } = {}) {
  let sum = 0
  try {
    for (const name of entries().filter(name => /^\d+$/.test(name))) {
      let inGroup = name === String(group)
      try {
        const path = `/proc/${name}`
        const before = procIdentity(read(`${path}/stat`, 'utf8'))
        if (before.group !== group || ['Z', 'X'].includes(before.state)) continue
        inGroup = true
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(read(`${path}/status`, 'utf8'))
        const bytes = match ? Number(match[1]) * 1024 : NaN
        const after = procIdentity(read(`${path}/stat`, 'utf8'))
        if (after.group !== before.group || after.session !== before.session || after.start !== before.start) {
          throw new Error('changed process identity during RSS sample')
        }
        if (['Z', 'X'].includes(after.state)) continue
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(sum + bytes)) {
          throw new Error('invalid RSS sample')
        }
        sum += bytes
      } catch (err) {
        if (['ENOENT', 'ESRCH'].includes(err.code)) continue
        if (!inGroup && ['EACCES', 'EPERM'].includes(err.code)) continue
        throw err
      }
    }
  } catch {
    throw new Error('resource guard cannot read complete process-group RSS')
  }
  return sum
}

export function readRunResources(limits, pid) {
  const memory = limits.minMemavailBytes === undefined ? {} : readHostResources({ memavailBytes: limits.minMemavailBytes })
  return { ...memory, ...(limits.maxRssBytes === undefined ? {} : { rssBytes: readGroupRss(pid) }) }
}

export function checkRunLimits(limits, resources, elapsedMs) {
  const elapsed_ms = Math.round(Math.max(0, elapsedMs))
  if (limits.maxMs !== undefined && elapsedMs >= limits.maxMs) {
    return { reason: 'max_minutes', limit: limits.maxMs, observed: elapsed_ms, unit: 'ms', elapsed_ms }
  }
  for (const [key, measured, reason, below] of [
    ['minMemavailBytes', 'memavailBytes', 'min_memavail', true],
    ['maxRssBytes', 'rssBytes', 'max_rss', false],
  ]) {
    if (limits[key] === undefined) continue
    const observed = resources[measured]
    if (!Number.isSafeInteger(observed) || observed < 0) throw new Error(`resource guard has no valid ${measured} sample`)
    if (below ? observed < limits[key] : observed > limits[key]) {
      return { reason, limit: limits[key], observed, unit: 'bytes', elapsed_ms }
    }
  }
  return null
}

export function preflightRunLimits(limits) {
  if (!limits) return null
  const resources = readRunResources(limits, process.pid)
  // The wrapper group is only an RSS availability check. It is not the worker group.
  return checkRunLimits(limits, { ...resources, rssBytes: 0 }, 0)
}

function measurementFailure(err, failures, elapsedMs) {
  return { reason: 'measurement_unavailable', message: err.message,
    consecutive_failures: failures, elapsed_ms: Math.round(Math.max(0, elapsedMs)) }
}

export async function waitForRunPreflight(limits, {
  preflight = preflightRunLimits, pollMs = POLL_MS, sleep = delay, now = () => performance.now(),
} = {}) {
  if (!limits) return null
  const started = now()
  for (let failures = 1; failures <= MAX_CONSECUTIVE_FAILURES; failures += 1) {
    try { return await preflight(limits) } catch (err) {
      if (failures === MAX_CONSECUTIVE_FAILURES) return measurementFailure(err, failures, now() - started)
      await sleep(pollMs)
    }
  }
}

export function startRunGuard(limits, pid, onStop, {
  sample = readRunResources, now = () => performance.now(), pollMs = POLL_MS,
} = {}) {
  if (!limits) return { close() {} }
  const started = now()
  let closed = false
  let failures = 0
  let interval
  let deadline
  const close = () => {
    closed = true
    clearInterval(interval)
    clearTimeout(deadline)
  }
  const check = () => {
    if (closed) return
    let reason
    try {
      reason = checkRunLimits(limits, sample(limits, pid), now() - started)
      failures = 0
    } catch (err) {
      failures += 1
      const elapsed = now() - started
      if (limits.maxMs !== undefined && elapsed >= limits.maxMs) reason = checkRunLimits(limits, {}, elapsed)
      else {
        if (failures < MAX_CONSECUTIVE_FAILURES) return
        reason = measurementFailure(err, failures, elapsed)
      }
    }
    if (reason) {
      close()
      onStop(reason)
    }
  }
  if (limits.minMemavailBytes !== undefined || limits.maxRssBytes !== undefined) interval = setInterval(check, pollMs)
  if (limits.maxMs !== undefined) deadline = setTimeout(() => {
    if (closed) return
    const elapsed = now() - started
    close()
    onStop({ reason: 'max_minutes', limit: limits.maxMs, observed: Math.round(elapsed), unit: 'ms', elapsed_ms: Math.round(elapsed) })
  }, limits.maxMs)
  check()
  return { close }
}
