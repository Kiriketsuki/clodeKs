import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const TURN = 'active-turn'
const ACTIVE = { type: 'active', activeFlags: [] }
const IDLE = { type: 'idle' }
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const thread = status => ({ id: ID, cwd: '/test', status, preview: 'work', ephemeral: false, canAcceptDirectInput: true })

async function setup(t, override = () => undefined) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  let status = ACTIVE
  let turnStatus = 'inProgress'
  const server = await fakeAppServer(socket, async request => {
    const result = await override(request)
    if (result !== undefined) return result
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread(status)] }
    if (request.method === 'thread/read') return { thread: thread(status) }
    if (request.method === 'thread/turns/list') return { data: [{ id: TURN, status: turnStatus }] }
    if (request.method === 'thread/queue/list') return { data: [{ id: 'older-message' }] }
    if (request.method === 'turn/interrupt') { status = IDLE; turnStatus = 'interrupted'; return {} }
    if (request.method === 'thread/queue/add') return { queuedSubmission: { id: 'urgent-message' } }
    if (request.method === 'thread/queue/start') return { turn: { id: 'urgent-turn', status: 'inProgress' } }
  })
  t.after(server.close)
  return { socket, env, server, setStatus: next => { status = next } }
}

async function send(state, priority = 'interrupt', message = 'Stop and read the merge order.', options = {}) {
  const { deliverMessage } = await import('../lib/messages.mjs')
  return deliverMessage(state.socket, ID, message, { priority, env: state.env, ...options })
}

test('interrupt: abort the exact turn and explicitly start only the urgent queued item', async t => {
  const state = await setup(t)
  const result = await send(state)
  assert.equal(result.delivery, 'started')
  assert.equal(result.interrupted_turn_id, TURN)
  assert.equal(result.started_turn_id, 'urgent-turn')
  const mutation = state.server.requests.filter(r => ['turn/interrupt', 'thread/queue/add', 'thread/queue/start'].includes(r.method))
  assert.deepEqual(mutation.map(r => r.method), ['turn/interrupt', 'thread/queue/add', 'thread/queue/start'])
  assert.deepEqual(mutation[0].params, { threadId: ID, turnId: TURN })
  assert.deepEqual(mutation[2].params, { threadId: ID, queuedSubmissionId: 'urgent-message' })
  assert.equal(mutation[1].params.input[0].text, 'Stop and read the merge order.')
  assert.ok(mutation[1].params.clientUserMessageId)
  assert.ok(!state.server.requests.some(r => ['thread/resume', 'thread/queue/delete', 'thread/queue/reorder'].includes(r.method)))
})

test('interrupt: await the abort acknowledgement before queueing the urgent message', async t => {
  let release
  const ack = new Promise(resolve => { release = resolve })
  let reached
  const requested = new Promise(resolve => { reached = resolve })
  const state = await setup(t, async request => {
    if (request.method !== 'turn/interrupt') return
    reached()
    await ack
  })
  const delivery = send(state)
  await requested
  assert.ok(!state.server.requests.some(r => r.method === 'thread/queue/add'))
  release()
  await delivery
})

test('interrupt: idle threads use normal delivery without an interrupt', async t => {
  const state = await setup(t)
  state.setStatus(IDLE)
  const result = await send(state)
  assert.equal(result.delivery, 'queued')
  assert.equal(result.observed_status, 'idle')
  assert.equal(result.interrupted_turn_id, null)
  assert.ok(!state.server.requests.some(r => r.method === 'turn/interrupt'))
})

test('interrupt: normal priority does not inspect or interrupt the active turn', async t => {
  const state = await setup(t)
  const result = await send(state, 'queue')
  assert.equal(result.delivery, 'queued')
  assert.ok(!state.server.requests.some(r => r.method === 'thread/turns/list' || r.method === 'turn/interrupt'))
})

test('interrupt: refuse approval waits, user-input waits, unloaded threads, and unknown status', async t => {
  for (const status of [
    { type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'active', activeFlags: ['waitingOnUserInput'] },
    { type: 'notLoaded' }, { type: 'systemError' }, { type: 'active' }, { type: 'mystery' },
  ]) {
    const state = await setup(t)
    state.setStatus(status)
    await assert.rejects(send(state), /approval|user input|not loaded|status|systemError/)
    const allowed = status.type === 'systemError' ? ['initialize', 'thread/read', 'thread/turns/list'] : ['initialize', 'thread/read']
    assert.ok(state.server.requests.every(r => allowed.includes(r.method)))
  }
})

test('interrupt: refuse a missing active turn or a turn that already completed', async t => {
  for (const data of [[], [{ id: TURN, status: 'completed' }], [{ status: 'inProgress' }]]) {
    const state = await setup(t, request => request.method === 'thread/turns/list' ? { data } : undefined)
    await assert.rejects(send(state), /active turn/)
    assert.ok(!state.server.requests.some(r => r.method === 'turn/interrupt'))
  }
})

test('interrupt: recheck approval status after reading the turn', async t => {
  let reads = 0
  const state = await setup(t, request => request.method === 'thread/read'
    ? { thread: thread(++reads === 1 ? ACTIVE : { type: 'active', activeFlags: ['waitingOnApproval'] }) } : undefined)
  await assert.rejects(send(state), /approval/)
  assert.ok(!state.server.requests.some(r => r.method === 'turn/interrupt'))
})

test('interrupt: a stale turn rejection never queues or retries another interrupt', async t => {
  const state = await setup(t, request => {
    if (request.method === 'turn/interrupt') throw new Error('expected active turn id but found a newer turn')
  })
  await assert.rejects(send(state), /newer turn/)
  assert.equal(state.server.requests.filter(r => r.method === 'turn/interrupt').length, 1)
  assert.ok(!state.server.requests.some(r => r.method === 'thread/queue/add'))
})

test('interrupt: failed start reports the queued item and the completed interrupt', async t => {
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/start') throw new Error('a newer turn won the race')
  })
  await assert.rejects(send(state), /active-turn.*urgent-message.*newer turn/s)
  assert.equal(state.server.requests.filter(r => r.method === 'thread/queue/add').length, 1)
})

test('interrupt: a missing queue service fails before stopping the turn', async t => {
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/list') throw new Error('queue service unavailable')
  })
  await assert.rejects(send(state), /queue service unavailable/)
  assert.ok(!state.server.requests.some(r => r.method === 'turn/interrupt'))
})

test('interrupt: confirmation waits for delayed terminal bookkeeping without another interrupt', async t => {
  let acknowledged = false
  let reads = 0
  const state = await setup(t, request => {
    if (request.method === 'turn/interrupt') acknowledged = true
    if (request.method === 'thread/turns/list' && acknowledged && ++reads < 3) {
      return { data: [{ id: TURN, status: 'inProgress' }] }
    }
  })
  assert.equal((await send(state)).delivery, 'started')
  assert.equal(state.server.requests.filter(r => r.method === 'turn/interrupt').length, 1)
})

test('interrupt: natural completion and replacement turns never receive urgent input', async t => {
  for (const latest of [{ id: TURN, status: 'completed' }, { id: 'replacement', status: 'inProgress' }]) {
    let acknowledged = false
    const state = await setup(t, request => {
      if (request.method === 'turn/interrupt') acknowledged = true
      if (request.method === 'thread/turns/list' && acknowledged) return { data: [latest] }
    })
    await assert.rejects(send(state), /confirm|changed|completed/)
    assert.ok(!state.server.requests.some(r => r.method === 'thread/queue/add'))
  }
})

test('interrupt: confirmation timeout reports an uncertain stop without queueing input', async t => {
  const state = await setup(t, request => request.method === 'thread/turns/list'
    ? { data: [{ id: TURN, status: 'inProgress' }] } : undefined)
  await assert.rejects(send(state, 'interrupt', 'Stop.', { confirmationMs: 5 }), /confirm/)
  assert.ok(!state.server.requests.some(r => r.method === 'thread/queue/add'))
})

test('interrupt: the operation deadline preserves partial state when start never replies', async t => {
  const state = await setup(t, request => request.method === 'thread/queue/start'
    ? new Promise(() => {}) : undefined)
  await assert.rejects(send(state, 'interrupt', 'Stop.', { deadlineMs: Date.now() + 1000 }),
    /Interrupted turn active-turn.*urgent-message.*deadline/s)
  assert.equal(state.server.requests.filter(r => r.method === 'thread/queue/start').length, 1)
})

test('interrupt: an expired operation budget refuses before any request', async t => {
  const state = await setup(t)
  await assert.rejects(send(state, 'interrupt', 'Stop.', { deadlineMs: Date.now() - 1 }), /deadline/)
  assert.deepEqual(state.server.requests, [])
})

test('interrupt: validate priority and message length before any network mutation', async t => {
  const state = await setup(t)
  await assert.rejects(send(state, 'urgent'), /priority/)
  await assert.rejects(send(state, 'interrupt', 'x'.repeat(100001)), /100000/)
  assert.deepEqual(state.server.requests, [])
})

test('interrupt: CLI exposes priority and preserves the peer reply envelope', async t => {
  const state = await setup(t)
  const child = spawn(process.execPath, [CLI, 'send', '--socket', state.socket, '--priority', 'interrupt',
    '--reply-to', 'uds:/tmp/test-reply.sock', 'codex-1234abcd', 'Stop now'], {
    env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, stderr)
  assert.equal(JSON.parse(stdout).delivery, 'started')
  const queued = state.server.requests.find(r => r.method === 'thread/queue/add')
  assert.match(queued.params.input[0].text, /BEGIN PEER MESSAGE/)
  assert.match(queued.params.input[0].text, /test-reply.sock/)
})

test('interrupt clear: delete every snapshot page before stopping the turn', async t => {
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/list') return request.params.cursor
      ? { data: [{ id: 'old-two' }], nextCursor: null }
      : { data: [{ id: 'old-one' }], nextCursor: 'page-two' }
    if (request.method === 'thread/queue/delete') return { deleted: true }
  })
  const result = await send(state, 'interrupt', 'Report and stop.', { clearQueue: true })
  assert.deepEqual(result.cleared_submission_ids, ['old-one', 'old-two'])
  const mutations = state.server.requests.filter(r => /delete|interrupt|add|start$/.test(r.method))
  assert.deepEqual(mutations.map(r => r.method), ['thread/queue/delete', 'thread/queue/delete', 'turn/interrupt', 'thread/queue/add', 'thread/queue/start'])
  assert.deepEqual(mutations.slice(0, 2).map(r => r.params), [
    { threadId: ID, queuedSubmissionId: 'old-one' }, { threadId: ID, queuedSubmissionId: 'old-two' },
  ])
})

test('interrupt clear: an idle thread clears the snapshot before urgent queue delivery', async t => {
  const state = await setup(t, request => request.method === 'thread/queue/delete' ? { deleted: true } : undefined)
  state.setStatus(IDLE)
  const result = await send(state, 'interrupt', 'Report and stop.', { clearQueue: true })
  assert.deepEqual(result.cleared_submission_ids, ['older-message'])
  assert.equal(result.delivery, 'queued')
  assert.equal(result.observed_status, 'idle')
  assert.ok(!state.server.requests.some(r => r.method === 'turn/interrupt'))
  const mutations = state.server.requests.filter(r => /delete|add/.test(r.method))
  assert.deepEqual(mutations.map(r => r.method), ['thread/queue/delete', 'thread/queue/add'])
})

test('interrupt clear: reject invalid option combinations before any request', async t => {
  const state = await setup(t)
  await assert.rejects(send(state, 'queue', 'Stop.', { clearQueue: true }), /clear.*interrupt/i)
  await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: 'yes' }), /clear.*boolean/i)
  assert.deepEqual(state.server.requests, [])
})

test('interrupt clear: validate the full snapshot before deleting or interrupting', async t => {
  for (const page of [
    { data: [{ id: '' }] }, { data: [{ id: 'same' }, { id: 'same' }] },
    { data: [{ id: 'old' }], nextCursor: 12 },
    { data: [], nextCursor: 'repeat' },
  ]) {
    const state = await setup(t, request => request.method === 'thread/queue/list' ? page : undefined)
    await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: true }), /queue|snapshot|cursor/i)
    assert.ok(!state.server.requests.some(r => ['thread/queue/delete', 'turn/interrupt', 'thread/queue/add'].includes(r.method)))
  }
})

test('interrupt clear: report partial deletion and never stop the turn on a failed clear', async t => {
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/list') return { data: [{ id: 'old-one' }, { id: 'old-two' }] }
    if (request.method === 'thread/queue/delete') {
      if (request.params.queuedSubmissionId === 'old-two') throw new Error('isolated delete failure')
      return { deleted: true }
    }
  })
  await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: true }), /old-one.*old-two.*isolated delete failure/s)
  assert.ok(!state.server.requests.some(r => ['turn/interrupt', 'thread/queue/add'].includes(r.method)))
})

test('interrupt clear: a missing or unconfirmed deletion prevents the interrupt', async t => {
  for (const response of [{ deleted: false }, {}, { deleted: 'true' }]) {
    const state = await setup(t, request => request.method === 'thread/queue/delete' ? response : undefined)
    await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: true }), /older-message.*delet/i)
    assert.ok(!state.server.requests.some(r => ['turn/interrupt', 'thread/queue/add'].includes(r.method)))
  }
})

test('interrupt clear: a new approval after the queue snapshot prevents deletion', async t => {
  let listed = false
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/list') listed = true
    if (request.method === 'thread/read' && listed) return { thread: thread({ type: 'active', activeFlags: ['waitingOnApproval'] }) }
  })
  await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: true }), /approval/)
  assert.ok(!state.server.requests.some(r => ['thread/queue/delete', 'turn/interrupt'].includes(r.method)))
})

test('interrupt clear: a later start failure still names confirmed deletions', async t => {
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/delete') return { deleted: true }
    if (request.method === 'thread/queue/start') throw new Error('isolated start failure')
  })
  await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: true }), /older-message.*Interrupted turn active-turn.*urgent-message.*isolated start failure/s)
})

test('interrupt clear: CLI requires interrupt priority before it connects', async t => {
  const state = await setup(t)
  const child = spawn(process.execPath, [CLI, 'send', '--socket', state.socket, '--clear-queue', ID, 'Stop.'], {
    env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolve => child.once('close', resolve))
  assert.equal(code, 2)
  assert.match(stderr, /--clear-queue requires --priority interrupt/)
  assert.deepEqual(state.server.requests, [])
})

test('interrupt clear: an approval during deletion prevents the later interrupt', async t => {
  let state
  state = await setup(t, request => {
    if (request.method === 'thread/queue/delete') {
      state.setStatus({ type: 'active', activeFlags: ['waitingOnApproval'] })
      return { deleted: true }
    }
  })
  await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: true }), /approval/)
  assert.ok(!state.server.requests.some(r => r.method === 'turn/interrupt'))
})

test('interrupt clear: later submissions remain outside the snapshot', async t => {
  let queued = ['old']
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/list') return { data: queued.map(id => ({ id })) }
    if (request.method === 'thread/queue/delete') {
      queued = queued.filter(id => id !== request.params.queuedSubmissionId).concat('concurrent-new')
      return { deleted: true }
    }
  })
  const result = await send(state, 'interrupt', 'Stop.', { clearQueue: true })
  assert.deepEqual(result.cleared_submission_ids, ['old'])
  assert.deepEqual(queued, ['concurrent-new'])
})

test('interrupt clear: a deletion deadline reports confirmed progress without retry', async t => {
  const state = await setup(t, request => {
    if (request.method === 'thread/queue/list') return { data: [{ id: 'old-one' }, { id: 'old-two' }] }
    if (request.method === 'thread/queue/delete') return request.params.queuedSubmissionId === 'old-one'
      ? { deleted: true } : new Promise(() => {})
  })
  await assert.rejects(send(state, 'interrupt', 'Stop.', { clearQueue: true, deadlineMs: Date.now() + 500 }), /old-one.*old-two.*deadline/s)
  assert.equal(state.server.requests.filter(r => r.method === 'thread/queue/delete').length, 2)
  assert.ok(!state.server.requests.some(r => r.method === 'turn/interrupt'))
})

test('interrupt clear: CLI forwards opt-in deletion and reports its IDs', async t => {
  const state = await setup(t, request => request.method === 'thread/queue/delete' ? { deleted: true } : undefined)
  const child = spawn(process.execPath, [CLI, 'send', '--socket', state.socket, '--priority', 'interrupt', '--clear-queue', ID, 'Stop.'], {
    env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, stderr)
  assert.deepEqual(JSON.parse(stdout).cleared_submission_ids, ['older-message'])
})
