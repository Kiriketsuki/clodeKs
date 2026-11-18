#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 0.169.0')
} else if (args[0] === 'app-server') {
  const record = process.env.FAKE_PERMISSION_RECORD
  let attempt = 0
  try { attempt = Number(readFileSync(record, 'utf8')) } catch {}
  writeFileSync(record, String(attempt + 1))
  const modes = JSON.parse(process.env.FAKE_PERMISSION_MODES ?? '["ok"]')
  const mode = modes[Math.min(attempt, modes.length - 1)]
  process.stderr.write(process.env.FAKE_PERMISSION_STDERR ?? '')
  if (mode === 'exit') process.exit(23)
  if (mode === 'signal') process.kill(process.pid, 'SIGTERM')
  if (mode === 'timeout') setInterval(() => {}, 1000)
  else if (mode === 'malformed') console.log('{bad json')
  else if (mode === 'missing') process.exit(0)
  else for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    if (mode === 'rpc') {
      console.log(JSON.stringify({ id: request.id, error: { code: -32000, message: 'private account data' } }))
      continue
    }
    const result = request.id === 1 ? {} : request.id === 2 ? { requirements: null }
      : { config: { sandbox_workspace_write: null } }
    console.log(JSON.stringify({ id: request.id, result }))
  }
} else {
  await import('./readonly-temp-codex.mjs')
}
