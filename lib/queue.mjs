import { createHash } from 'node:crypto'
import { closeSync, ftruncateSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ensurePrivateDir, privateRuntimeDir } from './paths.mjs'
import { socketIdentity } from './umask.mjs'

export const SENDER_KEY = 'clodeks_sender_v1'
const digest = value => createHash('sha256').update(value).digest('hex')

export function queueSender(sender) {
  if (sender === undefined || sender === null) return null
  if (typeof sender !== 'string' || !sender.startsWith('uds:') || sender.length <= 4 || sender.length > 4096 || sender.includes('\0')) {
    throw new Error('sender must be a resolved uds reply route')
  }
  return digest(`uds:${resolve(sender.slice(4))}`)
}

// Pages are observations. Concurrent mutations can change the backend's offset cursors.
export async function readQueueSnapshot(client, threadId, { firstPage, deadlineMs = Infinity } = {}) {
  const items = []
  const ids = new Set()
  const cursors = new Set()
  let page = firstPage ?? await client.request('thread/queue/list', { threadId, limit: 100 }, { deadlineMs })
  for (let count = 0; count < 100; count++) {
    if (!Array.isArray(page?.data)) throw new Error('cannot verify the queue snapshot')
    for (const item of page.data) {
      if (typeof item?.id !== 'string' || !item.id || ids.has(item.id)) {
        throw new Error('queue snapshot has a missing or duplicate submission ID')
      }
      ids.add(item.id)
      items.push(item)
    }
    const cursor = page.nextCursor
    if (cursor === undefined || cursor === null) return items
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('queue snapshot has an invalid pagination cursor')
    cursors.add(cursor)
    page = await client.request('thread/queue/list', { threadId, limit: 100, cursor }, { deadlineMs })
  }
  throw new Error('queue snapshot exceeds 100 pages')
}

export function queueAgeSeconds(createdAtMs, now) {
  return Math.floor(Math.max(0, now - createdAtMs) / 1000)
}

export function queueItemSummary(item, { now, preview }) {
  const id = item.id
  // Codex 0.169.0 uses UUIDv7 submission IDs. The RPC does not expose the creation time.
  // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/state/src/runtime/queued_items.rs#L72-L99
  const timestamp = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
    ? Number.parseInt(id.slice(0, 13).replace('-', ''), 16) : null
  const summary = { submission_id: id, age_seconds: timestamp === null ? null : queueAgeSeconds(timestamp, now) }
  if (preview) {
    const parts = Array.isArray(item.input) ? item.input : []
    const text = parts.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join(' ')
    summary.preview = Array.from(text.slice(0, 160)).slice(0, 80).join('')
  }
  return summary
}

export async function requireIdleQueue(client, threadId) {
  const { thread } = await client.request('thread/read', { threadId, includeTurns: false })
  const status = thread?.status?.type
  if (thread?.id !== threadId) throw new Error('Cannot verify thread identity.')
  if (status === 'active') throw new Error('The thread has an active turn.')
  if (thread.ephemeral !== false || !['idle', 'notLoaded'].includes(status)) {
    throw new Error('Cannot verify a persistent idle thread.')
  }
}

export const ownedQueueItem = (item, sender) => sender !== null && item.responsesapiClientMetadata?.[SENDER_KEY] === sender
export const exactQueueItem = (item, sender, message) => ownedQueueItem(item, sender) &&
  item.input?.length === 1 && item.input[0].type === 'text' && item.input[0].text === message

// A pending receipt prevents concurrent retries. Unknown outcomes remain held until the turn changes.
// These files contain hashes and fixed status text, never the message body.
export function steerReceipt(socket, threadId, turnId, sender, message, env) {
  if (!sender) return { confirmed: false, begin: () => {}, save: () => false, failed: () => {} }
  const identity = socketIdentity(socket)
  if (!identity) throw new Error('cannot verify app-server identity for duplicate checks')
  const folder = ensurePrivateDir(join(privateRuntimeDir(env), 'send-receipts'))
  const path = join(folder, `${digest(JSON.stringify([identity, threadId, turnId, sender, message]))}.json`)
  let confirmed = false
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 9) throw new Error('invalid receipt')
    const text = readFileSync(path, 'utf8')
    if (text === 'pending\n' || text === '') throw new Error('pending')
    confirmed = text === 'accepted\n'
    if (!confirmed) throw new Error('invalid receipt')
  } catch (err) {
    if (err.message === 'pending') throw new Error('an earlier identical auto delivery has an unconfirmed outcome. Inspect that turn before retrying.')
    if (err.code !== 'ENOENT') throw new Error('cannot verify confirmed-delivery receipt')
  }
  let fd
  const close = () => {
    if (fd === undefined) return true
    const handle = fd
    fd = undefined
    try { closeSync(handle); return true } catch { return false }
  }
  return { confirmed,
    begin: () => {
      try {
        fd = openSync(path, 'wx', 0o600)
        writeFileSync(fd, 'pending\n')
      } catch (err) {
        close()
        throw new Error(err.code === 'EEXIST' ? 'an identical auto delivery is already in progress or confirmed' : 'cannot reserve duplicate receipt')
      }
    },
    save: () => {
      try {
        ftruncateSync(fd, 0)
        writeSync(fd, Buffer.from('accepted\n'), 0, 9, 0)
        return true
      } catch { return false } finally { close() }
    },
    failed: rejected => {
      const closed = close()
      if (rejected) {
        try { unlinkSync(path) } catch (err) { return closed && err.code === 'ENOENT' }
      }
      return closed
    },
  }
}
