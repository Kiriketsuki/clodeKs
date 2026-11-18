import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { listThreads } from '../lib/appserver.mjs'
import { deliverMessage } from '../lib/messages.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const SENDER = 'uds:/tmp/sender.sock'
const KEY = createHash('sha256').update(SENDER).digest('hex')
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const entry = (id, text, sender = KEY) => ({ id, input: [{ type: 'text', text, text_elements: [] }],
  responsesapiClientMetadata: sender === null ? null : { clodeks_sender_v1: sender } })
const mutations = state => state.server.requests.filter(r => /turn\/steer|queue\/(add|delete|start)|turn\/interrupt/.test(r.method))

async function setup(t, { status = 'active', items = [], override = () => undefined } = {}) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  let queue = [...items]
  const server = await fakeAppServer(socket, async request => {
    const overridden = await override(request)
    if (overridden !== undefined) return overridden
    const thread = { id: ID, cwd: '/test', status: { type: status, ...(status === 'active' ? { activeFlags: [] } : {}) },
      ephemeral: false, canAcceptDirectInput: true }
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread] }
    if (request.method === 'thread/read') return { thread }
    if (request.method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: 'inProgress' }] }
    if (request.method === 'thread/queue/list') return { data: queue, nextCursor: null }
    if (request.method === 'turn/steer') return { turnId: 'turn-1' }
    if (request.method === 'thread/queue/delete') {
      queue = queue.filter(item => item.id !== request.params.queuedSubmissionId)
      return { deleted: true }
    }
    if (request.method === 'thread/queue/add') {
      queue = [...queue, { id: 'new-item', ...request.params }]
      return { queuedSubmission: queue.at(-1) }
    }
  })
  t.after(server.close)
  return { env, socket, server }
}
const send = (state, message = 'A ruling.', options = {}) => deliverMessage(state.socket, ID, message, {
  priority: 'auto', sender: SENDER, env: state.env, ...options,
})

test('queue controls: auto steers an active turn without queueing or interrupting', async t => {
  const state = await setup(t)
  const out = await send(state)
  assert.equal(out.priority, 'auto')
  assert.equal(out.delivery, 'accepted')
  assert.equal(out.steered_turn_id, 'turn-1')
  assert.equal(out.queued_count, 0)
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer'])
})

test('queue controls: auto queues idle input with sender metadata and reports depth', async t => {
  const state = await setup(t, { status: 'idle', items: [entry('older', 'Older.', null)] })
  const out = await send(state)
  assert.equal(out.delivery, 'queued-idle')
  assert.equal(out.queued_submission_id, 'new-item')
  assert.equal(out.queued_count, 2)
  assert.deepEqual(mutations(state).map(r => r.method), ['thread/queue/add'])
  assert.equal(mutations(state)[0].params.responsesapiClientMetadata.clodeks_sender_v1, KEY)
})

test('queue controls: exact pending duplicates stay single and preserve message bytes', async t => {
  const body = '`quoted`\n1) Keep  two spaces.\n'
  const state = await setup(t, { status: 'idle', items: [entry('same', body)] })
  const duplicate = await send(state, body)
  assert.equal(duplicate.delivery, 'duplicate')
  assert.equal(duplicate.queued_submission_id, 'same')
  assert.deepEqual(mutations(state), [])
  const changed = await send(state, body.trimEnd())
  assert.equal(changed.delivery, 'queued-idle')
  assert.deepEqual(mutations(state)[0].params.input[0].text, body.trimEnd())
})

test('queue controls: replacement deletes only this sender snapshot and steers the new ruling', async t => {
  const state = await setup(t, { items: [entry('mine', 'Old.'), entry('other', 'Other.', 'another-sender'), entry('legacy', 'Legacy.', null)] })
  const out = await send(state, 'New.', { replaceQueued: true })
  assert.deepEqual(out.replaced_submission_ids, ['mine'])
  assert.equal(out.queued_count, 2)
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer', 'thread/queue/delete'])
  assert.equal(mutations(state)[1].params.queuedSubmissionId, 'mine')
})

test('queue controls: sender replacement requires an identity before any request', async t => {
  const state = await setup(t)
  await assert.rejects(send(state, 'New.', { replaceQueued: true, sender: undefined }), /sender|reply/)
  assert.deepEqual(state.server.requests, [])
})

test('queue controls: confirmed auto steers suppress exact retries only in that turn and sender', async t => {
  const state = await setup(t)
  assert.equal((await send(state)).delivery, 'accepted')
  assert.equal((await send(state)).delivery, 'duplicate')
  assert.equal((await send(state, 'A ruling.', { sender: 'uds:/tmp/other.sock' })).delivery, 'accepted')
  assert.equal(mutations(state).length, 2)
})

test('queue controls: rejected auto steers fall back without creating a confirmed steer receipt', async t => {
  let attempts = 0
  const state = await setup(t, { override: request => {
    if (request.method === 'turn/steer' && ++attempts === 1) throw new Error('turn changed')
  } })
  assert.equal((await send(state)).delivery, 'queued')
  assert.equal((await send(state, 'A new ruling.')).delivery, 'accepted')
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer', 'thread/queue/add', 'turn/steer'])
})

test('queue controls: discovery counts every queue page and keeps unsupported depth unknown', async t => {
  const state = await setup(t, { override: request => request.method === 'thread/queue/list'
    ? request.params.cursor ? { data: [entry('last', 'Last.')], nextCursor: null }
      : { data: [entry('first', 'First.')], nextCursor: 'next' } : undefined })
  const rows = await listThreads(state.socket, { env: state.env })
  assert.equal(rows[0].queued_count, 2)
  const unsupported = await setup(t, { override: request => {
    if (request.method === 'thread/queue/list') throw new Error('unsupported queue API')
  } })
  const missing = await listThreads(unsupported.socket, { env: unsupported.env })
  assert.equal(missing[0].queued_count, null)
  assert.match(missing[0].queued_count_error, /queue/)
})

test('queue controls: malformed queue snapshots cause no send or deletion', async t => {
  for (const page of [{}, { data: [{ id: '' }] }, { data: [{ id: 'same' }, { id: 'same' }] }, { data: [], nextCursor: '' }]) {
    const state = await setup(t, { override: request => request.method === 'thread/queue/list' ? page : undefined })
    await assert.rejects(send(state, 'New.', { replaceQueued: true }), /queue|snapshot|cursor/)
    assert.deepEqual(mutations(state), [])
  }
})

test('queue controls: CLI forwards auto and sender replacement with the peer envelope', async t => {
  const state = await setup(t)
  const child = spawn(process.execPath, [CLI, 'send', '--socket', state.socket, '--priority', 'auto', '--replace-queued',
    '--reply-to', SENDER, '--', ID, 'New ruling.'], { env: state.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let error = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { error += data })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, error)
  assert.equal(JSON.parse(output).priority, 'auto')
  assert.match(mutations(state).at(-1).params.input[0].text, /BEGIN PEER MESSAGE/)
})

test('queue controls: controlled queued sends carry sender tags for later replacement', async t => {
  const state = await setup(t, { status: 'idle' })
  const queued = await send(state, 'Old ruling.', { priority: 'queue', replaceQueued: true })
  assert.equal(queued.delivery, 'queued')
  assert.equal(queued.observed_status, 'idle')
  assert.equal(mutations(state)[0].params.responsesapiClientMetadata.clodeks_sender_v1, KEY)
  const replaced = await send(state, 'New ruling.', { replaceQueued: true })
  assert.deepEqual(replaced.replaced_submission_ids, ['new-item'])
})

test('queue controls: replacement preserves entries that arrive after its snapshot', async t => {
  let added = false
  const later = entry('later', 'Concurrent ruling.')
  const state = await setup(t, { items: [entry('old', 'Old ruling.')], override: request => {
    if (request.method === 'thread/queue/delete') added = true
    if (request.method === 'thread/queue/list' && added) return { data: [later], nextCursor: null }
  } })
  const out = await send(state, 'New ruling.', { replaceQueued: true })
  assert.deepEqual(out.replaced_submission_ids, ['old'])
  assert.equal(out.queued_count, 1)
  assert.ok(!mutations(state).some(r => r.params.queuedSubmissionId === 'later'))
})

test('queue controls: partial replacement failure names the accepted input and confirmed deletions', async t => {
  const state = await setup(t, { items: [entry('first', 'First.'), entry('second', 'Second.')], override: request => {
    if (request.method === 'thread/queue/delete' && request.params.queuedSubmissionId === 'second') return { deleted: false }
  } })
  await assert.rejects(send(state, 'New.', { replaceQueued: true }), /Confirmed sender replacements: first.*second.*unconfirmed/s)
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer', 'thread/queue/delete', 'thread/queue/delete'])
})

test('queue controls: a later active turn can receive the same ruling again', async t => {
  let turn = 'turn-1'
  const state = await setup(t, { override: request => {
    if (request.method === 'thread/turns/list') return { data: [{ id: turn, status: 'inProgress' }] }
    if (request.method === 'turn/steer') return { turnId: turn }
  } })
  assert.equal((await send(state)).delivery, 'accepted')
  turn = 'turn-2'
  assert.equal((await send(state)).delivery, 'accepted')
  assert.equal(mutations(state).length, 2)
})

test('queue controls: blocked auto input never mutates a queue or turn', async t => {
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput', 'futureFlag']) {
    const state = await setup(t, { override: request => request.method === 'thread/read' ? { thread: {
      id: ID, status: { type: 'active', activeFlags: [flag] }, ephemeral: false,
    } } : undefined })
    await assert.rejects(send(state, 'New.', { replaceQueued: true }), /approval|user input|unknown/)
    assert.deepEqual(mutations(state), [])
  }
})

test('queue controls: concurrent exact auto steers cannot both reach the server', async t => {
  let release
  let entered
  let calls = 0
  const arrived = new Promise(resolve => { entered = resolve })
  const state = await setup(t, { override: request => {
    if (request.method === 'turn/steer' && ++calls === 1) {
      entered()
      return new Promise(resolve => { release = () => resolve({ turnId: 'turn-1' }) })
    }
  } })
  const first = send(state)
  await arrived
  try {
    await assert.rejects(send(state), /unconfirmed|pending|progress/)
  } finally { release() }
  assert.equal((await first).delivery, 'accepted')
  assert.equal(mutations(state).length, 1)
})

test('queue controls: an idle explicit steer never deletes queued replacements', async t => {
  const state = await setup(t, { status: 'idle', items: [entry('old', 'Old.')] })
  await assert.rejects(send(state, 'New.', { priority: 'steer', replaceQueued: true }), /active/)
  assert.deepEqual(mutations(state), [])
})

test('queue controls: an unconfirmed auto steer never repeats in the same turn', async t => {
  const state = await setup(t, { override: request => request.method === 'turn/steer' ? { turnId: 'wrong-turn' } : undefined })
  await assert.rejects(send(state), /unconfirmed/)
  await assert.rejects(send(state), /unconfirmed/)
  assert.equal(mutations(state).length, 1)
})

test('queue controls: concurrent exact idle sends cannot both enqueue', async t => {
  let release
  let entered
  let calls = 0
  const arrived = new Promise(resolve => { entered = resolve })
  const state = await setup(t, { status: 'idle', override: request => {
    if (request.method === 'thread/queue/add' && ++calls === 1) {
      entered()
      return new Promise(resolve => { release = () => resolve({ queuedSubmission: { id: 'first' } }) })
    }
  } })
  const first = send(state)
  await arrived
  try {
    await assert.rejects(send(state), /unconfirmed|pending|progress/)
  } finally { release() }
  assert.equal((await first).delivery, 'queued-idle')
  assert.equal(mutations(state).length, 1)
})

test('queue controls: sender identity hashes absolute socket paths with punctuation', async t => {
  const state = await setup(t)
  assert.equal((await send(state, 'Text.', { sender: "uds:/tmp/sender's socket.sock" })).delivery, 'accepted')
})

test('queue controls: a crashed reservation cannot block a later turn', async t => {
  const { steerReceipt } = await import('../lib/queue.mjs')
  let turn = 'turn-1'
  const state = await setup(t, { override: request => {
    if (request.method === 'thread/turns/list') return { data: [{ id: turn, status: 'inProgress' }] }
    if (request.method === 'turn/steer') return { turnId: turn }
  } })
  const old = steerReceipt(state.socket, ID, 'active:turn-1', KEY, 'A ruling.', state.env)
  old.begin()
  old.failed(false)
  await assert.rejects(send(state), /unconfirmed/)
  turn = 'turn-2'
  assert.equal((await send(state)).delivery, 'accepted')
  assert.equal(mutations(state).length, 1)
})

test('queue controls: every idle queue acknowledgement names its unconfirmed start', async t => {
  for (const priority of ['queue', 'auto', 'interrupt']) {
    const state = await setup(t, { status: 'idle' })
    const out = await send(state, 'Resume after the declined approval.', { priority })
    assert.equal(out.delivery, priority === 'auto' ? 'queued-idle' : 'queued', priority)
    assert.equal(out.observed_status, 'idle', priority)
    assert.equal(out.started_turn_id, null, priority)
    assert.match(out.hint, /start|client|resume/i)
    assert.ok(!mutations(state).some(r => r.method === 'thread/queue/start' || r.method === 'turn/interrupt'))
  }
})


test('queue review: a plain Claude send retains the original queue CLI and raw input', async t => {
  const state = await setup(t, { status: 'idle' })
  const record = join(state.env.XDG_RUNTIME_DIR, 'legacy-args.json')
  const fake = join(state.env.XDG_RUNTIME_DIR, 'legacy-codex.mjs')
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.LEGACY_QUEUE_RECORD, JSON.stringify(process.argv.slice(2)))
`, { mode: 0o700 })
  const body = 'Exact  bytes.\n1) `quoted`\n'
  const child = spawn(process.execPath, [CLI, 'send', '--socket', state.socket, '--raw', '--', ID, body], {
    env: { ...state.env, CLODEKS_CODEX_BIN: fake, LEGACY_QUEUE_RECORD: record,
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude-default.sock' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let error = ''
  child.stderr.on('data', data => { error += data })
  child.stdout.resume()
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, error)
  assert.equal(existsSync(record), true, 'plain sends must use the original CLI path')
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')),
    ['queue', '--remote', `unix://${state.socket}`, '--thread', ID, '--message', body])
  assert.deepEqual(mutations(state), [])
})

test('queue review: relative uds routes retain explicit and auto delivery', async t => {
  for (const priority of ['steer', 'auto']) {
    const state = await setup(t)
    assert.equal((await send(state, 'Relative route.', { priority, sender: 'uds:relative.sock' })).delivery, 'accepted')
  }
})

test('queue review: a rejected auto steer queues once without losing its input', async t => {
  const state = await setup(t, { override: request => {
    if (request.method === 'turn/steer') throw new Error('expected turn changed before acceptance')
  } })
  const out = await send(state)
  assert.match(out.delivery, /^queued/)
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer', 'thread/queue/add'])
})

test('queue review: auto queues when the observed active turn becomes idle', async t => {
  let reads = 0
  const state = await setup(t, { override: request => request.method === 'thread/read' && ++reads > 1
    ? { thread: { id: ID, status: { type: 'idle' }, ephemeral: false, canAcceptDirectInput: true } } : undefined })
  const out = await send(state)
  assert.match(out.delivery, /^queued/)
  assert.deepEqual(mutations(state).map(r => r.method), ['thread/queue/add'])
})

test('queue review: failed replacement delivery preserves every earlier queue item', async t => {
  for (const priority of ['steer', 'queue']) {
    const method = priority === 'steer' ? 'turn/steer' : 'thread/queue/add'
    const state = await setup(t, { items: [entry('old', 'Old.'), entry('other', 'Other.', 'other-sender')], override: request => {
      if (request.method === method) throw new Error('new ruling failed')
    } })
    await assert.rejects(send(state, 'New.', { priority, replaceQueued: true }), /new ruling failed/)
    assert.deepEqual(mutations(state).map(r => r.method), [method])
    assert.equal((await listThreads(state.socket, { env: state.env }))[0].queued_count, 2)
  }
})

test('queue review: a missing receipt during cleanup never replaces the result', async () => {
  const { steerReceipt } = await import('../lib/queue.mjs')
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, () => ({}))
  try {
    const receipt = steerReceipt(socket, ID, 'test-generation', KEY, 'Ruling.', env)
    receipt.begin()
    const folder = join(env.XDG_RUNTIME_DIR, 'clodeks', 'send-receipts')
    for (const file of readdirSync(folder)) unlinkSync(join(folder, file))
    assert.doesNotThrow(() => receipt.failed(true))
  } finally { await server.close() }
})

test('queue review: fallback never queues a ruling already accepted in the observed turn', async t => {
  for (const transition of ['ended', 'became-idle']) {
    let phase = 0
    let reads = 0
    const state = await setup(t, { override: request => {
      if (phase && transition === 'ended' && request.method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: 'completed' }] }
      if (phase && transition === 'became-idle' && request.method === 'thread/read' && ++reads > 1) {
        return { thread: { id: ID, status: { type: 'idle' }, ephemeral: false, canAcceptDirectInput: true } }
      }
    } })
    assert.equal((await send(state)).delivery, 'accepted')
    phase = 1
    assert.equal((await send(state)).delivery, 'duplicate', transition)
    assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer'])
  }
})

test('queue review: auto queues an unsent ruling after an idle generation changes', async t => {
  const state = await setup(t, { status: 'idle', override: (() => {
    let turns = 0
    return request => request.method === 'thread/turns/list'
      ? { data: [{ id: ++turns === 1 ? 'turn-1' : 'turn-2', status: 'completed' }] } : undefined
  })() })
  const out = await send(state)
  assert.equal(out.delivery, 'queued-idle')
  assert.deepEqual(mutations(state).map(r => r.method), ['thread/queue/add'])
})


test('queue review: receipt close failures never replace the delivery outcome', async t => {
  const { steerReceipt } = await import('../lib/queue.mjs')
  const state = await setup(t)
  const receipt = steerReceipt(state.socket, ID, 'close-failure', KEY, 'Ruling.', state.env)
  receipt.begin()
  const original = fs.closeSync
  const blocked = t.mock.method(fs, 'closeSync', fd => {
    original(fd)
    throw Object.assign(new Error('simulated close failure'), { code: 'EIO' })
  })
  syncBuiltinESMExports()
  try {
    assert.doesNotThrow(() => receipt.failed(true))
  } finally {
    blocked.mock.restore()
    syncBuiltinESMExports()
  }
})
