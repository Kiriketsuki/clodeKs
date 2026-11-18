import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'

import { appServerUmask, callerUmask, socketIdentity } from '../lib/umask.mjs'
import { testEnv } from './helpers/env.mjs'

async function listener(t, env, socket = join(env.XDG_RUNTIME_DIR, 'app.sock')) {
  let connections = 0
  const server = createServer(conn => { connections += 1; conn.end() })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { socket, connections: () => connections }
}

function cacheFile(env) {
  const folder = join(env.XDG_RUNTIME_DIR, 'clodeks', 'mask-cache')
  const names = readdirSync(folder).filter(name => name.endsWith('.json'))
  assert.equal(names.length, 1)
  return join(folder, names[0])
}

test('mask cache: repeated reads and a separate CLI process reuse one private observation', async t => {
  const env = testEnv()
  const state = await listener(t, env)
  const expected = { worker_shell_umask: callerUmask(), worker_shell_umask_source: 'app-server' }
  assert.deepEqual(await appServerUmask(state.socket, { env }), expected)
  assert.equal(state.connections(), 2)
  assert.deepEqual(await appServerUmask(state.socket, { env }), expected)
  assert.equal(state.connections(), 2, 'a cache hit must not open another probe connection')
  const path = cacheFile(env)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(record.pid, process.pid)
  assert.match(record.start, /^\d+$/)
  assert.equal(record.socket_identity, socketIdentity(state.socket))
  const url = new URL('../lib/umask.mjs', import.meta.url).href
  const script = `import { appServerUmask } from ${JSON.stringify(url)}\n` +
    `console.log(JSON.stringify(await appServerUmask(process.argv[1])))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, state.socket], {
    env: { ...env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(output), expected, 'a cached CLI read must work without Python on PATH')
  assert.equal(state.connections(), 2)
})

test('mask cache: a replacement socket forces a new measurement', async t => {
  const env = testEnv()
  const state = await listener(t, env)
  await appServerUmask(state.socket, { env })
  const old = socketIdentity(state.socket)
  renameSync(state.socket, `${state.socket}.old`)
  const replacement = await listener(t, env, state.socket)
  assert.notEqual(socketIdentity(state.socket), old)
  assert.deepEqual(await appServerUmask(state.socket, { env }), {
    worker_shell_umask: callerUmask(), worker_shell_umask_source: 'app-server',
  })
  assert.equal(replacement.connections(), 2)
})

test('mask cache: stale process identities and unsafe records trigger a fresh probe', async t => {
  for (const change of [
    value => ({ ...value, start: '0' }),
    value => ({ ...value, pid: 2147483647 }),
    value => ({ ...value, socket_identity: 'stale' }),
    value => ({ ...value, mask: 'invalid' }),
    () => null,
    'mode',
  ]) {
    const env = testEnv()
    const state = await listener(t, env)
    await appServerUmask(state.socket, { env })
    const path = cacheFile(env)
    if (change === 'mode') chmodSync(path, 0o644)
    else writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, 'utf8')))))
    assert.deepEqual(await appServerUmask(state.socket, { env }), {
      worker_shell_umask: callerUmask(), worker_shell_umask_source: 'app-server',
    })
    assert.equal(state.connections(), 4, 'an invalid cache must not supply a mask')
  }
})

test('mask cache: unavailable probes do not create cache directories', async t => {
  const env = testEnv()
  const state = await listener(t, env)
  assert.deepEqual(await appServerUmask(state.socket, { env, probe: async () => 'null' }), {
    worker_shell_umask: null, worker_shell_umask_source: null,
  })
  assert.throws(() => readdirSync(join(env.XDG_RUNTIME_DIR, 'clodeks', 'mask-cache')), /ENOENT/)
})

test('mask cache: a FIFO cannot block discovery before the file-type check', async t => {
  const env = testEnv()
  const state = await listener(t, env)
  await appServerUmask(state.socket, { env })
  const path = cacheFile(env)
  renameSync(path, `${path}.saved`)
  const fifo = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8', timeout: 1000 })
  assert.ifError(fifo.error)
  assert.equal(fifo.status, 0, fifo.stderr)
  const url = new URL('../lib/umask.mjs', import.meta.url).href
  const script = `import { appServerUmask } from ${JSON.stringify(url)}\n` +
    `console.log(JSON.stringify(await appServerUmask(process.argv[1])))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, state.socket], {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1500,
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, 'cache discovery must finish before the fixture timeout')
  assert.equal(JSON.parse(output).worker_shell_umask, callerUmask())
  assert.equal(state.connections(), 4)
})
