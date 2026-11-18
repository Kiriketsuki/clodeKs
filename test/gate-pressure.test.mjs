import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as gate from '../lib/gate.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const TUI = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const GIB = 1024 ** 3

function launch(command, { some = 0, full = 0, swapInPages = 0, unknown = false, flags = [] } = {}) {
  const preload = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const read = fs.readFileSync
    const deltas = ${JSON.stringify([swapInPages].flat())}
    let polls = 0
    let pswpin = 100000
    fs.readFileSync = (path, ...args) => {
      if (path === '/proc/meminfo') return 'MemAvailable: 6291456 kB\\nSwapTotal: 16777216 kB\\nSwapFree: 2097152 kB\\n'
      if (path === '/proc/pressure/memory' || path === '/proc/vmstat') {
        if (${unknown}) throw new Error('missing fixture metric')
        if (path === '/proc/vmstat') {
          if (polls % 2 === 1) pswpin += deltas[Math.min(Math.floor(polls / 2), deltas.length - 1)]
          polls++
          return 'pswpin ' + pswpin + '\\n'
        }
        return 'some avg10=${some} avg60=0 total=0\\nfull avg10=${full} avg60=0 total=0\\n'
      }
      return read(path, ...args)
    }
    syncBuiltinESMExports()
  `
  const env = testEnv({ CLODEKS_CODEX_BIN: command === 'run' ? FAKE : TUI, FAKE_MODE: 'capture-prompt' })
  const marker = join(env.XDG_RUNTIME_DIR, 'started.txt')
  env.FAKE_PROMPT_RECORD = marker
  const args = command === 'run' ? ['--prompt', 'pressure gate'] : ['--socket', TUI]
  const output = spawnSync(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(preload), CLI, command, ...args, ...flags,
  ], { cwd: env.XDG_RUNTIME_DIR, env, encoding: 'utf8', timeout: 10000 })
  assert.ifError(output.error)
  return { ...output, started: existsSync(marker) }
}

test('pressure gate parses overrides, off values and invalid inputs', () => {
  const limits = gate.parseGate('psi=25.5,psifull=off,swapin=3000,swap=16GiB')
  assert.equal(limits.psiSomeMax, 25.5)
  assert.equal(limits.psiFullMax, null)
  assert.equal(limits.swapInMax, 3000)
  assert.equal(limits.swapMaxBytes, 16 * GIB)
  assert.equal(gate.parseGate('swap=off').swapMaxBytes, null)
  for (const spec of ['psi=101', 'psifull=-1', 'swapin=NaN', 'swap=1Z', 'psi=20,psi=off']) {
    assert.throws(() => gate.parseGate(spec), /wait-gate/)
  }
})

test('pressure sampler derives pages per second over the actual elapsed time', async () => {
  let count = 0
  let now = 100
  const sample = await gate.sampleLaunchResources({}, {
    now: () => now,
    sleep: async ms => { assert.equal(ms, 500); now += 750 },
    read: path => {
      if (path === '/proc/vmstat') return 'pswpin ' + (100000 + count++ * 1500) + '\n'
      if (path === '/proc/pressure/memory') return 'some avg10=20.01 avg60=10 total=0\nfull avg10=5.05 avg60=0 total=0\n'
      assert.equal(path, '/proc/meminfo')
      return 'SwapTotal: 1000 kB\nSwapFree: 500 kB\n'
    },
  })
  assert.deepEqual(sample, { psiSomeAvg10: 20.01, psiFullAvg10: 5.05, swapInPagesPerSec: 2000, swapUsedBytes: 500 * 1024 })
})

for (const command of ['run', 'tui']) {
  test(`${command} refuses default memory pressure before launch`, () => {
    const result = launch(command, { some: 20, full: 5, swapInPages: 3000 })
    assert.equal(result.status, 75, result.stderr)
    assert.match(result.stderr, /after 3 samples/)
    assert.match(result.stderr, /psi=20/)
    assert.match(result.stderr, /psifull=5/)
    assert.match(result.stderr, /swapin=\d/)
    assert.match(result.stderr, /--wait-gate/)
    assert.equal(result.started, false)
    if (command === 'run') {
      const { gate: report, ok } = JSON.parse(result.stdout)
      assert.equal(ok, false)
      assert.equal(report.psi_some_avg10, 20)
      assert.equal(report.psi_full_avg10, 5)
      assert.ok(report.swap_in_pages_per_sec >= 2000)
      assert.equal(report.swap_used_bytes, 14 * GIB)
    } else assert.equal(result.stdout, '')
  })

  test(`${command} admits a launch after a single swap-in spike clears`, () => {
    const result = launch(command, { swapInPages: [5000, 0] })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /ready.*swapin=0\.0/)
    if (command === 'run') {
      const { gate: report } = JSON.parse(result.stdout)
      assert.equal(report.swap_in_pages_per_sec, 0)
      assert.ok(report.wait_reasons.some(reason => reason.startsWith('swapin ')))
      assert.equal(result.started, true)
    } else assert.ok(JSON.parse(result.stdout).includes('--remote'))
  })

  test(`${command} reports unknown active pressure and admits high swap use by default`, () => {
    const result = launch(command, { unknown: true })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /psi=unknown.*psifull=unknown.*swapin=unknown.*swap=15032385536/)
    if (command === 'run') {
      const { gate: report } = JSON.parse(result.stdout)
      assert.equal(report.psi_some_avg10, null)
      assert.equal(report.psi_full_avg10, null)
      assert.equal(report.swap_in_pages_per_sec, null)
      assert.equal(report.swap_used_bytes, 14 * GIB)
    }
  })
}

test('explicit wait uses the overrides and reports the last sample on timeout', () => {
  const flags = ['--wait-gate', 'psi=off,psifull=6,swapin=off,swap=10G', '--gate-timeout', '750ms', '--gate-jitter', '0']
  const result = launch('run', { some: 50, full: 5, flags })
  assert.equal(result.status, 75, result.stderr)
  assert.equal(result.started, false)
  assert.match(result.stderr, /waiting.*psi=50.*psifull=5.*swapin=0.*swap=15032385536/)
  const { gate: report } = JSON.parse(result.stdout)
  assert.equal(report.swap_used_bytes, 14 * GIB)
  assert.equal(report.wait_reasons.length, 1)
  assert.match(report.wait_reasons[0], /swap/i)

  flags[1] = 'psi=off,psifull=6,swapin=off,swap=off'
  flags[3] = '3s'
  const allowed = launch('run', { some: 50, full: 5, flags })
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.equal(allowed.started, true)
  assert.equal(JSON.parse(allowed.stdout).gate.psi_some_avg10, 50)
})
