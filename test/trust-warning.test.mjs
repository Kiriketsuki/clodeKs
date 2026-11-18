import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const BRIEF = fileURLToPath(new URL('./fixtures/tui-brief.md', import.meta.url))
const WARNING = 'cwd is not trusted, the Codex trust dialog will wait for a key press, add --trust for an unattended launch'

async function setup(t, config = { config: {}, layers: [] }) {
  const env = testEnv()
  const cwd = join(env.XDG_RUNTIME_DIR, 'selected worktree')
  const codex = join(env.XDG_RUNTIME_DIR, 'capture.mjs')
  mkdirSync(cwd)
  writeFileSync(codex, `#!/usr/bin/env node
process.stderr.write('TUI started\\n')
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n')
`, { mode: 0o700 })
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'config/read') {
      if (config instanceof Error) throw config
      return typeof config === 'function' ? config(cwd) : config
    }
    if (request.method === 'thread/loaded/list') return { data: [] }
    return {}
  })
  t.after(server.close)
  return { env: { ...env, CLODEKS_CODEX_BIN: codex }, cwd, socket, server }
}

async function launch(state, args = ['--brief', BRIEF]) {
  const child = spawn(process.execPath, [CLI, 'tui', '--socket', state.socket,
    '--cwd', state.cwd, ...args], {
    cwd: state.env.XDG_RUNTIME_DIR, env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, stdout, stderr }
}

test('tui trust warning: an undecided selected cwd warns once before the child starts', async t => {
  const state = await setup(t)
  const result = await launch(state)
  assert.equal(result.code, 0, result.stderr)
  const warnings = result.stderr.split('\n').filter(line => line.includes(WARNING))
  assert.equal(warnings.length, 1, result.stderr)
  assert.ok(result.stderr.indexOf(WARNING) < result.stderr.indexOf('TUI started'))
  const reads = state.server.requests.filter(request => request.method === 'config/read')
  assert.equal(reads.length, 1)
  assert.equal(reads[0].params.cwd, state.cwd)
  assert.equal(reads[0].params.includeLayers, true)
  assert.equal(state.server.requests.some(request => request.method === 'config/batchWrite'), false)
})

test('tui trust warning: saved trust decisions and enabled project layers do not warn', async t => {
  for (const config of [
    cwd => ({ config: { projects: { [cwd]: { trust_level: 'trusted' } } }, layers: [] }),
    cwd => ({ config: { projects: { [cwd]: { trust_level: 'untrusted' } } }, layers: [] }),
    cwd => ({ config: {}, layers: [{ name: { type: 'project', dotCodexFolder: join(cwd, '.codex') } }] }),
  ]) {
    const state = await setup(t, config)
    const result = await launch(state)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr.includes(WARNING), false, result.stderr)
    assert.equal(state.server.requests.some(request => request.method === 'config/batchWrite'), false)
  }
})

test('tui trust warning: explicit trust and non-brief launches need no trust read', async t => {
  for (const args of [['--trust', '--brief', BRIEF], []]) {
    const state = await setup(t)
    const result = await launch(state, args)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr.includes(WARNING), false, result.stderr)
    assert.equal(state.server.requests.some(request => request.method === 'config/read'), false)
  }
})

test('tui trust warning: a failed read reports unknown trust and still starts the child', async t => {
  const state = await setup(t, new Error('test read refused'))
  const result = await launch(state)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr.includes(WARNING), false, result.stderr)
  assert.match(result.stderr, /cannot check cwd trust/)
  assert.ok(result.stderr.indexOf('cannot check cwd trust') < result.stderr.indexOf('TUI started'))
})

test('tui trust warning: disabled project metadata selects the saved repository decision', async t => {
  for (const level of ['trusted', 'untrusted']) {
    for (const withReason of [true, false]) {
      const state = await setup(t, () => ({
        config: { projects: { '/repo': { trust_level: level } } },
        layers: [{ name: { type: 'project', dotCodexFolder: '/repo/.codex' },
          disabledReason: withReason ? `Project config is disabled, add /repo as a trusted project in config.toml` : '' }],
      }))
      const result = await launch(state)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr.includes(WARNING), false, result.stderr)
    }
  }
})

test('tui trust warning: exact cwd decisions take priority over disabled ancestor metadata', async t => {
  const state = await setup(t, cwd => ({
    config: { projects: { [cwd]: { trust_level: 'trusted' }, '/repo': { trust_level: 'untrusted' } } },
    layers: [{ name: { type: 'project', dotCodexFolder: '/repo/.codex' },
      disabledReason: '/repo is marked as untrusted' }],
  }))
  const result = await launch(state)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr.includes(WARNING), false, result.stderr)
})

test('tui trust warning: disabled project layers still need a decision despite an enabled layer', async t => {
  const state = await setup(t, cwd => ({
    config: {}, layers: [
      { name: { type: 'project', dotCodexFolder: '/repo/.codex' } },
      { name: { type: 'project', dotCodexFolder: join(cwd, '.codex') }, disabledReason: 'trust required' },
    ],
  }))
  const result = await launch(state)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr.split('\n').filter(line => line.includes(WARNING)).length, 1)
})

test('tui trust warning: inherited untrust errors do not claim that a dialog will wait', async t => {
  const state = await setup(t, cwd => ({
    config: { projects: { [cwd.slice(0, cwd.lastIndexOf('/'))]: { trust_level: 'untrusted' } } }, layers: [],
  }))
  const result = await launch(state)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr.includes(WARNING), false, result.stderr)
})

test('tui trust warning: malformed config stays unknown without exposing response contents', async t => {
  for (const response of [{}, { config: {}, layers: 'private data' },
    { config: {}, layers: [{ name: { type: 'project' }, disabledReason: null }] },
    { config: { projects: { '/repo': { trust_level: 'private data' } } }, layers: [] }]) {
    const state = await setup(t, response)
    const result = await launch(state)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /cannot check cwd trust/)
    assert.equal(result.stderr.includes(WARNING), false, result.stderr)
    assert.equal(result.stderr.includes('private data'), false, result.stderr)
  }
})

test('tui trust warning: an unanswered read has a deadline before the child starts', async t => {
  const state = await setup(t, () => new Promise(() => {}))
  const result = await launch(state)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /cannot check cwd trust/)
  assert.equal(result.stderr.includes(WARNING), false, result.stderr)
  assert.ok(result.stderr.indexOf('cannot check cwd trust') < result.stderr.indexOf('TUI started'))
})
