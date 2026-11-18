import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { acquireRecycleLock } from '../lib/recycle-lock.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const THREAD = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const ALIAS = 'codex-1234abcd'
const ITEM = '01959bae-c800-7000-a000-111111111111'
const OTHER = 'older-format-id'
const IDLE = { type: 'idle' }

async function setup(t) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const sample = { id: ITEM, input: [{ type: 'text', text: '😀'.repeat(80) + 'unprinted' }] }
  const state = { status: IDLE, deleted: [], failId: null, afterDelete: () => {} }
  const server = await fakeAppServer(socket, ({ method, params }) => {
    const thread = { id: THREAD, cwd: '/test', status: state.status, preview: 'stored conversation', ephemeral: false }
    if (method === 'thread/list') return { data: state.listed === false ? [] : [thread] }
    if (method === 'thread/loaded/list') return { data: state.status.type === 'notLoaded' ? [] : [THREAD] }
    if (method === 'thread/read') return { thread }
    if (method === 'thread/queue/list') {
      assert.equal(params.threadId, THREAD)
      if (!params.cursor) return { data: [sample], nextCursor: 'more' }
      assert.equal(params.cursor, 'more')
      return { data: [{ id: OTHER, input: [{ type: 'text', text: 'second message' }] }] }
    }
    if (method === 'thread/queue/delete') {
      assert.equal(params.threadId, THREAD)
      if (params.queuedSubmissionId === state.failId) return { deleted: false }
      state.deleted.push(params.queuedSubmissionId)
      state.afterDelete()
      return { deleted: true }
    }
  })
  t.after(server.close)
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'queue', ...args, '--socket', socket], { env, timeout: 5000 })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  return { env, socket, state, server, run }
}

test('queue list paginates stored threads and shows text only on request', async t => {
  const { run, state } = await setup(t)
  state.status = { type: 'notLoaded' }
  const result = await run(['list', ALIAS])
  assert.equal(result.code, 0, result.stderr)
  const listed = JSON.parse(result.stdout)
  assert.equal(listed.thread_id, THREAD)
  assert.deepEqual(listed.entries.map(entry => entry.submission_id), [ITEM, OTHER])
  assert.ok(listed.entries[0].age_seconds > 0)
  assert.equal(listed.entries[1].age_seconds, null)
  assert.ok(listed.entries.every(entry => !Object.hasOwn(entry, 'preview')))
  assert.doesNotMatch(result.stdout, /second message/)

  const withText = await run(['list', ALIAS, '--show-text'])
  assert.equal(withText.code, 0, withText.stderr)
  assert.deepEqual(JSON.parse(withText.stdout).entries.map(entry => entry.preview), ['😀'.repeat(80), 'second message'])
})

test('queue accepts a full ID outside discovery and refuses unknown thread status', async t => {
  const { run, state, server } = await setup(t)
  state.listed = false
  state.status = { type: 'notLoaded' }
  assert.equal((await run(['list', THREAD])).code, 0)
  assert.ok(!server.requests.some(request => request.method === 'thread/list'))

  state.status = { type: 'systemError' }
  const result = await run(['clear', THREAD])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /verify.*idle/i)
  assert.deepEqual(state.deleted, [])
})

test('queue clear previews a selected submission and logs only confirmed deletions', async t => {
  const { run, state } = await setup(t)
  const dryRun = await run(['clear', ALIAS, '--id', OTHER, '--dry-run'])
  assert.equal(dryRun.code, 0, dryRun.stderr)
  assert.deepEqual(state.deleted, [])
  assert.deepEqual(JSON.parse(dryRun.stdout).entries, [{ submission_id: OTHER, age_seconds: null, preview: 'second message' }])

  const result = await run(['clear', ALIAS, '--id', ITEM])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).entries.map(entry => entry.preview), ['😀'.repeat(80)])
  assert.deepEqual(state.deleted, [ITEM])
  assert.ok(result.stderr.includes(THREAD))
  assert.ok(result.stderr.includes(ITEM))
  assert.doesNotMatch(result.stderr, /unprinted|second message/)
})

test('queue clear requires an explicit thread and never deletes an unknown submission', async t => {
  const { run, state, server } = await setup(t)
  assert.equal((await run(['clear'])).code, 2)
  assert.equal(server.requests.length, 0)
  const missing = await run(['clear', ALIAS, '--id', 'missing'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /submission.*missing/i)
  assert.deepEqual(state.deleted, [])
})

test('queue operations refuse active status and clear rechecks before every deletion', async t => {
  const { run, state } = await setup(t)
  state.status = { type: 'active', activeFlags: [] }
  for (const verb of ['list', 'clear']) {
    const result = await run([verb, ALIAS])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /active/i)
    assert.deepEqual(state.deleted, [])
  }

  state.status = IDLE
  state.afterDelete = () => { state.status = { type: 'active', activeFlags: [] } }
  const result = await run(['clear', ALIAS])
  assert.equal(result.code, 1)
  assert.deepEqual(state.deleted, [ITEM])
  assert.equal(JSON.parse(result.stdout).entries.length, 2)
  assert.ok(result.stderr.includes(ITEM))
  assert.match(result.stderr, /active/i)
})

test('queue clear stops on an unconfirmed deletion and refuses an in-flight delivery', async t => {
  const { env, socket, run, state } = await setup(t)
  const lease = await acquireRecycleLock(socket, { env, mode: 'shared' })
  try {
    const busy = await run(['clear', ALIAS])
    assert.equal(busy.code, 1)
    assert.match(busy.stderr, /delivery|recycle/i)
    assert.deepEqual(state.deleted, [])
  } finally {
    lease.close()
  }

  state.failId = ITEM
  const result = await run(['clear', ALIAS])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /unconfirmed/i)
  assert.equal(JSON.parse(result.stdout).entries.length, 2)
  assert.deepEqual(state.deleted, [])
})
