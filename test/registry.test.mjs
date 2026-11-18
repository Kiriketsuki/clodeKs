import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { claudeConfigDirs } from '../lib/paths.mjs'
import { listClaudeSessions, resolveClaudeTarget } from '../lib/peers.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))

function setup() {
  const env = testEnv()
  const homePath = join(env.XDG_RUNTIME_DIR, 'home')
  mkdirSync(homePath)
  return { env: { ...env, HOME: homePath, CLAUDE_CONFIG_DIR: join(homePath, '.claude') }, homePath }
}

function registry(dir, name = 'orch-main', socket = '/test/main.sock') {
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({
    name, sessionId: name, pid: process.pid, cwd: '/test', messagingSocketPath: socket,
  }))
}

async function peersCli(env, args = []) {
  const child = spawn(process.execPath, [CLI, 'peers', ...args], {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, stderr)
  return stdout
}

test('registries: default discovery finds a second-account session by name', () => {
  const { env, homePath } = setup()
  registry(join(homePath, '.claude-work'))
  assert.equal(listClaudeSessions(env)[0]?.name, 'orch-main')
  assert.equal(resolveClaudeTarget('orch-main', env).socket, '/test/main.sock')
})

test('registries: active, default, discovered, and extra folders all remain available', () => {
  const { env, homePath } = setup()
  const active = join(homePath, 'active-config')
  const extra = join(homePath, 'outside-config')
  const standard = join(homePath, '.claude')
  const account = join(homePath, '.claude-hub-work')
  registry(account)
  registry(join(homePath, 'unrelated-folder'))
  mkdirSync(join(homePath, '.claude-empty'))
  const folders = claudeConfigDirs({ ...env, CLAUDE_CONFIG_DIR: active,
    CLODEKS_EXTRA_CLAUDE_DIRS: [extra, active].join(delimiter) })
  assert.deepEqual(new Set(folders), new Set([active, standard, account, extra]))
  assert.equal(folders.length, 4)
})

test('registries: shared session folders do not create false name ambiguity', () => {
  const { env, homePath } = setup()
  const standard = join(homePath, '.claude')
  const account = join(homePath, '.claude-hub-personal')
  registry(standard)
  mkdirSync(account)
  symlinkSync(join(standard, 'sessions'), join(account, 'sessions'), 'dir')
  assert.equal(listClaudeSessions({ ...env, CLAUDE_CONFIG_DIR: account }).length, 1)
  assert.equal(resolveClaudeTarget('orch-main', { ...env, CLAUDE_CONFIG_DIR: account }).socket, '/test/main.sock')
})

test('registries: two distinct live sessions with one name remain ambiguous', () => {
  const { env, homePath } = setup()
  registry(join(homePath, '.claude'))
  registry(join(homePath, '.claude-work'), 'orch-main', '/test/other.sock')
  assert.throws(() => resolveClaudeTarget('orch-main', env), /matches 2 Claude sessions/)
})

test('registries: missing names report searched folders and the extra-folder setting', () => {
  const { env, homePath } = setup()
  registry(join(homePath, '.claude-work'))
  assert.throws(() => resolveClaudeTarget('missing', env), error => {
    assert.match(error.message, /No live Claude session matches/)
    assert.ok(error.message.includes(join(homePath, '.claude-work', 'sessions')))
    assert.ok(error.message.includes(join(homePath, '.claude', 'sessions')))
    assert.match(error.message, /CLODEKS_EXTRA_CLAUDE_DIRS/)
    return true
  })
})

test('registries: CLI JSON keeps its array shape and finds account sessions', async () => {
  const { env, homePath } = setup()
  registry(join(homePath, '.claude-work'))
  const output = JSON.parse(await peersCli(env, ['--json']))
  assert.ok(Array.isArray(output))
  assert.equal(output[0]?.name, 'orch-main')
})

test('registries: CLI diagnostics reports sessions and searched registry folders', async () => {
  const { env, homePath } = setup()
  registry(join(homePath, '.claude-work'))
  const output = JSON.parse(await peersCli(env, ['--json', '--diagnostics']))
  assert.equal(output.sessions[0]?.name, 'orch-main')
  assert.deepEqual(new Set(output.searched_registries), new Set([
    join(homePath, '.claude', 'sessions'), join(homePath, '.claude-work', 'sessions'),
  ]))
})

test('registries: empty text output still lists searched registry folders', async () => {
  const { env, homePath } = setup()
  const output = await peersCli(env)
  assert.match(output, /No live Claude sessions/)
  assert.ok(output.includes(join(homePath, '.claude', 'sessions')))
})


test('registries: ambiguous names list each matching session route', () => {
  const { env, homePath } = setup()
  registry(join(homePath, '.claude'))
  registry(join(homePath, '.claude-work'), 'orch-main', '/test/other.sock')
  assert.throws(() => resolveClaudeTarget('orch-main', env), error => {
    assert.match(error.message, /matches 2 Claude sessions/)
    assert.ok(error.message.includes('/test/main.sock'))
    assert.ok(error.message.includes('/test/other.sock'))
    assert.ok(error.message.includes(`pid ${process.pid}`))
    return true
  })
})
