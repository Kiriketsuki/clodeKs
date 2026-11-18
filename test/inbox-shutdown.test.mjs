import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { Server, Socket } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'

import { inboxSocketFor, startInboxDaemon } from '../lib/inbox.mjs'
import { stateFile } from '../lib/status.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const ALIAS = 'codex-1234abcd'
const thread = { id: ID, cwd: '/tmp', status: { type: 'idle' } }

async function until(check) {
  const deadline = Date.now() + 2500
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), 'condition did not become ready')
}

async function fixture(t, read = () => ({ thread })) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, ({ method }) => {
    if (method === 'thread/loaded/list') return { data: [ID] }
    if (method === 'thread/list') return { data: [] }
    if (method === 'thread/read') return read()
  })
  const daemon = startInboxDaemon({ appSocket: socket, all: true, intervalMs: 60000 }, env)
  t.after(async () => {
    daemon.close()
    await server.close()
  })
  return { env, server, daemon, path: inboxSocketFor(ALIAS, env) }
}

test('inbox shutdown: a pending thread read cannot start an inbox after close', async t => {
  const started = Promise.withResolvers()
  const result = Promise.withResolvers()
  const state = await fixture(t, () => { started.resolve(); return result.promise })
  t.after(() => result.resolve({ thread }))
  let probes = 0
  const connect = Socket.prototype.connect
  t.mock.method(Socket.prototype, 'connect', function (...args) {
    if (args.flat().some(arg => arg?.path === state.path)) probes++
    return connect.apply(this, args)
  })
  await started.promise
  state.daemon.close()
  result.resolve({ thread })
  // The client closes after discovery returns. Its sync continuation runs before the peer receives that close.
  await until(() => state.server.connectionCount() === 0)
  assert.equal(probes, 0, 'closed daemon must not probe or create an inbox')
  assert.equal(existsSync(state.path), false)
  assert.equal(existsSync(stateFile(state.env)), false)
})

test('inbox shutdown: close a listener that finishes opening after shutdown', async t => {
  const listening = Promise.withResolvers()
  const state = await fixture(t)
  const listen = Server.prototype.listen
  let inboxServer
  t.mock.method(Server.prototype, 'listen', function (path, callback) {
    if (path !== state.path) return listen.apply(this, arguments)
    inboxServer = this
    return listen.call(this, path, () => {
      state.daemon.close()
      callback()
      listening.resolve()
    })
  })
  t.after(() => inboxServer?.close())
  await listening.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inboxServer.listening, false, 'late listener must close before sync completes')
  assert.equal(existsSync(state.path), false)
  assert.equal(existsSync(stateFile(state.env)), false)
})

test('inbox shutdown: close removes an established inbox and its heartbeat', async t => {
  const state = await fixture(t)
  await until(() => existsSync(stateFile(state.env)))
  assert.equal(existsSync(state.path), true)
  state.daemon.close()
  assert.equal(existsSync(state.path), false)
  assert.equal(existsSync(stateFile(state.env)), false)
})
