import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runExec } from '../lib/exec.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/preamble-codex.mjs', import.meta.url))
const pause = () => new Promise(resolve => setTimeout(resolve, 20))

function setup(extra = {}) {
  const env = testEnv({ CLODEKS_CODEX_BIN: FIXTURE, ...extra })
  const record = join(env.XDG_RUNTIME_DIR, 'scratch-record')
  return { env: { ...env, FAKE_CLEANUP_RECORD: record }, record }
}

function restore(env, record) {
  chmodSync(join(env.XDG_RUNTIME_DIR, 'clodeks'), 0o700)
  if (existsSync(record)) {
    const blocked = join(readFileSync(record, 'utf8'), 'blocked')
    if (existsSync(blocked)) chmodSync(blocked, 0o700)
  }
}

test('cleanup: a non-removable scratch subtree is repaired without following symlinks', async () => {
  const { env, record } = setup({ FAKE_BLOCKED_SCRATCH: '1' })
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  mkdirSync(outside)
  chmodSync(outside, 0o500)
  try {
    const result = await runExec({ prompt: 'task', sandbox: 'workspace-write', cwd: env.XDG_RUNTIME_DIR, timeoutMs: 5000 },
      { ...env, FAKE_EXTERNAL_DIR: outside })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.cleanup_error, undefined)
    assert.equal(existsSync(dirname(readFileSync(record, 'utf8'))), false)
    assert.equal(statSync(outside).mode & 0o777, 0o500)
  } finally {
    restore(env, record)
    chmodSync(outside, 0o700)
  }
})

test('cleanup: a persistent failure returns cleanup_error without replacing the result', async () => {
  const { env, record } = setup({ FAKE_BLOCK_PARENT: '1' })
  try {
    const result = await runExec({ prompt: 'task', sandbox: 'workspace-write', cwd: env.XDG_RUNTIME_DIR, timeoutMs: 5000 }, env)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.error, null)
    assert.equal(JSON.parse(result.text).wrote, true)
    assert.match(result.cleanup_error, /EACCES/)
  } finally { restore(env, record) }
})

test('cleanup: SIGINT removes scratch before re-raise while the private fixture still runs', async () => {
  const { env, record } = setup()
  const release = join(env.XDG_RUNTIME_DIR, 'release')
  const child = spawn(process.execPath, [CLI, 'run', '--write', '--cwd', env.XDG_RUNTIME_DIR, '--timeout', '10', '--prompt', 'task'], {
    env: { ...env, FAKE_SIGNAL_RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.resume()
  child.stderr.resume()
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  try {
    for (let i = 0; i < 250 && !existsSync(record); i++) await pause()
    assert.equal(existsSync(record), true)
    const scratch = readFileSync(record, 'utf8')
    assert.equal(existsSync(scratch), true)
    child.kill('SIGINT')
    assert.equal((await closed).signal, 'SIGINT')
    assert.equal(existsSync(dirname(scratch)), false)
  } finally {
    writeFileSync(release, 'release')
    for (let i = 0; i < 250 && !existsSync(`${release}.stopped`); i++) await pause()
    if (existsSync(record)) assert.equal(existsSync(`${release}.stopped`), true)
  }
})
