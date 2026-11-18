import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'
import { callerUmask } from '../lib/umask.mjs'

const LAUNCH_ID = 'f5d1e737-52c1-402a-b1d2-fc89e90cdd40'
const BRIEF = `[clodeks launch ${LAUNCH_ID}]\nRun the regression tests and report the result.`
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const worker = (id = ID, extra = {}) => ({
  id, cwd: '/work', ephemeral: false, threadSource: 'user', preview: BRIEF,
  createdAt: Math.floor(Date.now() / 1000), ...extra,
})

async function observe(t, read = id => worker(id), options = {}) {
  const { observeBriefLaunch } = await import('../lib/tui-launch.mjs')
  const socket = join(testEnv().XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, async request => {
    if (request.method === 'thread/loaded/list') return { data: ['already-loaded'] }
    if (request.method === 'thread/read') return { thread: await read(request.params.threadId) }
    if (request.method === 'thread/name/set') {
      if (options.hangName) return new Promise(() => {})
      if (options.rejectName) throw new Error('name refused')
      return {}
    }
  })
  t.after(server.close)
  const aliases = []
  const warnings = []
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const { onName, ...observerOptions } = options
  const observer = await observeBriefLaunch(socket, {
    cwd: '/work', brief: BRIEF, launchId: LAUNCH_ID, timeoutMs: 300, pollMs: 5, settleMs: 20,
    onAlias: alias => { aliases.push(alias); if (!options.name) finish() },
    onName: (name, error) => { onName?.(name, error); finish() },
    onWarning: warning => { warnings.push(warning); finish() },
    ...observerOptions,
  })
  t.after(observer.close)
  return { server, aliases, warnings, observer, done }
}

test('tui alias: bind a fresh worker after its brief preview arrives', async t => {
  let ready = false
  const state = await observe(t, id => worker(id, { preview: ready ? BRIEF : '' }))
  for (const thread of [
    worker('already-loaded'), worker('wrong-cwd', { cwd: '/elsewhere' }),
    worker('old-thread', { createdAt: 1 }),
    worker('helper', { ephemeral: true, threadSource: 'thread_title' }),
    worker('other-brief', { preview: 'Another task' }), worker(ID, { preview: '' }),
  ]) state.server.notify('thread/started', { thread })
  ready = true
  await state.done
  assert.deepEqual(state.aliases, ['codex-1234abcd'])
  assert.deepEqual(state.warnings, [])
  assert.ok(state.server.requests.every(r => ['initialize', 'thread/loaded/list', 'thread/read'].includes(r.method)))
})

test('tui alias: refuse two matching launches in the same cwd', async t => {
  const state = await observe(t)
  state.server.notify('thread/started', { thread: worker(ID) })
  state.server.notify('thread/started', { thread: worker('another-worker') })
  await state.done
  assert.deepEqual(state.aliases, [])
  assert.match(state.warnings[0], /ambiguous/)
})

test('tui alias: a timeout reports no alias and leaves threads unchanged', async t => {
  const state = await observe(t)
  await state.done
  assert.deepEqual(state.aliases, [])
  assert.match(state.warnings[0], /not identified/)
})

test('tui alias: a failed read warns instead of guessing', async t => {
  const state = await observe(t, () => { throw new Error('test read refused') })
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  assert.deepEqual(state.aliases, [])
  assert.match(state.warnings[0], /test read refused/)
})

test('tui alias: child exit cancels observation without a late report', async t => {
  const state = await observe(t)
  state.observer.close()
  state.server.notify('thread/started', { thread: worker() })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(state.aliases, [])
  assert.deepEqual(state.warnings, [])
})

test('tui alias: a staggered identical brief cannot claim this launch alias', async t => {
  const env = testEnv({ CLODEKS_CODEX_BIN: fileURLToPath(new URL('./fixtures/slow-tui.mjs', import.meta.url)) })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const fakeBin = join(env.XDG_RUNTIME_DIR, 'bin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'tmux'), "#!/bin/sh\nprintf '0\\tcx-test-window\\n'\n", { mode: 0o700 })
  env.PATH = `${fakeBin}:${env.PATH}`
  env.TMUX = '/tmp/test-only-mux,1,0'
  env.TMUX_PANE = '%42'
  const briefFile = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))
  const { readFileSync } = await import('node:fs')
  let thread
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'thread/loaded/list') {
      return { data: [] }
    }
    if (request.method === 'thread/read') return { thread: request.params.threadId === ID ? thread
      : worker('other-ffffffff', { cwd: env.XDG_RUNTIME_DIR, preview: readFileSync(briefFile, 'utf8') }) }
  })
  t.after(server.close)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url)),
    'tui', '--socket', socket, '--brief', briefFile, '--', '--model', 'test-model'], {
    env, cwd: env.XDG_RUNTIME_DIR, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stderr = ''
  let stdout = ''
  let pendingRecord
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (!stdout.includes('\n') || thread) return
    thread = worker(ID, { cwd: env.XDG_RUNTIME_DIR, preview: JSON.parse(stdout).at(-1) })
    const launchId = thread.preview.match(/^\[clodeks launch ([0-9a-f-]+)\]/)?.[1]
    try {
      pendingRecord = JSON.parse(readFileSync(join(env.XDG_RUNTIME_DIR, 'clodeks', 'launches', `${launchId}.json`), 'utf8'))
    } catch { /* The assertions below report a missing pre-launch record. */ }
    server.notify('thread/started', { thread: worker('other-ffffffff', {
      cwd: env.XDG_RUNTIME_DIR, preview: readFileSync(briefFile, 'utf8'),
    }) })
    setTimeout(() => server.notify('thread/started', { thread }), 850).unref()
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, stderr)
  assert.doesNotMatch(stderr, /clodeks tui: brief thread codex-1234abcd/)
  assert.doesNotMatch(stderr, /brief thread codex-ffffffff/)
  assert.equal(pendingRecord?.status, 'observing')
  const recordPath = stderr.match(/clodeks tui: launch record ([^\n]+)/)?.[1]
  assert.ok(recordPath, stderr)
  const saved = JSON.parse(readFileSync(recordPath, 'utf8'))
  assert.equal(saved.alias, 'codex-1234abcd')
  assert.equal(saved.thread_id, ID)
  assert.equal(saved.tmux_window_name, 'cx-test-window')
  assert.equal(saved.status, 'identified')
  assert.deepEqual(saved.naming, { name: 'Test brief', status: 'named', error: null })
  assert.deepEqual(server.requests.filter(r => r.method === 'thread/name/set').map(r => r.params),
    [{ threadId: ID, name: 'Test brief' }])
  assert.equal(saved.worker_shell_umask, callerUmask())
  assert.equal(saved.worker_shell_umask_source, 'app-server')
  assert.match(stderr, new RegExp(`worker shell umask ${callerUmask()} \\(source app-server\\)`))
  assert.match(stderr, /Shell startup can change it/)
  assert.ok(saved.exited_at)
})


const EMPTY_ROLLOUT = 'failed to read thread: thread-store internal error: failed to read session metadata /tmp/test-rollout.jsonl: rollout at /tmp/test-rollout.jsonl is empty'

test('tui alias: retry an empty startup rollout and bind only after a successful read', async t => {
  let reads = 0
  const state = await observe(t, id => {
    if (++reads <= 2) throw new Error(EMPTY_ROLLOUT)
    return worker(id)
  })
  state.server.notify('thread/started', { thread: worker(ID, { preview: '' }) })
  await state.done
  assert.ok(reads >= 3)
  assert.deepEqual(state.aliases, ['codex-1234abcd'])
  assert.deepEqual(state.warnings, [])
})

test('tui alias: persistent empty rollout reaches the original deadline with its last error', async t => {
  let reads = 0
  const state = await observe(t, () => { reads += 1; throw new Error(EMPTY_ROLLOUT) })
  const started = Date.now()
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  assert.ok(reads > 1)
  assert.ok(Date.now() - started >= 250)
  assert.deepEqual(state.aliases, [])
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /not identified before the launch timeout/)
  assert.match(state.warnings[0], /rollout at .* is empty/)
})

test('tui alias: a transient read resets the successful snapshot settling window', async t => {
  let reads = 0
  let recoveredAt
  const state = await observe(t, id => {
    reads += 1
    if (reads === 2 || reads === 3) throw new Error(EMPTY_ROLLOUT)
    if (reads === 4) recoveredAt = Date.now()
    return worker(id)
  }, { settleMs: 40 })
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  assert.deepEqual(state.warnings, [])
  assert.deepEqual(state.aliases, ['codex-1234abcd'])
  assert.ok(Date.now() - recoveredAt >= 40)
})

test('tui alias: a transient second candidate cannot let the first bind before ambiguity resolves', async t => {
  let otherReads = 0
  const state = await observe(t, id => {
    if (id === 'another-worker' && ++otherReads <= 2) throw new Error(EMPTY_ROLLOUT)
    return worker(id)
  })
  state.server.notify('thread/started', { thread: worker() })
  state.server.notify('thread/started', { thread: worker('another-worker', { preview: '' }) })
  await state.done
  assert.ok(otherReads >= 3)
  assert.deepEqual(state.aliases, [])
  assert.match(state.warnings[0], /ambiguous/)
})

test('tui alias: unrelated read errors still fail on the first request', async t => {
  let reads = 0
  const state = await observe(t, () => { reads += 1; throw new Error('permission denied while rollout metadata is empty') })
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  assert.equal(reads, 1)
  assert.deepEqual(state.aliases, [])
  assert.match(state.warnings[0], /permission denied/)
  assert.doesNotMatch(state.warnings[0], /launch timeout/)
})

for (const outcome of ['empty rollout', 'matching thread']) {
  test(`tui alias: close during a startup retry ignores a late ${outcome} response`, { timeout: 5000 }, async t => {
    let reads = 0
    let secondRead
    const inFlight = new Promise(resolve => { secondRead = resolve })
    let release
    const response = new Promise(resolve => { release = resolve })
    let complete
    const completed = new Promise(resolve => { complete = resolve })
    t.after(() => release())
    const state = await observe(t, async () => {
      reads += 1
      if (reads === 1) throw new Error(EMPTY_ROLLOUT)
      secondRead()
      await response
      complete()
      if (outcome === 'empty rollout') throw new Error(EMPTY_ROLLOUT)
      return worker()
    }, { timeoutMs: 5000, settleMs: 0 })
    state.server.notify('thread/started', { thread: worker() })
    await inFlight
    assert.equal(reads, 2)
    state.observer.close()
    const closedReads = reads
    release()
    await completed
    // Closing a socket can flush a request sent before close. Await transport closure before checking callbacks.
    while (state.server.connectionCount()) await nextTurn()
    assert.equal(reads, closedReads)
    assert.deepEqual(state.aliases, [])
    assert.deepEqual(state.warnings, [])
  })
}

test('tui alias: startup retry never accepts a different returned thread ID', async t => {
  let reads = 0
  const state = await observe(t, () => {
    if (++reads === 1) throw new Error(EMPTY_ROLLOUT)
    return worker('different-thread')
  })
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  assert.equal(reads, 2)
  assert.deepEqual(state.aliases, [])
  assert.match(state.warnings[0], /different ID/)
})


test('tui identity: name only the confirmed brief thread', async t => {
  const state = await observe(t, id => worker(id), { name: 'Worker 123' })
  state.server.notify('thread/started', { thread: worker('unrelated', { preview: 'Other brief' }) })
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  const names = state.server.requests.filter(r => r.method === 'thread/name/set')
  assert.deepEqual(names.map(r => r.params), [{ threadId: ID, name: 'Worker 123' }])
  assert.deepEqual(state.aliases, ['codex-1234abcd'])
})

test('tui identity: naming failure preserves the confirmed alias and reports the error', async t => {
  const reports = []
  const state = await observe(t, id => worker(id), {
    name: 'Worker 123', rejectName: true, onName: (...args) => reports.push(args),
  })
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  assert.deepEqual(state.aliases, ['codex-1234abcd'])
  assert.equal(reports.length, 1)
  assert.equal(reports[0][0], 'Worker 123')
  assert.match(reports[0][1], /name refused/)
})

test('tui identity: ambiguous launch never names any candidate', async t => {
  const state = await observe(t, id => worker(id), { name: 'Worker 123' })
  state.server.notify('thread/started', { thread: worker() })
  state.server.notify('thread/started', { thread: worker('other') })
  await state.done
  assert.equal(state.server.requests.filter(r => r.method === 'thread/name/set').length, 0)
})


test('tui identity: a stalled naming request keeps the confirmed route within a bounded wait', async t => {
  const reports = []
  const state = await observe(t, id => worker(id), {
    name: 'Worker 123', hangName: true, nameTimeoutMs: 20,
    onName: (...args) => reports.push(args),
  })
  state.server.notify('thread/started', { thread: worker() })
  await state.done
  assert.deepEqual(state.aliases, ['codex-1234abcd'])
  assert.deepEqual(state.warnings, [])
  assert.match(reports[0][1], /timed out/)
})

test('tui identity: confirmed alias survives TUI exit during a stalled name write', async t => {
  const state = await observe(t, id => worker(id), { name: 'Worker 123', hangName: true })
  state.server.notify('thread/started', { thread: worker() })
  const deadline = Date.now() + 1000
  while (!state.server.requests.some(r => r.method === 'thread/name/set') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(state.server.requests.some(r => r.method === 'thread/name/set'))
  state.observer.close()
  assert.deepEqual(state.aliases, ['codex-1234abcd'])
  assert.deepEqual(state.warnings, [])
})
