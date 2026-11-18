import { createHash } from 'node:crypto'

import { connectAppServer } from './appserver.mjs'

const MAX_PAGES = 100
const BATCH_SIZE = 32
const TERMINAL_STATUS = ['completed', 'interrupted', 'failed']

async function listIds(client, method, params, getId) {
  const ids = new Set()
  const cursors = new Set()
  let cursor
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.request(method, { ...params, ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(response?.data)) throw new Error(`${method} returned no thread list`)
    for (const item of response.data) {
      const id = getId(item)
      if (typeof id !== 'string' || !id || ids.has(id)) throw new Error(`${method} returned an invalid thread ID`)
      ids.add(id)
    }
    cursor = response.nextCursor
    if (cursor == null) return [...ids].sort()
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error(`${method} returned an invalid cursor`)
    cursors.add(cursor)
  }
  throw new Error(`${method} exceeded the page budget`)
}

export const readLoadedIds = client => listIds(client, 'thread/loaded/list', {}, id => id)

async function latestTurn(client, threadId) {
  const response = await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
  if (!Array.isArray(response?.data) || response.data.length > 1) throw new Error('latest turn is unavailable')
  if (response.data.length === 0) return null
  const [turn] = response.data
  if (typeof turn?.id !== 'string' || !turn.id || !TERMINAL_STATUS.includes(turn.status)) {
    throw new Error('cannot verify the latest terminal turn')
  }
  return [turn.id, turn.status, turn.completedAt ?? null]
}

async function orderedBatches(items, read) {
  const results = []
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    results.push(...await Promise.all(items.slice(offset, offset + BATCH_SIZE).map(read)))
  }
  return results
}

async function readIdleStatus(client, threadId) {
  const { thread } = await client.request('thread/read', { threadId, includeTurns: false })
  if (thread?.id !== threadId) throw new Error('thread read returned a different thread')
  const status = thread.status
  if (status?.type === 'active' && Array.isArray(status.activeFlags) && status.activeFlags.every(flag => typeof flag === 'string')) {
    return { reason: status.activeFlags.includes('waitingOnApproval') ? 'pending-approvals' : 'working-threads' }
  }
  if (status?.type === 'idle') {
    return { ephemeral: thread.ephemeral === true }
  }
  throw new Error('loaded thread status is unavailable')
}

async function scan(client, minLoaded, readQueue) {
  const loaded = await readLoadedIds(client)
  const count = loaded.length
  if (count < minLoaded) return { count, reason: 'below-threshold' }
  const statuses = await orderedBatches(loaded, id => readIdleStatus(client, id))
  if (statuses.some(s => s.reason === 'pending-approvals')) return { count, reason: 'pending-approvals' }
  if (statuses.some(s => s.reason === 'working-threads')) return { count, reason: 'working-threads' }
  const ephemeral = new Set(loaded.filter((_, i) => statuses[i].ephemeral))

  const queue = await readQueue()
  const turns = await orderedBatches(loaded, async id => {
    const status = await readIdleStatus(client, id)
    if (status.reason || status.ephemeral !== ephemeral.has(id)) throw new Error('loaded thread changed during the scan')
    // Codex uses the read time for ephemeral updatedAt. The loaded IDs include these threads.
    return status.ephemeral ? ['ephemeral'] : latestTurn(client, id)
  })
  const finalIds = await readLoadedIds(client)
  if (finalIds.length !== count || finalIds.some((id, i) => id !== loaded[i])) throw new Error('loaded threads changed during the scan')
  const signature = createHash('sha256').update(JSON.stringify([loaded, turns])).digest('hex')
  return { count, signature, queue }
}

export async function scanRecycleState(socket, { minLoaded, env, budgetMs, readQueue }) {
  const client = await connectAppServer(socket, { deadlineMs: Date.now() + budgetMs, env })
  try {
    return { ...await scan(client, minLoaded, readQueue), codexHome: client.codexHome }
  } finally {
    client.close()
  }
}

export async function countLoadedForRecycle(socket, { env, budgetMs }) {
  const client = await connectAppServer(socket, { deadlineMs: Date.now() + budgetMs, env })
  try { return (await readLoadedIds(client)).length } finally { client.close() }
}
