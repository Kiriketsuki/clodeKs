import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { waitForGate } from '../lib/gate.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))

test('gate report: a ready result preserves elapsed time and the last wait reasons', async () => {
  let clock = 0
  const report = await waitForGate({ loadMax: 1, timeoutMs: 5000, jitterMs: 0 }, {
    now: () => clock, sample: () => ({ load1: clock < 1000 ? 2 : 0 }), sleep: async ms => { clock += ms },
  })
  assert.equal(report.waited_ms, 1000)
  assert.deepEqual(report.wait_reasons, ['load1 2 is at or above 1'])
})

test('gate report: a timeout error preserves elapsed time and the blocked sample reasons', async () => {
  let clock = 0
  await assert.rejects(waitForGate({ loadMax: 1, timeoutMs: 1500 }, {
    now: () => clock, sample: () => ({ load1: 3 }), sleep: async ms => { clock += ms },
  }), error => {
    assert.equal(error.code, 'GATE_TIMEOUT')
    assert.equal(error.gate.waited_ms, 1500)
    assert.deepEqual(error.gate.wait_reasons, ['load1 3 is at or above 1'])
    return true
  })
})

test('gate report: an unavailable measurement retains the failure reason', async () => {
  await assert.rejects(waitForGate({ loadMax: 1, timeoutMs: 5000, jitterMs: 0 }, {
    now: () => 0, sample: () => { throw new Error('resource gate cannot read load1') },
  }), error => {
    assert.equal(error.gate.waited_ms, 0)
    assert.deepEqual(error.gate.wait_reasons, ['resource gate cannot read load1'])
    return true
  })
})

test('gate report: a slow blocked sample retains its reason without permitting a late start', async () => {
  let clock = 0
  await assert.rejects(waitForGate({ memavailBytes: 2, timeoutMs: 10 }, {
    now: () => clock, sample: () => { clock = 20; return { memavailBytes: 1 } },
  }), error => {
    assert.equal(error.code, 'GATE_TIMEOUT')
    assert.equal(error.gate.waited_ms, 20)
    assert.deepEqual(error.gate.wait_reasons, ['MemAvailable 1 bytes is below 2'])
    return true
  })
})

function run(args) {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'capture-prompt-json' })
  env.FAKE_PROMPT_RECORD = join(env.XDG_RUNTIME_DIR, 'started.txt')
  const result = spawnSync(process.execPath, [CLI, 'run', '--cwd', env.XDG_RUNTIME_DIR, '--prompt', 'x', ...args], {
    env, encoding: 'utf8', timeout: 10000,
  })
  assert.ifError(result.error)
  return { ...result, env }
}

test('gate report CLI: the default launch check adds gate metadata to the run result', () => {
  const result = run([])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.deepEqual(output.gate.wait_reasons, [])
  assert.equal(output.gate.jitter_ms, 0)
  for (const key of ['psi_some_avg10', 'psi_full_avg10', 'swap_in_pages_per_sec', 'swap_used_bytes']) {
    const value = output.gate[key]
    assert.ok(value === null || (Number.isFinite(value) && value >= 0), key)
  }
})

test('gate report CLI: a ready run includes metadata without changing its worker answer', () => {
  const result = run(['--wait-gate', 'memavail=1B', '--gate-timeout', '5s', '--gate-jitter', '0'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.result, '{"answer":"captured"}')
  assert.ok(output.gate.waited_ms >= 0)
  assert.deepEqual(output.gate.wait_reasons, [])
  assert.equal(output.gate.jitter_ms, 0)
})

test('gate report CLI: structured worker results remain separate from gate metadata', () => {
  const result = run(['--wait-gate', 'memavail=1B', '--gate-timeout', '5s', '--gate-jitter', '0', '--schema-json',
    '{"type":"object","properties":{"answer":{"type":"string"}}}'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.result, { answer: 'captured' })
  assert.ok(output.gate.waited_ms >= 0)
  assert.deepEqual(output.gate.wait_reasons, [])
  assert.equal(output.gate.jitter_ms, 0)
})

test('gate report CLI: gate timeout emits one failure JSON line without starting a worker', () => {
  const result = run(['--wait-gate', 'memavail=8000000G', '--gate-timeout', '0.01s'])
  assert.equal(result.status, 75, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, false)
  assert.equal(output.result, null)
  assert.equal(output.thread_id, null)
  assert.match(output.error, /gate timed out/)
  assert.ok(output.gate.waited_ms >= 10)
  assert.equal(output.gate.jitter_ms, 0)
  assert.ok(Array.isArray(output.gate.wait_reasons))
  for (const reason of output.gate.wait_reasons) assert.match(reason, /MemAvailable/)
  assert.equal(existsSync(result.env.FAKE_PROMPT_RECORD), false)
})

test('gate report TUI: the launch record retains metadata without a new terminal JSON line', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const result = spawnSync(process.execPath, [CLI, 'tui', '--socket', CAPTURE, '--brief', BRIEF,
    '--wait-gate', 'memavail=1B', '--gate-timeout', '5s', '--gate-jitter', '0'], { env, encoding: 'utf8', timeout: 10000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Array.isArray(JSON.parse(result.stdout)))
  const path = result.stderr.match(/clodeks tui: launch record ([^\n]+)/)?.[1]
  assert.ok(path, result.stderr)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(record.gate.waited_ms >= 0)
  assert.deepEqual(record.gate.wait_reasons, [])
  assert.equal(record.gate.jitter_ms, 0)
  assert.doesNotMatch(result.stderr, /"waited_ms"/)
})
