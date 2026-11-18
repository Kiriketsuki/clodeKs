import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { listThreads } from '../lib/appserver.mjs'
import { createLaunchRecord } from '../lib/launch-record.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'
import { callerUmask } from '../lib/umask.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))
const LAUNCH = 'f5d1e737-52c1-402a-b1d2-fc89e90cdd40'
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'

function launch(mask, env, ...args) {
  const result = spawnSync('/bin/sh', ['-c', 'umask "$1"\nshift\nexec "$@"',
    'clodeks-umask-test', mask, process.execPath, CLI, ...args], {
    env, cwd: env.XDG_RUNTIME_DIR, encoding: 'utf8', timeout: 5000,
  })
  assert.ifError(result.error)
  return result
}

test('umask: brief launches print and persist the caller mask under 022 and 077', () => {
  for (const mask of ['0022', '0077']) {
    const result = launch(mask, testEnv({ CLODEKS_CODEX_BIN: CAPTURE }), 'tui', '--socket', CAPTURE, '--brief', BRIEF)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, new RegExp(`caller umask ${mask}`))
    assert.match(result.stderr, /worker shell umask is unmeasured/)
    const path = result.stderr.match(/launch record ([^\n]+)/)?.[1]
    const record = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(record.caller_umask, mask)
    assert.equal(record.worker_shell_umask, null)
  }
})

test('umask: run results report caller inheritance without claiming a worker shell mask', () => {
  for (const mask of ['0022', '0077']) {
    const result = launch(mask, testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'umask' }), 'run', '--prompt', 'report')
    assert.equal(result.status, 0, result.stderr)
    const data = JSON.parse(result.stdout)
    assert.equal(data.caller_umask, mask)
    assert.equal(data.worker_shell_umask, null)
    assert.equal(data.result, mask)
    assert.match(result.stderr, new RegExp(`caller umask ${mask}`))
  }
})

test('umask: failed runs still report the caller mask', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: '/missing/fake-codex' })
  const result = launch('0022', env, 'run', '--prompt', 'report')
  assert.equal(result.status, 1)
  const data = JSON.parse(result.stdout)
  assert.equal(data.ok, false)
  assert.equal(data.caller_umask, '0022')
  assert.equal(data.worker_shell_umask, null)
})

async function recordedThread(t) {
  const env = testEnv()
  const record = createLaunchRecord({ launchId: LAUNCH, cwd: '/work', briefPath: '/work/brief.md',
    onError: error => { throw error } }, env)
  record.identified('codex-1234abcd', ID)
  const thread = { id: ID, cwd: '/work', preview: `[clodeks launch ${LAUNCH}]\nA task`, status: { type: 'idle' } }
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') return { data: [ID] }
    if (request.method === 'thread/list') return { data: [thread] }
  })
  t.after(server.close)
  return { env, record, socket }
}

test('umask: thread status reports the caller record and the measured server mask', async t => {
  const state = await recordedThread(t)
  const [thread] = await listThreads(state.socket, { env: state.env })
  assert.equal(thread.caller_umask, callerUmask())
  assert.equal(thread.worker_shell_umask, callerUmask())
  assert.equal(thread.worker_shell_umask_source, 'app-server')
})

test('umask: malformed or mismatched launch metadata remains unknown', async t => {
  const state = await recordedThread(t)
  const data = JSON.parse(readFileSync(state.record.path, 'utf8'))
  for (const patch of [{ thread_id: 'another-thread', caller_umask: '0022' },
    { caller_umask: 'not-octal' }, { caller_umask: ['0022'] },
    { launch_id: 'another-launch', caller_umask: '0022' }]) {
    writeFileSync(state.record.path, JSON.stringify({ ...data, ...patch }))
    const [thread] = await listThreads(state.socket, { env: state.env })
    assert.equal(thread.caller_umask, null)
  }
})

test('umask: thread status refuses a symlinked launch record', async t => {
  const state = await recordedThread(t)
  renameSync(state.record.path, `${state.record.path}.saved`)
  symlinkSync(`${state.record.path}.saved`, state.record.path)
  const [thread] = await listThreads(state.socket, { env: state.env })
  assert.equal(thread.caller_umask, null)
})

test('umask: discovery never invokes the process-wide getter', () => {
  const url = new URL('../lib/umask.mjs', import.meta.url).href
  const script = `process.umask = () => { throw new Error('process-wide getter used') }\n` +
    `const { callerUmask } = await import(${JSON.stringify(url)})\nprocess.stdout.write(JSON.stringify(callerUmask()))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.match(JSON.parse(result.stdout), /^0[0-7]{3}$/)
})

test('umask: unavailable or malformed process status yields an unknown mask', () => {
  const env = testEnv()
  const path = join(env.XDG_RUNTIME_DIR, 'process-status')
  assert.equal(callerUmask(path), null)
  for (const text of ['Name:\tnode\n', 'Umask:\tinvalid\n', 'Umask:\t022\n']) {
    writeFileSync(path, text)
    assert.equal(callerUmask(path), null)
  }
  writeFileSync(path, 'Name:\tnode\nUmask:\t0022\n')
  assert.equal(callerUmask(path), '0022')
})
