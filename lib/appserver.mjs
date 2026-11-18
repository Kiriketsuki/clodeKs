import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

import { resolveCodex } from './paths.mjs'
import { openWebSocket } from './ws.mjs'
import { readThreadLaunch } from './launch-record.mjs'
import { appServerUmask, socketIdentity, unknownWorkerUmask } from './umask.mjs'

import { readQueueSnapshot } from './queue.mjs'
import { approvalResumeCommand, readApprovalCommandCandidates } from './approval-context.mjs'
import { withThreadActivity } from './thread-activity.mjs'
import { lastTurnErrorText, readLastTurnError } from './thread-error.mjs'

const VERSION = '0.1.0'
const REQUEST_TIMEOUT_MS = 15000
const APPROVAL_HISTORY_BUDGET_MS = 1500
export const COMMAND_APPROVAL = 'item/commandExecution/requestApproval'
const FILE_APPROVAL = 'item/fileChange/requestApproval'
// `codex queue` takes the message as one argument. Linux caps one argument at 128 KiB.
export const MAX_QUEUE_CHARS = 100_000

// A JSON-RPC client for a Codex app-server on a Unix socket.
// Ordinary clients reject server requests. Approval recovery handles replays on its own connection.
export async function connectAppServer(socketPath, { deadlineMs = Infinity, env = process.env, onApprovalReplay } = {}) {
  if (Date.now() >= deadlineMs) throw new Error('app-server delivery deadline exceeded')
  if (!existsSync(socketPath)) {
    throw new Error(`No Codex app-server socket at ${socketPath}. Start one with: clodeks serve`)
  }
  const identity = socketIdentity(socketPath)
  const ws = await openWebSocket(socketPath, { timeoutMs: Math.max(1, Math.min(5000, deadlineMs - Date.now())) })
  let nextId = 1
  const pending = new Map()
  const listeners = []

  ws.onText(text => {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(msg.id)
      if (!waiter) return
      pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(Object.assign(new Error(`${waiter.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`), { rpcRejected: true }))
      else waiter.resolve(msg.result)
    } else if (msg.id !== undefined && msg.method) {
      if (onApprovalReplay) {
        const validId = (typeof msg.id === 'string' && msg.id.length > 0) || Number.isSafeInteger(msg.id)
        const allow = msg.method === FILE_APPROVAL ||
          (msg.method === COMMAND_APPROVAL && [undefined, 'command'].includes(msg.params?.kind))
        const decline = validId && allow ? () => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } }))
        } : null
        onApprovalReplay(msg, decline)
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'clodeks does not answer server requests' } }))
      }
    } else if (msg.method) {
      for (const fn of listeners) fn(msg)
    }
  })
  ws.onClose(() => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('app-server connection closed'))
    }
    pending.clear()
  })

  const request = (method, params, { deadlineMs: callDeadlineMs = Infinity } = {}) =>
    new Promise((resolve, reject) => {
      const remaining = Math.min(deadlineMs, callDeadlineMs) - Date.now()
      if (remaining <= 0) {
        reject(new Error(`${method}: delivery deadline exceeded`))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method}: ${remaining <= REQUEST_TIMEOUT_MS ? 'delivery deadline exceeded' : 'timed out'}`))
      }, Math.min(REQUEST_TIMEOUT_MS, remaining))
      pending.set(id, { resolve, reject, timer, method })
      ws.send(JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }))
    })

  let initialized
  try {
    initialized = await request('initialize', {
      clientInfo: { name: 'clodeks', title: 'clodeKs', version: VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
  } catch (err) {
    ws.destroy()
    throw err
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))

  return {
    request,
    codexHome: typeof initialized?.codexHome === 'string' && isAbsolute(initialized.codexHome) ? initialized.codexHome : null,
    workerUmask: () => appServerUmask(socketPath, {
      expectedIdentity: identity, timeoutMs: Math.min(1500, deadlineMs - Date.now()), env,
    }),
    onNotification: fn => listeners.push(fn),
    close: ({ immediate = false } = {}) => immediate ? ws.destroy() : ws.close(),
  }
}

// The short, stable name a Codex thread has in clodeks. UUIDv7 ids share their leading
// timestamp digits, so the name uses the last 8 hex digits. It ignores the thread title:
// Codex writes titles as free text, and an alias must be safe in a socket file name.
export function threadAlias(thread) {
  return `codex-${thread.id.replace(/-/g, '').slice(-8)}`
}

// Codex hides these temporary metadata helpers from its own TUI routing.
// https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/app/app_server_events.rs#L219
export function isHiddenThreadHelper(thread) {
  return thread.ephemeral === true && ['system', 'thread_title'].includes(thread.threadSource)
}

export function summarizeThread(thread, loadedIds, env = process.env, workerMask = unknownWorkerUmask()) {
  const launch = readThreadLaunch(thread, env)
  const backendSource = typeof thread.source === 'string' ? thread.source : (thread.source && Object.keys(thread.source)[0]) || null
  // The app-server uses vscode as a broad source label. It does not identify the remote frontend.
  // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/cli/src/main.rs#L1271
  const source = launch?.source ?? (backendSource === 'vscode' ? null : backendSource)
  return {
    id: thread.id,
    alias: threadAlias(thread),
    name: thread.name ?? null,
    status: thread.status?.type ?? 'unknown',
    active_flags: Array.isArray(thread.status?.activeFlags) ? [...thread.status.activeFlags] : [],
    loaded: loadedIds.has(thread.id),
    cwd: thread.cwd,
    preview: (thread.preview ?? '').replace(/\s+/g, ' ').slice(0, 120),
    updated_at: thread.updatedAt,
    source,
    backend_source: backendSource,
    caller_umask: launch?.caller_umask ?? null,
    tmux_window_name: launch?.tmux_window_name ?? null,
    ...(loadedIds.has(thread.id) ? workerMask : unknownWorkerUmask()),
  }
}

// Lists threads that the app-server knows, loaded (live) threads first.
export async function listThreads(socketPath, { limit = 20, all = false, includeQueueCounts = true, includeActivity = false, deadlineMs = Infinity, env = process.env } = {}) {
  const client = await connectAppServer(socketPath, { deadlineMs, env })
  try {
    const loaded = await client.request('thread/loaded/list', {})
    const loadedIds = new Set(loaded.data ?? [])
    const params = { limit, sortKey: 'updated_at', useStateDbOnly: true }
    const page = await client.request('thread/list', params)
    const workerMask = await client.workerUmask()
    const listedIds = new Set((page.data ?? []).map(t => t.id))
    let threads = (page.data ?? []).filter(t => !isHiddenThreadHelper(t)).map(t => summarizeThread(t, loadedIds, env, workerMask))
    // A loaded thread can be missing from the page (for example an exec thread). Read it.
    for (const id of loadedIds) {
      if (listedIds.has(id)) continue
      try {
        const read = await client.request('thread/read', { threadId: id })
        if (!isHiddenThreadHelper(read.thread)) threads.push(summarizeThread(read.thread, loadedIds, env, workerMask))
      } catch {
        // The thread unloaded between the two calls. Skip it.
      }
    }
    if (!all) threads = threads.filter(t => t.loaded)
    threads.sort((a, b) => Number(b.loaded) - Number(a.loaded) || (b.updated_at ?? 0) - (a.updated_at ?? 0))
    if (!includeQueueCounts) return includeActivity ? await withThreadActivity(client, threads) : threads
    const countDeadline = Math.min(deadlineMs, Date.now() + 1500)
    threads = await Promise.all(threads.map(async thread => {
      try {
        const entries = await readQueueSnapshot(client, thread.id, { deadlineMs: countDeadline })
        return { ...thread, queued_count: entries.length, queued_count_error: null }
      } catch {
        return { ...thread, queued_count: null, queued_count_error: 'queue depth unavailable' }
      }
    }))
    return includeActivity ? await withThreadActivity(client, threads) : threads
  } finally {
    client.close()
  }
}

// Read status and history only. A resume would attach a client and replay approvals.
export async function listPendingApprovals(socketPath) {
  const client = await connectAppServer(socketPath)
  try {
    const loaded = await client.request('thread/loaded/list', {})
    if (!Array.isArray(loaded?.data) || loaded.data.some(id => typeof id !== 'string' || !id)) {
      throw new Error('cannot read the loaded thread list. Approval status is unavailable.')
    }
    const pending = []
    let detailsDeadline
    for (const id of new Set(loaded.data)) {
      const read = await client.request('thread/read', { threadId: id })
      const thread = read?.thread
      const status = thread?.status
      const known = ['active', 'idle', 'notLoaded', 'systemError'].includes(status?.type)
      if (thread?.id !== id || !known || (status.type === 'active' &&
        (!Array.isArray(status.activeFlags) || status.activeFlags.some(flag => typeof flag !== 'string')))) {
        throw new Error(`cannot check ${threadAlias({ id })} status. Approval status is unavailable.`)
      }
      if (status.type === 'active' && status.activeFlags.includes('waitingOnApproval')) {
        detailsDeadline ??= Date.now() + APPROVAL_HISTORY_BUDGET_MS
        pending.push({
          thread_id: id, alias: threadAlias(thread), name: thread.name ?? null, cwd: thread.cwd ?? null,
          active_flags: [...status.activeFlags], details_available: false,
          request_id: null, resume_command: approvalResumeCommand(socketPath, id),
          ...await readApprovalCommandCandidates(client, id, detailsDeadline),
        })
      }
    }
    return {
      pending,
      hint: 'Unconfirmed command candidates come from current-turn history. Text can be redacted or unrelated to the approval. Exact pending command and request ID remain unavailable. Resolve prompts in the owning Codex client. If it is gone, run resume_command in a terminal and review the replayed prompt. Discovery never resumes or answers. History can be unavailable or truncated.',
    }
  } finally {
    client.close()
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nullable = (value, valid) => value === undefined || value === null || valid(value)
const int32 = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
const isString = value => typeof value === 'string'
const isBoolean = value => typeof value === 'boolean'

function validQuotaSnapshot(snapshot) {
  if (!isObject(snapshot)) return false
  const metadata = ['limitId', 'limitName', 'normalModelSlug', 'planType', 'rateLimitReachedType']
  if (!metadata.every(key => nullable(snapshot[key], isString)) ||
      !nullable(snapshot.spendControlReached, isBoolean) ||
      !nullable(snapshot.credits, credits => isObject(credits) &&
        isBoolean(credits.hasCredits) && isBoolean(credits.unlimited) && nullable(credits.balance, isString)) ||
      !nullable(snapshot.individualLimit, limit => isObject(limit) &&
        isString(limit.limit) && isString(limit.used) && int32(limit.remainingPercent) && Number.isSafeInteger(limit.resetsAt))) return false
  return ['primary', 'secondary'].every(key => nullable(snapshot[key], window =>
    isObject(window) && int32(window.usedPercent) &&
    nullable(window.resetsAt, Number.isSafeInteger) &&
    nullable(window.windowDurationMins, value => Number.isSafeInteger(value) && value >= 0),
  ))
}

// This reads the selected server account. It does not select a thread or advertise reserve support.
// https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/request_processors/account_processor.rs#L1191
export async function readQuota(socketPath) {
  const client = await connectAppServer(socketPath)
  try {
    const response = await client.request('account/rateLimits/read', { excludeResetCreditDetails: true })
    if (!isObject(response) || !validQuotaSnapshot(response.rateLimits) ||
        !nullable(response.rateLimitsByLimitId, buckets => isObject(buckets) && Object.values(buckets).every(validQuotaSnapshot)) ||
        !nullable(response.ordinaryUsageAllowed, isBoolean) ||
        !nullable(response.accountId, isString)) {
      throw new Error('cannot verify the quota response. Usage is unavailable.')
    }
    return {
      scope: 'shared-app-server-account', fetched_at: Date.now(), account_id: response.accountId ?? null,
      rate_limits: response.rateLimits, rate_limits_by_limit_id: response.rateLimitsByLimitId ?? null,
      ordinary_usage_allowed: response.ordinaryUsageAllowed ?? null,
      hint: 'This snapshot describes the selected server account, not each thread or every account. Missing values remain unknown.',
    }
  } finally {
    client.close()
  }
}

// Codex subcommands that are not an interactive TUI.
const NOT_TUI = new Set(['app-server', 'exec', 'e', 'queue', 'sandbox', 'mcp', 'mcp-server', 'login', 'logout', 'apply', 'completion', 'debug', 'remote-control', 'features', 'cloud'])

// Decides from one argv whether it is a Codex TUI on a private app-server. Pure.
export function isPrivateTui(argv) {
  if (argv.length === 0 || basename(argv[0]) !== 'codex') return false
  if (argv.includes('--remote')) return false
  const sub = argv.slice(1).find(a => !a.startsWith('-'))
  return !NOT_TUI.has(sub)
}

// Lists the cwd of each Codex TUI that runs on its own app-server (a plain `codex`).
// clodeKs cannot list or reach those threads. Linux only: elsewhere it returns [].
export function privateTuis(procDir = '/proc') {
  const found = []
  let pids = []
  try {
    pids = readdirSync(procDir).filter(n => /^\d+$/.test(n))
  } catch {
    return found
  }
  for (const pid of pids) {
    try {
      // The npm wrapper runs under node. Only the native binary counts, once per TUI.
      if (basename(readlinkSync(`${procDir}/${pid}/exe`)) !== 'codex') continue
      const argv = readFileSync(`${procDir}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (isPrivateTui(argv)) found.push({ pid: Number(pid), cwd: readlinkSync(`${procDir}/${pid}/cwd`) })
    } catch {
      // The process ended, or belongs to another user.
    }
  }
  return found
}

// Says why no live thread is listed: stored threads that nothing runs, and TUIs that clodeKs
// cannot see. A caller must not read an empty list as "no Codex work runs".
export async function explainNoThreads(socketPath, { procDir } = {}) {
  const lines = ['No live Codex threads on the shared app-server.']
  try {
    const stored = (await listThreads(socketPath, { all: true, limit: 50 })).filter(t => !t.loaded)
    if (stored.length) {
      lines.push(
        `${stored.length >= 50 ? '50 or more' : stored.length} stored thread(s), for example ${stored[0].alias}. A stored thread runs nothing, so codex_send refuses it. Resume one with: clodeks tui -- resume <id>`,
      )
    }
  } catch (err) {
    lines.push(`The app-server did not answer: ${err.message}`)
  }
  const tuis = privateTuis(procDir)
  if (tuis.length) {
    lines.push(
      `${tuis.length} Codex TUI(s) run on a private app-server (started as plain codex), so clodeKs cannot list or reach them: ${tuis.map(t => `pid ${t.pid} in ${t.cwd}`).join(', ')}`,
    )
  }
  lines.push('Private one-shot runs use a separate runner. Read them with clodeks jobs or codex_jobs. They cannot receive codex_send messages.')
  lines.push('Start a reachable thread with: clodeks tui, or clodeks tui --brief FILE')
  return lines.join('\n')
}

// Resolves an alias, a thread name or an id prefix to a thread id.
export async function resolveThread(socketPath, ref, { deadlineMs = Infinity, env = process.env } = {}) {
  // A short reference such as "codex-" or "" would match every thread.
  if (String(ref).replace(/^codex-/, '').replace(/-/g, '').length < 4) {
    throw new Error(`"${ref}" is too short to name a thread. Use an alias such as codex-1a2b3c4d.`)
  }
  const threads = await listThreads(socketPath, { limit: 100, all: true, includeQueueCounts: false, deadlineMs, env })
  const exactId = threads.find(t => t.id === ref)
  if (exactId) return exactId
  // Mutable names must not shadow canonical IDs, aliases, or partial ID references.
  for (const matches of [
    threads.filter(t => t.alias === ref),
    threads.filter(t => t.id.startsWith(ref) || t.id.replace(/-/g, '').endsWith(ref.replace(/^codex-/, ''))),
    threads.filter(t => t.name === ref || t.tmux_window_name === ref),
  ]) {
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      const candidates = matches.map(t => `${t.alias} (${t.id})`).join(', ')
      throw new Error(`"${ref}" matches ${matches.length} threads. Use the full ID: ${candidates}.`)
    }
  }
  throw new Error(`No Codex thread matches "${ref}".`)
}

// Queues input through the original Codex CLI path.
// Queue delivery does not prove that a turn started.
export async function queueMessage(socketPath, threadId, message, env = process.env, lockFd) {
  return (await queueMessageWithStatus(socketPath, threadId, message, env, lockFd)).output
}

export async function queueMessageWithStatus(socketPath, threadId, message, env = process.env, lockFd) {
  if (message.length > MAX_QUEUE_CHARS) {
    throw new Error(`Message is ${message.length} characters. codex queue takes at most ${MAX_QUEUE_CHARS}.`)
  }
  const status = await assertNoPendingApproval(socketPath, threadId)
  return new Promise((resolve, reject) => {
    const codex = resolveCodex(env)
    const child = spawn(codex, ['queue', '--remote', `unix://${socketPath}`, '--thread', threadId, '--message', message], {
      env,
      // Keep the lease if a caller times out while the queue process still runs.
      stdio: ['ignore', 'pipe', 'pipe', ...(lockFd === undefined ? [] : [lockFd])],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', c => (out += c))
    child.stderr.on('data', c => (err += c))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ output: out.trim(), status })
      else reject(new Error(`codex queue exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

// Recheck the live status after resolution. A list result can predate an approval prompt.
async function assertNoPendingApproval(socketPath, threadId) {
  const client = await connectAppServer(socketPath)
  try {
    const read = await client.request('thread/read', { threadId })
    const status = read.thread?.status
    const known = ['active', 'idle', 'notLoaded', 'systemError'].includes(status?.type)
    if (!known || (status.type === 'active' && !Array.isArray(status.activeFlags))) {
      throw new Error(`cannot check ${threadAlias({ id: threadId })} status. Message not queued.`)
    }
    if (status.activeFlags?.includes('waitingOnApproval')) {
      throw new Error(`${threadAlias({ id: threadId })} awaits approval. Message not queued. Resolve the approval prompt before sending.`)
    }
    if (status.type === 'systemError') {
      const error = await readLastTurnError(client, threadId)
      throw new Error(`${threadAlias({ id: threadId })} status is systemError. ${lastTurnErrorText(error)} Message not queued.`)
    }
    return status.type
  } finally {
    client.close()
  }
}
