import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createUnixServer } from 'node:net'
import { join } from 'node:path'

const quote = value => `'${value.replaceAll("'", "'\\''")}'`

// Fixed local Responses events exercise the installed executor without a model service.
export async function nativeExecFixture(env, cwd, extra, outside, probe, commandOverride, yieldTimeMs = 10000) {
  const home = join(env.XDG_RUNTIME_DIR, 'codex-home')
  mkdirSync(home, { mode: 0o700 })
  const unix = createUnixServer(client => client.end())
  const socket = join(env.XDG_RUNTIME_DIR, 'resume-host.sock')
  await new Promise(resolve => unix.listen(socket, resolve))
  let count = 0
  let output
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const part of request) body += part
    const input = JSON.parse(body).input
    count++
    const item = count === 2
      ? { type: 'function_call', call_id: 'scope-probe', name: 'exec_command',
          arguments: JSON.stringify({ cmd: command, yield_time_ms: yieldTimeMs, max_output_tokens: 2000 }) }
      : { type: 'message', role: 'assistant', id: `msg-${count}`,
          content: [{ type: 'output_text', text: 'Local fixture complete.' }] }
    if (count === 3) {
      const call = input.find(item => item.type === 'function_call_output' && item.call_id === 'scope-probe')
      output = call?.output
    }
    if (request.url !== '/v1/responses' || count > 3) {
      response.writeHead(500).end('Unexpected fixture request')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'response.created', response: { id: `resp-${count}` } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: `resp-${count}`,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ]
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const command = commandOverride ?? [
    'CLODEKS_PROBE_SKIP_PROXY=1',
    `CLODEKS_PROBE_HOST_PORT=${server.address().port}`,
    `CLODEKS_PROBE_HOST_SOCKET=${quote(socket)}`,
    `CLODEKS_PROBE_WRITE_DIRS=${quote(JSON.stringify([cwd, extra, outside]))}`,
    `python3 -I -B ${quote(probe)}`,
  ].join(' ')
  writeFileSync(join(home, 'config.toml'), `model = "gpt-5.1-codex-mini"
model_provider = "clodeks_probe"
[model_providers.clodeks_probe]
name = "Local deterministic fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`)
  return {
    env: { ...env, CODEX_HOME: home, CODEX_SQLITE_HOME: home },
    requestCount: () => count,
    rawCommandOutput: () => output,
    commandOutput: () => {
      assert.equal(typeof output, 'string', 'the fixture must receive the real command output')
      const line = output.split('\n').find(line => line.startsWith('{"public_tcp"'))
      assert.ok(line, output)
      return JSON.parse(line)
    },
    close: () => Promise.all([
      new Promise(resolve => server.close(resolve)), new Promise(resolve => unix.close(resolve)),
    ]),
  }
}
