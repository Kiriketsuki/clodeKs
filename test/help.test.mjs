import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseFrame } from '../lib/peers.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CAPTURE = fileURLToPath(new URL('./fixtures/capture-tui.mjs', import.meta.url))
const COMMANDS = ['run', 'serve', 'tui', 'threads', 'recycle', 'jobs', 'pending', 'quota', 'send', 'inbox', 'inboxd',
  'expose', 'unexpose', 'peers', 'claude-send', 'status', 'doctor']

function launch(env, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env, encoding: 'utf8', timeout: 5000, input: '',
  })
  assert.ifError(result.error)
  return result
}

function assertHelp(result, command) {
  const section = command === 'unexpose' ? 'expose' : command
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, new RegExp(`^  clodeks ${section}\\b`))
  assert.match(result.stdout, /-h, --help/)
  const headers = [...result.stdout.matchAll(/^  clodeks ([a-z-]+)/gm)].map(match => match[1])
  assert.deepEqual(headers, [section])
}

test('help: every wrapper subcommand supports both flags without runtime state', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  for (const command of COMMANDS) {
    for (const flag of ['-h', '--help']) assertHelp(launch(env, [command, flag]), command)
  }
  assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'clodeks')), false)
})

test('help: parsed help precedes effectful option handling and input validation', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  for (const args of [
    ['tui', '--trust', '--permissions', 'invalid', '--brief', '/missing/brief.md', '--help'],
    ['run', '--write', '--git', '--add-dir', '/missing/output', '--help'],
    ['inboxd', '--all', '--help'],
    ['status', '--band', '-h'],
  ]) assertHelp(launch(env, args), args[0])
  assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'clodeks')), false)
})

test('help: doctor help prints usage instead of running diagnostics', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const result = launch(env, ['doctor', '--help'])
  assertHelp(result, 'doctor')
  assert.doesNotMatch(result.stdout, /ok  |FAIL|live session/)
})

test('help: raw TUI help stays a native argument after the separator', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const result = launch(env, ['tui', '--socket', CAPTURE, '--', '--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).at(-1), '--help')
})

test('help: a help-looking message value remains message data', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'parent.sock')
  let accept
  const received = new Promise(resolve => { accept = resolve })
  const server = createServer(conn => {
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('data', chunk => { buffer += chunk })
    conn.on('end', () => { accept(parseFrame(buffer.trim())) })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const child = spawn(process.execPath, [CLI, 'claude-send', '--to', `uds:${socket}`, '--message=--help'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, stderr)
  assert.equal((await received).body, '--help')
})

test('help: top-level forms keep the complete command overview', () => {
  const env = testEnv()
  for (const args of [[], ['-h'], ['--help'], ['help']]) {
    const result = launch(env, args)
    assert.equal(result.status, 0, result.stderr)
    for (const command of ['run', 'tui', 'claude-send', 'doctor']) assert.ok(result.stdout.includes(`clodeks ${command}`))
  }
})

test('help: command usage lists the supported routing and polling options', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const expected = {
    threads: ['--socket', '--limit'], recycle: ['--if-idle', '--dry-run', '--min-loaded'], quota: ['--socket'], send: ['--socket'], inbox: ['--socket'],
    inboxd: ['--socket', '--interval'], expose: ['--socket'], unexpose: ['--socket'],
    'claude-send': ['--socket'],
  }
  for (const [command, flags] of Object.entries(expected)) {
    const result = launch(env, [command, '--help'])
    assertHelp(result, command)
    for (const flag of flags) assert.ok(result.stdout.includes(flag), `${command} help lacks ${flag}`)
  }
})

test('help: unattended brief guidance keeps folder trust explicit', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CAPTURE })
  const result = launch(env, ['tui', '--help'])
  assertHelp(result, 'tui')
  assert.match(result.stdout, /--brief does not skip the folder trust prompt/)
  assert.match(result.stdout, /For an unattended launch in a folder you trust:/)
  assert.match(result.stdout, /clodeks tui --cwd DIR --trust --brief FILE/)
  assert.match(result.stdout, /--trust persists trust for the selected workspace/)
  assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'clodeks')), false)
})
