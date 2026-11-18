import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { queueMessage, summarizeThread } from '../lib/appserver.mjs'
import { serveInbox } from '../lib/inbox.mjs'
import { sendToClaude } from '../lib/peers.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const WAITING = { type: 'active', activeFlags: ['waitingOnApproval'] }

function thread(status) {
  return { id: ID, cwd: '/test', status, preview: 'test' }
}

async function setup(t, handle) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, handle)
  t.after(server.close)
  return { env, socket, server }
}

test('approval send: thread summaries retain active flags', () => {
  const summary = summarizeThread(thread(WAITING), new Set([ID]))
  assert.equal(summary.status, 'active')
  assert.deepEqual(summary.active_flags, ['waitingOnApproval'])
  assert.deepEqual(summarizeThread(thread({ type: 'idle' }), new Set([ID])).active_flags, [])
})

test('approval send: a current approval wait refuses the queue command', async t => {
  const { env, socket, server } = await setup(t, () => ({ thread: thread(WAITING) }))
  await assert.rejects(queueMessage(socket, ID, 'stop', env), /awaits approval.*not queued/)
  assert.deepEqual(server.requests.map(r => r.method), ['initialize', 'thread/read'])
  assert.deepEqual(server.requests[1].params, { threadId: ID })
})

test('approval send: idle and active threads still receive messages', async t => {
  for (const status of [{ type: 'idle' }, { type: 'active', activeFlags: [] }]) {
    const { env, socket, server } = await setup(t, () => ({ thread: thread(status) }))
    const result = JSON.parse(await queueMessage(socket, ID, 'continue', env))
    assert.deepEqual(result, ['queue', '--remote', `unix://${socket}`, '--thread', ID, '--message', 'continue'])
    assert.deepEqual(server.requests.map(r => r.method), ['initialize', 'thread/read'])
  }
})

test('approval send: a failed state read refuses the queue command', async t => {
  const { env, socket } = await setup(t, request => {
    if (request.method === 'thread/read') throw new Error('test state unavailable')
    return {}
  })
  await assert.rejects(queueMessage(socket, ID, 'continue', env), /thread\/read: test state unavailable/)
})

test('approval send: a missing thread status refuses the queue command', async t => {
  const { env, socket } = await setup(t, () => ({ thread: { id: ID } }))
  await assert.rejects(queueMessage(socket, ID, 'continue', env), /cannot check.*status.*not queued/)
})

test('approval send: CLI rechecks status after thread resolution', async t => {
  const { env, socket } = await setup(t, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread({ type: 'active', activeFlags: [] })] }
    return { thread: thread(WAITING) }
  })
  const child = spawn(process.execPath, [CLI, 'send', '--socket', socket, 'codex-1234abcd', 'stop'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /awaits approval.*not queued/)
})

test('approval send: inbox delivery reports an approval wait without a queue command', async t => {
  const { env, socket } = await setup(t, () => ({ thread: thread(WAITING) }))
  let reportError
  const error = new Promise(resolve => { reportError = resolve })
  const inbox = await serveInbox({
    alias: 'codex-1234abcd', threadId: ID, appSocket: socket,
    onError: reportError,
    onMessage: () => reportError(new Error('message unexpectedly queued')),
  }, env)
  t.after(inbox.close)
  await sendToClaude({ socket: inbox.path, body: 'stop', fromName: 'test' }, env)
  const reported = await Promise.race([
    error,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('no inbox result')), 3000).unref() }),
  ])
  assert.match(reported.message, /awaits approval.*not queued/)
})
