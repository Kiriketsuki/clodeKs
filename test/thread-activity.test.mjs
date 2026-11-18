import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { threadCounts, threadActivityHint } from '../lib/thread-activity.mjs'
import { liveBand } from '../lib/band.mjs'
import { buildState, statusCacheFile } from '../lib/status.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const ACTIVE = '01a11f22-ed3b-7b43-9b60-da495678abcd'
const OTHER = '01a11f22-ed3b-7b43-9b60-da495555abcd'

async function run(env, args) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', part => { stdout += part })
  child.stderr.on('data', part => { stderr += part })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, stdout, stderr }
}

async function setup(t, turns, statuses = ['idle', 'active', 'systemError'], { queue = () => ({ data: [], nextCursor: null }), flags = [] } = {}) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const threads = statuses.map((type, i) => ({ id: [ID, ACTIVE, OTHER][i], cwd: '/test',
    status: { type, activeFlags: flags }, updatedAt: Math.floor(Date.now() / 1000) - 9999 }))
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'initialize') return {}
    if (request.method === 'thread/loaded/list') return { data: threads.map(thread => thread.id) }
    if (request.method === 'thread/list') return { data: threads }
    if (request.method === 'thread/queue/list') return queue(request)
    if (request.method === 'thread/turns/list') return turns(request)
    throw new Error(`Unexpected RPC: ${request.method}`)
  })
  t.after(server.close)
  return { env, socket, server }
}

test('activity: threads split working, idle, and other loaded states with unknown attachment', async t => {
  const now = Math.floor(Date.now() / 1000)
  const { env, socket, server } = await setup(t, () => ({ data: [{ id: 'turn', status: 'completed', completedAt: now - 120 }] }))
  const out = await run(env, ['threads', '--socket', socket, '--json', '--hint'])
  assert.equal(out.code, 0, out.stderr)
  const result = JSON.parse(out.stdout)
  assert.match(result.hint, /1 working, 1 idle, 1 other/)
  assert.match(result.hint, /client attachment.*unknown/i)
  assert.ok(result.threads.every(thread => thread.client_attachment === 'unknown'))
  const idle = result.threads.find(thread => thread.id === ID)
  assert.ok(idle.idle_age_seconds >= 120 && idle.idle_age_seconds < 130)
  assert.equal(idle.idle_age_source, 'last-turn-completed-at')
  assert.equal(result.threads.find(thread => thread.id === ACTIVE).idle_age_seconds, null)
  assert.deepEqual(server.requests.filter(r => r.method === 'thread/turns/list').map(r => r.params), [
    { threadId: ID, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' },
    { threadId: OTHER, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' },
  ])
  assert.ok(server.requests.every(r => ['initialize', 'thread/loaded/list', 'thread/list', 'thread/queue/list', 'thread/turns/list'].includes(r.method)))
})

test('activity: text output labels idle threads as loaded and reports idle age', async t => {
  const { env, socket } = await setup(t, () => ({ data: [{ id: 'turn', status: 'completed', completedAt: Math.floor(Date.now() / 1000) - 60 }] }), ['idle'])
  const out = await run(env, ['threads', '--socket', socket])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /idle.*loaded/)
  assert.match(out.stdout, /idle age \d+s/)
  assert.match(out.stdout, /client unknown/)
  assert.doesNotMatch(out.stdout, /\blive\b/)
})

test('activity: missing, future, active, or unsupported history never becomes an invented idle age', async t => {
  const cases = [
    () => ({ data: [] }),
    () => ({ data: [{ id: 'turn', status: 'completed', completedAt: null }] }),
    () => ({ data: [{ id: 'turn', status: 'completed', completedAt: Math.floor(Date.now() / 1000) + 100 }] }),
    () => ({ data: [{ id: 'turn', status: 'inProgress', completedAt: 100 }] }),
    () => { throw new Error('history unsupported') },
    () => new Promise(() => {}),
  ]
  for (const turns of cases) {
    const { env, socket } = await setup(t, turns, ['idle'])
    const out = await run(env, ['threads', '--socket', socket, '--json', '--hint'])
    assert.equal(out.code, 0, out.stderr)
    const idle = JSON.parse(out.stdout).threads[0]
    assert.equal(idle.status, 'idle')
    assert.equal(idle.idle_age_seconds, null)
    assert.equal(idle.client_attachment, 'unknown')
    assert.equal(typeof idle.idle_age_error, 'string')
  }
})

test('activity: counts and band distinguish working from idle without guessing client state', () => {
  const threads = [{ id: ID, status: 'idle' }, { id: ACTIVE, status: 'active' }, { id: OTHER, status: 'systemError' }]
  const state = buildState({ at: 1000, pid: 1, appUp: true, threads, exposedIds: new Set(), inboxes: 0 })
  assert.equal(state.counts.idle, 1)
  assert.equal(state.counts.other, 1)
  assert.equal(state.counts.client_attachment, 'unknown')
  const item = liveBand(state).items[0]
  assert.match(item.text, /1 working.*1 idle/)
  assert.match(item.hint, /client attachment.*unknown/i)
  assert.doesNotMatch(item.hint, /\blive\b/)
})

test('activity: close refuses before any RPC for any target', async t => {
  const { env, socket, server } = await setup(t, () => ({ data: [] }))
  for (const args of [[ID], [ACTIVE], ['missing-target'], ['--idle'], ['--idle', '--dry-run'], ['--idle', '--older-than', '1h']]) {
    const out = await run(env, ['close', '--socket', socket, ...args])
    assert.equal(out.code, 2, out.stderr)
    assert.match(out.stderr, /0\.169\.0.*thread\/unload/)
    assert.equal(out.stdout, '')
  }
  assert.deepEqual(server.requests, [])
})

test('activity: status text reports idle counts and old counters remain unknown', async () => {
  for (const counts of [{ live: 36, active: 4, idle: 32, other: 0, exposed: 0 }, { live: 36, active: 4, exposed: 0 }]) {
    const env = testEnv()
    const file = statusCacheFile(env)
    mkdirSync(dirname(file), { recursive: true })
    const service = { unit: 'fixture.service', enabled: 'enabled', active: 'active' }
    writeFileSync(file, JSON.stringify({ v: 1, at: Date.now(), counts,
      services: { appserver: service, inboxd: service }, app_server: { up: true }, codex: { version: '0.169.0' } }))
    const out = await run(env, ['status'])
    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, /4 working/)
    assert.match(out.stdout, counts.idle === undefined ? /unknown idle/ : /32 idle/)
    assert.match(out.stdout, /Client attachment unknown/)
    assert.match(out.stdout, /unknown idle with queued work, unknown idle with unknown queue depth/)
    assert.doesNotMatch(out.stdout, /36 live/)
  }
})


test('activity: queued idle work stays visible in counts, hint, status, band, and text', async t => {
  const threads = [
    { status: 'idle', queued_count: 2 }, { status: 'idle', queued_count: 0 },
    { status: 'idle', queued_count: null }, { status: 'active', queued_count: 3 },
    { status: 'idle', queued_count: 5, loaded: false },
  ]
  const counts = threadCounts(threads)
  assert.equal(counts.idle_queued, 1)
  assert.equal(counts.idle_queue_unknown, 1)
  assert.match(threadActivityHint(threads), /1 idle with queued work, 1 idle with unknown queue depth/)
  const state = buildState({ at: 1000, pid: 1, appUp: true, threads, exposedIds: new Set(), inboxes: 0 })
  assert.match(liveBand(state).items[0].hint, /1 idle with queued work, 1 idle with unknown queue depth/)
  const { env, socket } = await setup(t, () => ({ data: [] }), ['idle'], {
    queue: () => ({ data: [{ id: 'one' }, { id: 'two' }], nextCursor: null }),
  })
  const out = await run(env, ['threads', '--socket', socket])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /idle \(queued work\).*idle age unknown  queued 2/)
  const file = statusCacheFile(env)
  mkdirSync(dirname(file), { recursive: true })
  const service = { unit: 'fixture.service', enabled: 'enabled', active: 'active' }
  writeFileSync(file, JSON.stringify({ v: 1, at: Date.now(), counts: { ...counts, exposed: 0 },
    services: { appserver: service, inboxd: service }, app_server: { up: true }, codex: {} }))
  const status = await run(env, ['status'])
  assert.equal(status.code, 0, status.stderr)
  assert.match(status.stdout, /1 idle with queued work, 1 idle with unknown queue depth/)
})

test('activity: unavailable queue depth stays unknown in text and counts', async t => {
  const { env, socket } = await setup(t, () => ({ data: [] }), ['idle'], {
    queue: () => { throw new Error('queue unavailable') },
  })
  const out = await run(env, ['threads', '--socket', socket])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /idle age unknown  queued unknown/)
  assert.match(out.stdout, /0 idle with queued work, 1 idle with unknown queue depth/)
})

test('activity: active approval and input waits count as working and appear in text', async t => {
  for (const [flag, label] of [['waitingOnApproval', 'approval'], ['waitingOnUserInput', 'user input']]) {
    const { env, socket } = await setup(t, () => { throw new Error('active thread must not read idle age') }, ['active'], { flags: [flag] })
    const out = await run(env, ['threads', '--socket', socket])
    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, /1 working, 0 idle/)
    assert.ok(out.stdout.includes(`working (waiting on ${label})`), out.stdout)
    const state = buildState({ at: 1000, pid: 1, appUp: true,
      threads: [{ status: 'active', active_flags: [flag] }], exposedIds: new Set(), inboxes: 0 })
    assert.equal(state.counts.active, 1)
    assert.equal(state.counts.idle, 0)
    assert.match(liveBand(state).items[0].text, /1 working, 0 idle/)
  }
})

test('activity: close help says all forms refuse, including bulk and preview options', async () => {
  const out = await run(testEnv(), ['close', '--help'])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /Every form of close refuses on Codex 0\.169\.0, including --idle, --dry-run, and --older-than/)
})
