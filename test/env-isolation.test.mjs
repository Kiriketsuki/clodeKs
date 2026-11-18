import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
// The nested suite now runs files serially. Keep its budget long enough for a full run under load.
const NESTED_TIMEOUT_MS = 10 * 60 * 1000

test('test environments: the helper removes inherited bridge and parent settings', () => {
  const parent = Object.freeze({
    PATH: process.env.PATH,
    XDG_RUNTIME_DIR: '/sentinel/runtime',
    XDG_STATE_HOME: '/sentinel/state',
    CLODEKS_APP_SOCKET: '/sentinel/app.sock',
    CLODEKS_OUTBOX: '/sentinel/outbox',
    CLODEKS_FUTURE_INBOX: '/sentinel/inbox',
    CLAUDE_CODE_MESSAGING_SOCKET: '/sentinel/parent.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'sentinel',
  })
  const env = testEnv({}, parent)
  assert.deepEqual(Object.keys(env).sort(), ['NODE_OPTIONS', 'PATH', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME'])
  assert.match(env.NODE_OPTIONS, /quiet-pressure\.mjs$/)
  assert.match(env.XDG_RUNTIME_DIR, /^\/tmp\/cktest-[^/]+\/env-/)
  assert.match(env.XDG_STATE_HOME, /^\/tmp\/cktest-[^/]+\/state$/)
  assert.equal(env.PATH, parent.PATH)
  assert.equal(parent.CLODEKS_APP_SOCKET, '/sentinel/app.sock')
})

test('test environments: the suite ignores inherited service paths', { timeout: NESTED_TIMEOUT_MS + 10000 }, async t => {
  const root = mkdtempSync('/tmp/ckenv-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const socket = join(root, 'sentinel.sock')
  const outbox = join(root, 'sentinel.ndjson')
  writeFileSync(outbox, JSON.stringify({ body: 'Do not relay this sentinel' }) + '\n')
  let connections = 0
  const server = createServer(conn => {
    connections += 1
    conn.destroy()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const files = readdirSync(TEST_DIR)
    .filter(name => name.endsWith('.test.mjs') && name !== 'env-isolation.test.mjs')
    .map(name => join(TEST_DIR, name))
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    env: testEnv({
      HOME: root,
      TMPDIR: root,
      XDG_RUNTIME_DIR: root,
      CLODEKS_APP_SOCKET: socket,
      CLODEKS_OUTBOX: outbox,
      CLAUDE_CODE_MESSAGING_SOCKET: socket,
      CLAUDE_CODE_MESSAGING_TOKEN: 'sentinel',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NESTED_TIMEOUT_MS,
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(connections, 0, `tests reached inherited service paths ${connections} times`)
  assert.equal(code, 0, output)
})
