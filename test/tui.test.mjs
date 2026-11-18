import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))

function launch(...args) {
  const result = spawnSync(process.execPath, [CLI, 'tui', '--socket', CAPTURE, ...args], {
    encoding: 'utf8',
    env: testEnv({ CLODEKS_CODEX_BIN: CAPTURE }),
  })
  assert.ifError(result.error)
  return result
}

function captured(...args) {
  const result = launch(...args)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('tui: a brief defaults to workspace write with approval on request', () => {
  const args = captured('--brief', BRIEF)
  assert.deepEqual(args.slice(0, -1), [
    '--remote', `unix://${CAPTURE}`, '-C', process.cwd(),
    '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"',
  ])
  assert.match(args.at(-1), /^\[clodeks launch [0-9a-f-]{36}\]\n/)
  assert.ok(args.at(-1).endsWith(readFileSync(BRIEF, 'utf8')))
  assert.notEqual(args.at(-1), captured('--brief', BRIEF).at(-1))
})

test('tui: forwarded cwd flags suppress observation with an explicit warning', () => {
  for (const args of [['-C', '/other'], ['--cd=/other'], ['--worktree']]) {
    const result = launch('--brief', BRIEF, '--', ...args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /alias observation skipped.*forwarded cwd/)
    const recordPath = result.stderr.match(/clodeks tui: launch record ([^\n]+)/)?.[1]
    assert.ok(recordPath, result.stderr)
    const saved = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(saved.status, 'unavailable')
    assert.equal(saved.alias, null)
    assert.match(saved.error, /forwarded cwd/)
  }
})

test('tui: explicit ask and read-only modes keep approval on request', () => {
  for (const [mode, sandbox] of [['ask', 'workspace-write'], ['read-only', 'read-only']]) {
    const args = captured('--permissions', mode)
    assert.deepEqual(args.slice(4), ['-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="on-request"'])
  }
})

test('tui: auto uses automatic review inside workspace write', () => {
  const args = captured('--permissions', 'auto')
  assert.deepEqual(args.slice(4), ['-c', 'sandbox_mode="workspace-write"', '--approve-for-me'])
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('tui: unknown permission modes fail before Codex starts', () => {
  const result = launch('--permissions', 'unrestricted')
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--permissions must be one of ask, auto, read-only/)
})

test('tui: raw Codex arguments still follow wrapper defaults', () => {
  const args = captured('--', '--sandbox', 'read-only', '--model', 'test-model')
  assert.deepEqual(args.slice(4), [
    '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"',
    '--sandbox', 'read-only', '--model', 'test-model',
  ])
})

test('tui: remote resume preserves stored permissions', () => {
  const args = captured('--', 'resume', 'stored-thread')
  assert.deepEqual(args, [
    '--remote', `unix://${CAPTURE}`,
    'resume', 'stored-thread',
  ])
})

test('tui: forwarded Codex subcommands receive no permission defaults', () => {
  for (const command of ['fork', 'exec', 'help', 'features']) {
    const args = captured('--', command)
    assert.deepEqual(args.slice(4), [command])
  }
})

test('tui: a plain prompt still receives permission defaults', () => {
  const args = captured('--', 'Write the report')
  assert.deepEqual(args.slice(4), [
    '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"',
    'Write the report',
  ])
})
