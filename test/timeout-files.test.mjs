import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runExec } from '../lib/exec.mjs'
import { testEnv } from './helpers/env.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

test('long agent: forwards the caller timeout and permits background result reads', () => {
  const agent = readFileSync(new URL('../plugin/agents/codex-exec.md', import.meta.url), 'utf8')
  assert.doesNotMatch(agent, /--timeout 570\b/)
  assert.match(agent, /--timeout TIMEOUT/)
  assert.match(agent, /run_in_background: true/)
  assert.match(agent, /tools: Bash, Read/)
  assert.match(agent, /Do not start another Codex process/)
  assert.doesNotMatch(agent, /sleep 30/)
})

test('timeout files: shell writes in cwd and extra roots reach the result without file-change events', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'timeout-writes' })
  const cwd = join(env.XDG_RUNTIME_DIR, 'workspace')
  const extra = join(env.XDG_RUNTIME_DIR, 'reports')
  mkdirSync(cwd)
  mkdirSync(extra)
  writeFileSync(join(cwd, 'edited.txt'), 'before')
  writeFileSync(join(cwd, 'untouched.txt'), 'unchanged')
  const result = await runExec({
    prompt: 'x', cwd, sandbox: 'workspace-write', addDirs: [extra], timeoutMs: 800,
  }, { ...env, FAKE_ADD_DIR: extra })
  assert.equal(result.error, 'timeout')
  assert.equal(result.ok, false)
  assert.deepEqual(result.files_changed.sort(), [join(cwd, 'created.txt'), join(cwd, 'edited.txt'), join(extra, 'partial.txt')].sort())
  assert.equal(result.files_changed_scan.complete, true)
  assert.deepEqual(result.files_changed_scan.roots.sort(), [cwd, extra].sort())
})

test('file snapshots: metadata finds edits, additions, and removals without following symlinks', async () => {
  const { snapshotFiles, changedFiles } = await import('../lib/file-changes.mjs')
  const env = testEnv()
  const root = join(env.XDG_RUNTIME_DIR, 'workspace')
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(root, 'edited'), 'before')
  writeFileSync(join(root, 'removed'), 'before')
  writeFileSync(join(outside, 'secret'), 'do not read')
  symlinkSync(outside, join(root, 'link'), 'dir')
  const before = snapshotFiles([root])
  writeFileSync(join(root, 'edited'), 'after')
  writeFileSync(join(root, 'created'), 'new')
  writeFileSync(join(outside, 'secret'), 'outside change')
  renameSync(join(root, 'removed'), join(outside, 'removed'))
  const after = snapshotFiles([root])
  assert.deepEqual(changedFiles(before, after), [join(root, 'created'), join(root, 'edited'), join(root, 'removed')].sort())
  assert.equal(before.complete, true)
  assert.equal(after.complete, true)
})

test('file snapshots: entry limits and scan failures stay visible', async () => {
  const { snapshotFiles, changedFiles } = await import('../lib/file-changes.mjs')
  const env = testEnv()
  for (const name of ['a', 'b', 'c']) writeFileSync(join(env.XDG_RUNTIME_DIR, name), name)
  const limited = snapshotFiles([env.XDG_RUNTIME_DIR], { maxEntries: 1 })
  assert.equal(limited.complete, false)
  assert.match(limited.errors.join(' '), /limit/)
  const full = snapshotFiles([env.XDG_RUNTIME_DIR])
  assert.deepEqual(changedFiles(limited, full), [])
  assert.deepEqual(changedFiles(full, limited), [])
  const missing = snapshotFiles([join(env.XDG_RUNTIME_DIR, 'missing')])
  assert.equal(missing.complete, false)
  assert.match(missing.errors.join(' '), /ENOENT/)
})

test('file snapshots: overlapping roots count once and git metadata stays excluded', async () => {
  const { snapshotFiles } = await import('../lib/file-changes.mjs')
  const env = testEnv()
  const root = env.XDG_RUNTIME_DIR
  const nested = join(root, 'nested')
  mkdirSync(nested)
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'index'), 'git metadata')
  writeFileSync(join(nested, 'file'), 'tracked once')
  const snapshot = snapshotFiles([root, nested])
  assert.deepEqual([...snapshot.files.keys()], [join(nested, 'file')])
  assert.equal(snapshot.complete, true)
})
