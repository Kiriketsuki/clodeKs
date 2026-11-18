import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { inboxSocketFor } from '../lib/inbox.mjs'
import { parseFrame } from '../lib/peers.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const ALIAS = 'codex-1234abcd'
const BODY = 'Result line one.\nSecond line keeps $HOME and apostrophes: it is ready.\n'

function cli(env, args, cwd) {
  const child = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
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
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, "app's.sock")
  const thread = { id: ID, cwd: '/test', status: { type: 'idle' }, preview: '' }
  const app = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread] }
    return { thread }
  })
  t.after(app.close)
  const frames = []
  const parent = join(env.XDG_RUNTIME_DIR, 'parent.sock')
  const inbox = createServer(conn => {
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('data', chunk => { buffer += chunk })
    conn.on('end', () => {
      for (const line of buffer.trim().split('\n')) frames.push(JSON.parse(line))
    })
  })
  await new Promise((resolve, reject) => { inbox.once('error', reject); inbox.listen(parent, resolve) })
  t.after(() => new Promise(resolve => inbox.close(resolve)))
  return { env, socket, parent, frames }
}

async function executeReply(env, command, cwd) {
  const commandDir = mkdtempSync(join(env.XDG_RUNTIME_DIR, 'bin-'))
  const shim = join(commandDir, 'clodeks')
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`, { mode: 0o700 })
  const executable = join(env.XDG_RUNTIME_DIR, 'reply.sh')
  writeFileSync(executable, command.replace("'your reply'", "'acknowledged'"))
  const child = spawn('/bin/sh', [executable], {
    env: { ...env, PATH: `${commandDir}:${env.PATH}` }, cwd,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let replyOutput = ''
  let replyError = ''
  child.stdout.on('data', chunk => { replyOutput += chunk })
  child.stderr.on('data', chunk => { replyError += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, replyError)
  assert.equal(JSON.parse(replyOutput).thread_id, ID)
}

test('reply route: unexposed threads advertise a direct reply and no fabricated inbox address', async t => {
  const { env, socket, parent, frames } = await setup(t)
  assert.equal(existsSync(inboxSocketFor(ALIAS, env)), false)
  const result = await cli(env, ['claude-send', '--to', `uds:${parent}`, '--socket', socket,
    '--reply-thread', ALIAS, '--message', BODY])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(frames.length, 1)
  assert.equal(Object.hasOwn(frames[0], 'from'), false)
  assert.doesNotMatch(frames[0].message.content, /from="uds:/)
  const message = parseFrame(JSON.stringify(frames[0]))
  assert.equal(message.fromName, ALIAS)
  assert.equal(message.fromAddress, null)
  assert.match(message.body, /Reply with codex_send/)
  assert.ok(message.body.includes(ID))
  assert.ok(message.body.endsWith(BODY))
  const output = JSON.parse(result.stdout)
  assert.equal(output.reply_address, null)
  assert.equal(output.reply_thread, ID)
  assert.equal(output.reply_alias, ALIAS)
  assert.match(output.reply_command, /^clodeks send /)
  assert.equal(existsSync(inboxSocketFor(ALIAS, env)), false)

  await executeReply(env, output.reply_command)

})

test('reply route: a custom sender name cannot replace the resolved reply target', async t => {
  const { env, socket, parent, frames } = await setup(t)
  const result = await cli(env, ['claude-send', '--to', `uds:${parent}`, '--socket', socket,
    '--reply-thread', ALIAS, '--from-name', 'custom-worker', '--message', BODY])
  assert.equal(result.code, 0, result.stderr)
  const message = parseFrame(JSON.stringify(frames[0]))
  assert.equal(message.fromName, 'custom-worker')
  assert.equal(message.fromAddress, null)
  assert.ok(message.body.includes(ID))
  assert.equal(JSON.parse(result.stdout).reply_thread, ID)
})

test('reply route: sends without a reply thread preserve the caller body and result fields', async t => {
  const { env, parent, frames } = await setup(t)
  const result = await cli(env, ['claude-send', '--to', `uds:${parent}`, '--message', BODY])
  assert.equal(result.code, 0, result.stderr)
  const message = parseFrame(JSON.stringify(frames[0]))
  assert.equal(message.body, BODY)
  assert.equal(message.fromAddress, null)
  const output = JSON.parse(result.stdout)
  assert.equal(output.reply_address, null)
  assert.equal(Object.hasOwn(output, 'reply_thread'), false)
  assert.equal(Object.hasOwn(output, 'reply_command'), false)
})

test('reply route: relative sockets retain the sending server across different working directories', async t => {
  const { env, parent } = await setup(t)
  const result = await cli(env, ['claude-send', '--to', `uds:${parent}`, '--socket', "app's.sock",
    '--reply-thread', ALIAS, '--message', BODY], env.XDG_RUNTIME_DIR)
  assert.equal(result.code, 0, result.stderr)
  const recipient = mkdtempSync(join(env.XDG_RUNTIME_DIR, 'receiver-'))
  await executeReply(env, JSON.parse(result.stdout).reply_command, recipient)
})
