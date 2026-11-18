import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runExec } from '../lib/exec.mjs'
import { nativeExecFixture } from './helpers/native-exec.mjs'
import { isolatedLoopbackSettings, verifyIsolatedLoopback } from '../lib/loopback.mjs'
import { testEnv } from './helpers/env.mjs'

const PROBE = fileURLToPath(new URL('./fixtures/loopback-probe.py', import.meta.url))

async function sandbox(env, args, cwd = env.XDG_RUNTIME_DIR) {
  const child = spawn('codex', ['sandbox', ...args, '--include-managed-config', '-C', cwd,
    '-c', 'features.hooks=false', '--', 'python3', '-I', '-B', PROBE], {
    env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL',
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, stderr)
  return JSON.parse(stdout)
}

// Run explicitly. This probe uses installed Codex, real namespaces, and no model.
test('native isolated loopback: public egress and host services remain blocked', { timeout: 45000 }, async t => {
  const env = testEnv()
  let hostConnections = 0
  const tcp = createServer(client => { hostConnections++; client.end('host') })
  const unix = createServer(client => { hostConnections++; client.end() })
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
  const socket = join(env.XDG_RUNTIME_DIR, 'host.sock')
  await new Promise(resolve => unix.listen(socket, resolve))
  t.after(() => Promise.all([new Promise(resolve => tcp.close(resolve)), new Promise(resolve => unix.close(resolve))]))
  // A positive host-side control proves the listener exists before the namespace probe.
  await new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port: tcp.address().port })
    client.once('error', reject)
    client.on('data', data => { assert.equal(data.toString(), 'host') })
    client.once('close', resolve)
  })
  hostConnections = 0
  const probeEnv = { ...env, CLODEKS_PROBE_HOST_PORT: String(tcp.address().port), CLODEKS_PROBE_HOST_SOCKET: socket }
  const baseline = await sandbox(probeEnv, ['-P', ':workspace'])
  assert.equal(baseline.local_exchange, null)
  assert.ok(Object.values(baseline.binds).every(bound => bound === false))
  assert.equal(baseline.public_tcp.connected, false)

  for (const scope of ['workspace-write', 'read-only']) {
    const profile = `clodeks_loopback_probe_${scope.replaceAll('-', '_')}`
    const settings = isolatedLoopbackSettings({ sandbox: scope }, profile)
    await verifyIsolatedLoopback('codex', env.XDG_RUNTIME_DIR, settings, env)
    const args = ['-P', profile, ...settings.filter(value => !value.startsWith('default_permissions='))
      .flatMap(value => ['-c', value])]
    const result = await sandbox(probeEnv, args)
    assert.equal(result.public_tcp.connected, false)
    assert.equal(result.host_loopback.connected, false)
    assert.equal(result.host_unix_connected, false)
    assert.equal(result.local_exchange, 'isolated')
    assert.ok(Object.values(result.binds).every(bound => bound === true))
    assert.match(result.public_proxy, /^HTTP\/1\.1 403 /)
    assert.match(result.host_proxy, /^HTTP\/1\.1 403 /)
    t.diagnostic(JSON.stringify({ scope, ...result }))
  }
  assert.equal(hostConnections, 0)
  t.diagnostic(JSON.stringify({ scope: 'default', ...baseline }))
})

test('native isolated loopback: custom temp exclusions stop before execution', { timeout: 20000 }, async () => {
  const env = testEnv()
  const cwd = join(env.XDG_RUNTIME_DIR, 'primary')
  mkdirSync(cwd)
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  mkdirSync(outside)
  const excluded = ['sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true']
  const probeEnv = { ...env, CLODEKS_PROBE_SCOPE_ONLY: '1', CLODEKS_PROBE_WRITE_PATH: join(outside, 'excluded.txt') }
  // Named built-in selection ignores legacy exclusions. The production check must reject them.
  const parent = await sandbox(probeEnv, ['-P', ':workspace', ...excluded.flatMap(value => ['-c', value])], cwd)
  assert.equal(parent.writable, true)
  assert.equal(existsSync(probeEnv.CLODEKS_PROBE_WRITE_PATH), true)
  const settings = [...isolatedLoopbackSettings({ sandbox: 'workspace-write' }, 'clodeks_scope_check'), ...excluded]
  await assert.rejects(verifyIsolatedLoopback('codex', cwd, settings, env), /default workspace filesystem settings/)
})

test('native isolated loopback: primary and explicit extra roots stay writable with siblings blocked', { timeout: 30000 }, async t => {
  const env = testEnv()
  const source = fileURLToPath(new URL('..', import.meta.url))
  const root = mkdtempSync(join(source, '.loopback-scope-'))
  t.after(() => execFileSync('mv', ['--', root, join(env.XDG_RUNTIME_DIR, 'scope-project')]))
  const cwd = join(root, 'primary')
  const extra = join(root, 'extra')
  const outside = join(root, 'outside')
  for (const path of [cwd, extra, outside]) mkdirSync(path)
  const gitDir = join(cwd, '.git')
  mkdirSync(gitDir)
  const profile = 'clodeks_scope_roots'
  const settings = isolatedLoopbackSettings({ sandbox: 'workspace-write', addDirs: [extra], gitDirs: [gitDir] }, profile)
  await verifyIsolatedLoopback('codex', cwd, settings, env)
  const isolated = ['-P', profile, ...settings.filter(value => !value.startsWith('default_permissions='))
    .flatMap(value => ['-c', value])]
  for (const [name, path, expected] of [['primary', cwd, true], ['extra', extra, true], ['git', gitDir, true], ['outside', outside, false]]) {
    const result = await sandbox({ ...env, CLODEKS_PROBE_SCOPE_ONLY: '1',
      CLODEKS_PROBE_WRITE_PATH: join(path, 'isolated.txt') }, isolated, cwd)
    assert.equal(result.writable, expected, name)
  }
})

test('native isolated loopback: read-only roots never grant workspace writes', { timeout: 30000 }, async t => {
  const env = testEnv()
  const root = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), '.loopback-readonly-'))
  t.after(() => execFileSync('mv', ['--', root, join(env.XDG_RUNTIME_DIR, 'readonly-project')]))
  const cwd = join(root, 'primary')
  const extra = join(root, 'extra')
  const outbox = join(root, 'outbox')
  const gitDir = join(cwd, '.git')
  for (const path of [cwd, extra, outbox, gitDir]) mkdirSync(path)
  const profile = 'clodeks_readonly_roots'
  const settings = isolatedLoopbackSettings({ sandbox: 'read-only', addDirs: [cwd, extra],
    gitDirs: [gitDir], outboxDir: outbox }, profile)
  await verifyIsolatedLoopback('codex', cwd, settings, env)
  const args = ['-P', profile, ...settings.filter(value => !value.startsWith('default_permissions='))
    .flatMap(value => ['-c', value])]
  for (const path of [cwd, extra, gitDir, outbox]) {
    const target = join(path, 'denied.txt')
    const result = await sandbox({ ...env, CLODEKS_PROBE_SCOPE_ONLY: '1', CLODEKS_PROBE_WRITE_PATH: target }, args, cwd)
    assert.equal(result.writable, false, path)
    assert.equal(existsSync(target), false, path)
  }
})

test('native isolated loopback: exec resume replaces stored scope and isolates the command', { timeout: 60000 }, async t => {
  const env = testEnv()
  const root = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), '.loopback-resume-'))
  t.after(() => execFileSync('mv', ['--', root, join(env.XDG_RUNTIME_DIR, 'resume-project')]))
  const cwd = join(root, 'primary')
  const extra = join(root, 'extra')
  const outside = join(root, 'outside')
  for (const path of [cwd, extra, outside]) mkdirSync(path)
  const fixture = await nativeExecFixture(env, cwd, extra, outside, PROBE)
  t.after(() => fixture.close())
  const seed = await runExec({ cwd, prompt: 'Seed the local fixture session.', sandbox: 'workspace-write',
    loopbackIsolated: true, timeoutMs: 20000 }, fixture.env)
  assert.equal(seed.ok, true, JSON.stringify(seed))
  assert.ok(seed.thread_id)
  const resumed = await runExec({ cwd, prompt: 'Resume with isolated read-only scope.', sandbox: 'read-only',
    resume: seed.thread_id, loopbackIsolated: true, timeoutMs: 30000 }, fixture.env)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.thread_id, seed.thread_id)
  assert.equal(resumed.commands_run, 1)
  const result = fixture.commandOutput()
  assert.equal(result.local_exchange, 'isolated')
  assert.equal(result.public_tcp.connected, false)
  assert.equal(result.host_loopback.connected, false)
  assert.equal(result.host_unix_connected, false)
  for (const path of [cwd, extra, outside]) assert.equal(result.writes[path], false, path)
  assert.equal(fixture.requestCount(), 3)
  t.diagnostic(JSON.stringify(result))
})
