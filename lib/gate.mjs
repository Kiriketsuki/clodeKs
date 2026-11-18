import { readFileSync } from 'node:fs'
import { loadavg, platform } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_TIMEOUT = '60m'
const DEFAULT_JITTER_MS = 15000
const MAX_TIMER_MS = 2147483647
const POLL_MS = 1000
const NOTICE_MS = 60000
const SWAP_SAMPLE_MS = 500
const PREFLIGHT_SAMPLES = 3
const PREFLIGHT_INTERVAL_MS = 1250
export const DEFAULT_PRESSURE_LIMITS = Object.freeze({ psiSomeMax: 20, psiFullMax: 5, swapInMax: 2000 })

const PRESSURE_KEYS = new Map([
  ['psi', 'psiSomeMax'],
  ['psifull', 'psiFullMax'],
  ['swapin', 'swapInMax'],
  ['swap', 'swapMaxBytes'],
])
const GATE_KEYS_ERROR = '--wait-gate accepts memavail=SIZE, load=N, psi=N, psifull=N, swapin=N, and swap=SIZE'

function positive(value, flag) {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${flag} needs a positive finite value within the safe numeric range`)
  }
  return value
}

export function memoryBytes(text, flag = '--wait-gate memavail') {
  const match = /^(\d+(?:\.\d+)?)([KMGT](?:i?B)?|B)?$/i.exec(text)
  if (!match) throw new Error(`${flag} needs bytes or a K, M, G, or T unit`)
  const power = match[2] && match[2].toUpperCase() !== 'B' ? 'KMGT'.indexOf(match[2][0].toUpperCase()) + 1 : 0
  const bytes = positive(Number(match[1]) * 1024 ** power, flag)
  if (!Number.isSafeInteger(bytes)) throw new Error(`${flag} needs a whole byte count`)
  return bytes
}

function durationMs(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text)
  if (!match) throw new Error('--gate-timeout needs seconds or an ms, s, m, or h unit')
  const milliseconds = positive(Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? 's']), '--gate-timeout')
  if (milliseconds < 1) throw new Error('--gate-timeout needs at least 1 ms')
  return milliseconds
}

function jitterMs(text) {
  if (text === undefined) return DEFAULT_JITTER_MS
  const milliseconds = Number(text) * 1000
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(milliseconds) || milliseconds > MAX_TIMER_MS) {
    throw new Error('--gate-jitter needs nonnegative seconds within the timer range')
  }
  return milliseconds
}

export function parseGate(spec, timeout, jitter) {
  if (spec === undefined) {
    if (timeout !== undefined) throw new Error('--gate-timeout needs --wait-gate')
    if (jitter !== undefined) throw new Error('--gate-jitter needs --wait-gate')
    return null
  }
  const entries = spec.split(',').map(part => part.split('='))
  const names = entries.map(([key]) => key)
  if (!entries.length || new Set(names).size !== names.length) throw new Error('--wait-gate repeats a limit')
  const limits = entries.map(([key, value, extra]) => {
    if (!value || extra !== undefined) throw new Error(GATE_KEYS_ERROR)
    if (key === 'memavail') return ['memavailBytes', memoryBytes(value)]
    if (key === 'load' && /^\d+(?:\.\d+)?$/.test(value)) return ['loadMax', positive(Number(value), '--wait-gate load')]
    const pressureKey = PRESSURE_KEYS.get(key)
    if (pressureKey) {
      const flag = `--wait-gate ${key}`
      if (value === 'off') return [pressureKey, null]
      if (key === 'swap') return [pressureKey, memoryBytes(value, flag)]
      const limit = Number(value)
      if (!/^\d+(?:\.\d+)?$/.test(value) || (key !== 'swapin' && limit > 100)) {
        throw new Error(`${flag} has an invalid limit`)
      }
      return [pressureKey, positive(limit, flag)]
    }
    throw new Error(GATE_KEYS_ERROR)
  })
  return { ...Object.fromEntries(limits), timeoutMs: durationMs(timeout ?? DEFAULT_TIMEOUT), jitterMs: jitterMs(jitter) }
}

export function readHostResources(gate, { read = readFileSync, load = loadavg, hostPlatform = platform() } = {}) {
  let memory = {}
  let cpu = {}
  if (gate.memavailBytes !== undefined) {
    let bytes
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(read('/proc/meminfo', 'utf8'))
      bytes = match ? Number(match[1]) * 1024 : NaN
    } catch {
      throw new Error('resource gate cannot read Linux MemAvailable')
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('resource gate has no valid Linux MemAvailable value')
    memory = { memavailBytes: bytes }
  }
  if (gate.loadMax !== undefined) {
    let value
    try {
      value = hostPlatform === 'win32' ? NaN : load()[0]
    } catch {
      throw new Error('resource gate cannot read load1')
    }
    if (!Number.isFinite(value) || value < 0) throw new Error('resource gate has no valid load1 value')
    cpu = { load1: value }
  }
  return { ...memory, ...cpu }
}

function readMetricFile(read, path) {
  try { return read(path, 'utf8') } catch { return null }
}

function kiloBytes(meminfo, name) {
  const match = new RegExp(`^${name}:[ \t]+(\\d+)[ \t]+kB$`, 'm').exec(meminfo)
  const bytes = match ? Number(match[1]) * 1024 : NaN
  return Number.isSafeInteger(bytes) ? bytes : null
}

function psiAvg10(text, kind) {
  const line = text?.split('\n').find(line => line.startsWith(`${kind} `))
  const match = /(?:^|\s)avg10=(\d+(?:\.\d+)?)(?:\s|$)/.exec(line)
  const value = match ? Number(match[1]) : NaN
  return value >= 0 && value <= 100 ? value : null
}

function swapInPages(read) {
  const match = /^pswpin[ \t]+(\d+)$/m.exec(readMetricFile(read, '/proc/vmstat'))
  const pages = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(pages) ? pages : null
}

export async function sampleLaunchResources(gate, {
  read = readFileSync, now = () => performance.now(), sleep = delay, budgetMs = Infinity,
} = {}) {
  const first = swapInPages(read)
  let swapInPagesPerSec = null
  const swapInSampleIncomplete = first !== null && budgetMs < SWAP_SAMPLE_MS
  if (first !== null && !swapInSampleIncomplete) {
    const started = now()
    await sleep(SWAP_SAMPLE_MS)
    const last = swapInPages(read)
    const elapsed = now() - started
    if (last !== null && last >= first && elapsed > 0) {
      swapInPagesPerSec = (last - first) * 1000 / elapsed
    }
  }
  const pressure = readMetricFile(read, '/proc/pressure/memory')
  const meminfo = readMetricFile(read, '/proc/meminfo')
  const total = kiloBytes(meminfo, 'SwapTotal')
  const free = kiloBytes(meminfo, 'SwapFree')
  const observed = {
    psiSomeAvg10: psiAvg10(pressure, 'some'),
    psiFullAvg10: psiAvg10(pressure, 'full'),
    swapInPagesPerSec,
    swapUsedBytes: total !== null && free !== null && total >= free ? total - free : null,
  }
  try {
    const host = readHostResources(gate, { read: () => {
      if (meminfo === null) throw new Error('cannot read /proc/meminfo')
      return meminfo
    } })
    return { ...host, ...observed, ...(swapInSampleIncomplete ? { swapInSampleIncomplete } : {}) }
  } catch (err) {
    throw Object.assign(err, { observed })
  }
}

function pressureReport(resources) {
  if (!Object.hasOwn(resources, 'psiSomeAvg10')) return {}
  return {
    psi_some_avg10: resources.psiSomeAvg10,
    psi_full_avg10: resources.psiFullAvg10,
    swap_in_pages_per_sec: resources.swapInPagesPerSec,
    swap_used_bytes: resources.swapUsedBytes,
  }
}

function pressureNotice(resources) {
  if (!Object.hasOwn(resources, 'psiSomeAvg10')) return ''
  const show = value => value ?? 'unknown'
  const rate = resources.swapInPagesPerSec?.toFixed(1)
  return ` psi=${show(resources.psiSomeAvg10)}%, psifull=${show(resources.psiFullAvg10)}%, swapin=${show(rate)} pages/s, swap=${show(resources.swapUsedBytes)} bytes.`
}

function maxReason(name, observed, limit, unit) {
  if (limit == null || observed == null || observed < limit) return null
  return `${name} ${observed} ${unit} is at or above ${limit}`
}

function gateBreaches(gate, resources) {
  const reasons = {
    memavail: gate.memavailBytes !== undefined && resources.memavailBytes < gate.memavailBytes
      ? `MemAvailable ${resources.memavailBytes} bytes is below ${gate.memavailBytes}` : null,
    load: gate.loadMax !== undefined && resources.load1 >= gate.loadMax
      ? `load1 ${resources.load1} is at or above ${gate.loadMax}` : null,
    psi: maxReason('psi', resources.psiSomeAvg10, gate.psiSomeMax, '%'),
    psifull: maxReason('psifull', resources.psiFullAvg10, gate.psiFullMax, '%'),
    swapin: maxReason('swapin', resources.swapInPagesPerSec, gate.swapInMax, 'pages/s'),
    swap: gate.swapMaxBytes != null && resources.swapUsedBytes === null
      ? 'swap use is unknown' : maxReason('swap', resources.swapUsedBytes, gate.swapMaxBytes, 'bytes'),
  }
  const breaches = new Map(Object.entries(reasons).filter(([, reason]) => reason))
  if (!breaches.size && resources.swapInSampleIncomplete && gate.swapInMax != null) {
    breaches.set('swapin', 'swapin needs a 500 ms sample')
  }
  return breaches
}

export async function waitForGate(gate, {
  sample = sampleLaunchResources, now = () => performance.now(), sleep = delay,
  onNotice = () => {}, pollMs = POLL_MS, random = Math.random,
} = {}) {
  if (!gate) return { waitedMs: 0 }
  const started = now()
  let lastNotice = -Infinity
  let waited = false
  let lastReasons = []
  let lastResources = {}
  let jitterWaited = 0
  const report = () => ({
    waited_ms: Math.round(Math.max(0, now() - started)),
    wait_reasons: [...lastReasons], jitter_ms: Math.round(jitterWaited), ...pressureReport(lastResources),
  })
  const timeoutError = () => Object.assign(new Error(`resource gate timed out after ${gate.timeoutMs / 1000} seconds.${pressureNotice(lastResources)}`), {
    code: 'GATE_TIMEOUT', gate: report(),
  })
  const check = async () => {
    let resources
    try {
      const budgetMs = gate.timeoutMs === undefined ? Infinity : gate.timeoutMs - (now() - started)
      resources = await sample(gate, { budgetMs })
    } catch (err) {
      lastResources = err.observed ?? lastResources
      throw Object.assign(new Error(err.message + pressureNotice(lastResources), { cause: err }), { gate: { ...report(), wait_reasons: [err.message] } })
    }
    lastResources = resources
    const breaches = gateBreaches(gate, resources)
    const reasons = [...breaches.values()]
    if (reasons.length) lastReasons = reasons
    if (now() - started >= gate.timeoutMs) throw timeoutError()
    return { resources, reasons, breaches }
  }
  if (gate.timeoutMs === undefined) {
    let sampledAt = now()
    let { resources, breaches } = await check()
    let sustained = [...breaches.keys()]
    for (let attempt = 1; attempt < PREFLIGHT_SAMPLES && sustained.length; attempt++) {
      const remaining = PREFLIGHT_INTERVAL_MS - (now() - sampledAt)
      if (remaining > 0) await sleep(remaining)
      sampledAt = now()
      ;({ resources, breaches } = await check())
      sustained = sustained.filter(key => breaches.has(key))
    }
    if (sustained.length) {
      lastReasons = sustained.map(key => breaches.get(key))
      const message = `resource gate refused launch after ${PREFLIGHT_SAMPLES} samples. ${lastReasons.join(', ')}.${pressureNotice(resources)} Use --wait-gate with psi, psifull, swapin, or swap to wait or override a limit.`
      throw Object.assign(new Error(message), { code: 'GATE_REFUSED', gate: report() })
    }
    onNotice(`ready.${pressureNotice(resources)}`)
    return { ...resources, waitedMs: now() - started, ...report() }
  }
  while (now() - started < gate.timeoutMs) {
    let { resources, reasons } = await check()
    if (!reasons.length) {
      const jitter = random() * (gate.jitterMs ?? DEFAULT_JITTER_MS)
      if (jitter > 0) {
        const before = now()
        const remaining = gate.timeoutMs - (before - started)
        if (remaining <= 0) throw timeoutError()
        await sleep(Math.min(jitter, remaining))
        jitterWaited += Math.max(0, now() - before)
      }
      if (now() - started >= gate.timeoutMs) throw timeoutError()
      ;({ resources, reasons } = await check())
      if (!reasons.length) {
        const elapsed = now() - started
        const observed = pressureNotice(resources)
        if (waited) onNotice(`ready after ${Math.ceil(elapsed / 1000)} seconds.${observed}`)
        else if (observed) onNotice(`ready.${observed}`)
        return { ...resources, waitedMs: elapsed, ...report() }
      }
    }
    const elapsed = now() - started
    if (elapsed - lastNotice >= NOTICE_MS) {
      onNotice(`waiting. ${reasons.join(', ')}.${pressureNotice(resources)}`)
      lastNotice = elapsed
    }
    waited = true
    const remaining = gate.timeoutMs - (now() - started)
    if (remaining <= 0) throw timeoutError()
    await sleep(Math.min(pollMs, remaining))
  }
  throw timeoutError()
}
