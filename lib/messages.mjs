import { randomUUID } from 'node:crypto'

import { connectAppServer, MAX_QUEUE_CHARS, queueMessageWithStatus, threadAlias } from './appserver.mjs'

import { exactQueueItem, ownedQueueItem, queueSender, readQueueSnapshot, SENDER_KEY, steerReceipt } from './queue.mjs'
import { lastTurnErrorText, readLastTurnError } from './thread-error.mjs'

export const INTERRUPT_BUDGET_MS = 30000

const result = (priority, delivery, interrupted = null, queued = null, started = null) => ({
  priority, delivery, interrupted_turn_id: interrupted, queued_submission_id: queued, started_turn_id: started,
})

function queuedResult(priority, status, id = null) {
  return { ...result(priority, status === 'idle' && priority === 'auto' ? 'queued-idle' : 'queued', null, id), observed_status: status,
    ...(status === 'idle' ? { hint: 'Input was queued after an idle status check. A turn start is unconfirmed. Resume the thread in its owning client.' } : {}) }
}

async function readSendable(client, threadId, deadlineMs = Infinity) {
  const { thread } = await client.request('thread/read', { threadId }, { deadlineMs })
  const status = thread?.status
  if (thread?.id !== threadId || !['active', 'idle', 'notLoaded', 'systemError'].includes(status?.type) ||
      (status.type === 'active' && !Array.isArray(status.activeFlags)) ||
      (status.activeFlags !== undefined && (!Array.isArray(status.activeFlags) || status.activeFlags.some(f => typeof f !== 'string')))) {
    throw new Error('cannot verify thread status. Urgent input was not sent.')
  }
  const flags = status.activeFlags ?? []
  if (flags.includes('waitingOnApproval')) throw new Error('thread awaits approval. Resolve the owning client prompt before direct delivery.')
  if (flags.includes('waitingOnUserInput')) throw new Error('thread awaits user input. Resolve the owning client prompt before direct delivery.')
  if (flags.length) throw new Error('thread has an unknown active status flag. Urgent input was not sent.')
  if (status.type === 'notLoaded') throw new Error('thread is not loaded. Urgent input was not sent.')
  if (status.type === 'systemError') {
    const error = await readLastTurnError(client, threadId, { deadlineMs })
    throw new Error(`thread status is systemError. ${lastTurnErrorText(error)} Urgent input was not sent.`)
  }
  if (thread.ephemeral !== false || thread.canAcceptDirectInput === false) {
    throw new Error('thread cannot accept persistent direct input. Urgent input was not sent.')
  }
  return status.type
}

async function newestTurn(client, threadId, deadlineMs = Infinity) {
  const page = await client.request('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
  }, { deadlineMs })
  const turn = page.data?.[0]
  if (!Array.isArray(page.data) || page.data.length !== 1 || typeof turn?.id !== 'string' || !turn.id ||
      !['inProgress', 'interrupted', 'completed', 'failed'].includes(turn.status)) {
    throw new Error('cannot identify the active turn. Urgent input was not sent.')
  }
  return turn
}

async function confirmInterrupted(client, threadId, turnId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  do {
    const turn = await newestTurn(client, threadId, deadline)
    if (turn.id !== turnId) throw new Error('the active turn changed during interrupt confirmation')
    if (['completed', 'failed'].includes(turn.status)) throw new Error(`target turn ${turnId} ended as ${turn.status}`)
    const status = await readSendable(client, threadId, deadline)
    if (turn.status === 'interrupted' && status === 'idle') return
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
  } while (Date.now() <= deadline)
  throw new Error(`could not confirm that turn ${turnId} is interrupted and idle`)
}

async function addUrgent(client, threadId, message) {
  const added = await client.request('thread/queue/add', {
    threadId, input: [{ type: 'text', text: message, text_elements: [] }], clientUserMessageId: randomUUID(),
  })
  const id = added.queuedSubmission?.id
  if (typeof id !== 'string' || !id) throw new Error('queue response has no submission ID')
  return id
}

async function queueSnapshot(client, threadId, firstPage) {
  return (await readQueueSnapshot(client, threadId, { firstPage })).map(item => item.id)
}

async function deleteSnapshot(client, threadId, ids, cleared) {
  for (const id of ids) {
    await readSendable(client, threadId)
    try {
      const response = await client.request('thread/queue/delete', { threadId, queuedSubmissionId: id })
      if (response.deleted !== true) throw new Error('server did not confirm deletion')
    } catch (err) {
      throw new Error(`Queue item ${id} deletion is unconfirmed. ${err.message}`, { cause: err })
    }
    cleared.push(id)
  }
}

// The interrupt reply precedes terminal bookkeeping. Confirm status before adding urgent input.
// https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/bespoke_event_handling.rs#L1271
async function interruptAndDeliver(client, threadId, message, confirmationMs, clearQueue, cleared) {
  const queue = await client.request('thread/queue/list', { threadId, limit: clearQueue ? 100 : 1 })
  if (!Array.isArray(queue.data)) throw new Error('cannot verify the queue service. Turn was not interrupted.')
  const snapshot = clearQueue ? await queueSnapshot(client, threadId, queue) : []
  const turn = await newestTurn(client, threadId)
  if (turn.status !== 'inProgress') throw new Error('no active turn is available to interrupt')
  if (await readSendable(client, threadId) !== 'active') throw new Error('thread became idle before the interrupt')
  if (clearQueue) {
    await deleteSnapshot(client, threadId, snapshot, cleared)
    if (await readSendable(client, threadId) !== 'active') throw new Error('thread became idle during queue clearing')
  }
  let interrupted = false
  let queuedId = null
  try {
    await client.request('turn/interrupt', { threadId, turnId: turn.id })
    await confirmInterrupted(client, threadId, turn.id, confirmationMs)
    interrupted = true
    // Interrupted threads do not dispatch queue additions automatically. Start the selected item.
    // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/ext/queue/src/service.rs#L511
    queuedId = await addUrgent(client, threadId, message)
    if (await readSendable(client, threadId) !== 'idle') throw new Error('another turn started before urgent input')
    const started = await client.request('thread/queue/start', { threadId, queuedSubmissionId: queuedId })
    if (typeof started.turn?.id !== 'string' || !started.turn.id || started.turn.status !== 'inProgress') {
      throw new Error('urgent turn start has no confirmed turn ID')
    }
    return result('interrupt', 'started', turn.id, queuedId, started.turn.id)
  } catch (err) {
    if (!interrupted) {
      throw new Error(`Interrupt outcome for turn ${turn.id} is unconfirmed. Urgent input was not queued. ${err.message}`, { cause: err })
    }
    const queued = queuedId ? `Urgent queue item ${queuedId} has no confirmed start.` : 'Urgent queue delivery is unconfirmed.'
    throw new Error(`Interrupted turn ${turn.id}. ${queued} ${err.message}`, { cause: err })
  }
}

// Acceptance buffers input in the same turn. It does not confirm that the model read it.
// https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/session/turn_input.rs#L961
async function steerActiveTurn(client, threadId, message, status, receiptOptions, targetTurn) {
  if (status !== 'active') throw new Error('steer requires an active turn. Input was not sent.')
  const turn = targetTurn ?? await newestTurn(client, threadId)
  if (turn.status !== 'inProgress') throw Object.assign(new Error('no active turn is available to steer'), { safeToQueue: true })
  if (await readSendable(client, threadId) !== 'active') throw Object.assign(new Error('thread became idle before steering. Input was not sent.'), { safeToQueue: true })
  const receipt = receiptOptions ? steerReceipt(receiptOptions.socket, threadId, turn.id,
    receiptOptions.sender, message, receiptOptions.env) : null
  if (receipt?.confirmed) return { ...result('auto', 'duplicate'), steered_turn_id: turn.id }
  receipt?.begin()
  try {
    const accepted = await client.request('turn/steer', {
      threadId, expectedTurnId: turn.id,
      input: [{ type: 'text', text: message, text_elements: [] }], clientUserMessageId: randomUUID(),
    })
    if (accepted?.turnId !== turn.id) throw new Error('steer response does not confirm the targeted turn ID')
    return { ...result('steer', 'accepted'), steered_turn_id: turn.id,
      ...(receipt ? { duplicate_receipt_saved: receipt.save() } : {}) }
  } catch (err) {
    const cleaned = receipt?.failed(err.rpcRejected === true)
    throw Object.assign(new Error(`Steer outcome for turn ${turn.id} is unconfirmed. No fallback was attempted. ${err.message}` +
      (cleaned === false ? ' Receipt cleanup failed. Inspect the turn before retrying.' : ''), { cause: err }), { safeToQueue: err.rpcRejected === true })
  }
}

export async function deliverMessage(socket, threadId, message, {
  priority = 'queue', clearQueue = false, replaceQueued = false, sender, env = process.env, lockFd, confirmationMs = 2000, deadlineMs = Date.now() + INTERRUPT_BUDGET_MS,
} = {}) {
  if (!['queue', 'interrupt', 'steer', 'auto'].includes(priority)) throw new Error('priority must be queue, interrupt, steer, or auto')
  if (typeof replaceQueued !== 'boolean') throw new Error('replaceQueued must be boolean')
  const senderId = priority === 'auto' || replaceQueued ? queueSender(sender) : null
  if (replaceQueued && !senderId) throw new Error('sender replacement requires a resolved reply route')
  if (replaceQueued && (clearQueue || priority === 'interrupt')) throw new Error('sender replacement cannot combine with interrupt or clearQueue')
  if (typeof clearQueue !== 'boolean') throw new Error('clearQueue must be boolean')
  if (clearQueue && priority !== 'interrupt') throw new Error('clearQueue requires interrupt priority')
  if (typeof message !== 'string' || !message.trim()) throw new Error('empty message')
  if (message.length > MAX_QUEUE_CHARS) throw new Error(`message exceeds ${MAX_QUEUE_CHARS} characters`)
  if (priority === 'auto' || replaceQueued) {
    return controlledDelivery(socket, threadId, message, { priority, replaceQueued, sender: senderId, env, deadlineMs })
  }
  if (priority === 'queue') {
    const queued = await queueMessageWithStatus(socket, threadId, message, env, lockFd)
    return queuedResult(priority, queued.status)
  }
  const client = await connectAppServer(socket, { deadlineMs })
  const cleared = []
  const delivered = value => clearQueue ? { ...value, cleared_submission_ids: cleared } : value
  try {
    const status = await readSendable(client, threadId)
    if (priority === 'steer') return await steerActiveTurn(client, threadId, message, status)
    if (status === 'idle') {
      if (clearQueue) {
        const page = await client.request('thread/queue/list', { threadId, limit: 100 })
        const snapshot = await queueSnapshot(client, threadId, page)
        if (await readSendable(client, threadId) !== 'idle') throw new Error('thread became active before queue clearing')
        await deleteSnapshot(client, threadId, snapshot, cleared)
        if (await readSendable(client, threadId) !== 'idle') throw new Error('thread became active during queue clearing')
      }
      try {
        return delivered(queuedResult(priority, 'idle', await addUrgent(client, threadId, message)))
      } catch (err) {
        throw new Error(`Urgent queue delivery is unconfirmed. ${err.message}`, { cause: err })
      }
    }
    return delivered(await interruptAndDeliver(client, threadId, message, confirmationMs, clearQueue, cleared))
  } catch (err) {
    const progress = clearQueue ? `Confirmed queue deletions: ${cleared.join(', ') || 'none'}. ` : ''
    throw new Error(`${threadAlias({ id: threadId })}: ${progress}${err.message}`, { cause: err })
  } finally {
    client.close()
  }
}


async function deliveryGeneration(client, threadId, status) {
  const page = await client.request('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
  })
  if (!Array.isArray(page?.data) || page.data.length > 1) throw new Error('cannot identify delivery generation')
  if (status === 'idle' && page.data.length === 0) return { generation: 'idle:new', turn: null }
  const turn = page.data[0]
  if (!turn || typeof turn.id !== 'string' || !turn.id ||
      !['inProgress', 'interrupted', 'completed', 'failed'].includes(turn.status)) throw new Error('cannot identify active delivery generation')
  return { generation: `${status}:${turn.id}`, turn, ended: status === 'active' && turn.status !== 'inProgress' }
}

async function controlledDelivery(socket, threadId, message, options) {
  const client = await connectAppServer(socket, { deadlineMs: options.deadlineMs, env: options.env })
  const replaced = []
  let reservation
  let reserved = false
  let confirmedDelivery
  try {
    const status = await readSendable(client, threadId)
    if (options.priority === 'steer' && status !== 'active') throw new Error('steer requires an active turn. Input was not sent.')
    const observed = await deliveryGeneration(client, threadId, status)
    const targetTurn = status === 'active' && options.priority !== 'queue' ? observed.turn : null
    if (options.sender) {
      reservation = steerReceipt(socket, threadId, observed.generation, options.sender, message, options.env)
      reservation.begin()
      reserved = true
    }
    const snapshot = await readQueueSnapshot(client, threadId)
    const matching = snapshot.filter(item => ownedQueueItem(item, options.sender))
    if (!options.replaceQueued) {
      const duplicate = snapshot.find(item => exactQueueItem(item, options.sender, message))
      if (duplicate) return { ...result(options.priority, 'duplicate', null, duplicate.id), queued_count: snapshot.length }
    }
    const current = await readSendable(client, threadId)
    if (current !== status && options.priority !== 'auto') throw new Error('thread changed status before controlled delivery. Input was not sent.')
    if (status === 'idle' && current === status && (await deliveryGeneration(client, threadId, current)).generation !== observed.generation && options.priority !== 'auto') {
      throw new Error('idle thread generation changed before delivery. Input was not sent.')
    }
    const priorReceipt = options.priority === 'auto' && status === 'active' && observed.turn
      ? steerReceipt(socket, threadId, observed.turn.id, options.sender, message, options.env) : null
    let delivered
    if (priorReceipt?.confirmed) {
      delivered = { ...result('auto', 'duplicate'), steered_turn_id: observed.turn.id }
    } else if (options.priority === 'auto' && (current !== status || observed.ended)) {
      delivered = { ...await queueControlledInput(client, threadId, message, options), fallback_from: 'steer' }
    } else if (options.priority === 'steer' || (options.priority === 'auto' && status === 'active')) {
      try {
        delivered = await steerActiveTurn(client, threadId, message, status,
          options.priority === 'auto' ? { socket, sender: options.sender, env: options.env } : undefined, targetTurn)
      } catch (err) {
        if (options.priority !== 'auto' || !err.safeToQueue) throw err
        delivered = { ...await queueControlledInput(client, threadId, message, options), fallback_from: 'steer' }
      }
    } else {
      delivered = await queueControlledInput(client, threadId, message, options)
    }
    confirmedDelivery = delivered
    if (options.replaceQueued) await deleteSnapshot(client, threadId, matching.map(item => item.id), replaced)
    let count = null
    try { count = (await readQueueSnapshot(client, threadId)).length } catch { /* Delivery already succeeded. Depth stays unknown. */ }
    return { ...delivered, priority: options.priority, queued_count: count, sender_identified: options.sender !== null,
      ...(options.replaceQueued ? { replaced_submission_ids: replaced } : {}) }
  } catch (err) {
    throw new Error(`${threadAlias({ id: threadId })}: ` +
      (confirmedDelivery ? `New input ${confirmedDelivery.delivery}, queue ID ${confirmedDelivery.queued_submission_id ?? 'none'}. ` : '') +
      `Confirmed sender replacements: ${replaced.join(', ') || 'none'}. ${err.message}`, { cause: err })
  } finally {
    try { if (reserved) reservation.failed(true) } finally { client.close() }
  }
}

async function queueControlledInput(client, threadId, message, options) {
  const status = await readSendable(client, threadId)
  const added = await client.request('thread/queue/add', {
    threadId, input: [{ type: 'text', text: message, text_elements: [] }], clientUserMessageId: randomUUID(),
    ...(options.sender ? { responsesapiClientMetadata: { [SENDER_KEY]: options.sender } } : {}),
  })
  const id = added?.queuedSubmission?.id
  if (typeof id !== 'string' || !id) throw new Error('queue response has no submission ID. Delivery is unconfirmed.')
  return { ...queuedResult(options.priority, status, id), observed_status: status }
}
