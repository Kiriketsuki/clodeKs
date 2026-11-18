import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { listPendingApprovals } from '../lib/appserver.mjs'
import { openWebSocket } from '../lib/ws.mjs'
import { testEnv } from './helpers/env.mjs'
import { closeNativeApprovalFixture } from './helpers/native-approval-cleanup.mjs'

const CODEX = process.env.CLODEKS_NATIVE_CODEX_BIN

// A local fixed Responses stream requests approval. No model service receives a call.
test('native pending: passive discovery leaves the approval with the owning client', {
  timeout: 30000,
  skip: CODEX ? false : 'Set CLODEKS_NATIVE_CODEX_BIN to the installed native Codex ELF binary.',
}, async t => {
  assert.ok(isAbsolute(CODEX))
  const header = Buffer.alloc(4)
  const fd = openSync(CODEX, 'r')
  try { readSync(fd, header) } finally { closeSync(fd) }
  assert.deepEqual([...header], [0x7f, 0x45, 0x4c, 0x46], 'use the installed Linux binary, not a package wrapper')

  const host = testEnv()
  const home = join(host.XDG_RUNTIME_DIR, 'home')
  const cwd = join(host.XDG_RUNTIME_DIR, 'work')
  const env = {
    HOME: home, PATH: host.PATH, LANG: 'en_US.UTF-8',
    CODEX_HOME: home, CODEX_SQLITE_HOME: home,
    XDG_RUNTIME_DIR: host.XDG_RUNTIME_DIR, XDG_STATE_HOME: host.XDG_STATE_HOME,
  }
  mkdirSync(home)
  mkdirSync(cwd)
  let calls = 0
  const marker = join(cwd, 'command-ran')
  const command = `printf clodeks-native-approval-probe > ${marker}`
  const model = createServer(async (request, response) => {
    for await (const part of request) void part
    calls++
    const item = calls === 1
      ? { type: 'function_call', call_id: 'approval-probe', name: 'exec_command',
          arguments: JSON.stringify({ cmd: command, sandbox_permissions: 'require_escalated', justification: 'Inspect this local approval probe.' }) }
      : { type: 'message', role: 'assistant', id: 'msg-done', content: [{ type: 'output_text', text: 'Local fixture complete.' }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      { type: 'response.created', response: { id: 'resp-probe' } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: 'resp-probe', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  let child
  let ws
  let exited
  let spawnError
  const socket = join(env.XDG_RUNTIME_DIR, 'private.sock')
  t.after(() => closeNativeApprovalFixture({ child, exited, socket, ws, model }))
  await new Promise((resolve, reject) => {
    model.once('error', reject)
    model.listen(0, '127.0.0.1', resolve)
  })
  writeFileSync(join(home, 'config.toml'), `model = "gpt-5.1-codex-mini"
model_provider = "local_probe"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
[analytics]
enabled = false
[features]
hooks = false
shell_snapshot = false
[model_providers.local_probe]
name = "Local deterministic approval fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
[projects."${cwd}"]
trust_level = "trusted"
`)
  child = spawn(CODEX, ['app-server', '--listen', `unix://${socket}`], {
    cwd, env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192) })
  exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve([code, signal]))
    child.once('error', error => { spawnError = error; resolve(null) })
  })
  const deadline = Date.now() + 18000
  try {
    const until = async (check, label) => {
      while (!check()) {
        if (spawnError) throw spawnError
        assert.equal(child.exitCode, null, stderr)
        assert.equal(child.signalCode, null, stderr)
        assert.ok(Date.now() < deadline, `${label} timed out. ${stderr}`)
        await delay(25)
      }
    }
    await until(() => existsSync(socket), 'private socket')
    ws = await openWebSocket(socket, { timeoutMs: 2000 })
    const { rpc, readApproval, readCompletion } = approvalClient(ws, deadline)
    await rpc('initialize', { clientInfo: { name: 'local-probe', version: '1' }, capabilities: { experimentalApi: true } })
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
    const { thread } = await rpc('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'read-only' })
    const { turn } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Exercise the local approval fixture.' }] })
    await until(() => readApproval() !== null, 'approval request')
    const approval = readApproval()
    assert.equal(approval.method, 'item/commandExecution/requestApproval', JSON.stringify(approval))
    assert.match(approval.params.command, /clodeks-native-approval-probe/)

    const result = await Promise.race([
      listPendingApprovals(socket),
      delay(Math.max(1, deadline - Date.now()), null, { ref: false }).then(() => {
        throw new Error('passive discovery timed out')
      }),
    ])
    const waiting = result.pending.find(entry => entry.thread_id === thread.id)
    assert.ok(waiting, JSON.stringify(result))
    assert.equal(waiting.request_id, null)
    assert.ok(waiting.command_candidates.every(item => item.approval_confirmed === false))
    const visible = waiting.command_candidates.some(item => item.command.includes('clodeks-native-approval-probe'))
    t.diagnostic(visible
      ? 'Approval-time command appears in passive history as an unconfirmed candidate.'
      : `Approval-time command absent from passive history. ${waiting.command_details_error ?? 'History returned other command candidates.'}`)

    const after = await rpc('thread/read', { threadId: thread.id })
    assert.ok(after.thread.status.activeFlags?.includes('waitingOnApproval'), JSON.stringify(after.thread.status))
    assert.equal(calls, 1)
    assert.equal(existsSync(marker), false)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: approval.id, result: { decision: 'decline' } }))
    await until(() => readCompletion()?.id === turn.id, 'owner decline')
    assert.equal(existsSync(marker), false)
  } catch (error) {
    t.diagnostic(`Probe failed before cleanup. ${error.message}\n${stderr}`)
    throw error
  }
})

function approvalClient(ws, deadline) {
  const pending = new Map()
  let nextId = 1
  let approval = null
  let completion = null
  ws.onText(text => {
    const msg = JSON.parse(text)
    if (msg.method === 'item/commandExecution/requestApproval') approval = msg
    if (msg.method === 'turn/completed') completion = msg.params.turn
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    clearTimeout(waiter.timer)
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
    else waiter.resolve(msg.result)
  })
  ws.onClose(() => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('the private app-server closed the owner connection'))
    }
    pending.clear()
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method}: timed out`))
    }, Math.max(1, Math.min(5000, deadline - Date.now())))
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  return { rpc, readApproval: () => approval, readCompletion: () => completion }
}
