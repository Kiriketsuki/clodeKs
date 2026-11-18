import assert from 'node:assert/strict'
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ownedDiskUsage, workspaceGrowth } from '../lib/run-disk.mjs'
import { snapshotFiles } from '../lib/file-changes.mjs'
import { testEnv } from './helpers/env.mjs'

test('disk measurement: owned files count once across hardlinks and exclude symlink targets', () => {
  const env = testEnv()
  const owned = join(env.XDG_RUNTIME_DIR, 'owned')
  mkdirSync(owned)
  mkdirSync(join(owned, '.git'))
  writeFileSync(join(owned, 'a'), Buffer.alloc(20))
  linkSync(join(owned, 'a'), join(owned, 'b'))
  writeFileSync(join(owned, '.git', 'metadata'), Buffer.alloc(3))
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  writeFileSync(outside, Buffer.alloc(1000))
  symlinkSync(outside, join(owned, 'link'))
  const result = ownedDiskUsage(owned)
  assert.equal(result.logical_bytes, 23)
  assert.equal(result.files, 2)
  assert.equal(result.complete, true)
})

test('disk measurement: capped or missing scans retain an incomplete flag', () => {
  const env = testEnv()
  writeFileSync(join(env.XDG_RUNTIME_DIR, 'data'), 'x')
  for (const result of [ownedDiskUsage(env.XDG_RUNTIME_DIR, { maxEntries: 1 }),
    ownedDiskUsage(join(env.XDG_RUNTIME_DIR, 'missing'))]) {
    assert.equal(result.complete, false)
    assert.ok(result.errors.length)
  }
})

test('disk measurement: workspace growth has at most five largest positive deltas and ignores symlinks', () => {
  const env = testEnv()
  const cwd = env.XDG_RUNTIME_DIR
  writeFileSync(join(cwd, 'grown'), Buffer.alloc(10))
  writeFileSync(join(cwd, 'shrunk'), Buffer.alloc(30))
  const options = { includeSizes: true }
  const before = snapshotFiles([cwd], options)
  writeFileSync(join(cwd, 'grown'), Buffer.alloc(50))
  writeFileSync(join(cwd, 'shrunk'), Buffer.alloc(1))
  for (let index = 1; index <= 6; index++) writeFileSync(join(cwd, `new-${index}`), Buffer.alloc(index))
  symlinkSync('/outside', join(cwd, 'symlink'))
  const result = workspaceGrowth(before, snapshotFiles([cwd], options))
  assert.equal(result.bytes, 61)
  assert.equal(result.files, 7)
  assert.equal(result.complete, true)
  assert.equal(result.largest_paths.length, 5)
  assert.deepEqual(result.largest_paths[0], { path: join(cwd, 'grown'), bytes: 40 })
})

test('disk measurement: an incomplete baseline never calls an unknown path new', () => {
  const env = testEnv()
  writeFileSync(join(env.XDG_RUNTIME_DIR, 'data'), 'x')
  const before = snapshotFiles([env.XDG_RUNTIME_DIR], { includeSizes: true, maxEntries: 1 })
  const after = snapshotFiles([env.XDG_RUNTIME_DIR], { includeSizes: true })
  const result = workspaceGrowth(before, after)
  assert.equal(result.bytes, 0)
  assert.equal(result.complete, false)
  assert.deepEqual(result.largest_paths, [])
})

test('disk measurement: runtime aliases cannot bypass workspace exclusions', () => {
  const env = testEnv()
  const actual = join(env.XDG_RUNTIME_DIR, 'actual')
  const alias = join(env.XDG_RUNTIME_DIR, 'alias')
  mkdirSync(actual)
  symlinkSync(actual, alias, 'dir')
  const owned = join(actual, 'owned')
  mkdirSync(owned)
  writeFileSync(join(owned, 'private'), Buffer.alloc(100))
  const result = snapshotFiles([actual], { includeSizes: true, excludePaths: [join(alias, 'owned')] })
  assert.equal(result.files.size, 0)
})
