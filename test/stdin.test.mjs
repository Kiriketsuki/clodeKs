import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const MESSAGE = readFileSync(new URL('./fixtures/item4-message.txt', import.meta.url))
const ID = '01a11f22-ed3b-7b43-9b60-da49f9ae330c'

function launch(args, env, chunks, { delay = 150, close = true, gap = 0, timeout = 8000 } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], timeout })
  child.stdin.on('error', () => {})
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const writers = chunks.map((chunk, index) => setTimeout(() => {
    child.stdin.write(chunk)
    if (close && index === chunks.length - 1) child.stdin.end()
  }, delay + index * gap))
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      for (const writer of writers) clearTimeout(writer)
      child.stdin.destroy()
      resolve({ code, stdout, stderr })
    })
  })
}

async function queue(t) {
  const env = testEnv()
  const capture = join(env.XDG_RUNTIME_DIR, 'capture.mjs')
  env.CLODEKS_CAPTURE = join(env.XDG_RUNTIME_DIR, 'args.json')
  writeFileSync(capture, '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"\nwriteFileSync(process.env.CLODEKS_CAPTURE,JSON.stringify(process.argv.slice(2)))\nconsole.log("queued")\n', { mode: 0o700 })
  env.CLODEKS_CODEX_BIN = capture
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const thread = { id: ID, cwd: '/work', status: { type: 'idle' }, ephemeral: false }
  const server = await fakeAppServer(socket, ({ method }) => {
    if (method === 'thread/loaded/list') return { data: [ID] }
    if (method === 'thread/list') return { data: [thread] }
    if (method === 'thread/read') return { thread }
    return {}
  })
  t.after(server.close)
  return { env, socket, server }
}

for (const delay of [0, 150]) test(`stdin: exact 771 caller bytes survive the default queue path after ${delay} ms`, async t => {
  const state = await queue(t)
  assert.equal(MESSAGE.length, 771)
  const result = await launch(['send', '--socket', state.socket, '--', 'codex-f9ae330c'], state.env, [MESSAGE], { delay })
  assert.equal(result.code, 0, result.stderr)
  const args = JSON.parse(readFileSync(state.env.CLODEKS_CAPTURE, 'utf8'))
  assert.equal(args[0], 'queue')
  assert.equal(args.at(-2), '--message')
  const delivered = args.at(-1)
  const begin = '----- BEGIN PEER MESSAGE -----\n'
  const end = '\n----- END PEER MESSAGE -----'
  const body = delivered.slice(delivered.indexOf(begin) + begin.length, delivered.lastIndexOf(end))
  assert.deepEqual(Buffer.from(body), MESSAGE)
  assert.equal(JSON.parse(result.stdout).delivery, 'queued')
})

test('stdin: fragmented Unicode, backticks, parentheses, and numbered text retain their bytes', async t => {
  const state = await queue(t)
  const bytes = Buffer.from('1. (`résumé`) 🧪\n2. Keep $HOME literal.\n')
  const result = await launch(['send', '--socket', state.socket, '--raw', '--', ID], state.env,
    [...bytes].map(byte => Buffer.from([byte])))
  assert.equal(result.code, 0, result.stderr)
  const args = JSON.parse(readFileSync(state.env.CLODEKS_CAPTURE, 'utf8'))
  assert.deepEqual(Buffer.from(args.at(-1)), bytes)
})

test('stdin: delayed empty input remains an empty-message refusal before discovery', async t => {
  const state = await queue(t)
  const result = await launch(['send', '--socket', state.socket, '--', ID], state.env, [' \n'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /empty message/)
  assert.equal(state.server.requests.length, 0)
})

test('stdin: an open pipe has a bounded clear timeout and cannot queue partial input', { timeout: 9000 }, async t => {
  const state = await queue(t)
  const result = await launch(['send', '--socket', state.socket, '--', ID], state.env, [MESSAGE], { close: false })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /standard input idle timeout after 5000 ms/)
  assert.match(result.stderr, /Pass the message as an argument or close standard input/)
  assert.doesNotMatch(result.stderr, /\n\s+at /)
  assert.doesNotMatch(result.stderr, /empty message/)
  assert.equal(state.server.requests.length, 0)
})

test('stdin: delayed run prompts reach the private fixture unchanged', async () => {
  const env = testEnv({
    CLODEKS_CODEX_BIN: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    FAKE_MODE: 'capture-prompt',
  })
  env.FAKE_PROMPT_RECORD = join(env.XDG_RUNTIME_DIR, 'prompt.txt')
  const result = await launch(['run', '--cwd', env.XDG_RUNTIME_DIR], env, [MESSAGE])
  assert.equal(result.code, 0, result.stderr)
  const prompt = readFileSync(env.FAKE_PROMPT_RECORD)
  assert.deepEqual(prompt.subarray(-MESSAGE.length), MESSAGE)
})

test('stdin: TTY input returns without waiting for EOF', async () => {
  const { readStdin } = await import('../lib/stdin.mjs')
  const input = new Readable({ read() { throw new Error('a TTY must not be read') } })
  input.isTTY = true
  assert.equal(await readStdin(input, { timeoutMs: 20 }), '')
})

test('stdin: read errors keep their real cause instead of becoming empty input', async () => {
  const { readStdin } = await import('../lib/stdin.mjs')
  const input = new Readable({ read() { this.destroy(Object.assign(new Error('fixture failure'), { code: 'EIO' })) } })
  await assert.rejects(readStdin(input), /cannot read standard input: EIO/)
})

test('stdin: delayed Claude replies keep the caller bytes in the private relay outbox', async () => {
  const env = testEnv()
  env.CLODEKS_OUTBOX = join(env.XDG_RUNTIME_DIR, 'outbox.ndjson')
  const result = await launch(['claude-send', '--to', 'self'], env, [MESSAGE])
  assert.equal(result.code, 0, result.stderr)
  const frame = JSON.parse(readFileSync(env.CLODEKS_OUTBOX, 'utf8'))
  assert.deepEqual(Buffer.from(frame.body), MESSAGE)
})

test('stdin: UTF-8 sequences split across stream chunks decode once at EOF', async () => {
  const { readStdin } = await import('../lib/stdin.mjs')
  const text = 'résumé 🧪 `code`'
  const bytes = Buffer.from(text)
  const chunks = [...bytes].map(byte => Buffer.from([byte]))
  assert.equal(await readStdin(Readable.from(chunks)), text)
})


test('stdin: a producer can write every two seconds for eight seconds', { timeout: 14000 }, async () => {
  const env = testEnv()
  env.CLODEKS_OUTBOX = join(env.XDG_RUNTIME_DIR, 'outbox.ndjson')
  const chunks = ['first ', 'second ', 'third ', 'fourth ', 'last']
  const result = await launch(['claude-send', '--to', 'self'], env, chunks,
    { delay: 0, gap: 2000, timeout: 12000 })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(env.CLODEKS_OUTBOX, 'utf8')).body, chunks.join(''))
})

async function redirect(args, env, path) {
  const fd = openSync(path, 'r')
  let child
  try {
    child = spawn(process.execPath, [CLI, ...args], { env, stdio: [fd, 'pipe', 'pipe'], timeout: 8000 })
  } finally {
    closeSync(fd)
  }
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

test('stdin: /dev/null returns an empty-message usage error without waiting', async t => {
  const state = await queue(t)
  const result = await redirect(['send', '--socket', state.socket, '--', ID], state.env, '/dev/null')
  assert.equal(result.code, 2)
  assert.match(result.stderr, /empty message/)
  assert.doesNotMatch(result.stderr, /timeout|\n\s+at /)
  assert.equal(state.server.requests.length, 0)
})

test('stdin: a file redirect preserves the exact caller bytes', async () => {
  const env = testEnv()
  env.CLODEKS_OUTBOX = join(env.XDG_RUNTIME_DIR, 'outbox.ndjson')
  const result = await redirect(['claude-send', '--to', 'self'], env,
    fileURLToPath(new URL('./fixtures/item4-message.txt', import.meta.url)))
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(Buffer.from(JSON.parse(readFileSync(env.CLODEKS_OUTBOX, 'utf8')).body), MESSAGE)
})

test('stdin: the first-byte wait stays bounded and carries a usage hint', { timeout: 1000 }, async () => {
  const { readStdin } = await import('../lib/stdin.mjs')
  const input = new Readable({ read() {} })
  await assert.rejects(readStdin(input, { timeoutMs: 20 }), error => {
    assert.equal(error.code, 'STDIN_TIMEOUT')
    assert.match(error.message, /Pass the message as an argument or close standard input/)
    return true
  })
})
