import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'
import { inboxSocketFor, serveInbox } from '../lib/inbox.mjs'
import { buildFrame } from '../lib/peers.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const STORED = '01a11f22-ed3b-7b43-9b60-da491234abce'
const ARCHIVED = '01a11f22-ed3b-7b43-9b60-da491234abcf'
const ALIAS = 'codex-1234abcd'
const IDLE = { type: 'idle' }
const FIVE_MIN = 300_000

async function setup(t) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const state = {
    env, socket, now: 1000, loaded: [ID], status: IDLE,
    turn: { id: 'turn-a', status: 'completed', completedAt: 25 },
    queue: new Map(), generation: 'before', restarts: 0,
  }
  const server = await fakeAppServer(socket, request => {
    const { method, params } = request
    if (state.override) {
      const response = state.override(request)
      if (response !== undefined) return response
    }
    const thread = id => ({ id, cwd: '/test', status: state.status, preview: 'old thread', ephemeral: false })
    if (method === 'thread/loaded/list') return { data: state.loaded }
    if (method === 'thread/list') {
      return { data: (params.archived ? [ARCHIVED] : [ID, STORED]).map(thread) }
    }
    if (method === 'thread/read') return { thread: thread(params.threadId) }
    if (method === 'thread/turns/list') return { data: state.turn ? [state.turn] : [] }
    if (method === 'thread/queue/list') return { data: state.queue.get(params.threadId) ?? [] }
  })
  t.after(server.close)
  const { recycleIfIdle } = await import('../lib/recycle.mjs')
  const run = opts => recycleIfIdle({ socket, env, minLoaded: 1, ...opts }, {
    clock: () => state.now,
    readService: () => ({ generation: state.generation }),
    restart: async () => {
      state.restarts++
      await state.duringRestart?.()
      state.generation = 'after-' + state.restarts
      state.loaded = []
    },
    readBackgroundProcesses: async () => ({
      background: state.background ?? [], allowed: { server_chain: 2, codex_install: 1, cua_node: 2, plugin_cache: 0 },
    }),
    readDurableQueue: async () => {
      state.queueScans = (state.queueScans ?? 0) + 1
      if (state.queueReportError) throw new Error('cannot verify the app-server durable queue')
      const entries = [...state.queue.entries()].flatMap(([thread_id, items]) => items.map(
        ({ id }) => ({ thread_id, submission_id: id, created_at_ms: state.queuedAt }),
      ))
      return { pending_count: entries.length, entries }
    },
    retryDelay: 1,
  })
  return { ...state, state, run, server }
}

async function fillQuiet(run, state) {
  assert.equal((await run()).reason, 'quiet-period')
  state.now += FIVE_MIN
  assert.equal((await run()).reason, 'quiet-period')
  state.now += FIVE_MIN
}

test('recycle requires ten observed quiet minutes and logs both counts', async t => {
  const { run, state } = await setup(t)
  assert.equal((await run({ minLoaded: 10 })).reason, 'below-threshold')
  await fillQuiet(run, state)
  assert.equal((await run({ dryRun: true })).reason, 'eligible')
  assert.equal(state.restarts, 0)
  const result = await run()
  assert.equal(result.outcome, 'recycled')
  assert.equal(result.loaded_before, 1)
  assert.equal(result.loaded_after, 0)
  assert.equal(state.restarts, 1)
  state.loaded = [ID]
  state.now += FIVE_MIN
  assert.equal((await run()).reason, 'cooldown')
  state.now += 12 * FIVE_MIN
  assert.equal((await run()).reason, 'quiet-period')
})

for (const [name, setupBusy, reason] of [
  ['working thread', s => { s.status = { type: 'active', activeFlags: [] } }, 'working-threads'],
  ['approval', s => { s.status = { type: 'active', activeFlags: ['waitingOnApproval'] } }, 'pending-approvals'],
  ['unknown thread status', s => { s.status = { type: 'unknown' } }, 'scan-unavailable'],
  ['unknown queue', s => { s.queueReportError = true }, 'scan-unavailable'],
  ['incomplete pagination', s => {
    s.override = r => r.method === 'thread/loaded/list' ? { data: [], nextCursor: 'duplicate' } : undefined
  }, 'scan-unavailable'],
]) {
  test('recycle refuses ' + name + ' and resets quiet', async t => {
    const { run, state } = await setup(t)
    await fillQuiet(run, state)
    setupBusy(state)
    assert.equal((await run()).reason, reason)
    assert.equal(state.restarts, 0)
    state.status = IDLE
    state.queueReportError = false
    state.override = null
    state.now += 1
    assert.equal((await run()).reason, 'quiet-period')
  })
}

test('durable queue entries are reported without vetoing or resetting quiet time', async t => {
  const { run, state } = await setup(t)
  await fillQuiet(run, state)
  state.queuedAt = Date.now() - 65000
  state.queue.set(ID, [{ id: 'loaded-item' }])
  state.queue.set(STORED, [{ id: 'stored-item' }])
  state.queue.set(ARCHIVED, [{ id: 'archived-item' }])
  const preview = await run({ dryRun: true })
  assert.equal(preview.reason, 'eligible')
  const result = await run()
  assert.equal(result.outcome, 'recycled')
  assert.equal(result.queue.pending_count, 3)
  assert.equal(result.queue.truncated, false)
  assert.deepEqual(result.queue.entries.map(({ thread_id, submission_id }) => [thread_id, submission_id]), [
    [ID, 'loaded-item'], [STORED, 'stored-item'], [ARCHIVED, 'archived-item'],
  ])
  assert.ok(result.queue.entries.every(entry => entry.age_seconds >= 65))
})

for (const [name, change] of [
  ['new server generation', s => { s.generation = 'replacement' }],
  ['missed poll', s => { s.now += FIVE_MIN * 2 }],
  ['turn completed between polls', s => { s.turn = { ...s.turn, id: 'turn-b' } }],
]) {
  test('recycle resets quiet after ' + name, async t => {
    const { run, state } = await setup(t)
    await fillQuiet(run, state)
    change(state)
    assert.equal((await run()).reason, 'quiet-period')
    assert.equal(state.restarts, 0)
  })
}

function cli(env, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stderr.on('data', data => { output += data })
    child.stdout.resume()
    child.once('close', code => resolve({ code, output }))
  })
}

test('an in-flight send prevents recycle and a new CLI send waits through a recycle', { timeout: 4000 }, async t => {
  const { run, state, env, socket, server } = await setup(t)
  const { acquireRecycleLock } = await import('../lib/recycle-lock.mjs')
  await fillQuiet(run, state)
  const shared = await acquireRecycleLock(socket, { env, mode: 'shared' })
  assert.ok(shared)
  try {
    assert.notEqual((await run()).outcome, 'recycled')
    assert.equal(state.restarts, 0)
  } finally {
    shared.close()
  }
  const exclusive = await acquireRecycleLock(socket, { env, mode: 'exclusive' })
  assert.ok(exclusive)
  let result
  const sent = cli(env, ['send', '--socket', socket, ID, 'message']).then(value => { result = value })
  try {
    const previous = server.requests.length
    await sleep(300)
    assert.equal(result, undefined, 'send must wait for the restart lock')
    assert.equal(server.requests.length, previous)
  } finally {
    exclusive.close()
    await sent
  }
  assert.equal(result.code, 0, result.output)
})

test('an ordinary poll lets a send take a shared lease during the scan', { timeout: 3000 }, async t => {
  const { run, state, env, socket } = await setup(t)
  const { acquireRecycleLock } = await import('../lib/recycle-lock.mjs')
  let fullPoll
  const inScan = new Promise(resolve => { fullPoll = resolve })
  let resume
  const barrier = new Promise(resolve => { resume = resolve })
  state.override = ({ method }) => {
    if (method === 'thread/read') {
      fullPoll()
      return barrier.then(() => ({ thread: { id: ID, status: IDLE } }))
    }
  }
  const poll = run()
  try {
    await inScan
    const lease = await acquireRecycleLock(socket, { mode: 'shared', env })
    assert.ok(lease, 'poll must leave shared admission open')
    lease.close()
  } finally {
    resume()
    await poll
  }
})

test('recycle names background processes and leaves them running', async t => {
  const { run, state } = await setup(t)
  await fillQuiet(run, state)
  state.background = [{ pid: 12345, command: 'vite' }]
  const result = await run({ dryRun: true })
  assert.equal(result.reason, 'background-processes')
  assert.deepEqual(result.background_processes, state.background)
  assert.equal(result.allowed_processes.cua_node, 2)
  assert.equal(state.restarts, 0)
})

test('the recycle scan checks durable queue metadata without reading thread history pages', async t => {
  const { run, state, server } = await setup(t)
  assert.equal((await run()).reason, 'quiet-period')
  assert.equal(state.queueScans, 1)
  assert.ok(!server.requests.some(r => r.method === 'thread/list'))
  assert.ok(!server.requests.some(r => r.method === 'thread/queue/list'))
})

test('shared lock setup failure warns once and preserves delivery', async t => {
  const { socket } = await setup(t)
  const { withRecycleDelivery } = await import('../lib/recycle-lock.mjs')
  const env = testEnv({ PATH: '/missing-flock' })
  const warning = []
  for (let i = 0; i < 2; i++) {
    const result = await withRecycleDelivery(socket, async () => 'finished', { env, warn: text => warning.push(text) })
    assert.equal(result, 'finished')
  }
  const locks = join(dirname(socket), '.recycle')
  renameSync(locks, locks + '.old')
  writeFileSync(locks, 'blocked lock directory')
  assert.equal(await withRecycleDelivery(socket, () => 'finished', { warn: text => warning.push(text) }), 'finished')
  assert.equal(warning.length, 1)
  assert.match(warning[0], /recycle lock.*unavailable/i)
})

test('inbox keeps a frame received during recycle until the app-server is ready', async t => {
  const { env, socket, server } = await setup(t)
  const { acquireRecycleLock } = await import('../lib/recycle-lock.mjs')
  let complete
  const delivered = new Promise((resolve, reject) => {
    complete = { resolve, reject }
  })
  const inbox = await serveInbox({ alias: ALIAS, threadId: ID, appSocket: socket,
    onMessage: complete.resolve, onError: complete.reject }, env)
  t.after(inbox.close)
  assert.ok(existsSync(inboxSocketFor(ALIAS, env)))
  const exclusive = await acquireRecycleLock(socket, { env, mode: 'exclusive' })
  try {
    await new Promise((resolve, reject) => {
      const conn = connect(inbox.path, () => {
        conn.end(JSON.stringify(buildFrame({ body: 'message during restart' })) + '\n', resolve)
      })
      conn.once('error', reject)
    })
    await sleep(100)
    assert.ok(!server.requests.some(r => r.method === 'thread/read'), 'no delivery during recycle')
  } finally {
    exclusive.close()
  }
  const frame = await delivered
  assert.equal(frame.body, 'message during restart')
})

function addEphemeralHelper(state) {
  state.loaded.push('ephemeral-helper')
  let updatedAt = 45
  state.override = ({ method, params }) => {
    if (params?.threadId !== 'ephemeral-helper') return
    if (method === 'thread/read') return { thread: {
      id: 'ephemeral-helper', ephemeral: true, threadSource: 'thread_title',
      status: state.ephemeralStatus ?? IDLE, updatedAt: updatedAt++,
    } }
    if (method === 'thread/queue/list' || method === 'thread/turns/list') return {}
  }
}

test('idle ephemeral helpers count as loaded without resetting quiet on read timestamps', async t => {
  const { state, run, server } = await setup(t)
  addEphemeralHelper(state)
  await fillQuiet(run, state)
  const result = await run({ dryRun: true })
  assert.equal(result.reason, 'eligible', JSON.stringify(result))
  assert.equal(result.loaded_before, 2)
  assert.ok(!server.requests.some(r => r.method === 'thread/turns/list' && r.params.threadId === 'ephemeral-helper'))

  state.loaded.pop()
  assert.equal((await run({ dryRun: true })).quiet_seconds, 0)
})

test('an ephemeral helper that becomes active defers recycle and resets quiet', async t => {
  const { state, run } = await setup(t)
  addEphemeralHelper(state)
  await fillQuiet(run, state)
  state.ephemeralStatus = { type: 'active', activeFlags: [] }
  assert.equal((await run()).reason, 'working-threads')
  state.ephemeralStatus = { type: 'active', activeFlags: ['waitingOnApproval'] }
  assert.equal((await run()).reason, 'pending-approvals')
  assert.equal(state.restarts, 0)
  state.ephemeralStatus = IDLE
  const idle = await run()
  assert.equal(idle.reason, 'quiet-period')
  assert.equal(idle.quiet_seconds, 0)
})

test('a socket alias in another runtime uses the same lease', async t => {
  const { env, socket } = await setup(t)
  const aliasEnv = testEnv()
  const aliasSocket = join(aliasEnv.XDG_RUNTIME_DIR, 'alias.sock')
  symlinkSync(socket, aliasSocket)
  const { acquireRecycleLock } = await import('../lib/recycle-lock.mjs')
  const exclusive = await acquireRecycleLock(socket, { env, mode: 'exclusive' })
  try {
    const shared = await acquireRecycleLock(aliasSocket, { env: aliasEnv, mode: 'shared' })
    shared?.close()
    assert.equal(shared, null)
  } finally {
    exclusive.close()
  }
})

test('inbox logs overflow and caps frames retained while recycle holds the lock', { timeout: 5000 }, async t => {
  const { env, socket, state } = await setup(t)
  const { acquireRecycleLock } = await import('../lib/recycle-lock.mjs')
  const errors = []
  let reported
  const overflow = new Promise(resolve => { reported = resolve })
  const inbox = await serveInbox({
    alias: ALIAS, threadId: ID, appSocket: socket,
    onError(error) { errors.push(error.message); if (error.message.includes('overflow')) reported(error.message) },
  }, env)
  t.after(inbox.close)
  // Drain the admitted frames without spawning one queue process per frame.
  state.status = { type: 'active', activeFlags: ['waitingOnApproval'] }
  const exclusive = await acquireRecycleLock(socket, { env, mode: 'exclusive' })
  try {
    const frames = Array.from({ length: 65 }, (_, i) => JSON.stringify(buildFrame({ body: 'frame ' + i })))
    await new Promise((resolve, reject) => {
      const conn = connect(inbox.path, () => conn.end(frames.join('\n') + '\n', resolve))
      conn.once('error', reject)
    })
    const error = await Promise.race([overflow, sleep(200).then(() => null)])
    assert.match(error ?? '', /delivery error.*overflow/i)
  } finally {
    exclusive.close()
    for (let i = 0; i < 80 && errors.length < 65; i++) await sleep(20)
  }
  assert.equal(errors.length, 65)
  assert.equal(errors.filter(error => error.includes('overflow')).length, 1)
})

test('a regular file used by a wrapper fixture creates no lock beside the file', async () => {
  const env = testEnv()
  const fixture = testEnv()
  const path = join(fixture.XDG_RUNTIME_DIR, 'fixture')
  writeFileSync(path, '')
  const { acquireRecycleLock } = await import('../lib/recycle-lock.mjs')
  const shared = await acquireRecycleLock(path, { env, mode: 'shared' })
  shared.close()
  assert.equal(existsSync(join(fixture.XDG_RUNTIME_DIR, '.recycle')), false)
})
