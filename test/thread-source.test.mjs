import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { listThreads, summarizeThread } from '../lib/appserver.mjs'
import { createLaunchRecord } from '../lib/launch-record.mjs'
import { runtimeDir } from '../lib/paths.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const LAUNCH = 'e97088e9-e4c4-4bbf-8112-b89e5d7a61b3'
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const thread = (extra = {}) => ({ id: ID, cwd: '/work', source: 'vscode', originator: 'clodeks',
  preview: `[clodeks launch ${LAUNCH}]\nA task`, status: { type: 'idle' }, ...extra })
function record(env) {
  const value = createLaunchRecord({ launchId: LAUNCH, cwd: '/work', briefPath: '/work/brief.md', onError: error => { throw error } }, env)
  value.identified('codex-1234abcd', ID)
  return value
}
const summary = (env, value = thread()) => summarizeThread(value, new Set([value.id]), env)

test('source: confirmed brief launch reports wrapper provenance and preserves the backend label', () => {
  const env = testEnv()
  record(env)
  const value = summary(env)
  assert.equal(value.source, 'clodeks-tui')
  assert.equal(value.backend_source, 'vscode')
  assert.match(value.caller_umask, /^0[0-7]{3}$/)
})

test('source: backend vscode and originator do not prove a frontend without a record', () => {
  const env = testEnv()
  for (const extra of [{}, { preview: 'No marker', originator: 'codex-tui' }, { source: { vscode: {} } }]) {
    const value = summary(env, thread(extra))
    assert.equal(value.source, null)
    assert.equal(value.backend_source, 'vscode')
  }
  assert.equal(existsSync(runtimeDir(env)), false)
})

test('source: native, exec, custom, and subagent backend labels keep their existing normalization', () => {
  const env = testEnv()
  for (const [source, expected] of [['cli', 'cli'], ['exec', 'exec'], ['appServer', 'appServer'],
    [{ custom: 'other-client' }, 'custom'], [{ subAgent: { thread_spawn: {} } }, 'subAgent'], [null, null]]) {
    const value = summary(env, thread({ source }))
    assert.equal(value.source, expected)
    assert.equal(value.backend_source, expected)
  }
})

test('source: malformed and unconfirmed records cannot claim wrapper provenance', () => {
  const env = testEnv()
  const value = record(env)
  const original = JSON.parse(readFileSync(value.path, 'utf8'))
  for (const patch of [{ v: 2 }, { launch_id: 'other-launch' }, { thread_id: 'other-thread' },
    { cwd: '/another-workspace' }, { status: 'observing' }, { status: 'unavailable' }]) {
    writeFileSync(value.path, JSON.stringify({ ...original, ...patch }))
    const result = summary(env)
    assert.equal(result.source, null, JSON.stringify(patch))
    assert.equal(result.backend_source, 'vscode')
  }
  writeFileSync(value.path, '{')
  assert.equal(summary(env).source, null)
  writeFileSync(value.path, JSON.stringify(original))
  assert.equal(summary(env, thread({ id: 'different-thread' })).source, null)
  assert.equal(summary(env, thread({ cwd: '/different-workspace' })).source, null)
})

test('source: unsafe files and directories leave both provenance and caller mask unknown', () => {
  for (const target of ['file', 'launches', 'runtime', 'symlink-file', 'symlink-directory']) {
    const env = testEnv()
    const value = record(env)
    const folder = dirname(value.path)
    if (target === 'file') chmodSync(value.path, 0o644)
    if (target === 'launches') chmodSync(folder, 0o755)
    if (target === 'runtime') chmodSync(runtimeDir(env), 0o755)
    if (target === 'symlink-file') {
      renameSync(value.path, `${value.path}.saved`)
      symlinkSync(`${value.path}.saved`, value.path)
    }
    if (target === 'symlink-directory') {
      renameSync(folder, `${folder}.saved`)
      symlinkSync(`${folder}.saved`, folder)
    }
    const result = summary(env)
    assert.equal(result.source, null, target)
    assert.equal(result.caller_umask, null, target)
  }
})

test('source: provenance survives launcher exit and does not depend on a valid caller mask', () => {
  const env = testEnv()
  const value = record(env)
  value.finished()
  const saved = JSON.parse(readFileSync(value.path, 'utf8'))
  writeFileSync(value.path, JSON.stringify({ ...saved, caller_umask: 'unknown' }))
  assert.equal(summary(env).source, 'clodeks-tui')
  assert.equal(summary(env).caller_umask, null)
  assert.equal(summary(env).backend_source, 'vscode')
})

test('source: list discovery covers stored and loaded-outside-page threads without mutation', async t => {
  const env = testEnv()
  record(env)
  const other = thread({ id: 'unmarked', preview: 'ordinary remote client' })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [other] }
    if (request.method === 'thread/read') return { thread: thread() }
    return {}
  })
  t.after(server.close)
  const values = await listThreads(socket, { all: true, env })
  assert.deepEqual(values.map(value => [value.id, value.source, value.backend_source]),
    [[ID, 'clodeks-tui', 'vscode'], ['unmarked', null, 'vscode']])
  assert.ok(server.requests.every(value => ['initialize', 'thread/loaded/list', 'thread/list', 'thread/read', 'thread/queue/list'].includes(value.method)))
})
