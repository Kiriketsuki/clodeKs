#!/usr/bin/env node
// A stand-in for the codex binary. FAKE_MODE picks the behaviour under test.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { handlePermissionProbe } from '../helpers/permission-probe.mjs'

if (await handlePermissionProbe()) process.exit(0)

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const mode = process.env.FAKE_MODE
out({ type: 'thread.started', thread_id: '01a11f22-ed3b-7b43-9b60-da49320152fd' })
out({ type: 'turn.started' })

if (mode === 'jobs') {
  const timer = setInterval(() => {
    if (!process.env.FAKE_RELEASE || !existsSync(process.env.FAKE_RELEASE)) return
    clearInterval(timer)
    out({ type: 'item.completed', item: { type: 'agent_message', text: 'private output marker' } })
    out({ type: 'turn.completed', usage: {} })
  }, 20)
} else if (mode === 'relay') {
  appendFileSync(process.env.CLODEKS_OUTBOX, JSON.stringify({ body: 'progress: half done' }) + '\n')
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'finished' } })
  out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
} else if (mode === 'echo' || mode === 'capture-prompt' || mode === 'capture-prompt-json') {
  const prompt = readFileSync(0, 'utf8')
  if (mode !== 'echo') writeFileSync(process.env.FAKE_PROMPT_RECORD, prompt)
  out({ type: 'item.completed', item: { type: 'agent_message', text: mode === 'capture-prompt-json' ? '{"answer":"captured"}' : prompt } })
  out({ type: 'turn.completed', usage: {} })
} else if (mode === 'umask') {
  out({ type: 'item.completed', item: { type: 'agent_message', text: readFileSync('/proc/self/status', 'utf8').match(/^Umask:\s*(0[0-7]{3})/m)[1] } })
  out({ type: 'turn.completed', usage: {} })
} else if (mode === 'commit' || mode === 'commit-json' || mode === 'commit-hang' || mode === 'commit-cleanup-failure' || mode === 'tamper') {
  // Commits in the cwd, as Codex does in a --git run. Tamper also plants a hook.
  if (mode === 'tamper') writeFileSync('.git/hooks/pre-push', '#!/bin/sh\necho planted\n', { mode: 0o755 })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fake codex commit'])
  if (mode === 'commit-cleanup-failure') {
    const prompt = readFileSync(0, 'utf8')
    const scratch = JSON.parse(prompt.match(/^Scratch folder: (.+)$/m)[1])
    chmodSync(dirname(dirname(scratch)), 0o500)
  }
  out({ type: 'item.completed', item: { type: 'agent_message', text: mode === 'commit-json' ? '{"answer":"committed"}' : 'committed' } })
  out({ type: 'turn.completed', usage: {} })
  if (mode === 'commit-hang') {
    writeFileSync('committed.txt', 'guard stop after commit')
    setInterval(() => {}, 1000)
  }
} else if (mode === 'commit-late-writer') {
  // Commits, then leaves a writer in the same process group. It changes the git dir later.
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fake codex commit'])
  spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync('.git/hooks/pre-push', '#!/bin/sh\\n'), 1500)`],
    { stdio: 'ignore' }).unref()
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'committed' } })
  out({ type: 'turn.completed', usage: {} })
} else if (mode === 'timeout-writes') {
  writeFileSync('created.txt', 'partial output')
  writeFileSync('edited.txt', 'after')
  writeFileSync(join(process.env.FAKE_ADD_DIR, 'partial.txt'), 'partial report')
  setInterval(() => {}, 1000)
} else if (mode === 'guard-writes') {
  writeFileSync('partial.txt', 'partial output')
  spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {})
    require('node:fs').writeFileSync('tool-pid', String(process.pid))
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'inherit', 'inherit'] })
  setInterval(() => {}, 1000)
} else if (mode === 'hang') {
  // A tool that keeps stdout open, and a codex that never ends.
  spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] })
  setInterval(() => {}, 1000)
} else if (mode === 'exit-leaves-child') {
  // Codex exits, but a tool it started still holds stdout.
  spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'], detached: false }).unref()
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })
  out({ type: 'turn.completed', usage: {} })
  process.exit(0)
}
