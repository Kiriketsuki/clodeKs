import assert from 'node:assert/strict'
import { existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildResult, foldEvents, runExec } from '../lib/exec.mjs'
import { buildRunPrompt } from '../lib/run-context.mjs'
import { readStoppedOutputFile } from '../lib/stopped-output.mjs'
import { testEnv } from './helpers/env.mjs'

const event = (type, text) => JSON.stringify({ type, item: { type: 'agent_message', text } })
const stopped = extra => buildResult({ folded: foldEvents([event('item.completed', 'progress')]), outText: '',
  exitCode: 143, timedOut: true, wantsJson: false, durationMs: 10, ...extra })

test('stopped output: empty output files do not hide completed messages', () => {
  const r = stopped()
  assert.equal(r.ok, false)
  assert.equal(r.error, 'timeout')
  assert.equal(r.text, 'progress')
  assert.equal(r.result, 'progress')
  assert.equal(r.result_partial, true)
})

test('stopped output: current message updates survive without a final message', () => {
  const r = stopped({ folded: foldEvents([event('item.updated', 'current progress')]) })
  assert.equal(r.text, 'current progress')
  assert.equal(r.result, 'current progress')
  assert.ok(r.partial_output.items.some(item => item.source === 'agent_message_update'))
})

test('stopped output: preserve parsed JSON and label incomplete JSON without changing the stop cause', () => {
  const valid = stopped({ outText: '{"answer":"partial"}', wantsJson: true })
  assert.deepEqual(valid.result, { answer: 'partial' })
  assert.equal(valid.result_partial, true)
  const invalid = stopped({ outText: '{"answer":', wantsJson: true })
  assert.equal(invalid.result, null)
  assert.equal(invalid.text, '{"answer":')
  assert.equal(invalid.error, 'timeout')
  assert.equal(invalid.result_partial, true)
})

test('stopped output: resource stops retain text and their original cause', () => {
  const r = stopped({ timedOut: false, resourceStop: { reason: 'max_rss' } })
  assert.equal(r.error, 'resource limit: max_rss')
  assert.equal(r.result, 'progress')
  assert.equal(r.result_partial, true)
  assert.equal(r.ok, false)
})

test('stopped output: command tails are sanitized and share the total byte budget', () => {
  const folded = foldEvents([
    event('item.completed', '🧪'.repeat(30_000)),
    JSON.stringify({ type: 'item.updated', item: { type: 'command_execution', aggregated_output: 'old'.repeat(10_000) + '\u001b[31m\tTAIL\u0000\n\u202e' } }),
  ])
  const r = stopped({ folded, outText: '🧪'.repeat(30_000) })
  assert.ok(r.partial_output.bytes <= 65536)
  assert.equal(r.partial_output.truncated, true)
  const command = r.partial_output.items.find(item => item.source === 'command_output')
  assert.ok(Buffer.byteLength(command.text) <= 8192)
  assert.equal(command.truncated, true)
  assert.ok(command.text.endsWith('\tTAIL\n'))
  assert.doesNotMatch(command.text.replace(/[\n\t]/g, ''), /[\p{Cc}\p{Cf}]/u)
  assert.doesNotMatch(r.text, /\uFFFD/)
})

test('stopped output: successful results keep their existing output behavior', () => {
  const r = stopped({ timedOut: false, exitCode: 0, outText: 'final' })
  assert.equal(r.ok, true)
  assert.equal(r.result, 'final')
  assert.equal(r.result_partial, undefined)
  assert.equal(r.partial_output, undefined)
})

test('stopped output: command-only output stays separate from the agent result', () => {
  const folded = foldEvents([JSON.stringify({ type: 'item.updated', item: { type: 'command_execution', aggregated_output: 'command progress' } })])
  const r = stopped({ folded })
  assert.equal(r.result, null)
  assert.equal(r.text, '')
  assert.equal(r.result_partial, true)
  assert.equal(r.partial_output.items[0].source, 'command_output')
})

test('stopped output: output-file reads stay bounded and refuse symlinks', () => {
  const env = testEnv()
  const file = join(env.XDG_RUNTIME_DIR, 'large')
  writeFileSync(file, '🧪'.repeat(100_000))
  const output = readStoppedOutputFile(file)
  assert.ok(Buffer.byteLength(output.text) <= 65536)
  assert.equal(output.truncated, true)
  assert.doesNotMatch(output.text, /\uFFFD/)
  const link = join(env.XDG_RUNTIME_DIR, 'link')
  symlinkSync(file, link)
  assert.equal(readStoppedOutputFile(link).text, '')
})

test('stopped output: preamble names the cap and checkpoint before the unchanged caller task', () => {
  const prompt = buildRunPrompt({ prompt: 'caller task', executionBudget: { limitMs: 1000, startedAt: 0 } })
  assert.match(prompt, /1000 ms/)
  assert.match(prompt, /1970-01-01T00:00:01.000Z/)
  assert.match(prompt, /80 percent/)
  assert.match(prompt, /requested report path first/)
  assert.ok(prompt.endsWith('\n\nCaller task\n\ncaller task'))
})

const fixture = fileURLToPath(new URL('./fixtures/stopped-codex.mjs', import.meta.url))
test('stopped output: real wrapper timeout retains messages, command tail and elapsed cap', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: fixture })
  const r = await runExec({ prompt: 'task', cwd: env.XDG_RUNTIME_DIR, sandbox: 'read-only', timeoutMs: 800 }, env)
  assert.equal(r.error, 'timeout')
  assert.equal(r.result, 'current progress')
  assert.equal(r.result_partial, true)
  assert.ok(r.partial_output.items.some(item => item.source === 'agent_message' && item.text === 'saved progress'))
  assert.ok(r.partial_output.items.some(item => item.source === 'command_output' && item.text.endsWith('command tail')))
  assert.equal(r.execution_budget.limit_ms, 800)
  assert.ok(r.execution_budget.stop_elapsed_ms >= 700)
  assert.ok(r.execution_budget.elapsed_ms >= r.execution_budget.stop_elapsed_ms)
})

test('stopped output: resource stop budget excludes preflight and retains progress', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: fixture })
  const ready = join(env.XDG_RUNTIME_DIR, 'ready')
  const r = await runExec({ prompt: 'task', cwd: env.XDG_RUNTIME_DIR, sandbox: 'read-only', timeoutMs: 5000,
    resourceLimits: { minMemavailBytes: 100, maxMs: 1000 } }, { ...env, FAKE_READY: ready }, {
    preflight: () => new Promise(resolve => setTimeout(resolve, 150)), pollMs: 10,
    sample: () => ({ memavailBytes: existsSync(ready) ? 99 : 100 }),
  })
  assert.equal(r.resource_stop.reason, 'min_memavail')
  assert.equal(r.result, 'current progress')
  assert.equal(r.result_partial, true)
  assert.equal(r.execution_budget.limit_ms, 1000)
  assert.ok(r.duration_ms - r.execution_budget.elapsed_ms >= 120)
})
