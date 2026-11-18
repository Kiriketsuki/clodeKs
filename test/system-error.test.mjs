import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { deliverMessage } from '../lib/messages.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const ERROR = '\u001b[31mPolicy blocked\u001b[0m\n\u0007\u0085\u202e the turn'
const SAFE = 'Policy blocked the turn'
const TURN = { id: 'latest', status: 'failed', error: { message: ERROR, additionalDetails: 'PRIVATE_DETAIL' } }

async function setup(t, history = () => ({ data: [TURN] })) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const thread = { id: ID, status: { type: 'systemError' }, cwd: '/test', ephemeral: false }
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread] }
    if (request.method === 'thread/read') return { thread }
    if (request.method === 'thread/turns/list') return history(request)
    if (request.method === 'thread/queue/list') return { data: [], nextCursor: null }
    if (request.method === 'initialize') return {}
    throw new Error('Unexpected mutation: ' + request.method)
  })
  t.after(server.close)
  return { env, socket, server }
}

async function cli(state, args) {
  const child = spawn(process.execPath, [CLI, args[0], '--socket', state.socket, ...args.slice(1)], {
    env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, stdout, stderr }
}

function assertReadOnly(server) {
  assert.ok(server.requests.every(request => ['initialize', 'thread/loaded/list', 'thread/list', 'thread/read',
    'thread/queue/list', 'thread/turns/list'].includes(request.method)))
  const reads = server.requests.filter(request => request.method === 'thread/turns/list')
  assert.ok(reads.length > 0)
  assert.ok(reads.every(request => JSON.stringify(request.params) === JSON.stringify({
    threadId: ID, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
  })))
}

test('system error: JSON threads include only the sanitized latest error message', async t => {
  const state = await setup(t)
  const out = await cli(state, ['threads', '--json'])
  assert.equal(out.code, 0, out.stderr)
  const thread = JSON.parse(out.stdout)[0]
  assert.equal(thread.status, 'systemError')
  assert.equal(thread.last_turn_error, SAFE)
  assert.doesNotMatch(out.stdout, /PRIVATE_DETAIL/)
  assertReadOnly(state.server)
})

test('system error: text threads label error text as untrusted data', async t => {
  const state = await setup(t)
  const out = await cli(state, ['threads'])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /systemError.*Last turn error \(untrusted\): "Policy blocked the turn"/)
  assert.doesNotMatch(out.stdout, /[\x1b\x07\u0085\u202e]|PRIVATE_DETAIL/)
  assertReadOnly(state.server)
})

for (const priority of ['queue', 'interrupt', 'steer', 'auto']) {
  test(`system error: ${priority} delivery refuses with the last error and no mutation`, async t => {
    const state = await setup(t)
    await assert.rejects(deliverMessage(state.socket, ID, 'continue', {
      priority, env: state.env, sender: 'uds:/tmp/caller.sock',
    }), error => {
      assert.match(error.message, /systemError/)
      assert.match(error.message, /Last turn error \(untrusted\): "Policy blocked the turn"/)
      assert.doesNotMatch(error.message, /[\x1b\x07\u0085\u202e]|PRIVATE_DETAIL/)
      return true
    })
    assertReadOnly(state.server)
  })
}

test('system error: the codex_send CLI path refuses the default queue with detail', async t => {
  const state = await setup(t)
  const out = await cli(state, ['send', ID, 'continue'])
  assert.equal(out.code, 1, out.stderr)
  assert.equal(out.stdout, '')
  assert.match(out.stderr, /systemError.*Last turn error \(untrusted\): "Policy blocked the turn"/)
  assertReadOnly(state.server)
})

test('system error: missing, malformed, failed, and timed-out history keep an explicit fallback', async t => {
  for (const history of [() => ({ data: [] }), () => ({ data: [{ ...TURN, error: null }] }),
    () => ({ data: [{ ...TURN, error: { message: 3 } }] }),
    () => ({ data: [{ ...TURN, id: null }] }), () => ({ data: [TURN, TURN] }),
    () => ({ data: [{ ...TURN, error: { message: '\u0000\u202e' } }] }),
    () => { throw new Error('PRIVATE_RPC_FAILURE') }, () => new Promise(() => {})]) {
    const state = await setup(t, history)
    const out = await cli(state, ['threads'])
    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, /systemError.*Last turn error unavailable/)
    await assert.rejects(deliverMessage(state.socket, ID, 'continue', { priority: 'steer' }), /systemError.*Last turn error unavailable/)
    assertReadOnly(state.server)
  }
})

test('system error: error messages have a fixed length and exclude terminal escapes', async t => {
  const error = '\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007 ' + 'x'.repeat(9000)
  const state = await setup(t, () => ({ data: [{ ...TURN, error: { message: error } }] }))
  const out = await cli(state, ['threads', '--json'])
  const message = JSON.parse(out.stdout)[0].last_turn_error
  assert.equal(typeof message, 'string')
  assert.ok(message.length <= 500)
  assert.ok(message.startsWith('link '))
  assert.ok(message.endsWith('...'))
  assert.doesNotMatch(message, /example.invalid|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
})
