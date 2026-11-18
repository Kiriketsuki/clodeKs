import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { buildExecArgs } from '../lib/exec.mjs'
import { buildRunPrompt } from '../lib/run-context.mjs'

const task = 'Review only. Run the tests if possible.\nKeep this task text unchanged.\n'
const boundary = '\n\nCaller task\n\n'

for (const resume of [undefined, 'existing-thread']) {
  test(`read-only context: ${resume ? 'resumed' : 'new'} runs explain private temp writes and repository protection`, () => {
    const opts = { prompt: task, sandbox: 'read-only', cwd: '/work', resume, tempDir: '/private/temp', permissionProfile: 'context_temp' }
    const prompt = buildRunPrompt(opts)
    assert.match(prompt, /Caches and build output inside the repository still need write access/)
    assert.match(prompt, /A request to run tests does not authorize repository writes/)
    assert.match(prompt, /Report checks that could not run/)
    assert.match(prompt, /explicitly authorized writable run/)
    assert.ok(prompt.includes(boundary))
    assert.equal(prompt.slice(prompt.indexOf(boundary) + boundary.length), task)
    const args = buildExecArgs(opts)
    assert.ok(args.some(arg => arg.includes('extends=":read-only"')))
    assert.ok(args.includes('approval_policy="never"'))
    assert.ok(!args.some(arg => arg.startsWith('sandbox_workspace_write.writable_roots=')))
  })
}

test('read-only context: writable runs retain their prompt and Git-hook context', () => {
  for (const sandbox of ['workspace-write', 'danger-full-access']) {
    assert.ok(buildRunPrompt({ prompt: task, sandbox }).endsWith(boundary + task))
    const prompt = buildRunPrompt({ prompt: task, sandbox, git: true })
    assert.match(prompt, /Installed Git hooks run as Git subprocesses/)
    assert.doesNotMatch(prompt, /clodeKs read-only context/)
    assert.ok(prompt.endsWith(boundary + task))
  }
})

test('read-only agent: a test request does not authorize writes and blocked checks stay visible', () => {
  const agent = readFileSync(new URL('../plugin/agents/codex-exec.md', import.meta.url), 'utf8')
  assert.match(agent, /A request to run tests does not authorize repository writes/)
  assert.match(agent, /grants one private temporary folder outside it/)
  assert.match(agent, /Do not add --write just to make tests pass/)
  assert.match(agent, /report the missing runtime proof/)
})
