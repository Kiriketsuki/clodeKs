import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as appserver from '../lib/appserver.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const OTHER = '01a11f22-ed3b-7b43-9b60-da495678abcd'
const WAITING = { type: 'active', activeFlags: ['waitingOnApproval'] }

async function setup(t, handle) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'initialize') return {}
    return handle(request)
  })
  t.after(server.close)
  return { env, socket, server }
}

async function pendingCli(socket, env) {
  const child = spawn(process.execPath, [CLI, 'pending', '--socket', socket], {
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
  return { code, stdout, stderr }
}

test('pending: reads fresh loaded status without resuming or answering prompts', async t => {
  const { socket, server } = await setup(t, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID, OTHER] }
    if (request.method === 'thread/turns/list') return { data: [] }
    if (request.method === 'thread/read') return { thread: {
      id: request.params.threadId, cwd: '/test', name: 'worker',
      status: request.params.threadId === ID ? WAITING : { type: 'idle' },
    } }
    throw new Error(`Unexpected RPC: ${request.method}`)
  })
  const result = await appserver.listPendingApprovals(socket)
  assert.deepEqual(result.pending, [{
    thread_id: ID, alias: 'codex-1234abcd', name: 'worker', cwd: '/test',
    active_flags: ['waitingOnApproval'], details_available: false,
    request_id: null, resume_command: `clodeks tui --socket '${socket}' -- resume '${ID}'`,
    command_candidates: [], commands_truncated: null, command_details_error: 'Current command history is unavailable.',
  }])
  assert.match(result.hint, /command.*request ID.*unavailable/)
  assert.deepEqual(server.requests.map(r => r.method), [
    'initialize', 'thread/loaded/list', 'thread/read', 'thread/turns/list', 'thread/read',
  ])
  assert.deepEqual(server.requests.filter(r => r.method === 'thread/read').map(r => r.params), [{ threadId: ID }, { threadId: OTHER }])
})

test('pending: excludes ordinary activity and user-input waits', async t => {
  for (const status of [{ type: 'idle' }, { type: 'active', activeFlags: [] }, { type: 'active', activeFlags: ['waitingOnUserInput'] }]) {
    const { socket } = await setup(t, request => request.method === 'thread/loaded/list'
      ? { data: [ID] } : { thread: { id: ID, cwd: '/test', status } })
    assert.deepEqual((await appserver.listPendingApprovals(socket)).pending, [])
  }
})

test('pending: an empty loaded list never reads stored threads', async t => {
  const { socket, server } = await setup(t, () => ({ data: [] }))
  assert.deepEqual((await appserver.listPendingApprovals(socket)).pending, [])
  assert.deepEqual(server.requests.map(r => r.method), ['initialize', 'thread/loaded/list'])
})

test('pending: a failed read does not become an empty successful result', async t => {
  const { socket } = await setup(t, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    throw new Error('test read unavailable')
  })
  await assert.rejects(appserver.listPendingApprovals(socket), /test read unavailable/)
})

test('pending: rejects malformed loaded lists and thread statuses', async t => {
  for (const loaded of [{}, { data: 'bad' }, { data: [null] }]) {
    const { socket } = await setup(t, () => loaded)
    await assert.rejects(appserver.listPendingApprovals(socket), /loaded thread list/)
  }
  for (const thread of [{ id: ID }, { id: OTHER, status: WAITING }, { id: ID, status: { type: 'active' } },
    { id: ID, status: { type: 'active', activeFlags: 'waitingOnApproval' } }, { id: ID, status: { type: 'new-status' } }]) {
    const { socket } = await setup(t, request => request.method === 'thread/loaded/list' ? { data: [ID] } : { thread })
    await assert.rejects(appserver.listPendingApprovals(socket), /cannot check.*status/)
  }
})

test('pending: CLI prints the approval waits and their detail limit', async t => {
  const { socket, env } = await setup(t, request => request.method === 'thread/loaded/list'
    ? { data: [ID] } : { thread: { id: ID, cwd: '/test', status: WAITING } })
  const result = await pendingCli(socket, env)
  assert.equal(result.code, 0, result.stderr)
  const out = JSON.parse(result.stdout)
  assert.equal(out.pending[0].alias, 'codex-1234abcd')
  assert.equal(out.pending[0].details_available, false)
  assert.match(out.hint, /command.*request ID.*unavailable/)
})

test('pending: CLI reports read failures without successful JSON', async t => {
  const { socket, env } = await setup(t, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    throw new Error('test read unavailable')
  })
  const result = await pendingCli(socket, env)
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /test read unavailable/)
})
