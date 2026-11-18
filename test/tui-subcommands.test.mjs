import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))
const COMMANDS = [
  ['--model', 'test-model', 'resume', 'stored-thread'],
  ['--model=test-model', 'fork', 'stored-thread'],
  ['-mtest-model', 'resume', 'stored-thread'],
  ['-c', 'model="test-model"', 'exec', 'task'],
  ['--enable', 'test-feature', 'help'],
  ['--image', 'one.png', 'two.png', '--model', 'test-model', 'resume', 'stored-thread'],
  ['--image=one.png', 'two.png', '--model', 'test-model', 'resume', 'stored-thread'],
  ['-ione.png', 'two.png', '--model', 'test-model', 'resume', 'stored-thread'],
  ['cloud-tasks'], ['execpolicy'], ['git-credential'], ['stdio-to-uds'],
  ['tcp-tunnel'], ['responses-api-proxy'],
]

async function launch(env, socket, args) {
  const child = spawn(process.execPath, [CLI, 'tui', '--socket', socket, ...args], {
    env, cwd: env.XDG_RUNTIME_DIR, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr }
}

async function setup(t) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => request.method === 'thread/loaded/list' ? { data: [] } : {})
  t.after(server.close)
  return { env, socket, server }
}

test('tui subcommands: trust refuses option-prefixed and hidden commands before server effects', async t => {
  const { env, socket, server } = await setup(t)
  for (const args of COMMANDS) {
    const result = await launch(env, socket, ['--trust', '--', ...args])
    assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--trust is only supported for a new TUI session/)
    assert.deepEqual(server.requests, [])
    assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
  }
})

test('tui subcommands: stored and native commands receive no new-session permission defaults', async t => {
  const { env, socket, server } = await setup(t)
  for (const args of COMMANDS) {
    const result = await launch(env, socket, ['--permissions', 'auto', '--', ...args])
    assert.equal(result.code, 0, result.stderr)
    const cwdArgs = args.includes('resume') ? [] : ['-C', env.XDG_RUNTIME_DIR]
    assert.deepEqual(JSON.parse(result.stdout), ['--remote', `unix://${socket}`, ...cwdArgs, ...args])
    assert.deepEqual(server.requests, [])
  }
})

test('tui subcommands: a resumed brief stays unchanged and creates no new launch record', async t => {
  const { env, socket, server } = await setup(t)
  const raw = ['--model', 'test-model', 'resume', 'stored-thread']
  const result = await launch(env, socket, ['--brief', BRIEF, '--', ...raw])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['--remote', `unix://${socket}`, ...raw, readFileSync(BRIEF, 'utf8')])
  assert.doesNotMatch(result.stderr, /launch record|brief thread alias/)
  assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
  assert.deepEqual(server.requests, [])
})

test('tui subcommands: command-like values still allow a trusted new brief launch', async t => {
  const { env, socket, server } = await setup(t)
  const raw = ['--model', 'resume']
  const result = await launch(env, socket, ['--trust', '--permissions', 'auto', '--brief', BRIEF, '--', ...raw])
  assert.equal(result.code, 0, result.stderr)
  const args = JSON.parse(result.stdout)
  assert.deepEqual(args.slice(4, -1), ['-c', 'sandbox_mode="workspace-write"', '--approve-for-me', ...raw])
  assert.match(args.at(-1), /^\[clodeks launch [0-9a-f-]{36}\]\n/)
  assert.ok(args.at(-1).endsWith(readFileSync(BRIEF, 'utf8')))
  assert.equal(server.requests.filter(r => r.method === 'config/batchWrite').length, 1)
  assert.match(result.stderr, /launch record/)
})

test('tui subcommands: a raw separator keeps a command-like prompt in a new session', async t => {
  const { env, socket } = await setup(t)
  const raw = ['--', 'resume']
  const result = await launch(env, socket, ['--trust', '--', ...raw])
  assert.equal(result.code, 0, result.stderr)
  const args = JSON.parse(result.stdout)
  assert.deepEqual(args.slice(4), ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"', ...raw])
})
