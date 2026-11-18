import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { MAX_QUEUE_CHARS } from '../lib/appserver.mjs'
import { parseFrame } from '../lib/peers.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const BODY = "Original brief keeps $HOME, `code`, apostrophes, and trailing spaces.  \n"

function setup() {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const brief = join(env.XDG_RUNTIME_DIR, 'brief.md')
  writeFileSync(brief, BODY)
  return { env, brief }
}

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

function launch(state, args, options) {
  return run(state.env, ['tui', '--socket', CAPTURE, ...args], options)
}

function prompt(result) {
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout).at(-1)
}

function assertNoLaunch(state, result, pattern) {
  assert.equal(result.code, 2, result.stderr)
  assert.match(result.stderr, pattern)
  assert.equal(result.stdout, '')
  assert.equal(existsSync(join(state.env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
}

test('tui reply: an explicit route reaches the first prompt and preserves the brief', async () => {
  const state = setup()
  const text = prompt(await launch(state, ['--brief', state.brief, '--reply-to', 'uds:/tmp/parent.sock']))
  assert.match(text, /^\[clodeks launch [0-9a-f-]{36}\]\n\[clodeKs reply channel\]/)
  assert.match(text, /clodeks claude-send .*--to 'uds:\/tmp\/parent.sock'/)
  assert.ok(text.includes(`--reply-thread "$CODEX_THREAD_ID" --message 'your reply'`))
  assert.ok(text.endsWith(BODY))
  assert.doesNotMatch(text, /CLODEKS_REPLY|from-mode/)
})

test('tui reply: self resolves the parent path without copying its token', async () => {
  const state = setup()
  state.env = { ...state.env, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/own-parent.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'test-only-token-marker' }
  const result = await launch(state, ['--brief', state.brief, '--reply-to', 'self'])
  assert.ok(prompt(result).includes("--to 'uds:/tmp/own-parent.sock'"))
  assert.doesNotMatch(result.stdout + result.stderr, /test-only-token-marker/)
})

test('tui reply: a session name resolves once to its registry socket', async () => {
  const state = setup()
  const config = join(state.env.XDG_RUNTIME_DIR, 'claude')
  mkdirSync(join(config, 'sessions'), { recursive: true })
  state.env = { ...state.env, CLAUDE_CONFIG_DIR: config }
  writeFileSync(join(config, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, name: 'test-parent', sessionId: 'test-session', messagingSocketPath: '/tmp/named-parent.sock',
  }))
  const text = prompt(await launch(state, ['--brief', state.brief, '--reply-to', 'test-parent']))
  assert.ok(text.includes("--to 'uds:/tmp/named-parent.sock'"))
  assert.ok(text.includes('Reply recipient session: "test-parent"'), text)
  assert.equal(text.includes('--to test-parent'), false)
})

test('tui reply: ambiguous names fail before launch state', async () => {
  const state = setup()
  const config = join(state.env.XDG_RUNTIME_DIR, 'claude')
  mkdirSync(join(config, 'sessions'), { recursive: true })
  state.env = { ...state.env, CLAUDE_CONFIG_DIR: config }
  for (const n of [1, 2]) {
    writeFileSync(join(config, 'sessions', `${n}.json`), JSON.stringify({
      pid: process.pid, name: 'duplicate-parent', sessionId: `session-${n}`, messagingSocketPath: `/tmp/parent-${n}.sock`,
    }))
  }
  const result = await launch(state, ['--brief', state.brief, '--reply-to', 'duplicate-parent'])
  assertNoLaunch(state, result, /--reply-to.*matches 2 Claude sessions/)
})

test('tui reply: invalid and unresolved routes fail before trust or launch state', async () => {
  for (const target of ['', 'uds:relative.sock', 'uds:/tmp/bad\npath.sock', 'uds:/tmp/bad\u0001path.sock', 'unknown-parent']) {
    const state = setup()
    const result = await launch(state, ['--brief', state.brief, '--trust', '--reply-to', target])
    assertNoLaunch(state, result, /--reply-to/)
    assert.doesNotMatch(result.stderr, /worker shell umask|launch record/)
  }
})

test('tui reply: a route needs a brief for a new TUI session', async () => {
  for (const args of [[], ['--', 'resume', 'stored-thread'],
    ['--', '--model', 'test-model', 'resume', 'stored-thread'],
    ['--', '--image', 'one.png', 'two.png', '--model', 'test-model', 'exec', 'task'],
    ['--', 'cloud-tasks']]) {
    const state = setup()
    const brief = args.length ? ['--brief', state.brief] : []
    const result = await launch(state, ['--reply-to', 'uds:/tmp/parent.sock', ...brief, ...args])
    assertNoLaunch(state, result, /--reply-to.*(?:--brief|new TUI session)/)
  }
})

test('tui reply: reply context counts toward the first prompt limit', async () => {
  const state = setup()
  writeFileSync(state.brief, 'x'.repeat(MAX_QUEUE_CHARS - 100))
  const result = await launch(state, ['--brief', state.brief, '--reply-to', 'uds:/tmp/parent.sock'])
  assertNoLaunch(state, result, /brief.*characters.*at most/)
})

test('tui reply: no option adds no reply route even in a Claude environment', async () => {
  const state = setup()
  state.env = { ...state.env, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock' }
  const text = prompt(await launch(state, ['--brief', state.brief]))
  assert.ok(text.endsWith(BODY))
  assert.doesNotMatch(text, /clodeKs reply channel|parent.sock/)
})

test('tui reply: the first prompt command reports through custom sockets from another folder', async t => {
  const state = setup()
  const socket = join(state.env.XDG_RUNTIME_DIR, "app's.sock")
  const parent = join(state.env.XDG_RUNTIME_DIR, "parent's.$(false).sock")
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
  const text = prompt(await run(state.env, ['tui', '--socket', "app's.sock", '--brief', 'brief.md',
    '--reply-to', `uds:${parent}`], { cwd: state.env.XDG_RUNTIME_DIR }))
  const command = text.split('\n').find(line => line.startsWith('clodeks claude-send '))
  assert.ok(command, text)
  const bin = join(state.env.XDG_RUNTIME_DIR, 'bin')
  const worker = join(state.env.XDG_RUNTIME_DIR, 'worker')
  mkdirSync(bin)
  mkdirSync(worker)
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  writeFileSync(join(bin, 'clodeks'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(CLI)} "$@"\n`, { mode: 0o700 })
  const result = await run({ ...state.env, CODEX_THREAD_ID: ID, PATH: `${bin}:${state.env.PATH}` }, [],
    { cwd: worker, command: command.replace("'your reply'", "'first-turn report'") })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).reply_thread, ID)
  assert.equal(frames.length, 1)
  const message = parseFrame(JSON.stringify(frames[0]))
  assert.ok(message.body.includes(ID))
  assert.ok(message.body.endsWith('first-turn report'))
  assert.equal(message.fromAddress, null)
  assert.equal(message.fromName, 'codex-1234abcd')
})

test('tui reply: the launch context asks for authorized continuation without routine steering', async () => {
  const state = setup()
  const text = prompt(await launch(state, ['--brief', state.brief, '--reply-to', 'uds:/tmp/parent.sock']))
  assert.match(text, /Continue through the authorized work in the brief without waiting for routine steering\./)
  assert.ok(text.endsWith(BODY))
})

test('tui reply: continuation preserves explicit stops, approval gates, and blocking questions', async () => {
  const state = setup()
  const body = 'Complete item one. Then stop for review. Merge only after an exact-head order.\n'
  writeFileSync(state.brief, body)
  const text = prompt(await launch(state, ['--brief', state.brief, '--reply-to', 'uds:/tmp/parent.sock']))
  const context = text.slice(0, -body.length)
  assert.match(context, /Respect explicit stop instructions and required approval, review, and merge gates\./)
  assert.match(context, /Ask through this route when missing information blocks the next authorized step\./)
  assert.match(context, /This guidance grants no extra permissions or merge authority\./)
  assert.ok(text.endsWith(body))
})
