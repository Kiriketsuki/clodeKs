import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createJobRecord } from '../lib/jobs.mjs'
import { sweepOrphanRuns } from '../lib/orphan-cleanup.mjs'
import { privateRuntimeDir } from '../lib/paths.mjs'
import { testEnv } from './helpers/env.mjs'

function setup() {
  const env = testEnv()
  const root = privateRuntimeDir(env)
  const old = join(root, 'run-Old123')
  mkdirSync(old, { mode: 0o700 })
  const now = Date.now()
  const date = new Date(now - 86400001)
  utimesSync(old, date, date)
  const procRoot = join(env.XDG_RUNTIME_DIR, 'proc')
  mkdirSync(procRoot)
  const alias = `${env.XDG_RUNTIME_DIR}-alias`
  symlinkSync(env.XDG_RUNTIME_DIR, alias)
  return { env, aliasEnv: { ...env, XDG_RUNTIME_DIR: alias }, old, options: { now, procRoot } }
}

test('orphans review: an alias runtime preserves a live job folder', () => {
  const { env, aliasEnv, old, options } = setup()
  const job = createJobRecord({ cwd: env.XDG_RUNTIME_DIR }, env)
  try {
    job.folder(old)
    const view = sweepOrphanRuns(aliasEnv, options)
    assert.deepEqual(view.removed, [], JSON.stringify(view))
    assert.equal(existsSync(old), true)
  } finally { job.finished() }
})

test('orphans review: an alias runtime preserves a live process cwd folder', () => {
  const { aliasEnv, old, options } = setup()
  mkdirSync(join(options.procRoot, '123'))
  symlinkSync(old, join(options.procRoot, '123', 'cwd'))
  const view = sweepOrphanRuns(aliasEnv, options)
  assert.deepEqual(view.removed, [], JSON.stringify(view))
  assert.equal(existsSync(old), true)
})

test('orphans review: a readable cwd inode protects a descendant despite another path', () => {
  const { env, aliasEnv, old, options } = setup()
  const child = join(old, 'child')
  mkdirSync(child)
  const date = new Date(options.now - 86400001)
  utimesSync(child, date, date)
  utimesSync(old, date, date)
  mkdirSync(join(options.procRoot, '123'))
  symlinkSync(join(aliasEnv.XDG_RUNTIME_DIR, 'clodeks', 'run-Old123', 'child'), join(options.procRoot, '123', 'cwd'))
  const view = sweepOrphanRuns(env, options)
  assert.equal(existsSync(child), true, JSON.stringify(view))
  assert.deepEqual(view.removed, [])
  assert.ok(view.skipped.some(item => /cwd/.test(item.reason)))
})

test('orphans review: a fresh root skips permission repair on every descendant', () => {
  const { env, old, options } = setup()
  const blocked = join(old, 'blocked')
  mkdirSync(blocked)
  chmodSync(blocked, 0)
  utimesSync(old, new Date(options.now), new Date(options.now))
  try {
    const view = sweepOrphanRuns(env, options)
    assert.equal(statSync(blocked).mode & 0o777, 0, JSON.stringify(view))
    assert.deepEqual(view.removed, [])
    assert.equal(view.complete, true)
  } finally { if (existsSync(blocked)) chmodSync(blocked, 0o700) }
})

test('orphans review: a current stamp needs no helper or PATH lookup', () => {
  const { env, options } = setup()
  sweepOrphanRuns(env, options)
  const view = sweepOrphanRuns({ ...env, PATH: '' }, options)
  assert.equal(view.throttled, true, JSON.stringify(view))
  assert.equal(view.complete, true)
  assert.deepEqual(view.errors, [])
})

test('orphans review: report unsafe generated names as skips', () => {
  const { env, old, options } = setup()
  symlinkSync(old, join(privateRuntimeDir(env), 'run-Link12'))
  const view = sweepOrphanRuns(env, options)
  assert.ok(view.skipped.some(item => item.path.endsWith('run-Link12') && /plain private directory/.test(item.reason)), JSON.stringify(view))
})

test('orphans review: a root replaced by a symlink between checks stays untouched', () => {
  const { env, old, options } = setup()
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  mkdirSync(outside)
  const preload = join(env.XDG_RUNTIME_DIR, 'race.mjs')
  writeFileSync(preload, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const original = fs.lstatSync
let count = 0
fs.lstatSync = function(path, ...args) {
  if (String(path).endsWith('/run-Old123') && ++count === 2) {
    fs.renameSync(${JSON.stringify(old)}, ${JSON.stringify(`${old}-moved`)})
    fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(old)})
    const date = new Date(${options.now - 86400001})
    fs.lutimesSync(${JSON.stringify(old)}, date, date)
  }
  return original(path, ...args)
}
syncBuiltinESMExports()
`)
  const view = sweepOrphanRuns({ ...env, NODE_OPTIONS: `--import=${preload}` }, options)
  assert.equal(lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink(), true, JSON.stringify(view))
  assert.equal(existsSync(`${old}-moved`), true)
  assert.deepEqual(view.removed, [])
  assert.equal(view.complete, false)
})

test('orphans review: repair unreadable owned directories without changing symlink targets', () => {
  const { env, old, options } = setup()
  const blocked = join(old, 'blocked')
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  mkdirSync(blocked)
  mkdirSync(outside)
  symlinkSync(outside, join(blocked, 'link'))
  const date = new Date(options.now - 86400001)
  // A fresh link protects its folder. Use an old empty blocked folder for the repair case.
  const blockedEmpty = join(old, 'empty')
  mkdirSync(blockedEmpty)
  utimesSync(blockedEmpty, date, date)
  chmodSync(blockedEmpty, 0)
  chmodSync(outside, 0o500)
  utimesSync(old, date, date)
  try {
    const view = sweepOrphanRuns(env, options)
    assert.equal(view.complete, true, JSON.stringify(view))
    assert.equal(statSync(blockedEmpty).mode & 0o700, 0o700)
    assert.equal(statSync(outside).mode & 0o777, 0o500)
  } finally {
    if (existsSync(blockedEmpty)) chmodSync(blockedEmpty, 0o700)
    chmodSync(outside, 0o700)
  }
})
