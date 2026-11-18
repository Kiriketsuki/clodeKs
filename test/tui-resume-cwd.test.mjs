import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'

function launch(raw, options = []) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const result = spawnSync(process.execPath, [CLI, 'tui', '--socket', CAPTURE,
    '--cwd', join(env.XDG_RUNTIME_DIR, 'removed-worktree'), ...options, '--', ...raw], {
    env, cwd: env.XDG_RUNTIME_DIR, encoding: 'utf8', timeout: 5000,
  })
  assert.ifError(result.error)
  return { result, env }
}

test('tui resume cwd: ignores wrapper cwd with a warning and preserves saved permissions', () => {
  for (const raw of [['resume', ID], ['resume', '--last'], ['--model', 'test-model', 'resume', ID]]) {
    const { result } = launch(raw, ['--permissions', 'auto'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), ['--remote', `unix://${CAPTURE}`, ...raw])
    assert.match(result.stderr, /ignoring --cwd for resume.*saved workspace/)
    assert.doesNotMatch(result.stdout, /approval_policy|sandbox_mode|approve-for-me|removed-worktree/)
  }
})

test('tui resume cwd: still refuses trust overrides and other subcommands', () => {
  for (const [raw, options, expected] of [
    [['resume', ID], ['--trust'], /--trust.*new TUI session/],
    [['fork', ID], [], /--cwd.*new TUI session/],
    [['exec', 'task'], [], /--cwd.*new TUI session/],
    [['--model', 'resume', 'task'], [], /--cwd.*existing folder/],
  ]) {
    const { result } = launch(raw, options)
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, expected)
  }
})

test('tui resume cwd: wrapper cwd and forwarded cwd flags still conflict', () => {
  for (const raw of [['-C', '/other', 'resume', ID], ['resume', ID, '-C', '/other'], ['--cd=/other', 'resume', ID]]) {
    const { result } = launch(raw)
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--cwd cannot be combined with forwarded cwd flags/)
  }
})
