import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

import { COMMAND_APPROVAL, connectAppServer, threadAlias } from './appserver.mjs'
import { hasLiveThreadLauncher } from './launch-record.mjs'
import { acquireRecycleLock } from './recycle-lock.mjs'

const exec = promisify(execFile)
const MIN_AGE_MS = 30 * 60_000
const RECOVERY_BUDGET_MS = 15_000
const REPLAY_BUDGET_MS = 3000
const PREVIEW_LIMIT = 200

async function assertNoKnownClient(thread, env) {
  if (hasLiveThreadLauncher(thread.id, env)) {
    throw new Error('A live clodeKs launcher owns this thread.')
  }
  let windows
  try {
    const { stdout } = await exec('tmux', ['list-windows', '-a', '-F', '#{window_name}'], {
      env, encoding: 'utf8', timeout: 1000, maxBuffer: 32768,
    })
    windows = stdout
  } catch (err) {
    if (err.code === 'ENOENT' || /^no server running on /m.test(err.stderr ?? '') ||
        /^error connecting to .* \((?:No such file or directory|Connection refused)\)$/m.test(err.stderr ?? '')) return
    throw new Error('Cannot check tmux windows.', { cause: err })
  }
  const names = [thread.id, threadAlias(thread), thread.name].filter(Boolean)
  if (windows.split(/\r?\n/).some(name => names.includes(name))) {
    throw new Error('A tmux window names this thread.')
  }
}

async function readWaitingTurn(client, threadId, env) {
  const { thread } = await client.request('thread/read', { threadId, includeTurns: false })
  const { type, activeFlags } = thread?.status ?? {}
  if (thread?.id !== threadId || thread.ephemeral !== false || type !== 'active' ||
      !Array.isArray(activeFlags) || activeFlags.length !== 1 || activeFlags[0] !== 'waitingOnApproval') {
    throw new Error('The thread is not in a confirmed approval wait.')
  }
  await assertNoKnownClient(thread, env)
  const { data } = await client.request('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
  })
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.status !== 'inProgress' ||
      typeof data[0].id !== 'string' || !data[0].id) throw new Error('Cannot verify the waiting turn.')
  return data[0].id
}

async function waitFor(predicate, deadlineMs) {
  while (!predicate() && Date.now() < deadlineMs) {
    await sleep(Math.min(25, Math.max(1, deadlineMs - Date.now())))
  }
  return predicate()
}

function approvalAge(startedAtMs) {
  const age = Date.now() - startedAtMs
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0 || age < 0) {
    throw new Error('The replayed approval has no valid start time.')
  }
  if (age < MIN_AGE_MS) throw new Error('The replayed approval is younger than 30 minutes.')
  return Math.floor(age / 1000)
}

async function filePreview(client, { threadId, turnId, itemId }) {
  const { data } = await client.request('thread/items/list', { threadId, turnId, limit: 100, sortDirection: 'desc' })
  const matches = Array.isArray(data) ? data.filter(
    entry => entry?.turnId === turnId && entry.item?.id === itemId && entry.item.type === 'fileChange',
  ) : []
  const changes = matches.length === 1 ? matches[0].item.changes : null
  if (!Array.isArray(changes)) throw new Error('Cannot read the exact file approval preview.')
  return changes.map(change => change?.path).filter(path => typeof path === 'string' && path).join(', ')
}

export async function declinePendingApproval(socket, threadId, { dryRun, print, env = process.env }) {
  const lease = await acquireRecycleLock(socket, { mode: 'exclusive', env })
  if (!lease) throw new Error('Delivery or recycle is in progress. Try again later.')
  const deadlineMs = Date.now() + RECOVERY_BUDGET_MS
  const pending = new Map()
  const resolved = new Set()
  let client
  let attached = false
  try {
    client = await connectAppServer(socket, {
      deadlineMs, env,
      onApprovalReplay: (request, decline) => {
        if (request.params?.threadId === threadId) pending.set(request.id, { request, decline })
      },
    })
    client.onNotification(({ method, params }) => {
      if (method !== 'serverRequest/resolved' || params?.threadId !== threadId) return
      pending.delete(params.requestId)
      resolved.add(params.requestId)
    })

    const turnId = await readWaitingTurn(client, threadId, env)
    attached = true
    const resumed = await client.request('thread/resume', { threadId, excludeTurns: true })
    if (resumed?.thread?.id !== threadId) throw new Error('Resume returned a different thread.')
    await waitFor(() => pending.size > 0, Math.min(deadlineMs, Date.now() + REPLAY_BUDGET_MS))
    if (pending.size !== 1) throw new Error('Recovery requires exactly one replayed approval.')
    const [entry] = pending.values()
    const { request, decline } = entry
    const { params } = request
    if (!decline || params.turnId !== turnId || typeof params.itemId !== 'string' || !params.itemId) {
      throw new Error('Cannot decline this replayed approval.')
    }

    const age = approvalAge(params.startedAtMs)
    const kind = request.method === COMMAND_APPROVAL ? 'command' : 'file'
    const text = kind === 'command' ? params.command : await filePreview(client, params)
    if (typeof text !== 'string' || !text.trim()) throw new Error('The exact approval preview is unavailable.')
    const preview = Array.from(text.slice(0, PREVIEW_LIMIT * 2)).slice(0, PREVIEW_LIMIT).join('')
    await print({ thread_id: threadId, turn_id: turnId, request_id: request.id,
      item_id: params.itemId, kind, preview, age_seconds: age, dry_run: dryRun })
    if (dryRun) return

    if (await readWaitingTurn(client, threadId, env) !== turnId || pending.size !== 1 ||
        pending.get(request.id) !== entry || resolved.has(request.id)) {
      throw new Error('The waiting turn or approval request changed.')
    }
    // Codex lists the default UI choices separately from its command approval response enum.
    decline()
    if (!await waitFor(() => resolved.has(request.id), Math.min(deadlineMs, Date.now() + REPLAY_BUDGET_MS))) {
      throw new Error('The decline response has no confirmation.')
    }
  } finally {
    try {
      if (attached) {
        await client.request('thread/unsubscribe', { threadId }, { deadlineMs: Date.now() + 1000 }).catch(() => {})
      }
    } finally {
      client?.close()
      lease.close()
    }
  }
}
