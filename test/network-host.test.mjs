import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildExecArgs, runExec } from '../lib/exec.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CODEX = fileURLToPath(new URL('./fixtures/loopback-codex.mjs', import.meta.url))
const options = { prompt: 'Fetch allowed packages.', sandbox: 'workspace-write',
  networkHosts: ['pypi.org', 'files.pythonhosted.org'], timeoutMs: 10000 }
const report = { allowed_hosts: options.networkHosts, audit_scope: 'admission', requests: null, complete: false, truncated: false }

for (const sandbox of ['workspace-write', 'read-only']) {
  test(`network host: ${sandbox} new and resumed arguments select exact named policy`, () => {
    for (const resume of [undefined, 'stored']) {
      const args = buildExecArgs({ ...options, sandbox, cwd: '/work', resume, networkProfile: 'network_test',
        tempDir: sandbox === 'read-only' ? '/private/temp' : undefined, addDirs: ['/extra'] })
      const profile = args.find(arg => arg.startsWith('permissions.network_test='))
      assert.ok(profile, JSON.stringify(args))
      assert.ok(profile.includes(`extends=":${sandbox === 'read-only' ? 'read-only' : 'workspace'}"`))
      assert.ok(profile.includes('"pypi.org"="allow"') && profile.includes('"files.pythonhosted.org"="allow"'))
      for (const setting of ['allow_local_binding=false', 'enable_socks5=false', 'enable_socks5_udp=false',
        'allow_upstream_proxy=false', 'unix_sockets={}', 'dangerously_allow_all_unix_sockets=false']) assert.ok(profile.includes(setting), setting)
      assert.ok(args.includes('features.network_proxy=true'))
      assert.ok(args.includes('approval_policy="never"'))
      assert.equal(args.some(arg => arg.includes('network_access=true') || arg.startsWith('sandbox_mode=')), false)
      assert.equal(args.includes('-s'), false)
      assert.equal(args.some(arg => arg.startsWith('sandbox_workspace_write.writable_roots=')), false)
      assert.equal(args.includes('-C'), !resume)
      if (sandbox === 'read-only') assert.ok(profile.includes('filesystem={"/private/temp"="write",'))
    }
  })
}

test('network host: CLI accepts repeated hosts and labels unavailable admission logs', () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
  const result = spawnSync(process.execPath, [CLI, 'run', '--cwd', env.XDG_RUNTIME_DIR, '--write',
    '--network-host', 'pypi.org', '--network-host', 'files.pythonhosted.org', '--prompt', 'task'],
  { env, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).network, report)
})

test('network host: invalid hosts and incompatible options refuse before model execution', async () => {
  for (const networkHosts of [['*'], ['*.example.com'], ['https://pypi.org'], ['user@pypi.org'], ['pypi.org:443'],
    ['127.0.0.1'], ['::1'], ['2130706433'], ['localhost'], ['metadata.local'], ['service.internal'],
    ['no-dots'], ['bad..org'], ['-bad.org'], ['bad_.org'], ['bad.org.'], [' pypi.org'], ['pypi.org\n'], [''],
    ['a'.repeat(64) + '.org'], ['é.org']]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR, networkHosts }, env)
    assert.equal(result.ok, false, JSON.stringify(networkHosts))
    assert.match(result.error, /network-host/)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
  }
  for (const override of [{ sandbox: 'danger-full-access' }, { loopbackIsolated: true }]) {
    assert.throws(() => buildExecArgs({ ...options, cwd: '/work', networkProfile: 'test', ...override }), /network-host/)
  }
})

test('network host: verification errors refuse without a permissive fallback', async () => {
  for (const refusal of [{ FAKE_CODEX_VERSION: '0.170.0' }, { FAKE_REQUIREMENTS_RESPONSE: '{"requirements":{}}' },
    { FAKE_SERVER_MODE: 'malformed' }, { FAKE_SERVER_MODE: 'error' },
    { FAKE_CONFIG_RESPONSE: '{"config":{"sandbox_workspace_write":{"writable_roots":["/other"]}}}' }]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, ...refusal })
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /network-host/)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
    assert.deepEqual(result.network, report)
  }
})

test('network host: fresh profiles replace resumed policy and deduplicate normalized hosts', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
  env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
  const profiles = []
  for (const resume of [undefined, 'stored']) {
    const result = await runExec({ ...options, networkHosts: ['PYPI.ORG', 'pypi.org'], cwd: env.XDG_RUNTIME_DIR, resume }, env)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.network, { ...report, allowed_hosts: ['pypi.org'] })
    const args = JSON.parse(readFileSync(env.FAKE_EXEC_RECORD, 'utf8'))
    profiles.push(args.find(arg => arg.startsWith('default_permissions=')))
    assert.match(profiles.at(-1), /^default_permissions="clodeks_network_[a-z0-9]+"$/)
    const checked = args.find(arg => arg.startsWith('permissions.'))
    assert.ok(checked.includes('"pypi.org"="allow"'))
  }
  assert.notEqual(profiles[0], profiles[1])
})

test('network host: absent option keeps result shape and existing sandbox arguments', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
  const result = await runExec({ ...options, networkHosts: [], cwd: env.XDG_RUNTIME_DIR }, env)
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(result, 'network'), false)
})

test('network host: failed and timed-out runs never claim complete audit delivery', async () => {
  const codex = fileURLToPath(new URL('./fixtures/network-host-codex.mjs', import.meta.url))
  for (const mode of ['fail', 'hang']) {
    const env = testEnv({ CLODEKS_CODEX_BIN: codex, FAKE_NETWORK_RUN_MODE: mode })
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR, timeoutMs: 500 }, env)
    assert.equal(result.ok, false)
    assert.equal(result.error, mode === 'fail' ? 'codex exited 1' : 'timeout')
    assert.deepEqual(result.network, report)
  }
})

test('network host: CLI rejects incompatible options and invalid hosts before the resource gate', () => {
  for (const flags of [['--network-host', 'bad..org'], ['--network-host', 'pypi.org', '--loopback-isolated'],
    ['--network-host', 'pypi.org', '--sandbox', 'danger-full-access']]) {
    const result = spawnSync(process.execPath, [CLI, 'run', ...flags, '--prompt', 'task', '--wait-gate', 'load=0.001'],
      { env: testEnv(), encoding: 'utf8', timeout: 3000 })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /network-host/)
  }
})

test('network host: alternate numeric IP spellings and oversized lists refuse', async () => {
  for (const networkHosts of [['0x7f.0x0.0x0.0x1'], Array(65).fill('pypi.org')]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX })
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR, networkHosts }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /network-host/)
  }
})

test('network host: native-style stderr admissions survive success, failure, and timeout without private metadata', async () => {
  const codex = fileURLToPath(new URL('./fixtures/network-host-codex.mjs', import.meta.url))
  const line = '2026-11-17T08:30:37Z INFO codex_otel.network_proxy: event.name="codex.network_proxy.policy_decision" event.timestamp=2026-11-17T08:30:37.228Z server.address="pypi.org" server.port=443 network.policy.decision="allow" network.policy.reason="allow" user.email="private metadata"\n'
  const requests = [{ host: 'pypi.org', port: 443, decision: 'allow', reason: 'allow', time: '2026-11-17T08:30:37.228Z' }]
  for (const mode of ['', 'fail', 'hang']) {
    const env = testEnv({ CLODEKS_CODEX_BIN: codex, FAKE_NETWORK_RUN_MODE: mode, FAKE_NETWORK_AUDIT: line })
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR, timeoutMs: 500 }, env)
    assert.equal(result.ok, mode === '')
    assert.deepEqual(result.network, { ...report, requests })
    assert.equal(JSON.stringify(result).includes('private metadata'), false)
  }
})

test('network host review: profiles deny credential paths in the process and caller homes', async () => {
  const { homedir } = await import('node:os')
  const paths = ['.ssh', '.gnupg', '.codex/auth.json', '.config/gh', '.config/act-secrets', '.netrc', '.npmrc',
    '.pypirc', '.docker/config.json', '.aws', '.kube', '.git-credentials']
  for (const sandbox of ['read-only', 'workspace-write']) {
    const args = buildExecArgs({ ...options, sandbox, cwd: '/work', homeDir: '/caller-home',
      codexHome: '/custom-codex', networkProfile: 'credential_test', tempDir: '/private/temp' })
    const profile = args.find(arg => arg.startsWith('permissions.credential_test='))
    for (const home of [homedir(), '/caller-home']) {
      for (const path of paths) assert.ok(profile.includes(`${JSON.stringify(join(home, path))}="deny"`), path)
    }
    assert.ok(profile.includes('"/custom-codex/auth.json"="deny"'))
    if (sandbox === 'read-only') assert.ok(profile.includes('"/private/temp"="write"'))
  }
})

test('network host review: effective unrestricted or malformed network access refuses before execution', async () => {
  for (const network_access of [true, 'false', null, 0]) {
    const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, FAKE_CONFIG_RESPONSE: JSON.stringify({ config: {
      sandbox_workspace_write: { writable_roots: [], exclude_tmpdir_env_var: false, exclude_slash_tmp: false, network_access },
    } }) })
    env.FAKE_EXEC_RECORD = join(env.XDG_RUNTIME_DIR, 'exec.json')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
    assert.equal(result.ok, false)
    assert.match(result.error, /network-host.*network access/)
    assert.equal(existsSync(env.FAKE_EXEC_RECORD), false)
  }
})

test('network host review: logger fallback retains Codex exporter defaults and caller directives', async () => {
  const codex = fileURLToPath(new URL('./fixtures/network-host-codex.mjs', import.meta.url))
  for (const RUST_LOG of ['', 'warn']) {
    const env = testEnv({ CLODEKS_CODEX_BIN: codex, RUST_LOG })
    env.FAKE_NETWORK_LOG_RECORD = join(env.XDG_RUNTIME_DIR, 'log-filter.txt')
    const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
    assert.equal(result.ok, true)
    assert.equal(readFileSync(env.FAKE_NETWORK_LOG_RECORD, 'utf8'),
      `${RUST_LOG || 'error,opentelemetry_sdk=off,opentelemetry_otlp=off'},codex_otel.network_proxy=info`)
  }
})

test('network host review: a dropped oversized stderr line sets the result truncation flag', async () => {
  const codex = fileURLToPath(new URL('./fixtures/network-host-codex.mjs', import.meta.url))
  const env = testEnv({ CLODEKS_CODEX_BIN: codex, FAKE_NETWORK_AUDIT: 'x'.repeat(8193) + '\n' })
  const result = await runExec({ ...options, cwd: env.XDG_RUNTIME_DIR }, env)
  assert.deepEqual(result.network, { ...report, truncated: true })
})
