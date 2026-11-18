import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildExecArgs, runExec } from '../lib/exec.mjs'
import { readonlyTempSettings } from '../lib/readonly-temp.mjs'
import { testEnv } from './helpers/env.mjs'

const fixture = fileURLToPath(new URL('./fixtures/readonly-temp-codex.mjs', import.meta.url))

test('read-only temp: new and resumed concurrent runs receive unique private temporary roots', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: fixture, TMPDIR: '/caller-temp-must-not-be-used' })
  const cwd = join(env.XDG_RUNTIME_DIR, 'repository')
  mkdirSync(cwd)
  const task = 'Review the tree. Preserve `bytes` and $HOME.  \n'
  const results = await Promise.all([undefined, 'stored-thread'].map(resume => runExec({
    prompt: task, cwd, resume, sandbox: 'read-only', timeoutMs: 5000,
  }, env)))
  const paths = []
  for (const result of results) {
    assert.equal(result.ok, true, JSON.stringify(result))
    const seen = JSON.parse(result.text)
    assert.ok(isAbsolute(seen.tmpdir))
    assert.ok(seen.tmpdir.startsWith(join(env.XDG_RUNTIME_DIR, 'clodeks', 'run-')))
    assert.equal(dirname(seen.tmpdir).startsWith(cwd), false)
    assert.equal(seen.mode, 0o700)
    assert.equal(seen.wrote, true)
    assert.equal(seen.privateTempExists, true)
    assert.equal(seen.temp, seen.tmpdir)
    assert.equal(seen.tmp, seen.tmpdir)
    assert.equal(seen.tmpprefix, join(seen.tmpdir, 'zsh'))
    assert.ok(seen.prompt.includes(JSON.stringify(seen.tmpdir)))
    assert.match(seen.prompt, /repository stays read-only/)
    assert.ok(seen.prompt.endsWith('\n\nCaller task\n\n' + task))
    assert.ok(seen.args.includes('approval_policy="never"'))
    assert.equal(seen.args.includes('-s'), false)
    assert.equal(existsSync(dirname(seen.tmpdir)), false)
    paths.push(seen.tmpdir)
  }
  assert.notEqual(paths[0], paths[1])
})

for (const refusal of [
    { FAKE_CODEX_VERSION: '0.170.0' },
    { FAKE_REQUIREMENTS_RESPONSE: JSON.stringify({ requirements: { allowed_permission_profiles: [':workspace'] } }) },
]) {
  test(`read-only temp: ${refusal.FAKE_CODEX_VERSION ? 'version mismatch' : 'managed requirements'} retains the original read-only policy`, async () => {
    for (const resume of [undefined, 'stored-thread']) {
      const env = testEnv({ CLODEKS_CODEX_BIN: fixture, TMPDIR: '/caller-temp', ...refusal })
      const result = await runExec({ prompt: 'Review only.\n', cwd: env.XDG_RUNTIME_DIR,
        sandbox: 'read-only', resume, timeoutMs: 5000 }, env)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(typeof result.temp_folder_unavailable, 'string')
      assert.match(result.temp_folder_unavailable, refusal.FAKE_CODEX_VERSION ? /tested Codex 0\.169\.0/ : /managed requirements/)
      const seen = JSON.parse(result.text)
      assert.equal(seen.tmpdir, '/caller-temp')
      assert.equal(seen.mode, null)
      assert.equal(seen.wrote, false)
      assert.equal(seen.privateTempExists, false)
      assert.equal(seen.args.some(arg => /default_permissions|permissions\.|use_legacy_landlock/.test(arg)), false)
      assert.ok(resume ? seen.args.includes('sandbox_mode="read-only"') : seen.args.includes('read-only'))
      assert.match(seen.prompt, /It grants no writable folders/)
      assert.ok(seen.prompt.includes(result.temp_folder_unavailable))
      assert.ok(seen.prompt.endsWith('\n\nCaller task\n\nReview only.\n'))
    }
  })
}

test('read-only temp: a profile name is mandatory', () => {
  assert.throws(() => readonlyTempSettings({ sandbox: 'read-only', tempDir: '/private/temp' }), /profile name/)
})

test('read-only temp: failed and timed-out workers leave no private temporary folder', async () => {
  for (const mode of ['FAKE_TEMP_FAIL', 'FAKE_TEMP_HANG']) {
    const env = testEnv({ CLODEKS_CODEX_BIN: fixture, [mode]: '1' })
    env.FAKE_TEMP_RECORD = join(env.XDG_RUNTIME_DIR, 'temp-path')
    const result = await runExec({ prompt: 'task', cwd: env.XDG_RUNTIME_DIR, sandbox: 'read-only', timeoutMs: 1000 }, env)
    assert.equal(result.ok, false)
    assert.equal(result.error, mode === 'FAKE_TEMP_FAIL' ? 'codex exited 1' : 'timeout')
    const tempDir = readFileSync(env.FAKE_TEMP_RECORD, 'utf8')
    assert.equal(existsSync(dirname(tempDir)), false)
  }
})

test('read-only temp: only the temporary directory receives a filesystem write entry', () => {
  for (const loopbackIsolated of [false, true]) {
    const args = buildExecArgs({ sandbox: 'read-only', cwd: '/repository', tempDir: '/private/temp',
      permissionProfile: 'temp_test', loopbackProfile: 'temp_test', loopbackIsolated })
    const profile = args.find(arg => arg.startsWith('permissions.temp_test='))
    assert.ok(profile, JSON.stringify(args))
    assert.ok(profile.includes('extends=":read-only"'))
    assert.ok(profile.includes('filesystem={"/private/temp"="write"}'))
    assert.equal(profile.includes('":workspace"'), false)
    assert.equal(args.includes('-s'), false)
    assert.equal(args.some(arg => arg.startsWith('sandbox_workspace_write.writable_roots=')), false)
    if (!loopbackIsolated) assert.equal(args.includes('features.network_proxy=true'), false)
  }
})
