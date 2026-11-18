import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { serveInbox } from '../lib/inbox.mjs'
import { parseFrame, sendToClaude } from '../lib/peers.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const ALIAS = 'codex-1234abcd'
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

function run(env, args, { cwd, command } = {}) {
  const child = command
    ? spawn('/bin/sh', ['-c', command], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
    : spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

async function setup(t) {
  const base = testEnv()
  const queueBin = join(base.XDG_RUNTIME_DIR, 'queue.mjs')
  const record = join(base.XDG_RUNTIME_DIR, 'queue.json')
  writeFileSync(queueBin, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.QUEUE_RECORD, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 })
  const env = { ...base, CLODEKS_CODEX_BIN: queueBin, QUEUE_RECORD: record,
    CLODEKS_APP_SOCKET: join(base.XDG_RUNTIME_DIR, 'wrong-default.sock') }
  const socket = join(env.XDG_RUNTIME_DIR, "app's.$(false).sock")
  const thread = { id: ID, cwd: '/test', status: { type: 'idle' }, preview: '' }
  const app = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread] }
    if (request.method === 'thread/queue/add') {
      writeFileSync(record, JSON.stringify(['queue', '--message', request.params.input[0].text]))
      return { queuedSubmission: { id: 'test-message' } }
    }
    return { thread }
  })
  t.after(app.close)
  const parent = join(env.XDG_RUNTIME_DIR, 'parent.sock')
  let accept
  const received = new Promise(resolve => { accept = resolve })
  const inbox = createServer(conn => {
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('data', chunk => { buffer += chunk })
    conn.on('end', () => { accept(parseFrame(buffer.trim())) })
  })
  await new Promise((resolve, reject) => { inbox.once('error', reject); inbox.listen(parent, resolve) })
  t.after(() => new Promise(resolve => inbox.close(resolve)))
  return { env, socket, parent, record, received }
}

function queuedText(record) {
  const args = JSON.parse(readFileSync(record, 'utf8'))
  assert.equal(args[0], 'queue')
  return args[args.indexOf('--message') + 1]
}

async function report(state, prompt) {
  const command = prompt.split('\n').find(line => line.startsWith('clodeks claude-send '))
  assert.ok(command, prompt)
  assert.ok(command.includes(`--socket ${quote(state.socket)}`), command)
  const bin = join(state.env.XDG_RUNTIME_DIR, 'bin')
  const worker = join(state.env.XDG_RUNTIME_DIR, 'worker')
  mkdirSync(bin)
  mkdirSync(worker)
  writeFileSync(join(bin, 'clodeks'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(CLI)} "$@"\n`, { mode: 0o700 })
  const result = await run({ ...state.env, PATH: `${bin}:${state.env.PATH}` }, [], {
    cwd: worker, command: command.replace("'your reply'", "'custom-server report'"),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).reply_thread, ID)
  const message = await state.received
  assert.ok(message.body.endsWith('custom-server report'))
  assert.equal(message.fromName, ALIAS)
  assert.equal(message.fromAddress, null)
}

test('peer reply server: send retains a relative custom server across worker folders and defaults', { timeout: 10000 }, async t => {
  const state = await setup(t)
  const result = await run(state.env, ['send', '--socket', "app's.$(false).sock", '--reply-to', `uds:${state.parent}`,
    ALIAS, 'Report the result.'], { cwd: state.env.XDG_RUNTIME_DIR })
  assert.equal(result.code, 0, result.stderr)
  const prompt = queuedText(state.record)
  assert.ok(prompt.endsWith('----- BEGIN PEER MESSAGE -----\nReport the result.\n----- END PEER MESSAGE -----'))
  await report(state, prompt)
})

test('peer reply server: inbox delivery carries its owning app-server into the reply command', { timeout: 10000 }, async t => {
  const state = await setup(t)
  let complete
  let fail
  const queued = new Promise((resolve, reject) => { complete = resolve; fail = reject })
  const inbox = await serveInbox({ alias: ALIAS, threadId: ID, appSocket: state.socket,
    onMessage: complete, onError: fail }, state.env)
  t.after(inbox.close)
  await sendToClaude({ socket: inbox.path, body: 'Report from the inbox.', fromAddress: `uds:${state.parent}` }, state.env)
  await queued
  await report(state, queuedText(state.record))
})

test('peer reply server: raw sends keep the caller body without reply context', async t => {
  const state = await setup(t)
  const body = 'Keep this exact raw body.'
  const result = await run(state.env, ['send', '--socket', state.socket, '--reply-to', `uds:${state.parent}`,
    '--raw', ALIAS, body])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(queuedText(state.record), body)
})
