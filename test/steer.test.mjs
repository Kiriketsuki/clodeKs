import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { deliverMessage } from '../lib/messages.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const TURN = 'active-turn'
const ACTIVE = { type: 'active', activeFlags: [] }
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const thread = status => ({ id: ID, cwd: '/test', status, ephemeral: false, canAcceptDirectInput: true })
const mutations = state => state.server.requests.filter(r => r.method === 'turn/steer' || /interrupt|queue\/(add|start|delete)/.test(r.method))

async function setup(t, override = () => undefined) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, async request => {
    const result = await override(request)
    if (result !== undefined) return result
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread(ACTIVE)] }
    if (request.method === 'thread/read') return { thread: thread(ACTIVE) }
    if (request.method === 'thread/turns/list') return { data: [{ id: TURN, status: 'inProgress' }] }
    if (request.method === 'turn/steer') return { turnId: TURN }
  })
  t.after(server.close)
  return { env, socket, server }
}

const send = (state, options = {}) => deliverMessage(state.socket, ID, 'Correct item 8.', {
  priority: 'steer', env: state.env, ...options,
})

async function cli(state, args) {
  const child = spawn(process.execPath, [CLI, 'send', '--socket', state.socket, ...args], {
    env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, stdout, stderr }
}

test('steer: submit to the exact active turn without queueing or interrupting', async t => {
  const state = await setup(t)
  const result = await send(state)
  assert.equal(result.priority, 'steer')
  assert.equal(result.delivery, 'accepted')
  assert.equal(result.steered_turn_id, TURN)
  assert.equal(result.interrupted_turn_id, null)
  assert.equal(result.queued_submission_id, null)
  assert.equal(result.started_turn_id, null)
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer'])
  const params = mutations(state)[0].params
  assert.equal(params.threadId, ID)
  assert.equal(params.expectedTurnId, TURN)
  assert.deepEqual(params.input, [{ type: 'text', text: 'Correct item 8.', text_elements: [] }])
  assert.match(params.clientUserMessageId, /^[0-9a-f-]{36}$/)
  assert.ok(!state.server.requests.some(r => /queue\/|thread\/resume/.test(r.method)))
})

test('steer: refuse idle, blocked, unloaded, unknown, and restricted thread states', async t => {
  for (const value of [
    thread({ type: 'idle' }), thread({ type: 'notLoaded' }), thread({ type: 'systemError' }),
    thread({ type: 'active', activeFlags: ['waitingOnApproval'] }),
    thread({ type: 'active', activeFlags: ['waitingOnUserInput'] }),
    thread({ type: 'active', activeFlags: ['futureFlag'] }), thread({ type: 'active' }),
    thread({ type: 'unknown' }), { ...thread(ACTIVE), ephemeral: true },
    { ...thread(ACTIVE), canAcceptDirectInput: false }, { ...thread(ACTIVE), id: 'wrong' },
  ]) {
    const state = await setup(t, request => request.method === 'thread/read' ? { thread: value } : undefined)
    await assert.rejects(send(state), /idle|active|approval|user input|not loaded|status|systemError|direct input/)
    assert.deepEqual(mutations(state), [])
  }
})

test('steer: refuse missing, ended, or malformed active turn snapshots', async t => {
  for (const page of [
    { data: [] }, {}, { data: [{ id: '', status: 'inProgress' }] },
    ...['completed', 'interrupted', 'failed', 'unknown'].map(status => ({ data: [{ id: TURN, status }] })),
  ]) {
    const state = await setup(t, request => request.method === 'thread/turns/list' ? page : undefined)
    await assert.rejects(send(state), /active turn/)
    assert.deepEqual(mutations(state), [])
  }
})

test('steer: recheck approval and active status after identifying the turn', async t => {
  for (const status of [{ type: 'active', activeFlags: ['waitingOnApproval'] }, { type: 'idle' }]) {
    let reads = 0
    const state = await setup(t, request => request.method === 'thread/read' && ++reads > 1
      ? { thread: thread(status) } : undefined)
    await assert.rejects(send(state), /approval|idle|active/)
    assert.deepEqual(mutations(state), [])
  }
})

test('steer: turn replacement rejects once without a queue or interrupt fallback', async t => {
  const state = await setup(t, request => {
    if (request.method === 'turn/steer') {
      assert.equal(request.params.expectedTurnId, TURN)
      throw new Error('expected turn differs from the active turn replacement')
    }
  })
  await assert.rejects(send(state), /active-turn.*replacement/s)
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer'])
})

test('steer: unsupported API and malformed acceptance never report success or retry', async t => {
  for (const response of [null, {}, { turnId: '' }, { turnId: 'replacement' }]) {
    const state = await setup(t, request => {
      if (request.method !== 'turn/steer') return
      if (response === null) throw new Error('method not found')
      return response
    })
    await assert.rejects(send(state), /active-turn.*unconfirmed/s)
    assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer'])
  }
})

test('steer: a deadline after submission reports an unconfirmed outcome without retry', async t => {
  const state = await setup(t, request => request.method === 'turn/steer' ? new Promise(() => {}) : undefined)
  await assert.rejects(send(state, { deadlineMs: Date.now() + 1000 }), /active-turn.*unconfirmed.*deadline/s)
  assert.deepEqual(mutations(state).map(r => r.method), ['turn/steer'])
})

test('steer: reject queue clearing and expired budgets before any request', async t => {
  const state = await setup(t)
  await assert.rejects(send(state, { clearQueue: true }), /clear.*interrupt/i)
  await assert.rejects(send(state, { deadlineMs: Date.now() - 1 }), /deadline/)
  assert.deepEqual(state.server.requests, [])
})

test('steer: CLI preserves the peer envelope and exposes API acceptance', async t => {
  const state = await setup(t)
  const out = await cli(state, ['--priority', 'steer', '--reply-to', 'uds:/tmp/test-reply.sock', 'codex-1234abcd', 'Correct item 8.'])
  assert.equal(out.code, 0, out.stderr)
  assert.equal(JSON.parse(out.stdout).delivery, 'accepted')
  assert.equal(JSON.parse(out.stdout).steered_turn_id, TURN)
  const text = mutations(state)[0].params.input[0].text
  assert.match(text, /BEGIN PEER MESSAGE/)
  assert.match(text, /Correct item 8\./)
  assert.match(text, /test-reply.sock/)
})

test('steer: CLI clear-queue validation precedes all requests', async t => {
  const state = await setup(t)
  const out = await cli(state, ['--priority', 'steer', '--clear-queue', ID, 'Correct item 8.'])
  assert.equal(out.code, 2)
  assert.match(out.stderr, /--clear-queue requires --priority interrupt/)
  assert.deepEqual(state.server.requests, [])
})
