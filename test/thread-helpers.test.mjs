import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { listThreads, resolveThread } from '../lib/appserver.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

function thread(id, extra = {}) {
  return { id, cwd: '/work', status: { type: 'idle' }, preview: '', ...extra }
}

test('threads: hide only identified ephemeral title and system helpers', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const threads = [
    thread('empty-user', { ephemeral: false, threadSource: 'user' }),
    thread('real-subagent', { ephemeral: true, threadSource: 'subagent' }),
    thread('persistent-title', { ephemeral: false, threadSource: 'thread_title' }),
    thread('other-feature', { ephemeral: true, threadSource: 'other' }),
    thread('title-helper', { ephemeral: true, threadSource: 'thread_title' }),
    thread('system-helper', { ephemeral: true, threadSource: 'system' }),
  ]
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: threads.map(t => t.id) }
    if (request.method === 'thread/list') return { data: threads }
  })
  t.after(server.close)
  for (const all of [false, true]) {
    assert.deepEqual((await listThreads(socket, { all, env })).map(t => t.id),
      ['empty-user', 'real-subagent', 'persistent-title', 'other-feature'])
  }
})

test('threads: helper filtering also covers loaded threads outside the list page', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: ['title-helper', 'empty-user'] }
    if (request.method === 'thread/list') return { data: [] }
    if (request.method === 'thread/read') return { thread: request.params.threadId === 'title-helper'
      ? thread('title-helper', { ephemeral: true, threadSource: 'thread_title' })
      : thread('empty-user', { ephemeral: false, threadSource: 'user' }) }
  })
  t.after(server.close)
  assert.deepEqual((await listThreads(socket, { env })).map(t => t.id), ['empty-user'])
  await assert.rejects(resolveThread(socket, 'title-helper', { env }), /No Codex thread matches/)
  assert.ok(server.requests.every(r => ['initialize', 'thread/loaded/list', 'thread/list', 'thread/read', 'thread/queue/list'].includes(r.method)))
})
