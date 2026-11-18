import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readExposed, inboxSocketFor, startInboxDaemon } from '../lib/inbox.mjs'
import { exposedFile } from '../lib/paths.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CONTROLLED = fileURLToPath(new URL('./fixtures/controlled-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'

async function until(check) {
  const deadline = Date.now() + 2500
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), 'condition did not become ready')
}

async function launch(t, { expose = true, failRead = false, blockMark = false, ambiguous = false } = {}) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CONTROLLED })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  let thread
  const server = await fakeAppServer(socket, ({ method, params }) => {
    if (method === 'config/read') return { config: {}, layers: [] }
    if (method === 'thread/loaded/list') return { data: thread ? [ID] : [] }
    if (method === 'thread/list') return { data: thread ? [thread] : [] }
    if (method === 'thread/read') {
      if (failRead) throw new Error('isolated read failure')
      return { thread: { ...thread, id: params.threadId } }
    }
  })
  t.after(server.close)
  const child = spawn(process.execPath, [CLI, 'tui', '--socket', socket, '--brief', BRIEF,
    ...(expose ? ['--expose'] : [])], {
    env, cwd: env.XDG_RUNTIME_DIR, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
  })
  t.after(() => child.stdin.end('finish\n'))
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  let exited = false
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { exited = true; resolve(code) })
  })
  await until(() => stdout.includes('\n') || exited)
  assert.equal(exited, false, stderr)
  const path = stderr.match(/launch record ([^\n]+)/)?.[1]
  assert.ok(path, stderr)
  const before = stderr
  if (expose) assert.equal(JSON.parse(readFileSync(path, 'utf8')).exposure.status, 'pending')
  if (blockMark) mkdirSync(exposedFile(env))
  thread = { id: ID, cwd: env.XDG_RUNTIME_DIR, ephemeral: false, threadSource: 'user',
    createdAt: Math.floor(Date.now() / 1000), preview: JSON.parse(stdout).at(-1), status: { type: 'idle' } }
  server.notify('thread/started', { thread })
  if (ambiguous) server.notify('thread/started', { thread: { ...thread, id: 'another-ffffffff' } })
  return { env, server, path, before, stderr: () => stderr, read: () => JSON.parse(readFileSync(path, 'utf8')),
    finish: async () => { child.stdin.end('finish\n'); return done } }
}

test('tui expose: mark only the confirmed brief thread and let inboxd serve it', async t => {
  const state = await launch(t)
  writeFileSync(exposedFile(state.env), 'existing-thread\n', { mode: 0o600 })
  await until(() => state.read().exposure?.status === 'marked')
  assert.deepEqual([...readExposed(state.env)], ['existing-thread', ID])
  assert.equal(statSync(exposedFile(state.env)).mode & 0o777, 0o600)
  assert.equal(state.stderr(), state.before, 'no late terminal output')
  const daemon = startInboxDaemon({ appSocket: join(state.env.XDG_RUNTIME_DIR, 'app.sock'), intervalMs: 30 }, state.env)
  t.after(daemon.close)
  await until(() => existsSync(inboxSocketFor('codex-1234abcd', state.env)))
  assert.equal(state.read().thread_id, ID)
  assert.equal(await state.finish(), 0)
  const trustReads = state.server.requests.filter(r => r.method === 'config/read')
  assert.deepEqual(trustReads.map(r => r.params), [{ cwd: state.env.XDG_RUNTIME_DIR, includeLayers: true }])
  assert.ok(state.server.requests.every(r => ['initialize', 'config/read', 'thread/loaded/list', 'thread/list', 'thread/read', 'thread/queue/list', 'thread/name/set'].includes(r.method)))
})

test('tui expose: default launches do not mark threads', async t => {
  const state = await launch(t, { expose: false })
  await until(() => state.read().status === 'identified')
  assert.equal(state.read().exposure, undefined)
  assert.deepEqual([...readExposed(state.env)], [])
  assert.equal(await state.finish(), 0)
})

for (const option of ['failRead', 'ambiguous']) test(`tui expose: ${option} never marks a guessed thread`, async t => {
  const state = await launch(t, { [option]: true })
  await until(() => state.read().exposure?.status === 'unavailable')
  assert.deepEqual([...readExposed(state.env)], [])
  assert.match(state.read().exposure.error, option === 'ambiguous' ? /ambiguous/ : /isolated read failure/)
  assert.equal(state.stderr(), state.before)
  assert.equal(await state.finish(), 0)
  assert.match(state.stderr().slice(state.before.length), /inbox exposure did not complete/)
})

test('tui expose: a mark failure stays visible in the record and exit summary', async t => {
  const state = await launch(t, { blockMark: true })
  await until(() => state.read().exposure?.status === 'failed')
  assert.equal(state.read().status, 'identified')
  assert.match(state.read().exposure.error, /EISDIR/)
  assert.equal(state.stderr(), state.before)
  assert.equal(await state.finish(), 0)
  assert.match(state.stderr().slice(state.before.length), /inbox exposure did not complete/)
})

test('tui expose: early exit leaves exposure unavailable', async t => {
  const state = await launch(t)
  assert.equal(await state.finish(), 0)
  assert.deepEqual([...readExposed(state.env)], [])
  assert.equal(state.read().exposure.status, 'unavailable')
})

test('tui expose: reject missing briefs, native commands, and forwarded cwd before effects', async () => {
  for (const args of [[], ['--brief', BRIEF, '--', '--model', 'test', 'resume', ID],
    ['--brief', BRIEF, '--', '--cd', '/tmp']]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CONTROLLED })
    const child = spawn(process.execPath, [CLI, 'tui', '--expose', ...args], {
      env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, 2, stderr)
    assert.match(stderr, /--expose (?:requires --brief|is only supported|cannot be combined)/)
    assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'clodeks')), false)
  }
})
