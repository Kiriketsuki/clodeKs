import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createLaunchRecord } from '../lib/launch-record.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const THREAD = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const TURN = 'turn-target'
const ITEM = 'item-target'
const WAIT = { type: 'active', activeFlags: ['waitingOnApproval'] }
const COMMAND = 'item/commandExecution/requestApproval'
const FILE = 'item/fileChange/requestApproval'

async function setup(t) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const bin = join(env.XDG_RUNTIME_DIR, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_TMUX_WINDOWS"\n', { mode: 0o700 })
  env.PATH = bin + ':' + env.PATH
  const state = {
    status: WAIT, turn: TURN, preview: 'An old thread', resumed: false, duration: 31 * 60_000,
    method: COMMAND, kind: 'command', requestId: 'approval-17', command: 'x'.repeat(200) + 'unprinted',
  }
  const replay = (send, id, params = {}) => send({
    id, method: state.method,
    params: {
      threadId: THREAD, turnId: TURN, itemId: ITEM, startedAtMs: Date.now() - state.duration,
      ...(state.method === COMMAND ? { kind: state.kind, command: state.command, availableDecisions: ['accept', 'cancel'] } : {}), ...params,
    },
  })
  const server = await fakeAppServer(socket, ({ method, params }, send) => {
    const thread = { id: THREAD, cwd: '/work', name: 'Thread name', preview: state.preview, status: state.status, ephemeral: false }
    if (method === 'thread/loaded/list') return { data: [THREAD] }
    if (method === 'thread/list') return { data: [thread] }
    if (method === 'thread/read') return { thread }
    if (method === 'thread/turns/list') {
      if (state.recheck) state.recheck(send, replay)
      return { data: [{ id: state.turn, status: 'inProgress' }] }
    }
    if (method === 'thread/items/list') return { data: [
      { turnId: TURN, item: { id: 'different', type: 'fileChange', changes: [{ path: '/work/other' }] } },
      { turnId: TURN, item: { id: ITEM, type: 'fileChange', changes: [{ path: '/work/target' }] } },
    ] }
    if (method === 'thread/resume') {
      assert.equal(params.threadId, THREAD)
      state.resumed = true
      if (state.unrelated) replay(send, 'other-thread', { threadId: 'foreign' })
      replay(send, state.requestId)
      if (state.multiple) replay(send, 'second-target')
      return { thread }
    }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
  }, { onResponse: ({ id, result }, send) => {
    if (result?.decision === 'decline') send({ method: 'serverRequest/resolved', params: { threadId: THREAD, requestId: id } })
  } })
  t.after(server.close)
  const run = (args, overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'pending', ...args, '--socket', socket], {
      env: { ...env, ...overrides }, timeout: 10000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  return { env, state, server, run }
}

test('decline prints precisely one replayed command and answers only that request', async t => {
  const { run, state, server } = await setup(t)
  state.unrelated = true
  const result = await run(['decline', THREAD])
  assert.equal(result.code, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.kind, 'command')
  assert.equal(preview.preview, 'x'.repeat(200))
  assert.equal(preview.request_id, state.requestId)
  assert.ok(preview.age_seconds >= 30 * 60)
  assert.deepEqual(server.responses, [{ jsonrpc: '2.0', id: state.requestId, result: { decision: 'decline' } }])
  assert.equal(server.requests.at(-1).method, 'thread/unsubscribe')
})

test('file dry run previews the exact file item and detaches without a response', async t => {
  const { run, state, server } = await setup(t)
  state.method = FILE
  const result = await run(['decline', THREAD, '--dry-run'])
  assert.equal(result.code, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.kind, 'file')
  assert.equal(preview.preview, '/work/target')
  assert.equal(preview.dry_run, true)
  assert.deepEqual(server.responses, [])
  assert.equal(server.requests.at(-1).method, 'thread/unsubscribe')
})

test('decline requires an explicit thread and refuses working or mixed active flags', async t => {
  const { run, state, server } = await setup(t)
  assert.equal((await run(['decline'])).code, 2)
  assert.equal(server.requests.length, 0)
  for (const activeFlags of [[], ['waitingOnApproval', 'waitingOnUserInput']]) {
    state.status = { type: 'active', activeFlags }
    const result = await run(['decline', THREAD])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /approval wait/i)
  }
  assert.equal(state.resumed, false)
  assert.deepEqual(server.responses, [])
})

test('decline refuses both a matching tmux window and a live launch record', async t => {
  const { env, run, state, server } = await setup(t)
  const alias = 'codex-1234abcd'
  const named = await run(['decline', THREAD], { FAKE_TMUX_WINDOWS: 'unrelated\n' + alias })
  assert.equal(named.code, 1)
  assert.match(named.stderr, /tmux/i)

  const launchId = '01a11f22-ed3b-7b43-9b60-da4912340000'
  createLaunchRecord({ launchId, cwd: '/work', briefPath: '/brief' }, env).identified(alias, THREAD)
  state.preview = '[clodeks launch ' + launchId + ']'
  const live = await run(['decline', THREAD])
  assert.equal(live.code, 1)
  assert.match(live.stderr, /live.*launcher/i)
  state.preview = 'The original launch marker is unavailable'
  const withoutMarker = await run(['decline', THREAD])
  assert.equal(withoutMarker.code, 1)
  assert.match(withoutMarker.stderr, /live.*launcher/i)
  assert.equal(state.resumed, false)
  assert.deepEqual(server.responses, [])
})

test('decline refuses a young or ambiguous replay and sends no decision', async t => {
  const { run, state, server } = await setup(t)
  state.duration = 29 * 60_000
  const young = await run(['decline', THREAD])
  assert.equal(young.code, 1)
  assert.match(young.stderr, /30 minutes/)
  state.duration = 31 * 60_000
  state.multiple = true
  const ambiguous = await run(['decline', THREAD])
  assert.equal(ambiguous.code, 1)
  assert.match(ambiguous.stderr, /exactly one|multiple/i)
  assert.deepEqual(server.responses, [])
})

test('decline leaves human-only and unsupported prompts unanswered', async t => {
  const { run, state, server } = await setup(t)
  state.kind = 'humanCommand'
  assert.match((await run(['decline', THREAD])).stderr, /cannot decline/i)
  state.method = 'item/tool/requestUserInput'
  assert.match((await run(['decline', THREAD])).stderr, /cannot decline/i)
  assert.deepEqual(server.responses, [])
})

for (const changed of ['turn', 'request']) {
  test(`decline refuses a changed ${changed} after it prints the preview`, async t => {
    const { run, state, server } = await setup(t)
    state.recheck = (send, replay) => {
      if (!state.resumed) return
      if (changed === 'turn') state.turn = 'other-turn'
      else {
        send({ method: 'serverRequest/resolved', params: { threadId: THREAD, requestId: state.requestId } })
        replay(send, 'replacement')
      }
    }
    const result = await run(['decline', THREAD])
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).request_id, state.requestId)
    assert.match(result.stderr, /changed/i)
    assert.deepEqual(server.responses, [])
    assert.equal(server.requests.at(-1).method, 'thread/unsubscribe')
  })
}
