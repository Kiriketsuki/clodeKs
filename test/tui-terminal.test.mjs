import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const SLOW = fileURLToPath(new URL('./fixtures/slow-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const RECORD_WARNING = 'clodeks tui: launch record writes failed during this session. Check the record before using its alias.\n'

test('tui terminal: late observation failures update the launch record without terminal output', async t => {
  const env = testEnv({ CLODEKS_CODEX_BIN: SLOW })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, ({ method }) => {
    if (method === 'thread/loaded/list') return { data: [] }
    if (method === 'thread/read') throw new Error('isolated observation failure')
    return {}
  })
  t.after(server.close)
  const child = spawn(process.execPath, [CLI, 'tui', '--socket', socket, '--brief', BRIEF], {
    env, cwd: env.XDG_RUNTIME_DIR, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stderr = ''
  let stdout = ''
  let beforeStart
  let sent = false
  child.stderr.on('data', data => { stderr += data })
  child.stdout.on('data', data => {
    stdout += data
    if (!stdout.includes('\n') || sent) return
    sent = true
    beforeStart = stderr
    server.notify('thread/started', { thread: {
      id: ID, cwd: env.XDG_RUNTIME_DIR, ephemeral: false, threadSource: 'user',
      preview: JSON.parse(stdout).at(-1), createdAt: Math.floor(Date.now() / 1000),
    } })
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, stderr)
  assert.equal(stderr, beforeStart, 'the wrapper must not print while the fake TUI owns its streams')
  const path = stderr.match(/clodeks tui: launch record ([^\n]+)/)?.[1]
  assert.ok(path, stderr)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(record.status, 'unavailable')
  assert.match(record.error, /isolated observation failure/)
  assert.ok(record.exited_at)
})

for (const recover of [true, false]) test(`tui terminal: storage failures print one exit warning when recovery is ${recover}`, async t => {
  const fixture = fileURLToPath(new URL('./fixtures/controlled-tui.mjs', import.meta.url))
  const env = testEnv({ CLODEKS_CODEX_BIN: fixture })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  let thread
  const server = await fakeAppServer(socket, ({ method }) => {
    if (method === 'thread/loaded/list') return { data: [] }
    if (method === 'thread/read') return { thread }
    return {}
  })
  t.after(server.close)
  const child = spawn(process.execPath, [CLI, 'tui', '--socket', socket, '--brief', BRIEF], {
    env, cwd: env.XDG_RUNTIME_DIR, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
  })
  t.after(() => child.stdin.end('finish\n'))
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', data => { stderr += data })
  const ready = new Promise(resolve => child.stdout.on('data', data => {
    stdout += data
    if (stdout.includes('\n')) resolve(JSON.parse(stdout))
  }))
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const args = await ready
  const before = stderr
  const path = stderr.match(/clodeks tui: launch record ([^\n]+)/)?.[1]
  assert.ok(path, stderr)
  const folder = dirname(path)
  renameSync(folder, `${folder}.saved`)
  writeFileSync(folder, 'block record updates')
  thread = { id: ID, cwd: env.XDG_RUNTIME_DIR, ephemeral: false, threadSource: 'user',
    preview: args.at(-1), createdAt: Math.floor(Date.now() / 1000) }
  server.notify('thread/started', { thread })
  const deadline = Date.now() + 2000
  while (server.connectionCount() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(server.connectionCount(), 0, 'alias observation must finish before restoring storage')
  assert.equal(stderr, before, 'a late persistence error must not paint over the fake TUI')
  if (recover) {
    renameSync(folder, `${folder}.blocked`)
    renameSync(`${folder}.saved`, folder)
  }
  child.stdin.end('finish\n')
  assert.equal(await done, 0, stderr)
  assert.equal(stderr.slice(before.length), RECORD_WARNING, 'record failures need exactly one warning after TUI exit')
  if (recover) {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(saved.status, 'identified')
    assert.equal(saved.alias, 'codex-1234abcd')
    assert.ok(saved.exited_at)
  }
})

test('tui terminal: a failed executable reports startup failure and finalizes the record', () => {
  const socket = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
  const env = testEnv({ CLODEKS_CODEX_BIN: '/nonexistent-clodeks-test-executable' })
  const result = spawnSync(process.execPath, [CLI, 'tui', '--socket', socket, '--brief', BRIEF,
    '--', '--worktree'], { env, cwd: env.XDG_RUNTIME_DIR, encoding: 'utf8', timeout: 5000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot start Codex/)
  const path = result.stderr.match(/clodeks tui: launch record ([^\n]+)/)?.[1]
  assert.ok(path, result.stderr)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(record.status, 'unavailable')
  assert.match(record.error, /cannot start Codex/)
  assert.ok(record.exited_at)
})
