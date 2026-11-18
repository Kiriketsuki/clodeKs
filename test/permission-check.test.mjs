import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyNamedPermissions } from '../lib/permission-check.mjs'
import { runExec } from '../lib/exec.mjs'
import { testEnv } from './helpers/env.mjs'

const fixture = fileURLToPath(new URL('./fixtures/permission-check-codex.mjs', import.meta.url))
function probeEnv(modes, stderr = '') {
  const env = testEnv({ CLODEKS_CODEX_BIN: fixture, FAKE_PERMISSION_MODES: JSON.stringify(modes),
    FAKE_PERMISSION_STDERR: stderr })
  return { ...env, FAKE_PERMISSION_RECORD: join(env.XDG_RUNTIME_DIR, 'attempts') }
}
const check = env => verifyNamedPermissions(env.CLODEKS_CODEX_BIN, env.XDG_RUNTIME_DIR, [], env, 'Private temporary folder')
const attempts = env => Number(readFileSync(env.FAKE_PERMISSION_RECORD, 'utf8'))

for (const [mode, reason, count] of [
  ['timeout', /timeout/, 2], ['exit', /exit code 23/, 2], ['signal', /signal SIGTERM/, 1],
  ['malformed', /protocol error/, 1], ['missing', /protocol error/, 1], ['rpc', /RPC error/, 1],
]) {
  test(`permission check: ${mode} reports its cause and limits attempts`, { timeout: 14000 }, async () => {
    const env = probeEnv([mode], '\u001b[31mresource temporarily unavailable\u001b[0m\n')
    const started = performance.now()
    await assert.rejects(check(env), error => {
      assert.match(error.message, reason)
      assert.match(error.message, /stderr.*resource temporarily unavailable/)
      assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}]/u)
      assert.doesNotMatch(error.message, /private account data/)
      return true
    })
    assert.equal(attempts(env), count)
    assert.ok(performance.now() - started < 11000, 'the private probe has one total budget')
  })
}

test('permission check: spawn failure reports only the safe error code', async () => {
  const env = probeEnv(['ok'])
  const script = join(env.XDG_RUNTIME_DIR, 'codex')
  writeFileSync(script, '#!/bin/sh\nchmod 600 "$0"\nprintf "codex-cli 0.169.0\\n"\n', { mode: 0o700 })
  await assert.rejects(check({ ...env, CLODEKS_CODEX_BIN: script }), /spawn error EACCES/)
})

for (const mode of ['timeout', 'exit']) {
  test(`permission check: one ${mode} can recover on the second attempt`, { timeout: 14000 }, async () => {
    const env = probeEnv([mode, 'ok'])
    assert.deepEqual(await check(env), { requirements: null, config: { sandbox_workspace_write: null } })
    assert.equal(attempts(env), 2)
  })
}

test('permission check: stderr tail excludes secrets, account data, and control characters', async () => {
  const privateData = 'sk-test-secret ghp_private_token user@example.invalid account_id=acct-private /home/private-user token=opaque-value'
  const env = probeEnv(['exit'], 'prefix '.repeat(3000) + privateData + '\u001b]0;private title\u0007\u202e\nresource temporarily unavailable (os error 11)\n')
  await assert.rejects(check(env), error => {
    assert.match(error.message, /stderr.*resource temporarily unavailable/)
    assert.ok(error.message.length < 500)
    for (const word of privateData.split(' ')) assert.equal(error.message.includes(word), false)
    assert.doesNotMatch(error.message, /private title|[\p{Cc}\p{Cf}]/u)
    return true
  })
})

test('permission check: exhausted retries preserve plain read-only fallback without a private temp folder', async () => {
  const env = probeEnv(['exit'])
  const result = await runExec({ prompt: 'Review only.', cwd: env.XDG_RUNTIME_DIR, sandbox: 'read-only', timeoutMs: 5000 }, env)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.temp_folder_unavailable, /exit code 23/)
  const seen = JSON.parse(result.text)
  assert.equal(seen.privateTempExists, false)
  assert.equal(seen.args.some(arg => /default_permissions|permissions\./.test(arg)), false)
  assert.ok(seen.args.includes('read-only'))
  assert.equal(attempts(env), 2)
})
