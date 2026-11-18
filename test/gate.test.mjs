import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const gateModule = () => import('../lib/gate.mjs')
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))
const GIB = 1024 ** 3

test('gate: explicit limits and a bounded default, with no gate by default', async () => {
  const { parseGate } = await gateModule()
  assert.equal(parseGate(), null)
  assert.deepEqual(parseGate('memavail=10G,load=20', '60m'), { memavailBytes: 10 * GIB, loadMax: 20, timeoutMs: 3600000, jitterMs: 15000 })
  assert.deepEqual(parseGate('load=1.5'), { loadMax: 1.5, timeoutMs: 3600000, jitterMs: 15000 })
  assert.deepEqual(parseGate('memavail=0.5GiB', '0.01s'), { memavailBytes: GIB / 2, timeoutMs: 10, jitterMs: 15000 })
})

test('gate: malformed, duplicate, zero, and overflowing limits fail', async () => {
  const { parseGate } = await gateModule()
  for (const spec of ['', 'load=0', 'load=-1', 'load=NaN', 'load=1,load=2', 'memavail=0G', 'memavail=1Z', 'other=2', 'load=1,', 'load=1=2', 'memavail=99999999999999999999G']) {
    assert.throws(() => parseGate(spec), /wait-gate/)
  }
  for (const timeout of ['0', '-1s', 'forever', '1d', '999999999999999999h']) {
    assert.throws(() => parseGate('load=1', timeout), /gate-timeout/)
  }
  assert.throws(() => parseGate(undefined, '1s'), /needs --wait-gate/)
})

test('gate: requested host measurements are validated and independent', async () => {
  const { readHostResources } = await gateModule()
  const unavailable = () => { throw new Error('unavailable') }
  assert.deepEqual(readHostResources({ memavailBytes: 1 }, { read: () => 'MemAvailable: 1234 kB\n', load: unavailable }), { memavailBytes: 1234 * 1024 })
  assert.deepEqual(readHostResources({ loadMax: 1 }, { read: unavailable, load: () => [0.5] }), { load1: 0.5 })
  assert.throws(() => readHostResources({ memavailBytes: 1 }, { read: () => 'MemFree: 123 kB\n' }), /MemAvailable/)
  assert.throws(() => readHostResources({ memavailBytes: 1 }, { read: unavailable }), /MemAvailable/)
  assert.throws(() => readHostResources({ loadMax: 1 }, { load: unavailable }), /load1/)
  assert.throws(() => readHostResources({ loadMax: 1 }, { hostPlatform: 'win32' }), /load1/)
  for (const load of [NaN, -1, Infinity]) {
    assert.throws(() => readHostResources({ loadMax: 1 }, { load: () => [load] }), /load1/)
  }
})

test('gate: both limits must pass in the same sample before launch', async () => {
  const { waitForGate } = await gateModule()
  let clock = 0
  let index = 0
  const samples = [{ memavailBytes: 9 * GIB, load1: 1 }, { memavailBytes: 12 * GIB, load1: 20 }, { memavailBytes: 10 * GIB, load1: 19 }]
  const notices = []
  const result = await waitForGate({ memavailBytes: 10 * GIB, loadMax: 20, timeoutMs: 5000, jitterMs: 0 }, {
    now: () => clock, sample: () => samples[Math.min(index++, samples.length - 1)], sleep: async ms => { clock += ms }, onNotice: text => notices.push(text),
  })
  assert.equal(result.waitedMs, 2000)
  assert.equal(index, 4)
  assert.equal(notices.filter(text => text.startsWith('waiting')).length, 1)
  assert.match(notices[0], /MemAvailable/)
  assert.match(notices.at(-1), /ready/)
})

test('gate: deadlines are bounded and wait notices occur at most once a minute', async () => {
  const { waitForGate } = await gateModule()
  let clock = 0
  const notices = []
  await assert.rejects(waitForGate({ loadMax: 1, timeoutMs: 125000 }, {
    now: () => clock, sample: () => ({ load1: 2 }), sleep: async ms => { clock += ms },
    onNotice: text => notices.push({ clock, text }), pollMs: 10000,
  }), error => error.code === 'GATE_TIMEOUT' && /timed out/.test(error.message))
  assert.equal(clock, 125000)
  assert.deepEqual(notices.map(notice => notice.clock), [0, 60000, 120000])
})

for (const command of ['run', 'tui']) {
  test(`gate CLI: ${command} starts normally when the requested resource limit passes`, () => {
    const env = testEnv({ CLODEKS_CODEX_BIN: command === 'run' ? FAKE : CAPTURE, FAKE_MODE: 'echo' })
    const args = command === 'run' ? ['--cwd', env.XDG_RUNTIME_DIR, '--prompt', 'gate passed'] : ['--socket', CAPTURE]
    const result = spawnSync(process.execPath, [CLI, command, ...args, '--wait-gate', 'memavail=1B', '--gate-timeout', '5s', '--gate-jitter', '0'], {
      cwd: env.XDG_RUNTIME_DIR, env, encoding: 'utf8', timeout: 10000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.ok(command === 'run' ? output.ok : output.includes('--remote'))
    assert.doesNotMatch(result.stderr, /clodeks gate: waiting/)
  })

  test(`gate CLI: ${command} times out without starting a worker or creating launch state`, () => {
    const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'capture-prompt' })
    env.FAKE_PROMPT_RECORD = join(env.XDG_RUNTIME_DIR, 'started.txt')
    const args = command === 'run' ? ['--cwd', env.XDG_RUNTIME_DIR, '--prompt', 'x'] : ['--socket', CAPTURE, '--trust', '--brief', BRIEF]
    const result = spawnSync(process.execPath, [CLI, command, ...args, '--wait-gate', 'memavail=8000000G', '--gate-timeout', '0.01s'], {
      cwd: env.XDG_RUNTIME_DIR, env, encoding: 'utf8', timeout: 10000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 75, result.stderr)
    assert.match(result.stderr, /gate.*timed out/)
    if (command === 'run') assert.equal(JSON.parse(result.stdout).ok, false)
    else assert.equal(result.stdout, '')
    assert.equal(existsSync(env.FAKE_PROMPT_RECORD), false)
    assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'clodeks', 'launches')), false)
  })

  test(`gate CLI: ${command} rejects a timeout without a gate before launch`, () => {
    const result = spawnSync(process.execPath, [CLI, command, '--gate-timeout', '1s'], {
      env: testEnv({ CLODEKS_CODEX_BIN: FAKE }), encoding: 'utf8', timeout: 10000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /needs --wait-gate/)
  })
}

for (const command of ['run', 'tui']) {
  test(`gate CLI: ${command} rejects jitter without a gate and invalid jitter before launch`, () => {
    for (const args of [['--gate-jitter', '0'], ['--wait-gate', 'memavail=1B', '--gate-jitter=-1']]) {
      const result = spawnSync(process.execPath, [CLI, command, ...args], {
        env: testEnv({ CLODEKS_CODEX_BIN: FAKE }), encoding: 'utf8', timeout: 10000,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 2, result.stderr)
      assert.match(result.stderr, /gate-jitter/)
    }
  })
}
