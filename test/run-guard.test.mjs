import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runExec } from '../lib/exec.mjs'
import { testEnv } from './helpers/env.mjs'

const api = () => import('../lib/run-guard.mjs')
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const GIB = 1024 ** 3
const opts = cwd => ({ prompt: 'x', cwd, sandbox: 'read-only', timeoutMs: 1000 })
const stat = (pid, group, start = '100', state = 'S') => `${pid} (name with ) space) ${[state, '1', String(group), String(group), ...Array(15).fill('0'), start, '0', '1'].join(' ')}`

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 5000
  let state
  while (Date.now() < deadline) {
    try { state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[0] } catch (err) {
      if (['ENOENT', 'ESRCH'].includes(err.code)) return
      throw err
    }
    if (['Z', 'X'].includes(state)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`tool still runs with state ${state}`)
}

// Each fake stat uses the Linux field positions from state through resident pages.
test('run guards: explicit limits parse without changing unguarded runs', async () => {
  const { parseRunLimits } = await api()
  assert.equal(parseRunLimits({}), null)
  assert.deepEqual(parseRunLimits({ minMemavail: '6G', maxRss: '0.5GiB', maxMinutes: '30' }), {
    minMemavailBytes: 6 * GIB, maxRssBytes: GIB / 2, maxMs: 1800000,
  })
  for (const key of ['minMemavail', 'maxRss']) {
    for (const value of ['0', '-1G', 'NaN', '', '1Z', '0.1B', '99999999999T']) {
      assert.throws(() => parseRunLimits({ [key]: value }))
    }
  }
  for (const value of ['0', '-1', 'Infinity', '1m', '', '99999999999', '0.00000001']) {
    assert.throws(() => parseRunLimits({ maxMinutes: value }), /max-minutes/)
  }
})

test('run guards: RSS sums group members and ignores unrelated processes', async () => {
  const { readGroupRss } = await api()
  const data = new Map([
    ['/proc/10/stat', stat(10, 10)], ['/proc/11/stat', stat(11, 10)], ['/proc/12/stat', stat(12, 12)],
    ['/proc/10/status', 'VmRSS: 100 kB'], ['/proc/11/status', 'VmRSS: 200 kB'],
  ])
  const read = path => {
    assert.ok(data.has(path), `unexpected read ${path}`)
    return data.get(path)
  }
  assert.equal(readGroupRss(10, { read, entries: () => ['10', '11', '12', 'self', 'net'] }), 300 * 1024)
})

test('run guards: disappearing processes are skipped and incomplete group reads fail', async () => {
  const { readGroupRss } = await api()
  const gone = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
  const entries = () => ['10', '11']
  const read = path => path === '/proc/10/stat' ? stat(10, 10) : path === '/proc/10/status' ? 'VmRSS: 100 kB' : gone()
  assert.equal(readGroupRss(10, { read, entries }), 100 * 1024)
  for (const status of ['', 'VmRSS: -1 kB', 'VmRSS: 99999999999999999999 kB']) {
    assert.throws(() => readGroupRss(10, { entries: () => ['10'], read: path => path.endsWith('/stat') ? stat(10, 10) : status }), /RSS/)
  }
  assert.throws(() => readGroupRss(10, { entries: () => ['10'], read: path => {
    if (path.endsWith('/stat')) return stat(10, 10)
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  } }), /RSS/)
  let reads = 0
  assert.throws(() => readGroupRss(10, { entries: () => ['10'], read: path => {
    if (path.endsWith('/stat')) return stat(10, 10, String(++reads))
    return 'VmRSS: 100 kB'
  } }), /RSS/)
})

test('run guards: equality passes and each breached limit reports its value', async () => {
  const { checkRunLimits } = await api()
  const limits = { minMemavailBytes: 100, maxRssBytes: 200, maxMs: 1000 }
  assert.equal(checkRunLimits(limits, { memavailBytes: 100, rssBytes: 200 }, 999), null)
  assert.deepEqual(checkRunLimits(limits, { memavailBytes: 99, rssBytes: 200 }, 20), {
    reason: 'min_memavail', limit: 100, observed: 99, unit: 'bytes', elapsed_ms: 20,
  })
  assert.equal(checkRunLimits(limits, { memavailBytes: 100, rssBytes: 201 }, 20).reason, 'max_rss')
  assert.deepEqual(checkRunLimits(limits, { memavailBytes: 100, rssBytes: 200 }, 1000), {
    reason: 'max_minutes', limit: 1000, observed: 1000, unit: 'ms', elapsed_ms: 1000,
  })
})

test('run guards: preflight refuses unavailable measurements before worker launch', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'capture-prompt' })
  env.FAKE_PROMPT_RECORD = join(env.XDG_RUNTIME_DIR, 'launched')
  const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), resourceLimits: { minMemavailBytes: 1 } }, env, {
    preflight: () => { throw new Error('MemAvailable unavailable') }, pollMs: 5,
  })
  assert.equal(result.ok, false)
  assert.equal(result.resource_stop.reason, 'measurement_unavailable')
  assert.equal(existsSync(env.FAKE_PROMPT_RECORD), false)
})

test('run guards: runtime measurement failure reports a failure without silent fallback', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' })
  const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), resourceLimits: { minMemavailBytes: 1 } }, env, {
    preflight: () => {}, sample: () => { throw new Error('MemAvailable unavailable') }, pollMs: 10,
  })
  assert.equal(result.ok, false)
  assert.equal(result.resource_stop.reason, 'measurement_unavailable')
  assert.equal(result.resource_stop.consecutive_failures, 3)
  assert.match(result.error, /resource/)
})

test('run guards: stop preserves partial files, kills resistant tools, and leaves another run alone', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'guard-writes' })
  const pidFile = join(env.XDG_RUNTIME_DIR, 'tool-pid')
  const release = join(env.XDG_RUNTIME_DIR, 'release')
  const other = runExec({ ...opts(env.XDG_RUNTIME_DIR), timeoutMs: 30000 }, { ...env, FAKE_MODE: 'jobs', FAKE_RELEASE: release })
  try {
    const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), sandbox: 'workspace-write', timeoutMs: 8000, resourceLimits: { maxRssBytes: 1 } }, env, {
      preflight: () => {}, pollMs: 10, sample: () => ({ rssBytes: existsSync(pidFile) ? 2 : 0 }),
    })
    assert.equal(result.error, 'resource limit: max_rss')
    assert.equal(result.resource_stop.observed, 2)
    assert.equal(result.ok, false)
    assert.ok(result.files_changed.includes(join(env.XDG_RUNTIME_DIR, 'partial.txt')))
    assert.equal(result.files_changed_scan.complete, true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await waitForProcessExit(pid)
  } finally {
    writeFileSync(release, '')
    assert.equal((await other).ok, true)
  }
})

test('run guards: max-minutes and timeout preserve the first stop cause', async () => {
  for (const [timeoutMs, maxMs, expected] of [[1000, 30, 'resource limit: max_minutes'], [30, 1000, 'timeout']]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' })
    const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), timeoutMs, resourceLimits: { maxMs } }, env)
    assert.equal(result.error, expected)
    assert.equal(result.resource_stop?.reason, expected === 'timeout' ? undefined : 'max_minutes')
  }
})

test('run guards: successful exit stops sampling while inherited stdout drains', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'exit-leaves-child' })
  const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), timeoutMs: 5000, resourceLimits: { maxMs: 1000, minMemavailBytes: 1 } }, env, {
    preflight: () => {}, pollMs: 10, sample: (_, pid) => ({ memavailBytes: existsSync(`/proc/${pid}`) ? 1 : 0 }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.resource_stop, undefined)
})

test('run guard CLI: accepts limits, prints one failure JSON line, and validates before launch', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' })
  const result = spawnSync(process.execPath, [CLI, 'run', '--cwd', env.XDG_RUNTIME_DIR, '--prompt', 'x', '--max-minutes', '0.001'], { env, encoding: 'utf8', timeout: 10000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stdout.trim().split('\n').length, 1)
  assert.equal(JSON.parse(result.stdout).resource_stop.reason, 'max_minutes')
  for (const args of [['--min-memavail', '0'], ['--max-rss', 'NaN'], ['--max-minutes', '99999999999']]) {
    const rejected = spawnSync(process.execPath, [CLI, 'run', '--prompt', 'x', ...args], { env, encoding: 'utf8', timeout: 10000 })
    assert.ifError(rejected.error)
    assert.equal(rejected.status, 2, rejected.stderr)
    assert.equal(rejected.stdout, '')
  }
})


test('run guard CLI: real Linux memory samples stop low RSS and refuse a low-memory start', () => {
  for (const [flag, value, reason] of [['--max-rss', '1B', 'max_rss'], ['--min-memavail', '8000000G', 'min_memavail']]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' })
    const run = spawnSync(process.execPath, [CLI, 'run', '--cwd', env.XDG_RUNTIME_DIR, '--prompt', 'x', '--timeout', '5', flag, value], {
      env, encoding: 'utf8', timeout: 10000,
    })
    assert.ifError(run.error)
    assert.equal(run.status, 1, run.stderr)
    const result = JSON.parse(run.stdout)
    assert.equal(result.resource_stop.reason, reason, JSON.stringify(result))
    assert.ok(result.resource_stop.observed >= 0)
  }
})

test('run guard CLI: permissive real measurements preserve a successful result', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'echo' })
  const run = spawnSync(process.execPath, [CLI, 'run', '--cwd', env.XDG_RUNTIME_DIR, '--prompt', 'x', '--min-memavail', '1B', '--max-rss', '1T', '--max-minutes', '1'], {
    env, encoding: 'utf8', timeout: 10000,
  })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).ok, true)
  assert.equal(JSON.parse(run.stdout).resource_stop, undefined)
})


test('run guards: an unrelated traced process does not invalidate group RSS', async () => {
  const { readGroupRss } = await api()
  assert.equal(readGroupRss(10, { entries: () => ['10', '12'], read: path => {
    if (path === '/proc/12/stat') return stat(12, 12, '100', 't')
    return path.endsWith('/stat') ? stat(10, 10) : 'VmRSS: 100 kB'
  } }), 100 * 1024)
})

test('run guards: a member that becomes a zombie contributes no live RSS', async () => {
  const { readGroupRss } = await api()
  let reads = 0
  assert.equal(readGroupRss(10, { entries: () => ['10'], read: path => {
    if (path.endsWith('/stat')) return stat(10, 10, '100', ++reads === 1 ? 'S' : 'Z')
    return ''
  } }), 0)
})


test('run guards: unreadable foreign stat entries do not stop RSS sampling', async () => {
  const { readGroupRss } = await api()
  for (const code of ['EACCES', 'EPERM']) {
    const rss = readGroupRss(10, { entries: () => ['12', '10'], read: path => {
      if (path === '/proc/12/stat') throw Object.assign(new Error('foreign stat denied'), { code })
      return path.endsWith('/stat') ? stat(10, 10) : 'VmRSS: 100 kB'
    } })
    assert.equal(rss, 100 * 1024)
  }
})

test('run guards: denied reads after group membership remain incomplete samples', async () => {
  const { readGroupRss } = await api()
  for (const code of ['EACCES', 'EPERM']) {
    for (const deniedRead of ['status', 'second-stat']) {
      let statReads = 0
      assert.throws(() => readGroupRss(10, { entries: () => ['10'], read: path => {
        if (path.endsWith('/stat') && ++statReads === 1) return stat(10, 10)
        if (deniedRead === 'second-stat' && path.endsWith('/status')) return 'VmRSS: 100 kB'
        throw Object.assign(new Error('group read denied'), { code })
      } }), /complete.*RSS/)
    }
  }
})

test('run guards: three consecutive runtime failures stop and a good sample resets the count', async () => {
  const { startRunGuard } = await api()
  const samples = [false, false, true, false, false, false]
  let calls = 0
  let guard
  const stop = await new Promise(resolve => {
    guard = startRunGuard({ minMemavailBytes: 1, maxMs: 3000 }, 10, resolve, {
      pollMs: 5,
      sample: () => {
        const good = samples[calls++]
        if (!good) throw new Error('transient measurement failure')
        return { memavailBytes: 1 }
      },
    })
  })
  guard.close()
  assert.equal(calls, 6)
  assert.equal(stop.reason, 'measurement_unavailable')
  assert.equal(stop.consecutive_failures, 3)
})

test('run guards: two failed runtime samples recover without stopping the worker', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' })
  const release = join(env.XDG_RUNTIME_DIR, 'release')
  let samples = 0
  const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), timeoutMs: 3000, resourceLimits: { minMemavailBytes: 1 } },
    { ...env, FAKE_RELEASE: release }, {
      preflight: () => {}, pollMs: 5,
      sample: () => {
        if (++samples <= 2) throw new Error('temporary measurement failure')
        writeFileSync(release, '')
        return { memavailBytes: 1 }
      },
    })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.resource_stop, undefined)
  assert.ok(samples >= 3)
})

test('run guards: preflight tolerates transient measurement errors without starting an unmeasured worker', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'echo' })
  let calls = 0
  const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), resourceLimits: { minMemavailBytes: 1 } }, env, {
    pollMs: 5,
    preflight: () => {
      if (++calls < 3) throw new Error('temporary MemAvailable failure')
    },
    sample: () => ({ memavailBytes: 1 }),
  })
  assert.equal(calls, 3)
  assert.equal(result.ok, true, result.error)
})

test('run guards: persistent preflight failure reports three failed observations', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'capture-prompt' })
  env.FAKE_PROMPT_RECORD = join(env.XDG_RUNTIME_DIR, 'launched')
  let calls = 0
  const result = await runExec({ ...opts(env.XDG_RUNTIME_DIR), resourceLimits: { maxRssBytes: 1 } }, env, {
    pollMs: 5,
    preflight: () => { calls += 1; throw new Error('RSS unavailable') },
  })
  assert.equal(calls, 3)
  assert.equal(result.resource_stop.reason, 'measurement_unavailable')
  assert.equal(result.resource_stop.consecutive_failures, 3)
  assert.equal(existsSync(env.FAKE_PROMPT_RECORD), false)
})


test('run guards: failed samples do not postpone the worker deadline', async () => {
  const { startRunGuard } = await api()
  let samples = 0
  const stop = await new Promise(resolve => {
    startRunGuard({ minMemavailBytes: 1, maxMs: 20 }, 10, resolve, {
      pollMs: 100,
      sample: () => { samples += 1; throw new Error('temporary failure') },
    })
  })
  assert.equal(stop.reason, 'max_minutes')
  assert.equal(samples, 1)
})


test('run guards: the known group leader cannot become a false zero RSS sample', async () => {
  const { readGroupRss } = await api()
  for (const code of ['EACCES', 'EPERM']) {
    assert.throws(() => readGroupRss(10, { entries: () => ['10'], read: () => {
      throw Object.assign(new Error('leader stat denied'), { code })
    } }), /complete.*RSS/)
  }
})


test('run guards: a failed sample that crosses the deadline reports max-minutes', async () => {
  const { startRunGuard } = await api()
  let clock = 0
  let samples = 0
  const stop = await new Promise(resolve => {
    startRunGuard({ minMemavailBytes: 1, maxMs: 3000 }, 10, resolve, {
      pollMs: 5, now: () => clock,
      sample: () => {
        clock = [0, 1000, 4000][Math.min(samples++, 2)]
        throw new Error('slow failed sample')
      },
    })
  })
  assert.equal(samples, 3)
  assert.equal(stop.reason, 'max_minutes')
  assert.equal(stop.observed, 4000)
})
