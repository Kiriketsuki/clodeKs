import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildRunPrompt } from '../lib/run-context.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))

function checkGuidance(text) {
  assert.match(text, /private per-run file/)
  assert.match(text, /Never reuse a shared body file path/)
  assert.match(text, /Pass -R OWNER\/REPO on every gh pr edit/)
  assert.match(text, /after create and before merge/)
  assert.match(text, /gh pr view.*-R OWNER\/REPO.*--json body/)
  assert.match(text, /Compare the full body and closing issue references with the intended file/)
  assert.match(text, /If they differ, stop and report the mismatch/)
  assert.match(text, /grants no extra permissions or merge authority/)
}

test('PR body context: writable and push run prompts include the guard and preserve caller text', () => {
  const task = 'Commit only. Stop for review. $HOME `literal`  \n'
  for (const options of [{ sandbox: 'workspace-write' }, { sandbox: 'danger-full-access' }, { push: true }]) {
    const prompt = buildRunPrompt({ prompt: task, ...options })
    checkGuidance(prompt)
    assert.ok(prompt.endsWith('\n\nCaller task\n\n' + task))
  }
})

test('PR body context: read-only reviews receive no PR write guidance', () => {
  const task = 'Review only.\n'
  const prompt = buildRunPrompt({ prompt: task, sandbox: 'read-only' })
  assert.doesNotMatch(prompt, /clodeKs PR body guidance|gh pr|body-file/)
  assert.match(prompt, /clodeKs read-only context/)
  assert.ok(prompt.endsWith('\n\nCaller task\n\n' + task))
})

test('PR body context: a new brief receives guidance without a reply route', () => {
  const result = spawnSync(process.execPath, [CLI, 'tui', '--socket', CAPTURE, '--brief', BRIEF], {
    env: testEnv({ CLODEKS_CODEX_BIN: CAPTURE }), encoding: 'utf8', timeout: 5000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const prompt = JSON.parse(result.stdout).at(-1)
  checkGuidance(prompt)
  assert.ok(prompt.endsWith(readFileSync(BRIEF, 'utf8')))
})

test('PR body context: the forwarding agent tells the caller to guard its own PR writes', () => {
  const agent = readFileSync(new URL('../plugin/agents/codex-exec.md', import.meta.url), 'utf8')
  checkGuidance(agent)
  assert.match(agent, /The calling session handles GitHub PR writes/)
  assert.match(agent, /These instructions do not authorize the forwarder to edit a PR/)
})
