import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const agent = readFileSync(new URL('../plugin/agents/codex-exec.md', import.meta.url), 'utf8')
const waiting = agent.split('## Wait for the same run\n')[1]?.split('## Return it\n')[0]
const returning = agent.split('## Return it\n')[1]

test('agent completion: a launch receipt cannot enter the final-result path', () => {
  assert.ok(waiting)
  assert.match(waiting, /task ID and output-file path are a launch receipt, not a completion signal/)
  assert.match(waiting, /do not enter.*Return it.*until.*completion notification.*same task ID/is)
  assert.match(waiting, /Do not give a final answer while the task still runs/)
  assert.match(waiting, /Do not start another Codex process/)
})

test('agent completion: required waiting updates carry an explicit interim label and no verdict', () => {
  assert.ok(waiting)
  const template = waiting.match(/```text\n([\s\S]*?)\n```/)?.[1]
  assert.equal(template, 'INTERIM: Codex is still running. This is not a result or review verdict.')
  assert.match(waiting, /If the harness requires a waiting update/)
  assert.match(waiting, /non-final update/)
  assert.match(waiting, /Do not put this notice in.*result.*text.*or a success JSON object/)
  assert.throws(() => JSON.parse(template))
})

test('agent completion: missing output becomes failure only after completion or a launch refusal', () => {
  assert.ok(returning)
  assert.match(returning, /If Bash refused to start the task/)
  assert.match(returning, /Only after task completion, if the output file has no complete CLI JSON line/)
  assert.doesNotMatch(returning, /If the Bash call printed no JSON line or failed to run/)
  assert.match(returning, /Otherwise return the JSON line unchanged/)
  assert.match(waiting, /Do not treat an interim update as the task result/)
})

test('agent completion: a launch refusal bypasses the completion-notification wait', () => {
  assert.match(waiting, /If Bash returns a background receipt, do not enter/)
  assert.match(waiting, /If Bash refused to start, skip the wait and use the launch-refusal result/)
  assert.match(returning, /If Bash refused to start the task, return/)
})

test('agent foreground: routine and default runs block on Bash without shortening Codex time', () => {
  const run = agent.split('## Run it\n')[1]?.split('### A caller-supplied brief file')[0]
  assert.ok(run)
  assert.match(run, /If TIMEOUT is at most 900 seconds/)
  assert.match(run, /run_in_background: false/)
  assert.match(run, /min\(\(TIMEOUT \+ 30\) \* 1000, 600000\)/)
  assert.match(run, /Keep --timeout TIMEOUT unchanged/)
  assert.match(run, /If TIMEOUT exceeds 900 seconds/)
  assert.match(run, /run_in_background: true/)
})

test('agent foreground: completed inline output does not wait for a nonexistent task notice', () => {
  assert.match(waiting, /foreground Bash call returns complete CLI JSON.*Return it/is)
  assert.match(waiting, /no background task ID.*command has ended/is)
  assert.match(waiting, /completed foreground command has no complete CLI JSON.*failure/is)
})

test('agent foreground: moved commands retain the same task and never end with an interim result', () => {
  assert.match(waiting, /moved to the background/)
  assert.match(waiting, /do not use a turn-ending INTERIM notice/i)
  assert.match(waiting, /Do not issue a second launch/)
  assert.match(waiting, /background receipt.*completion notification.*same task ID/is)
})
