import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

function setup() {
  const base = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'echo' })
  const cwd = join(base.XDG_RUNTIME_DIR, 'work')
  const scratch = join(base.XDG_RUNTIME_DIR, 'scratch')
  mkdirSync(cwd)
  mkdirSync(scratch)
  return { env: { ...base, TMPDIR: scratch }, cwd, scratch }
}

function run(state, args, prompt = 'create the output') {
  const result = spawnSync(process.execPath, [CLI, 'run', '--cwd', state.cwd,
    '--prompt', prompt, ...args], {
    cwd: state.env.XDG_RUNTIME_DIR, env: state.env, encoding: 'utf8', timeout: 5000,
  })
  assert.ifError(result.error)
  return result
}

test('add-dir: writable runs create nested cwd and scratch folders before starting Codex', () => {
  const state = setup()
  const local = join(state.cwd, 'bundle', 'reports')
  const scratch = join(state.scratch, 'results', 'review')
  const result = run(state, ['--write', '--add-dir', local, '--add-dir', scratch])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true)
  assert.ok(statSync(local).isDirectory())
  assert.ok(statSync(scratch).isDirectory())
})

test('add-dir: relative folders retain launcher-relative resolution', () => {
  const state = setup()
  const result = run(state, ['--write', '--add-dir', 'work/reports/new'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(statSync(join(state.cwd, 'reports', 'new')).isDirectory())
})

test('add-dir: read-only and invalid prompts create no folder', () => {
  for (const args of [[], ['--write']]) {
    const state = setup()
    const target = join(state.cwd, 'reports')
    const result = run(state, [...args, '--add-dir', target], args.length ? '' : 'create')
    assert.equal(result.status, 2, result.stderr)
    assert.equal(existsSync(target), false)
    assert.equal(result.stdout, '')
  }
})

test('add-dir: missing outside folders and files refuse the whole request before mkdir', () => {
  for (const kind of ['outside', 'file', 'symlink', 'dangling']) {
    const state = setup()
    const allowed = join(state.cwd, 'allowed')
    const outside = join(state.env.XDG_RUNTIME_DIR, 'outside')
    mkdirSync(outside)
    let refused = join(outside, 'new')
    if (kind === 'file') {
      refused = join(state.cwd, 'file')
      writeFileSync(refused, 'existing content')
    }
    if (kind === 'symlink') {
      symlinkSync(outside, join(state.cwd, 'escape'), 'dir')
      refused = join(state.cwd, 'escape', 'new')
    }
    if (kind === 'dangling') {
      refused = join(state.cwd, 'dangling')
      symlinkSync(join(outside, 'missing'), refused, 'dir')
    }
    const result = run(state, ['--write', '--add-dir', allowed, '--add-dir', refused])
    assert.equal(result.status, 2, result.stderr)
    assert.equal(existsSync(allowed), false)
    assert.equal(existsSync(join(outside, 'new')), false)
    assert.equal(existsSync(join(outside, 'missing')), false)
  }
})

test('add-dir: existing extra folders outside creation roots remain valid', () => {
  const state = setup()
  const outside = join(state.env.XDG_RUNTIME_DIR, 'outside')
  mkdirSync(outside)
  const result = run(state, ['--write', '--add-dir', outside])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true)
})
