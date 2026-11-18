import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { connectAppServer } from '../lib/appserver.mjs'
import { recycleIfIdle } from '../lib/recycle.mjs'
import { readDurableQueue } from '../lib/recycle-service.mjs'
import { socketIdentity } from '../lib/umask.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CODEX = process.env.CLODEKS_NATIVE_CODEX_BIN
const MINUTE = 60_000
const exec = promisify(execFile)

async function until(check) {
  let error
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await check()
      if (value) return value
    } catch (err) { error = err }
    await sleep(100)
  }
  throw new Error('private Codex probe timed out', { cause: error })
}

function run(binary, args, options) {
  const child = spawn(binary, args, options)
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return { child, exited }
}

async function stop({ child, exited }, signal) {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  const waited = await Promise.race([exited, sleep(4000, null, { ref: false })])
  if (!waited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await exited
}

function fixtureReply(res, responseId) {
  const item = { type: 'message', role: 'assistant', id: 'msg-' + responseId,
    content: [{ type: 'output_text', text: 'Private recycle fixture finished.' }] }
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: responseId, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

test('native recycle: an idle TUI reconnects and a stored queue survives restart', {
  timeout: 50_000,
  skip: CODEX ? false : 'Set CLODEKS_NATIVE_CODEX_BIN to the installed native Codex ELF binary.',
}, async t => {
  assert.ok(isAbsolute(CODEX))
  const header = Buffer.alloc(4)
  const binFd = openSync(CODEX, 'r')
  try { readSync(binFd, header) } finally { closeSync(binFd) }
  assert.deepEqual([...header], [0x7f, 0x45, 0x4c, 0x46], 'use the installed Linux binary, not a package wrapper')
  const host = testEnv()
  const home = join(host.XDG_RUNTIME_DIR, 'codex')
  const cwd = join(host.XDG_RUNTIME_DIR, 'work')
  const socket = join(host.XDG_RUNTIME_DIR, 'private.sock')
  const brief = join(host.XDG_RUNTIME_DIR, 'brief.md')
  const env = {
    HOME: host.HOME, PATH: host.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    CODEX_HOME: home, CODEX_SQLITE_HOME: home, XDG_RUNTIME_DIR: host.XDG_RUNTIME_DIR,
    XDG_STATE_HOME: host.XDG_STATE_HOME, CLODEKS_CODEX_BIN: CODEX,
  }
  mkdirSync(home)
  mkdirSync(cwd)
  writeFileSync(brief, 'Private recycle fixture.\n')

  let calls = 0
  const model = createServer(async (req, res) => {
    for await (const part of req) void part
    fixtureReply(res, 'resp-' + ++calls)
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  let server
  let tui
  try {
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
name = "Local deterministic fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
[projects."${cwd}"]
trust_level = "trusted"
`)
    const rpc = async (method, params) => {
      const client = await connectAppServer(socket, { deadlineMs: Date.now() + 1000, env })
      try { return await client.request(method, params) } finally { client.close() }
    }
    const start = () => run(CODEX, ['app-server', '--listen', `unix://${socket}`], {
      cwd, env, stdio: 'ignore',
    })
    const restart = async () => {
      await stop(server, 'SIGTERM')
      server = start()
    }
    server = start()
    await until(() => rpc('thread/loaded/list', {}))
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    const argv = [process.execPath, CLI, 'tui', '--socket', socket, '--cwd', cwd, '--brief', brief,
      '--wait-gate', 'psi=off,psifull=off,swapin=off', '--gate-jitter', '0']
    tui = run('script', ['-qefc', 'stty rows 34 cols 140 && exec ' + argv.map(quote).join(' '), '/dev/null'],
      { cwd, env, stdio: ['pipe', 'ignore', 'ignore'] })
    const threadId = await until(async () => {
      const { data } = await rpc('thread/loaded/list', {})
      for (const id of data) {
        const { thread } = await rpc('thread/read', { threadId: id })
        if (thread.preview?.startsWith('[clodeks launch ') && thread.status?.type === 'idle') return id
      }
      return null
    })
    let now = 1000
    const check = () => recycleIfIdle({ socket, env, minLoaded: 1 }, {
      clock: () => now,
      readService: () => ({ generation: socketIdentity(socket), peerPid: server.child.pid }),
      readBackgroundProcesses: () => ({ background: [], allowed: {} }),
      restart,
    })
    const observations = []
    let recycled = false
    for (let sample = 0; sample < 12; sample++) {
      const result = await check()
      observations.push(result)
      if (result.outcome === 'recycled') {
        recycled = true
        break
      }
      const retryable = ['quiet-period', 'activity-changed', 'delivery-activity', 'working-threads']
      assert.ok(retryable.includes(result.reason), JSON.stringify(observations))
      now += 5 * MINUTE
      await sleep(300)
    }
    assert.ok(recycled, JSON.stringify(observations))
    await until(async () => (await rpc('thread/loaded/list', {})).data.includes(threadId))
    assert.equal(tui.child.exitCode, null)
    const send = run(process.execPath, [CLI, 'send', '--socket', socket, '--raw', threadId, 'Fixture after recycle.'],
      { cwd, env, stdio: 'ignore' })
    assert.equal((await send.exited).code, 0)
    await until(async () => {
      const { data } = await rpc('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'full' })
      return data.some(turn => turn.status === 'completed' && JSON.stringify(turn).includes('Fixture after recycle.'))
    })

    // Park input on a stored thread so the native server does not dispatch it.
    await stop(tui, 'SIGHUP')
    tui = undefined
    await restart()
    const stored = () => until(async () => {
      const { thread } = await rpc('thread/read', { threadId, includeTurns: false })
      return thread.status?.type === 'notLoaded'
    })
    await stored()
    const text = 'Private stored queue after restart.'
    const { queuedSubmission } = await rpc('thread/queue/add', {
      threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: randomUUID(),
    })
    const observedQueue = () => rpc('thread/queue/list', { threadId, limit: 10 })
    assert.deepEqual((await observedQueue()).data.map(item => item.id), [queuedSubmission.id])
    const durable = await readDurableQueue({ peerPid: server.child.pid }, { env })
    assert.equal(durable.pending_count, 1)
    assert.equal(durable.entries[0].submission_id, queuedSubmission.id)
    assert.equal(durable.entries[0].thread_id, threadId)
    await restart()
    await stored()
    assert.deepEqual((await observedQueue()).data.map(item => item.id), [queuedSubmission.id])
    t.diagnostic(`Stored queue retained submission ${queuedSubmission.id} across the private restart.`)
    const queueCli = args => exec(process.execPath, [CLI, 'queue', ...args, '--socket', socket], { cwd, env, timeout: 5000 })
    const { stdout: listing } = await queueCli(['list', threadId, '--show-text'])
    const [item] = JSON.parse(listing).entries
    assert.equal(item.submission_id, queuedSubmission.id)
    assert.ok(Number.isInteger(item.age_seconds) && item.age_seconds >= 0)
    assert.equal(item.preview, text)
    const { stderr } = await queueCli(['clear', threadId, '--id', queuedSubmission.id])
    assert.ok(stderr.includes(queuedSubmission.id))
    assert.deepEqual((await observedQueue()).data, [])
  } finally {
    const stopped = Promise.allSettled([
      tui && stop(tui, 'SIGHUP'),
      server && stop(server, 'SIGTERM'),
    ])
    model.closeAllConnections()
    await new Promise(resolve => model.close(resolve))
    for (const result of await stopped) if (result.status === 'rejected') throw result.reason
  }
})
