import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { codexPromptFor } from '../lib/inbox.mjs'
import { parseFrame } from '../lib/peers.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const ZSH = '/usr/bin/zsh'
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

function execute(env, command) {
  const child = spawn(ZSH, ['-fc', command], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

test('reply template: no alias keeps a usable message argument without a reply-thread flag', () => {
  const text = codexPromptFor({ body: 'question', fromName: null, fromAddress: 'uds:/tmp/parent.sock' })
  const command = text.split('\n').find(line => line.startsWith('clodeks claude-send '))
  assert.ok(command?.endsWith("--message 'your reply'"), text)
  assert.doesNotMatch(command, /--reply-thread|<</)
  assert.ok(text.endsWith('----- BEGIN PEER MESSAGE -----\nquestion\n----- END PEER MESSAGE -----'))
})

test('reply template: message arguments work when zsh cannot create a heredoc file', { skip: !existsSync(ZSH) }, async t => {
  const initial = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(initial.XDG_RUNTIME_DIR, 'app.sock')
  const parent = join(initial.XDG_RUNTIME_DIR, 'parent.sock')
  const bin = join(initial.XDG_RUNTIME_DIR, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'clodeks'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(CLI)} "$@"\n`, { mode: 0o700 })
  const env = { ...initial, CLODEKS_APP_SOCKET: socket, PATH: `${bin}:${initial.PATH}`, TMPPREFIX: '/proc/clodeks-heredoc-' }
  const thread = { id: ID, cwd: '/test', status: { type: 'idle' }, preview: '' }
  const app = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread] }
    return { thread }
  })
  t.after(app.close)
  const frames = []
  const inbox = createServer(conn => {
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('data', chunk => { buffer += chunk })
    conn.on('end', () => { frames.push(...buffer.trim().split('\n').map(line => JSON.parse(line))) })
  })
  await new Promise((resolve, reject) => { inbox.once('error', reject); inbox.listen(parent, resolve) })
  t.after(() => new Promise(resolve => inbox.close(resolve)))

  const oldForm = await execute(env, "cat <<'CLODEKS_REPLY'\nreport\nCLODEKS_REPLY")
  assert.notEqual(oldForm.code, 0)
  assert.match(oldForm.stderr, /temp file.*here document/)
  const prompt = codexPromptFor({ body: 'Report the result.', fromName: 'test-parent', fromAddress: `uds:${parent}` }, 'codex-1234abcd')
  const command = prompt.split('\n').find(line => line.startsWith('clodeks claude-send '))
  assert.ok(command?.endsWith("--message 'your reply'"), prompt)
  const body = "Report keeps $HOME, `false`, $(false), and an apostrophe: it's ready.\nSecond line.\n"
  const result = await execute(env, command.replace("'your reply'", quote(body)))
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).reply_thread, ID)
  assert.equal(frames.length, 1)
  const message = parseFrame(JSON.stringify(frames[0]))
  assert.ok(message.body.endsWith(body))
  assert.equal(message.fromName, 'codex-1234abcd')
  assert.equal(message.fromAddress, null)
})
