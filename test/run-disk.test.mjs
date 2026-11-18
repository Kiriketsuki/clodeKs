import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runExec } from '../lib/exec.mjs'
import { testEnv } from './helpers/env.mjs'
const CODEX = fileURLToPath(new URL('./fixtures/run-disk-codex.mjs', import.meta.url))

for (const outcome of ['success', 'fail', 'timeout']) {
  test(`run disk: writable ${outcome} routes temp to scratch and reports owned footprint and workspace growth`, async () => {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
    const cwd = join(env.XDG_RUNTIME_DIR, 'repo')
    const extra = join(env.XDG_RUNTIME_DIR, 'reports')
    const callerTemp = join(env.XDG_RUNTIME_DIR, 'caller-temp')
    for (const folder of [cwd, extra, callerTemp]) mkdirSync(folder)
    writeFileSync(join(cwd, 'grown.bin'), Buffer.alloc(20))
    writeFileSync(join(cwd, 'shrunk.bin'), Buffer.alloc(50))
    env.FAKE_DISK_OUTSIDE = join(env.XDG_RUNTIME_DIR, 'outside.bin')
    writeFileSync(env.FAKE_DISK_OUTSIDE, Buffer.alloc(10000))
    const result = await runExec({ prompt: 'Use temporary files.', cwd, sandbox: 'workspace-write', addDirs: [extra],
      timeoutMs: outcome === 'timeout' ? 700 : 5000 }, { ...env, TMPDIR: callerTemp, FAKE_DISK_EXTRA: extra,
      ...(outcome === 'timeout' ? { FAKE_DISK_HANG: '1' } : {}), ...(outcome === 'fail' ? { FAKE_DISK_FAIL: '1' } : {}) })
    assert.equal(result.ok, outcome === 'success')
    const observed = JSON.parse(result.text)
    assert.equal(observed.temporary, observed.scratch)
    assert.equal(observed.temp, observed.scratch)
    assert.equal(observed.tmp, observed.scratch)
    assert.equal(observed.tmpprefix, join(observed.scratch, 'zsh'))
    assert.equal(existsSync(join(callerTemp, 'temp.bin')), false)
    assert.equal(existsSync(dirname(observed.scratch)), false)
    const owned = result.disk_usage.owned
    assert.equal(owned.logical_bytes, 105 + Buffer.byteLength(result.text))
    assert.ok(owned.allocated_bytes >= 0)
    assert.equal(owned.complete, true)
    assert.equal(owned.measurement, 'before_cleanup')
    const growth = result.disk_usage.workspace_growth
    assert.equal(growth.bytes, 280)
    assert.equal(growth.complete, true)
    assert.deepEqual(growth.largest_paths, [
      { path: join(cwd, '.tmp/stage/package.tar'), bytes: 200 },
      { path: join(extra, 'report.bin'), bytes: 50 },
      { path: join(cwd, 'grown.bin'), bytes: 30 },
    ])
    if (outcome === 'timeout') assert.equal(result.files_changed_scan.complete, true)
  })
}

test('run disk: read-only runs preserve private tmp and omit workspace growth', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, FAKE_DISK_READ_ONLY: '1' })
  const result = await runExec({ prompt: 'Review.', cwd: env.XDG_RUNTIME_DIR, sandbox: 'read-only', timeoutMs: 5000 }, env)
  assert.equal(result.ok, true)
  const observed = JSON.parse(result.text)
  assert.equal(observed.scratch, null)
  assert.equal(observed.temporary.endsWith('/tmp'), true)
  assert.equal(result.disk_usage.owned.logical_bytes, 105 + Buffer.byteLength(result.text))
  assert.equal(result.disk_usage.owned.complete, true)
  assert.equal(Object.hasOwn(result.disk_usage, 'workspace_growth'), false)
})

test('run disk: an aliased runtime excludes scratch and job metadata from workspace growth', async () => {
  const { symlinkSync } = await import('node:fs')
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
  const cwd = join(env.XDG_RUNTIME_DIR, 'actual')
  const alias = join(env.XDG_RUNTIME_DIR, 'alias')
  mkdirSync(cwd)
  symlinkSync(cwd, alias, 'dir')
  writeFileSync(join(cwd, 'grown.bin'), Buffer.alloc(20))
  writeFileSync(join(cwd, 'shrunk.bin'), Buffer.alloc(50))
  const result = await runExec({ prompt: 'Use private temp.', cwd, sandbox: 'workspace-write', timeoutMs: 5000 },
    { ...env, XDG_RUNTIME_DIR: alias })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.disk_usage.workspace_growth.bytes, 230)
  assert.equal(result.disk_usage.workspace_growth.complete, true)
})
