import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { networkHostSettings, verifyNetworkHosts } from '../lib/network-host.mjs'
import { runExec } from '../lib/exec.mjs'
import { nativeExecFixture } from './helpers/native-exec.mjs'
import { testEnv } from './helpers/env.mjs'

const execute = promisify(execFile)
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const PROBE = fileURLToPath(new URL('./fixtures/network-host-probe.py', import.meta.url))
const hosts = ['pypi.org', 'httpbingo.org', 'localtest.me']
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

async function publicControl() {
  const { address } = await lookup('pypi.org', { family: 4 })
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, port: 443 })
    socket.setTimeout(5000, () => socket.destroy(new Error('Public control timed out')))
    socket.once('connect', () => { socket.end(); resolve() })
    socket.once('error', reject)
  })
  return address
}

function check(result) {
  assert.equal(result.proxy_present, true)
  assert.equal(result.credential_read_denied, true)
  assert.equal(result.direct_connected, false, 'RELEASE GATE: direct egress must remain denied')
  assert.equal(result.allowed.code, 0, result.allowed.error)
  assert.equal(result.allowed.status, '200')
  if (!result.unlisted) return
  assert.notEqual(result.unlisted.code, 0)
  assert.match(result.unlisted.error, /CONNECT tunnel failed, response 403/)
  assert.equal(result.private.status, '403')
  assert.equal(result.local.status, '403')
  assert.equal(result.private_name.status, '403')
  assert.equal(result.redirect_start.code, 0, result.redirect_start.error)
  assert.equal(result.redirect_start.status, '302')
  assert.notEqual(result.redirect_end.code, 0)
  assert.match(result.redirect_end.error, /CONNECT tunnel failed, response 403/)
}

// Run explicitly. These public, read-only checks use real namespaces and no model.
for (const sandbox of ['read-only', 'workspace-write']) {
  test(`native network host: ${sandbox} denies direct, unlisted, private, local, and redirect egress`, { timeout: 150000 }, async t => {
    const env = testEnv()
    env.HOME = mkdtempSync(fileURLToPath(new URL('../.network-home-', import.meta.url)))
    t.after(() => execFileSync('mv', ['--', env.HOME, join(env.XDG_RUNTIME_DIR, 'dummy-home')]))
    env.CLODEKS_CREDENTIAL_PROBE = join(env.HOME, '.netrc')
    writeFileSync(env.CLODEKS_CREDENTIAL_PROBE, 'synthetic fixture')
    assert.equal(readFileSync(env.CLODEKS_CREDENTIAL_PROBE, 'utf8'), 'synthetic fixture')
    env.CODEX_HOME = join(env.XDG_RUNTIME_DIR, 'codex-home')
    mkdirSync(env.CODEX_HOME)
    env.CLODEKS_PUBLIC_IP = await publicControl()
    const cwd = join(env.XDG_RUNTIME_DIR, 'repository')
    mkdirSync(cwd)
    const opts = { sandbox, homeDir: env.HOME, codexHome: env.CODEX_HOME, networkHosts: hosts, networkProfile: 'clodeks_network_native' }
    const settings = networkHostSettings(opts)
    await verifyNetworkHosts('codex', cwd, settings, env)
    const args = ['sandbox', '-P', opts.networkProfile, '--include-managed-config', '-C', cwd,
      ...settings.flatMap(value => ['-c', value]), '-c', 'features.hooks=false', '--', 'python3', '-I', '-B', PROBE]
    const child = spawn('codex', args, { env, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' })
    let output = ''
    let error = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { error += data })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 0, error)
    const result = JSON.parse(output)
    t.diagnostic(JSON.stringify({ sandbox, ...result }))
    check(result)
  })
}

test('native network host: exec resume applies the new read-only host policy', { timeout: 150000 }, async t => {
  const env = testEnv()
  env.CLODEKS_PUBLIC_IP = await publicControl()
  env.HOME = join(env.XDG_RUNTIME_DIR, 'dummy-home')
  mkdirSync(env.HOME)
  env.CLODEKS_CREDENTIAL_PROBE = join(env.HOME, '.netrc')
  writeFileSync(env.CLODEKS_CREDENTIAL_PROBE, 'synthetic fixture')
  assert.equal(readFileSync(env.CLODEKS_CREDENTIAL_PROBE, 'utf8'), 'synthetic fixture')
  const cwd = env.XDG_RUNTIME_DIR
  const command = `CLODEKS_ALLOWED_ONLY=1 python3 -I -B ${quote(PROBE)}`
  const fixture = await nativeExecFixture(env, cwd, cwd, cwd, PROBE, command, 30000)
  t.after(() => fixture.close())
  const seed = await runExec({ prompt: 'Seed.', sandbox: 'workspace-write', cwd, timeoutMs: 20000 }, fixture.env)
  assert.equal(seed.ok, true, JSON.stringify(seed))
  const cli = await execute(process.execPath, [CLI, 'run', '--cwd', cwd, '--resume', seed.thread_id,
    ...hosts.flatMap(host => ['--network-host', host]), '--timeout', '120', '--prompt', 'Run the network probe.'],
    { env: fixture.env, timeout: 125000, maxBuffer: 100000 })
  const resumed = JSON.parse(cli.stdout)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.commands_run, 1)
  assert.deepEqual(resumed.network.allowed_hosts, hosts)
  assert.equal(resumed.network.audit_scope, 'admission')
  assert.equal(resumed.network.complete, false)
  assert.equal(resumed.network.truncated, false)
  assert.ok(resumed.network.requests?.some(event => event.host === 'pypi.org' && event.port === 443 && event.decision === 'allow'), JSON.stringify(resumed.network))
  const line = fixture.rawCommandOutput()?.split('\n').find(line => line.startsWith('{"proxy_present"'))
  assert.ok(line, fixture.rawCommandOutput())
  const result = JSON.parse(line)
  t.diagnostic(JSON.stringify({ sandbox: 'resumed read-only', ...result }))
  check(result)
})
