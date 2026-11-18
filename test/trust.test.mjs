import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))

async function launch(env, socket, cwd, args) {
  const child = spawn(process.execPath, [CLI, 'tui', '--socket', socket, ...args], {
    env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr }
}

test('tui trust: explicit trust records only the exact folder before a brief launch', async t => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const cwd = join(env.XDG_RUNTIME_DIR, 'folder.with "quotes"')
  mkdirSync(cwd)
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => request.method === 'thread/loaded/list' ? { data: [] } : {})
  t.after(server.close)
  const result = await launch(env, socket, cwd, ['--trust', '--brief', BRIEF])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(server.requests.map(r => r.method), ['initialize', 'config/batchWrite', 'initialize', 'thread/loaded/list'])
  assert.deepEqual(server.requests[1].params, {
    edits: [{ keyPath: `projects.${JSON.stringify(cwd)}.trust_level`, value: 'trusted', mergeStrategy: 'replace' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  })
  const args = JSON.parse(result.stdout)
  assert.deepEqual(args.slice(0, 4), ['--remote', `unix://${socket}`, '-C', cwd])
  assert.ok(!args.includes('--trust'))
})

test('tui trust: ordinary launches do not change server trust', async t => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, () => ({}))
  t.after(server.close)
  const result = await launch(env, socket, env.XDG_RUNTIME_DIR, [])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(server.requests, [])
})

test('tui trust: a refused trust write prevents the TUI launch', async t => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'config/batchWrite') throw new Error('test trust write refused')
    return {}
  })
  t.after(server.close)
  const result = await launch(env, socket, env.XDG_RUNTIME_DIR, ['--trust'])
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /config\/batchWrite: test trust write refused/)
})

test('tui trust: forwarded subcommands cannot trust the wrong folder', async t => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, () => ({}))
  t.after(server.close)
  const result = await launch(env, socket, env.XDG_RUNTIME_DIR, ['--trust', '--', 'resume', 'stored-thread'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--trust is only supported for a new TUI session/)
  assert.deepEqual(server.requests, [])
})
