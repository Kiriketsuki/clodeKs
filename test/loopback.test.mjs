import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildExecArgs, runExec } from '../lib/exec.mjs'
import { testEnv } from './helpers/env.mjs'
import { buildRunPrompt } from '../lib/run-context.mjs'
import { validateIsolatedLoopback } from '../lib/loopback.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CODEX = fileURLToPath(new URL('./fixtures/loopback-codex.mjs', import.meta.url))
const options = { prompt: 'Run local socket tests.', sandbox: 'workspace-write', loopbackIsolated: true, timeoutMs: 10000 }

test('isolated loopback: named permissions preserve the write scope without enabling unrestricted networking', () => {
  const args = buildExecArgs({ ...options, cwd: '/work', loopbackProfile: 'isolated_test',
    outboxDir: '/outbox', gitDirs: ['/git'], addDirs: ['/extra "quoted"'] })
  assert.ok(args.includes('default_permissions="isolated_test"'))
  assert.ok(args.some(arg => arg.includes('extends=":workspace"')))
  assert.ok(args.some(arg => arg.includes('"/outbox"=true') && arg.includes('"/git"=true') && arg.includes('"/extra \\"quoted\\""=true')))
  assert.ok(args.some(arg => arg.includes('domains={}') && arg.includes('allow_local_binding=true')))
  assert.ok(args.includes('features.network_proxy=true'))
  assert.equal(args.includes('-s'), false)
  assert.equal(args.some(arg => arg.startsWith('sandbox_mode=') || arg.includes('network_access=true')), false)
  assert.ok(args.includes('approval_policy="never"'))
})

test('isolated loopback: read-only and resumed runs keep their permission scope', () => {
  const args = buildExecArgs({ ...options, sandbox: 'read-only', cwd: '/work', resume: 'stored', loopbackProfile: 'isolated_test' })
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'stored'])
  assert.ok(args.some(arg => arg.includes('extends=":read-only"')))
  assert.equal(args.includes('-C'), false)
  assert.equal(args.some(arg => arg.startsWith('sandbox_mode=')), false)
})

test('isolated loopback: normal runs retain their existing arguments', () => {
  const args = buildExecArgs({ cwd: '/work', sandbox: 'workspace-write' })
  assert.ok(args.includes('-s'))
  assert.equal(args.some(arg => /default_permissions|network_proxy|permissions\./.test(arg)), false)
})

test('isolated loopback: the CLI accepts the flag and checks the backend before a run', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
  env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
  env.FAKE_CHECK_RECORD = join(env.XDG_RUNTIME_DIR, 'check.json')
  const result = spawnSync(process.execPath, [CLI, 'run', '--cwd', env.XDG_RUNTIME_DIR,
    '--write', '--loopback-isolated', '--prompt', 'test'], { env, encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true)
  const args = JSON.parse(readFileSync(env.FAKE_EXEC_RECORD, 'utf8'))
  assert.ok(args.some(arg => /^default_permissions="clodeks_loopback_/.test(arg)))
  const checked = JSON.parse(readFileSync(env.FAKE_CHECK_RECORD, 'utf8'))
  assert.equal(checked.cwd, env.XDG_RUNTIME_DIR)
  assert.ok(checked.args.includes(args.find(arg => arg.startsWith('default_permissions='))))
})

test('isolated loopback: managed or unknown requirements stop before model execution', async () => {
  for (const response of [{ requirements: {} }, { requirements: { network: {} } }, {}, { requirements: false }]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, FAKE_REQUIREMENTS_RESPONSE: JSON.stringify(response) })
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /loopback-isolated.*(?:managed|verify)/)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
  }
})

test('isolated loopback: unsupported backends and unrestricted sandbox combinations fail closed', async () => {
  for (const version of ['0.168.0', '0.170.0']) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, FAKE_CODEX_VERSION: version })
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /loopback-isolated.*0\.169/)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
  }
  assert.throws(() => buildExecArgs({ ...options, sandbox: 'danger-full-access' }), /loopback-isolated/)
  assert.throws(() => validateIsolatedLoopback('workspace-write', 'darwin'), /requires Linux/)
})

test('isolated loopback: backend errors and malformed replies never start the model or expose response data', async () => {
  for (const mode of ['malformed', 'error']) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, FAKE_SERVER_MODE: mode })
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /cannot verify/)
    assert.equal(result.error.includes('private response data'), false)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
  }
})

test('isolated loopback: a silent requirements server fails within its deadline', { timeout: 10000 }, async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, FAKE_SERVER_MODE: 'hang' })
  env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
  const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
  assert.equal(result.ok, false)
  assert.match(result.error, /cannot verify/)
  assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
})

test('isolated loopback: the worker learns that servers and clients need one command tree', () => {
  const prompt = buildRunPrompt({ ...options, prompt: 'caller text' })
  assert.match(prompt, /private network namespace/)
  assert.match(prompt, /same command process tree/)
  assert.ok(prompt.endsWith('caller text'))
})

test('isolated loopback: custom workspace filesystem settings never gain or lose write scope', async () => {
  for (const settings of [
    { writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: false },
    { writable_roots: [], exclude_slash_tmp: false, exclude_tmpdir_env_var: true },
    { writable_roots: ['/extra-configured-root'], exclude_slash_tmp: false, exclude_tmpdir_env_var: false },
  ]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX,
      FAKE_CONFIG_RESPONSE: JSON.stringify({ config: { sandbox_workspace_write: settings } }) })
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /loopback-isolated.*filesystem/)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
  }
})

test('isolated loopback: refused verification never fetches Git refs', async () => {
  for (const refusal of [
    { FAKE_CODEX_VERSION: '0.170.0' },
    { FAKE_REQUIREMENTS_RESPONSE: JSON.stringify({ requirements: {} }) },
    { FAKE_CONFIG_RESPONSE: JSON.stringify({ config: { sandbox_workspace_write: {
      writable_roots: ['/configured'], exclude_slash_tmp: false, exclude_tmpdir_env_var: false,
    } } }) },
  ]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, ...refusal })
    const bin = join(env.XDG_RUNTIME_DIR, 'bin')
    mkdirSync(bin)
    env.FAKE_GIT_FETCH_RECORD = join(env.XDG_RUNTIME_DIR, 'fetch.txt')
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args.includes('fetch')) writeFileSync(process.env.FAKE_GIT_FETCH_RECORD, 'fetch')
else if (args.includes('--absolute-git-dir') || args.includes('--git-common-dir')) console.log(process.env.XDG_RUNTIME_DIR)
else if (args.includes('symbolic-ref')) console.log('test')
else if (args.includes('rev-parse')) console.log('abc123')
`, { mode: 0o755 })
    env.PATH = `${bin}:${env.PATH}`
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR, git: true }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /loopback-isolated/)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
    assert.equal(existsSync(env.FAKE_GIT_FETCH_RECORD), false, 'verification must precede fetch')
  }
})
