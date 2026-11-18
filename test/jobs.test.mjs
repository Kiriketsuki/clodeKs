import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { explainNoThreads } from '../lib/appserver.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { runExec } from '../lib/exec.mjs'
import { privateRuntimeDir, runtimeDir } from '../lib/paths.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const api = () => import('../lib/jobs.mjs')
const options = cwd => ({ prompt: 'private prompt marker', cwd, sandbox: 'read-only', timeoutMs: 10000 })
async function until(check) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('job observation timed out')
}
function files(env) { return readdirSync(join(runtimeDir(env), 'jobs')).filter(name => name.endsWith('.json')) }
function record(env) {
  const path = join(runtimeDir(env), 'jobs', files(env)[0])
  return { path, data: JSON.parse(readFileSync(path, 'utf8')) }
}

test('jobs: missing runtime is an empty read with no filesystem writes', async () => {
  const { listJobs } = await api()
  const env = testEnv()
  const view = listJobs({}, env)
  assert.deepEqual(view.jobs, [])
  assert.deepEqual(view.errors, [])
  assert.match(view.hint, /cannot receive.*shared app-server/)
  assert.equal(existsSync(runtimeDir(env)), false)
})

test('jobs: private records expose lifecycle and omit prompts and output', async () => {
  const { createJobRecord, listJobs } = await api()
  const env = testEnv()
  const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
  try {
    let [view] = listJobs({}, env).jobs
    assert.equal(view.state, 'starting')
    assert.equal(view.pid, process.pid)
    assert.equal(view.cwd, env.XDG_RUNTIME_DIR)
    assert.equal(view.thread_id, null)
    assert.ok(view.started_at <= Date.now())
    assert.ok(view.elapsed_ms >= 0)
    job.running(process.pid)
    job.identified('thread-id')
    ;[view] = listJobs({}, env).jobs
    assert.equal(view.state, 'running')
    assert.equal(view.codex_pid, process.pid)
    assert.equal(view.thread_id, 'thread-id')
    job.finishing()
    assert.equal(listJobs({}, env).jobs[0].state, 'finishing')
    const { path, data } = record(env)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(join(runtimeDir(env), 'jobs')).mode & 0o777, 0o700)
    assert.deepEqual(Object.keys(data).sort(), ['v', 'job_id', 'pid', 'start', 'boot_id', 'codex_pid', 'codex_start', 'cwd', 'started_at', 'state', 'thread_id'].sort())
  } finally { job.finished() }
  assert.deepEqual(listJobs({ all: true }, env).jobs, [])
})

test('jobs: PID reuse, boot changes, and dead workers never appear active', async () => {
  const { createJobRecord, listJobs } = await api()
  for (const patch of [{ start: '0' }, { boot_id: '00000000-0000-0000-0000-000000000000' }, { codex_start: '0' }, { pid: 2147483647 }]) {
    const env = testEnv()
    const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
    job.running(process.pid)
    const { path, data } = record(env)
    writeFileSync(path, JSON.stringify({ ...data, ...patch }), { mode: 0o600 })
    assert.deepEqual(listJobs({}, env).jobs, [])
    assert.equal(listJobs({ all: true }, env).jobs[0].state, 'stale')
    job.finished()
  }
})

test('jobs: partial files, unsafe files, and unsafe directories report incomplete discovery', async () => {
  const { createJobRecord, listJobs } = await api()
  const env = testEnv()
  const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
  const { path, data } = record(env)
  const folder = join(runtimeDir(env), 'jobs')
  writeFileSync(join(folder, 'ignored.tmp'), '{')
  assert.equal(listJobs({}, env).jobs.length, 1)
  for (const invalid of ['{', JSON.stringify({ ...data, pid: -1 }), JSON.stringify({ ...data, thread_id: 7 })]) {
    writeFileSync(path, invalid)
    assert.equal(listJobs({}, env).jobs.length, 0)
    assert.equal(listJobs({}, env).errors.length, 1)
  }
  writeFileSync(path, JSON.stringify(data))
  chmodSync(path, 0o644)
  assert.equal(listJobs({}, env).errors.length, 1)
  chmodSync(path, 0o600)
  renameSync(path, join(folder, 'saved.tmp'))
  symlinkSync(join(folder, 'saved.tmp'), path)
  assert.equal(listJobs({}, env).errors.length, 1)
  chmodSync(folder, 0o755)
  assert.equal(listJobs({}, env).errors.length, 1)
  chmodSync(folder, 0o700)
  job.finished()
})

test('jobs: overlapping exec runs stay distinct and disappear after their final results', async () => {
  const { listJobs } = await api()
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' })
  const runs = [1, 2].map(n => {
    const release = join(env.XDG_RUNTIME_DIR, `release-${n}`)
    return { release, result: runExec(options(env.XDG_RUNTIME_DIR), { ...env, FAKE_RELEASE: release }) }
  })
  try {
    const jobs = await until(() => {
      const view = listJobs({}, env).jobs
      return view.length === 2 && view.every(job => job.thread_id) && view
    })
    assert.equal(new Set(jobs.map(job => job.job_id)).size, 2)
    assert.equal(new Set(jobs.map(job => job.codex_pid)).size, 2)
    const raw = files(env).map(name => readFileSync(join(runtimeDir(env), 'jobs', name), 'utf8')).join('')
    assert.doesNotMatch(raw, /private prompt marker|private output marker|tokens/)
    writeFileSync(runs[0].release, '')
    assert.equal((await runs[0].result).text, 'private output marker')
    assert.equal(listJobs({}, env).jobs.length, 1)
  } finally {
    for (const run of runs) writeFileSync(run.release, '')
    await Promise.all(runs.map(run => run.result))
  }
  assert.deepEqual(listJobs({ all: true }, env).jobs, [])
})

test('jobs: spawn errors and timeouts clean their records', async () => {
  const { listJobs } = await api()
  for (const extra of [{ CLODEKS_CODEX_BIN: '/does-not-exist' }, { CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' }]) {
    const env = testEnv(extra)
    const result = await runExec({ ...options(env.XDG_RUNTIME_DIR), timeoutMs: 300 }, env)
    assert.equal(result.ok, false)
    assert.deepEqual(listJobs({ all: true }, env).jobs, [])
  }
})

test('jobs: metadata failure preserves the run and reports its visibility limit', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'echo' })
  writeFileSync(join(privateRuntimeDir(env), 'jobs'), 'not a directory')
  const result = await runExec(options(env.XDG_RUNTIME_DIR), env)
  assert.equal(result.ok, true)
  assert.ok(result.text.trimEnd().endsWith('private prompt marker'))
  assert.match(result.job_metadata_error, /job metadata/i)
})

test('jobs CLI: lists private runners without an app-server and keeps run stdout as one result', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs', CLODEKS_APP_SOCKET: '/does-not-exist' })
  const release = join(env.XDG_RUNTIME_DIR, 'release')
  const child = spawn(process.execPath, [CLI, 'run', '--cwd', env.XDG_RUNTIME_DIR, '--prompt', 'private prompt marker'], {
    env: { ...env, FAKE_RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const ended = new Promise(resolve => child.once('close', resolve))
  try {
    await until(() => existsSync(join(runtimeDir(env), 'jobs')) && files(env).length)
    const out = execFileSync(process.execPath, [CLI, 'jobs'], { env, encoding: 'utf8' })
    const view = JSON.parse(out)
    assert.equal(view.jobs.length, 1)
    assert.equal(view.jobs[0].pid, child.pid)
    assert.equal(stdout, '')
    assert.match(view.hint, /codex_send/)
    const help = execFileSync(process.execPath, [CLI, 'threads', '--help'], { env, encoding: 'utf8' })
    assert.match(help, /clodeks jobs/)
  } finally {
    writeFileSync(release, '')
    await ended
  }
  assert.match(stderr, /^clodeks gate: ready\. psi=0%, psifull=0%, swapin=unknown pages\/s, swap=(?:\d+|unknown) bytes\.$/m)
  assert.match(stderr, /^clodeks run: caller umask 0[0-7]{3}\. The worker shell umask is unmeasured\.$/m)
  const lines = stdout.trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).ok, true)
})


test('jobs discovery: empty shared thread hints point to private jobs without a model turn', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'initialize') return {}
    if (request.method === 'thread/list' || request.method === 'thread/loaded/list') return { data: [] }
    throw new Error(`Unexpected RPC: ${request.method}`)
  })
  t.after(server.close)
  const hint = await explainNoThreads(socket, { procDir: env.XDG_RUNTIME_DIR })
  assert.match(hint, /clodeks jobs or codex_jobs/)
  assert.match(hint, /cannot receive codex_send/)
})

test('jobs: metadata updates do not enter timeout file-change results', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'jobs' })
  const result = await runExec({ ...options(env.XDG_RUNTIME_DIR), sandbox: 'workspace-write', timeoutMs: 300 }, env)
  assert.equal(result.error, 'timeout')
  assert.deepEqual(result.files_changed, [])
})


test('jobs: exited Codex stays visible while a tool holds stdout open', async () => {
  const { listJobs } = await api()
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'exit-leaves-child' })
  const result = runExec(options(env.XDG_RUNTIME_DIR), env)
  try {
    const pid = await until(() => {
      if (!existsSync(join(runtimeDir(env), 'jobs')) || !files(env).length) return false
      return record(env).data.codex_pid
    })
    await until(() => !existsSync(`/proc/${pid}`))
    const jobs = listJobs({}, env).jobs
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].state, 'finishing')
  } finally {
    assert.equal((await result).ok, true)
  }
})

test('jobs: malformed record errors never quote their contents', async () => {
  const { createJobRecord, listJobs } = await api()
  const env = testEnv()
  const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
  try {
    const { path } = record(env)
    writeFileSync(path, 'SECRET')
    const view = listJobs({}, env)
    assert.equal(view.errors.length, 1)
    assert.doesNotMatch(JSON.stringify(view), /SECRET/)
  } finally { job.finished() }
})
