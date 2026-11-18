import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const SLOW = fileURLToPath(new URL('./fixtures/slow-tui.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'

function setup() {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const launcher = join(env.XDG_RUNTIME_DIR, 'launcher')
  const worktree = join(env.XDG_RUNTIME_DIR, 'issue worktree')
  mkdirSync(launcher)
  mkdirSync(worktree)
  writeFileSync(join(launcher, 'brief.md'), 'Use the assigned issue worktree.\n')
  writeFileSync(join(worktree, 'brief.md'), 'This is the wrong brief.\n')
  return { env, launcher, worktree }
}

function launch(state, args) {
  const result = spawnSync(process.execPath, [CLI, 'tui', '--socket', CAPTURE, ...args], {
    env: state.env, cwd: state.launcher, encoding: 'utf8', timeout: 5000,
  })
  assert.ifError(result.error)
  return result
}

function record(stderr) {
  const path = stderr.match(/clodeks tui: launch record ([^\n]+)/)?.[1]
  assert.ok(path, stderr)
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('tui cwd: selected worktree aligns trust, native root, record, and alias observation', async t => {
  const state = setup()
  const { env, launcher, worktree } = state
  let thread
  const socket = join(launcher, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: [] }
    if (request.method === 'thread/read') return { thread }
    return {}
  })
  t.after(server.close)
  const child = spawn(process.execPath, [CLI, 'tui', '--socket', 'app.sock', '--cwd', '../issue worktree',
    '--brief', 'brief.md', '--trust'], {
    env: { ...env, CLODEKS_CODEX_BIN: SLOW }, cwd: launcher, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (!stdout.includes('\n') || thread) return
    thread = { id: ID, cwd: worktree, ephemeral: false, threadSource: 'user',
      preview: JSON.parse(stdout).at(-1), createdAt: Math.floor(Date.now() / 1000) }
    server.notify('thread/started', { thread })
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, stderr)
  const args = JSON.parse(stdout)
  assert.equal(args[args.indexOf('-C') + 1], worktree)
  assert.ok(args.at(-1).endsWith(readFileSync(join(launcher, 'brief.md'), 'utf8')))
  assert.equal(args.includes('--cwd'), false)
  const saved = record(stderr)
  assert.equal(saved.cwd, worktree)
  assert.equal(saved.brief_path, join(launcher, 'brief.md'))
  assert.equal(saved.alias, 'codex-1234abcd')
  assert.equal(saved.thread_id, ID)
  assert.equal(saved.status, 'identified')
  const writes = server.requests.filter(r => r.method === 'config/batchWrite')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].params.edits[0].keyPath, `projects.${JSON.stringify(worktree)}.trust_level`)
  assert.doesNotMatch(stderr, /observation skipped/)
})

test('tui cwd: permission modes keep their scope and approval settings', () => {
  const state = setup()
  for (const permissions of ['ask', 'auto', 'read-only']) {
    const result = launch(state, ['--cwd', state.worktree, '--permissions', permissions])
    assert.equal(result.status, 0, result.stderr)
    const args = JSON.parse(result.stdout)
    assert.equal(args[3], state.worktree)
    assert.ok(args.includes(`sandbox_mode="${permissions === 'read-only' ? 'read-only' : 'workspace-write'}"`))
    if (permissions === 'auto') assert.ok(args.includes('--approve-for-me'))
    else assert.ok(args.includes('approval_policy="on-request"'))
  }
})

test('tui cwd: missing, empty, file, and dangling paths fail before launch side effects', () => {
  const state = setup()
  const missing = join(state.env.XDG_RUNTIME_DIR, 'missing')
  const file = join(state.launcher, 'brief.md')
  const dangling = join(state.launcher, 'dangling')
  symlinkSync(missing, dangling)
  for (const cwd of [missing, '', file, dangling]) {
    const result = launch(state, ['--cwd', cwd, '--brief', 'brief.md', '--trust'])
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--cwd.*existing folder/)
    assert.equal(existsSync(join(state.env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
  }
  assert.equal(existsSync(missing), false)
})

test('tui cwd: conflicting raw cwd flags fail before launch', () => {
  const state = setup()
  for (const args of [['-C', '/other'], ['--cd=/other'], ['--worktree']]) {
    const result = launch(state, ['--cwd', state.worktree, '--brief', 'brief.md', '--trust', '--', ...args])
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /--cwd.*forwarded cwd/)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(state.env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
  }
})

test('tui cwd: wrapper scope cannot override forwarded subcommands', () => {
  const state = setup()
  for (const command of ['fork', 'exec', 'help']) {
    const result = launch(state, ['--cwd', state.worktree, '--', command])
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /--cwd.*new TUI session/)
    assert.equal(result.stdout, '')
  }
})

test('tui cwd: symlink roots use the same canonical folder in argv and the launch record', () => {
  const state = setup()
  const link = join(state.launcher, 'worktree-link')
  symlinkSync(state.worktree, link, 'dir')
  const result = launch(state, ['--cwd', 'worktree-link', '--brief', 'brief.md'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout)[3], realpathSync(link))
  assert.equal(record(result.stderr).cwd, realpathSync(link))
})

test('tui cwd: native options before a subcommand cannot bypass scope checks', () => {
  const state = setup()
  for (const [args, error] of [
    [['--model', 'test-model', 'resume', 'stored-thread'], /--trust.*new TUI session/],
    [['--model=test-model', 'fork', 'stored-thread'], /--cwd.*new TUI session/],
    [['-mtest-model', 'resume', 'stored-thread'], /--trust.*new TUI session/],
    [['-c', 'model="test-model"', 'exec', 'task'], /--cwd.*new TUI session/],
    [['--enable', 'test-feature', 'help'], /--cwd.*new TUI session/],
    [['--image', 'first.png', 'second.png', '--model', 'test-model', 'resume', 'stored-thread'], /--trust.*new TUI session/],
    [['--image=first.png', 'second.png', '--model', 'test-model', 'resume', 'stored-thread'], /--trust.*new TUI session/],
    [['-ifirst.png', 'second.png', '--model', 'test-model', 'resume', 'stored-thread'], /--trust.*new TUI session/],
  ]) {
    const result = launch(state, ['--cwd', state.worktree, '--trust', '--', ...args])
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, error)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(state.env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
  }
})

test('tui cwd: native option values that resemble commands remain values', () => {
  const state = setup()
  for (const args of [['--model', 'resume', 'Write the report'], ['-mresume', 'Write the report'], ['--image', 'first.png', 'resume']]) {
    const result = launch(state, ['--cwd', state.worktree, '--', ...args])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).slice(-args.length), args)
  }
})

test('tui cwd: pinned aliases and hidden commands cannot bypass scope checks', () => {
  const state = setup()
  for (const command of ['cloud-tasks', 'execpolicy', 'git-credential', 'stdio-to-uds',
    'tcp-tunnel', 'responses-api-proxy', ...(['darwin', 'win32'].includes(process.platform) ? ['app'] : [])]) {
    const result = launch(state, ['--cwd', state.worktree, '--trust', '--', command])
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /--cwd.*new TUI session/)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(state.env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
  }
})
