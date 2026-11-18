import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lutimesSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runExec } from '../lib/exec.mjs'
import { createJobRecord } from '../lib/jobs.mjs'
import { privateRuntimeDir } from '../lib/paths.mjs'
import { testEnv } from './helpers/env.mjs'

const api = () => import('../lib/orphan-cleanup.mjs')
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
function setup() {
  const env = testEnv()
  const root = privateRuntimeDir(env)
  const procRoot = join(env.XDG_RUNTIME_DIR, 'proc')
  mkdirSync(procRoot)
  return { env, root, options: { now, procRoot } }
}
function age(path, ms = DAY + 1000) { utimesSync(path, new Date(now - ms), new Date(now - ms)) }
function folder(root, name = 'run-Ab123Z') {
  const path = join(root, name)
  mkdirSync(path, { mode: 0o700 })
  age(path)
  return path
}

test('orphans: remove only aged generated names and keep fresh entries and symlink targets', async () => {
  const { sweepOrphanRuns } = await api()
  const { env, root, options } = setup()
  const old = folder(root)
  const fresh = folder(root, 'run-Fresh1')
  const nested = join(fresh, 'scratch')
  mkdirSync(nested)
  writeFileSync(join(nested, 'recent'), 'recent')
  age(fresh)
  const other = folder(root, 'run-not-generated')
  const outside = folder(env.XDG_RUNTIME_DIR, 'outside')
  symlinkSync(outside, join(root, 'run-Link12'))
  symlinkSync(outside, join(old, 'link'))
  lutimesSync(join(old, 'link'), new Date(now - DAY - 1000), new Date(now - DAY - 1000))
  age(old)
  const view = sweepOrphanRuns(env, options)
  assert.deepEqual(view.removed, [old])
  assert.equal(view.complete, true, JSON.stringify(view))
  for (const path of [fresh, nested, other, outside, join(root, 'run-Link12')]) assert.equal(existsSync(path), true)
})

test('orphans: throttle every attempt for one hour and keep the stamp private', async () => {
  const { sweepOrphanRuns } = await api()
  const { env, root, options } = setup()
  sweepOrphanRuns(env, options)
  assert.equal(statSync(join(root, '.orphan-cleanup.stamp')).mode & 0o777, 0o600)
  const old = folder(root)
  const second = sweepOrphanRuns(env, { ...options, now: now + 3599999 })
  assert.equal(second.throttled, true)
  assert.equal(existsSync(old), true)
  assert.deepEqual(sweepOrphanRuns(env, { ...options, now: now + 3600001 }).removed, [old])
})

test('orphans: simultaneous sweeps share one stamp lock', async () => {
  const { env, root, options } = setup()
  const old = folder(root)
  const module = new URL('../lib/orphan-cleanup.mjs', import.meta.url).href
  const script = `import { sweepOrphanRuns } from ${JSON.stringify(module)}; console.log(JSON.stringify(sweepOrphanRuns(process.env, ${JSON.stringify(options)})))`
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.resume()
    child.once('error', reject)
    child.once('close', code => { if (code) reject(new Error(`Sweep exited ${code}`)); else resolve(JSON.parse(stdout)) })
  })
  const results = await Promise.all([invoke(), invoke(), invoke()])
  assert.equal(results.filter(view => view.throttled).length, 2, JSON.stringify(results))
  assert.deepEqual(results.flatMap(view => view.removed), [old])
})

test('orphans: unsafe stamp and persistent errors preserve the worker result', async () => {
  const { env, root } = setup()
  const old = folder(root)
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  writeFileSync(outside, 'do not change')
  symlinkSync(outside, join(root, '.orphan-cleanup.stamp'))
  const fixture = fileURLToPath(new URL('./fixtures/preamble-codex.mjs', import.meta.url))
  const result = await runExec({ prompt: 'task', cwd: env.XDG_RUNTIME_DIR, sandbox: 'workspace-write', timeoutMs: 5000 },
    { ...env, CLODEKS_CODEX_BIN: fixture })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.orphan_cleanup.complete, false)
  assert.ok(result.orphan_cleanup.errors.length)
  assert.equal(readFileSync(outside, 'utf8'), 'do not change')
  assert.equal(existsSync(old), true)
})

test('orphans: a fresh descendant or excessive depth keeps the complete folder', async () => {
  const { sweepOrphanRuns } = await api()
  for (const depth of [2, 42]) {
    const { env, root, options } = setup()
    const old = folder(root)
    const paths = [old]
    for (let n = 0; n < depth; n++) { paths.push(join(paths.at(-1), 'd')); mkdirSync(paths.at(-1)) }
    for (const path of paths) age(path)
    if (depth === 2) utimesSync(paths.at(-1), new Date(now), new Date(now))
    const result = sweepOrphanRuns(env, options)
    assert.deepEqual(result.removed, [])
    assert.equal(existsSync(paths.at(-1)), true)
    assert.equal(result.complete, depth === 2)
  }
})

test('orphans: live wrapper and child identities independently protect associated folders', async () => {
  const { sweepOrphanRuns } = await api()
  for (const patch of [{}, { pid: 2147483647 }, { codex_pid: 2147483647 }]) {
    const { env, root, options } = setup()
    const old = folder(root)
    const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
    try {
      job.folder(old)
      job.running(process.pid)
      const path = join(root, 'jobs', readdirSync(join(root, 'jobs')).find(name => name.endsWith('.json')))
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }))
      const result = sweepOrphanRuns(env, options)
      assert.equal(existsSync(old), true, JSON.stringify(result))
      assert.ok(result.skipped.some(item => /live job/i.test(item.reason)))
    } finally { job.finished() }
  }
})

test('orphans: stale PID starts and boot identities do not protect folders', async () => {
  const { sweepOrphanRuns } = await api()
  for (const patch of [{ start: '0', codex_start: '0' }, { boot_id: '00000000-0000-0000-0000-000000000000' }]) {
    const { env, root, options } = setup()
    const old = folder(root)
    const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
    try {
      job.folder(old)
      job.running(process.pid)
      const path = join(root, 'jobs', readdirSync(join(root, 'jobs')).find(name => name.endsWith('.json')))
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }))
      assert.deepEqual(sweepOrphanRuns(env, options).removed, [old])
    } finally { job.finished() }
  }
})

test('orphans: live legacy jobs and malformed metadata stop deletion', async () => {
  const { sweepOrphanRuns } = await api()
  for (const malformed of [false, true]) {
    const { env, root, options } = setup()
    const old = folder(root)
    const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
    try {
      if (malformed) writeFileSync(join(root, 'jobs', readdirSync(join(root, 'jobs'))[0]), '{')
      const view = sweepOrphanRuns(env, options)
      assert.equal(existsSync(old), true)
      assert.equal(view.complete, false)
    } finally { job.finished() }
  }
})

test('orphans: a live process cwd protects a folder and unreadable cwd does not block other orphans', async () => {
  const { sweepOrphanRuns } = await api()
  const { env, root, options } = setup()
  const kept = folder(root)
  const old = folder(root, 'run-Old123')
  mkdirSync(join(options.procRoot, '123'))
  symlinkSync(kept, join(options.procRoot, '123', 'cwd'))
  mkdirSync(join(options.procRoot, '456'))
  chmodSync(join(options.procRoot, '456'), 0)
  try {
    const view = sweepOrphanRuns(env, options)
    assert.deepEqual(view.removed, [old])
    assert.equal(view.skipped_processes, 1)
    assert.equal(existsSync(kept), true)
  } finally { chmodSync(join(options.procRoot, '456'), 0o700) }
})

test('orphans: entry and process limits keep folders intact and report incomplete scans', async () => {
  const { sweepOrphanRuns } = await api()
  for (const limit of ['maxEntries', 'maxProcesses']) {
    const { env, root, options } = setup()
    const old = folder(root)
    writeFileSync(join(old, 'file'), 'old')
    age(join(old, 'file'))
    age(old)
    mkdirSync(join(options.procRoot, '123'))
    const view = sweepOrphanRuns(env, { ...options, [limit]: 0 })
    assert.equal(existsSync(join(old, 'file')), true)
    assert.equal(view.complete, false)
    assert.ok(view.errors.length)
  }
})

test('orphans: run results report startup cleanup without changing the worker result', async () => {
  const { env, root } = setup()
  const old = folder(root)
  const fixture = fileURLToPath(new URL('./fixtures/preamble-codex.mjs', import.meta.url))
  const result = await runExec({ prompt: 'task', cwd: env.XDG_RUNTIME_DIR, sandbox: 'workspace-write', timeoutMs: 5000 },
    { ...env, CLODEKS_CODEX_BIN: fixture })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.orphan_cleanup.removed.includes(old), JSON.stringify(result.orphan_cleanup))
  assert.equal(existsSync(old), false)
})

test('orphans: an aged concurrent run stays owned before the child starts', async () => {
  const { sweepOrphanRuns } = await api()
  const { env, root, options } = setup()
  const old = folder(root)
  const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
  try {
    job.folder(old)
    const view = sweepOrphanRuns(env, options)
    assert.equal(existsSync(old), true)
    assert.deepEqual(view.removed, [])
  } finally { job.finished() }
})
