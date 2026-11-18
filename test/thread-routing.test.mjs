import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createLaunchRecord } from '../lib/launch-record.mjs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveThread } from '../lib/appserver.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const OTHER = '01a11f22-ed3b-7b43-9b60-da495678abcd'
const thread = (id, name) => ({ id, name, cwd: '/work', status: { type: 'idle' }, ephemeral: false })

async function setup(t, threads, loaded = threads.map(t => t.id)) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'initialize') return {}
    if (request.method === 'thread/loaded/list') return { data: loaded }
    if (request.method === 'thread/list') return { data: threads }
    throw new Error(`Unexpected request: ${request.method}`)
  })
  t.after(server.close)
  return { socket, env, server }
}

const resolve = (state, ref) => resolveThread(state.socket, ref, { env: state.env })

test('routing: duplicate exact names refuse with every candidate alias and full ID', async t => {
  const state = await setup(t, [thread(ID, 'same worker'), thread(OTHER, 'same worker')])
  await assert.rejects(resolve(state, 'same worker'), error => {
    assert.match(error.message, /matches 2 threads/)
    for (const value of [ID, OTHER, 'codex-1234abcd', 'codex-5678abcd']) assert.ok(error.message.includes(value))
    return true
  })
})

test('routing: stored and loaded name collisions refuse rather than prefer the loaded worker', async t => {
  const state = await setup(t, [thread(ID, 'same worker'), thread(OTHER, 'same worker')], [OTHER])
  await assert.rejects(resolve(state, 'same worker'), /matches 2 threads/)
})

test('routing: an exact alias wins over another thread name regardless of list order', async t => {
  const state = await setup(t, [thread(OTHER, 'codex-1234abcd'), thread(ID, 'the actual worker')])
  assert.equal((await resolve(state, 'codex-1234abcd')).id, ID)
})

test('routing: a full ID wins over another thread name regardless of list order', async t => {
  const state = await setup(t, [thread(OTHER, ID), thread(ID, 'the actual worker')])
  assert.equal((await resolve(state, ID)).id, ID)
})

test('routing: alias collisions refuse and a full ID can disambiguate them', async t => {
  const collision = '01a11f22-ed3b-7b43-9b61-da491234abcd'
  const state = await setup(t, [thread(ID, 'first worker'), thread(collision, 'second worker')])
  await assert.rejects(resolve(state, 'codex-1234abcd'), error => {
    assert.match(error.message, /matches 2 threads/)
    assert.ok(error.message.includes(ID))
    assert.ok(error.message.includes(collision))
    return true
  })
  assert.equal((await resolve(state, collision)).id, collision)
})

test('routing: preserve unique names, aliases, partial IDs, and short-reference refusals', async t => {
  const state = await setup(t, [thread(ID, 'unique worker'), thread(OTHER, 'another worker')])
  for (const ref of ['unique worker', 'codex-1234abcd', 'da491234abcd']) assert.equal((await resolve(state, ref)).id, ID)
  await assert.rejects(resolve(state, 'abcd'), /matches 2 threads/)
  await assert.rejects(resolve(state, 'codex-'), /too short/)
  await assert.rejects(resolve(state, 'missing worker'), /No Codex thread matches/)
})

test('routing: CLI refuses an ambiguous name before status reads or delivery mutations', async t => {
  const state = await setup(t, [thread(ID, 'same worker'), thread(OTHER, 'same worker')])
  const child = spawn(process.execPath, [CLI, 'send', '--socket', state.socket, '--priority', 'steer', 'same worker', 'Read the correction.'], {
    env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.notEqual(code, 0)
  assert.equal(stdout, '')
  assert.match(stderr, /matches 2 threads/)
  assert.ok(!state.server.requests.some(r => !['initialize', 'thread/loaded/list', 'thread/list'].includes(r.method)))
})


function windowRecord(env, value, windowName, launchId = 'e97088e9-e4c4-4bbf-8112-b89e5d7a61b3') {
  value.preview = `[clodeks launch ${launchId}]\nTask`
  const record = createLaunchRecord({ launchId, cwd: value.cwd, briefPath: '/brief.md',
    tmuxWindowName: windowName, onError: error => { throw error } }, env)
  record.identified(value.id, value.id)
  return record
}

test('routing: a confirmed recorded window name resolves and is visible', async t => {
  const value = thread(ID, 'Generated generic name')
  const state = await setup(t, [value])
  windowRecord(state.env, value, 'cx-worker-123')
  assert.equal((await resolve(state, 'cx-worker-123')).id, ID)
  assert.equal((await resolve(state, ID)).tmux_window_name, 'cx-worker-123')
})

test('routing: window collisions and cross-name collisions refuse', async t => {
  const values = [thread(ID, 'first'), thread(OTHER, 'cx-worker-123')]
  const state = await setup(t, values)
  windowRecord(state.env, values[0], 'cx-worker-123')
  await assert.rejects(resolve(state, 'cx-worker-123'), /matches 2 threads/)
  windowRecord(state.env, values[1], 'cx-worker-123', 'da2a5e85-e57d-4a2c-aef5-f059a3a16da6')
  values[1].name = 'second'
  await assert.rejects(resolve(state, 'cx-worker-123'), /matches 2 threads/)
})

test('routing: canonical aliases win over recorded window names', async t => {
  const values = [thread(OTHER, 'other'), thread(ID, 'actual')]
  const state = await setup(t, values)
  windowRecord(state.env, values[0], 'codex-1234abcd')
  assert.equal((await resolve(state, 'codex-1234abcd')).id, ID)
})

test('routing: invalid and unconfirmed records cannot provide a window route', async t => {
  const value = thread(ID, 'worker')
  const state = await setup(t, [value])
  const record = windowRecord(state.env, value, 'cx-worker-123')
  const original = JSON.parse(readFileSync(record.path, 'utf8'))
  for (const patch of [{ status: 'observing' }, { thread_id: OTHER }, { cwd: '/other' },
    { tmux_window_name: 'bad\nname' }, { tmux_window_name: 'a'.repeat(257) }]) {
    writeFileSync(record.path, JSON.stringify({ ...original, ...patch }))
    await assert.rejects(resolve(state, 'cx-worker-123'), /No Codex thread matches/)
    assert.equal((await resolve(state, ID)).tmux_window_name, null)
  }
})


for (const condition of ['exited', 'dead', 'recycled', 'missing-start', 'different-boot']) {
  test(`routing: ${condition} launcher cannot retain a window route`, async t => {
    const value = thread(ID, 'old idle worker')
    const state = await setup(t, [value])
    const record = windowRecord(state.env, value, 'clodeks-self17')
    assert.equal((await resolve(state, 'clodeks-self17')).id, ID)
    const original = JSON.parse(readFileSync(record.path, 'utf8'))
    const dead = condition === 'dead' ? spawnSync(process.execPath, ['-e', '']) : null
    if (dead) assert.equal(dead.status, 0)
    const patch = condition === 'exited' ? { exited_at: Date.now() }
      : condition === 'dead' ? { launcher_pid: dead.pid }
      : condition === 'recycled' ? { launcher_start: '0' }
      : condition === 'different-boot' ? { launcher_boot_id: 'other-boot' }
      : { launcher_start: null }
    writeFileSync(record.path, JSON.stringify({ ...original, ...patch }))
    await assert.rejects(resolve(state, 'clodeks-self17'), /No Codex thread matches/)
    const result = await resolve(state, ID)
    assert.equal(result.tmux_window_name, null)
    assert.equal(result.source, 'clodeks-tui', 'expired routing must preserve launch provenance')
  })
}

for (const ref of ['01a11f22-ed3b-7b43-9b60-da4912', 'da491234abcd']) {
  for (const field of ['name', 'window']) test(`routing: ${field} cannot shadow ID reference ${ref}`, async t => {
    const values = [thread(OTHER, field === 'name' ? ref : 'other'), thread(ID, 'actual')]
    const state = await setup(t, values)
    if (field === 'window') windowRecord(state.env, values[0], ref)
    assert.equal((await resolve(state, ref)).id, ID)
  })
}
