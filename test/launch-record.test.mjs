import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const LAUNCH = 'e97088e9-e4c4-4bbf-8112-b89e5d7a61b3'
const THREAD = '01a11f22-ed3b-7b43-9b60-da491234abcd'

async function create(env, extra = {}) {
  const { createLaunchRecord } = await import('../lib/launch-record.mjs')
  return createLaunchRecord({ launchId: LAUNCH, cwd: '/work', briefPath: '/work/brief.md',
    onError: error => { throw error }, ...extra }, env)
}

test('launch record: preserve an identified alias after the TUI exits', async () => {
  const env = testEnv()
  const record = await create(env)
  assert.equal(record.path, join(env.XDG_RUNTIME_DIR, 'clodeks', 'launches', `${LAUNCH}.json`))
  assert.equal(statSync(record.path).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(record.path)).mode & 0o777, 0o700)
  const pending = JSON.parse(readFileSync(record.path, 'utf8'))
  assert.equal(pending.launch_id, LAUNCH)
  assert.equal(pending.status, 'observing')
  assert.equal(pending.alias, null)
  record.identified('codex-1234abcd', THREAD)
  record.finished()
  const final = JSON.parse(readFileSync(record.path, 'utf8'))
  assert.equal(final.alias, 'codex-1234abcd')
  assert.equal(final.thread_id, THREAD)
  assert.equal(final.status, 'identified')
  assert.ok(final.exited_at >= final.created_at)
})

test('launch record: persist failed observation and early exit states', async () => {
  for (const warning of [null, 'ambiguous worker alias']) {
    const record = await create(testEnv())
    if (warning) record.unavailable(warning)
    record.finished()
    const state = JSON.parse(readFileSync(record.path, 'utf8'))
    assert.equal(state.alias, null)
    assert.equal(state.status, warning ? 'unavailable' : 'closed')
    assert.match(state.error, warning ? /ambiguous/ : /exited/)
  }
})

test('launch record: different launch IDs keep separate files', async () => {
  const env = testEnv()
  const first = await create(env)
  const second = await create(env, { launchId: 'da2a5e85-e57d-4a2c-aef5-f059a3a16da6' })
  first.identified('codex-1234abcd', THREAD)
  assert.notEqual(first.path, second.path)
  assert.equal(JSON.parse(readFileSync(second.path, 'utf8')).alias, null)
})

test('launch record: reject invalid IDs and a symlinked launch directory', async () => {
  await assert.rejects(create(testEnv(), { launchId: '../escape' }), /launch ID/)
  const env = testEnv()
  const root = join(env.XDG_RUNTIME_DIR, 'clodeks')
  const elsewhere = join(env.XDG_RUNTIME_DIR, 'elsewhere')
  mkdirSync(root, { mode: 0o700 })
  mkdirSync(elsewhere, { mode: 0o700 })
  symlinkSync(elsewhere, join(root, 'launches'))
  await assert.rejects(create(env), /plain directory/)
})

test('launch record: report update errors and preserve the previous complete record', async () => {
  const errors = []
  const record = await create(testEnv(), { onError: error => errors.push(error) })
  const folder = dirname(record.path)
  renameSync(folder, `${folder}.saved`)
  writeFileSync(folder, 'block updates')
  record.identified('codex-1234abcd', THREAD)
  assert.equal(errors.length, 1)
  assert.equal(JSON.parse(readFileSync(join(`${folder}.saved`, `${LAUNCH}.json`), 'utf8')).status, 'observing')
  renameSync(folder, `${folder}.blocked`)
  renameSync(`${folder}.saved`, folder)
  record.finished()
  const recovered = JSON.parse(readFileSync(record.path, 'utf8'))
  assert.equal(recovered.status, 'identified')
  assert.equal(recovered.alias, 'codex-1234abcd')
  assert.equal(recovered.thread_id, THREAD)
})

test('launch record: a storage failure warns while the TUI still launches', () => {
  const capture = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
  const env = testEnv({ CLODEKS_CODEX_BIN: capture })
  writeFileSync(join(env.XDG_RUNTIME_DIR, 'clodeks'), 'block runtime directory')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url)),
    'tui', '--socket', capture, '--brief', fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url)),
    '--', '--worktree'], { env, encoding: 'utf8', timeout: 5000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(JSON.parse(result.stdout).includes('--worktree'))
  assert.match(result.stderr, /cannot persist launch record/)
})
