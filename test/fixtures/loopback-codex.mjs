#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.169.0'}\n`)
} else if (args[0] === 'app-server') {
  if (process.env.FAKE_CHECK_RECORD) writeFileSync(process.env.FAKE_CHECK_RECORD, JSON.stringify({ cwd: process.cwd(), args }))
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    const request = JSON.parse(line)
    if (request.id === undefined) return
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n')
    } else if (request.method === 'configRequirements/read') {
      if (process.env.FAKE_SERVER_MODE === 'hang') return
      if (process.env.FAKE_SERVER_MODE === 'malformed') { process.stdout.write('null\n'); return }
      if (process.env.FAKE_SERVER_MODE === 'error') {
        process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'private response data' } }) + '\n')
        return
      }
      const result = process.env.FAKE_REQUIREMENTS_RESPONSE
        ? JSON.parse(process.env.FAKE_REQUIREMENTS_RESPONSE) : { requirements: null }
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
    } else if (request.method === 'config/read') {
      const result = process.env.FAKE_CONFIG_RESPONSE ? JSON.parse(process.env.FAKE_CONFIG_RESPONSE)
        : { config: { sandbox_workspace_write: null } }
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
    }
  })
} else {
  readFileSync(0, 'utf8')
  if (process.env.FAKE_EXEC_RECORD) writeFileSync(process.env.FAKE_EXEC_RECORD, JSON.stringify(args))
  for (const event of [
    { type: 'thread.started', thread_id: 'isolated-test' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: {} },
  ]) process.stdout.write(JSON.stringify(event) + '\n')
}
