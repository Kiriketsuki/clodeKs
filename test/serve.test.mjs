import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const cli = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const fakeCodex = fileURLToPath(new URL('./fixtures/serve-codex.mjs', import.meta.url))
const run = promisify(execFile)

function setup() {
  const env = testEnv({ CLODEKS_CODEX_BIN: fakeCodex })
  const dir = env.XDG_RUNTIME_DIR
  return {
    socket: join(dir, 'app.sock'),
    env: {
      ...env,
      FIXTURE_READY: join(dir, 'ready'),
      FIXTURE_STOPPED: join(dir, 'stopped'),
      FIXTURE_RELEASE: join(dir, 'release'),
    },
  }
}

async function waitForFile(path) {
  const deadline = Date.now() + 2000
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `fixture did not create ${path}`)
    await delay(20)
  }
}

async function leaveStaleSocket(socket, env) {
  await run(process.execPath, ['-e',
    'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', socket],
  { env, timeout: 4000 })
  assert.ok(lstatSync(socket).isSocket())
}

async function startAndStop(t, socket, env) {
  const wrapper = spawn(process.execPath, [cli, 'serve', '--socket', socket], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  wrapper.stderr.on('data', data => { stderr += data })
  const closed = once(wrapper, 'close')
  t.after(async () => {
    writeFileSync(env.FIXTURE_RELEASE, '')
    await closed
  })
  await Promise.race([
    waitForFile(env.FIXTURE_READY),
    closed.then(([code]) => { throw new Error(`serve closed with ${code}. ${stderr}`) }),
  ])
  assert.equal(wrapper.kill('SIGTERM'), true)
  assert.deepEqual(await closed, [0, null], stderr)
  assert.equal(existsSync(socket), false)
}

for (const signal of ['SIGHUP', 'SIGTERM']) {
  test(`serve: ${signal} stops the owned server before the wrapper exits`, async t => {
    const { env, socket } = setup()
    const wrapper = spawn(process.execPath, [cli, 'serve', '--socket', socket], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    })
    wrapper.stderr.resume()
    const exited = once(wrapper, 'exit')
    const closed = once(wrapper, 'close')
    t.after(async () => {
      writeFileSync(env.FIXTURE_RELEASE, '')
      await closed
    })
    await waitForFile(env.FIXTURE_READY)

    assert.equal(wrapper.kill(signal), true)
    await exited
    assert.equal(readFileSync(env.FIXTURE_STOPPED, 'utf8'), 'SIGTERM')
    assert.equal(existsSync(socket), false)
  })
}

test('serve: distinguishes an unresponsive listener and leaves its socket alone', async t => {
  const { env, socket } = setup()
  const connections = new Set()
  const listener = createServer(connection => {
    connections.add(connection)
    connection.on('error', () => connection.destroy())
    connection.on('close', () => connections.delete(connection))
    connection.resume()
  })
  listener.listen(socket)
  await once(listener, 'listening')
  t.after(async () => {
    for (const connection of connections) connection.destroy()
    await new Promise(resolve => listener.close(resolve))
  })
  const inode = lstatSync(socket).ino

  await assert.rejects(run(process.execPath, [cli, 'serve', '--socket', socket], { env, timeout: 4000 }),
    error => error.code === 1 && /listener .* did not answer/.test(error.stderr))
  assert.equal(lstatSync(socket).ino, inode)
  assert.equal(existsSync(env.FIXTURE_READY), false)
})

test('serve: preserves a regular file at the requested socket path', async () => {
  const { env, socket } = setup()
  writeFileSync(socket, 'keep this file')
  writeFileSync(env.FIXTURE_RELEASE, '')

  await assert.rejects(run(process.execPath, [cli, 'serve', '--socket', socket], { env, timeout: 4000 }),
    error => error.code === 1 && /is not a Unix socket/.test(error.stderr))
  assert.equal(readFileSync(socket, 'utf8'), 'keep this file')
  assert.equal(existsSync(env.FIXTURE_READY), false)
})

test('serve: refuses a second launch when the existing server answers', async t => {
  const { env, socket } = setup()
  const server = await fakeAppServer(socket, () => ({}))
  t.after(() => server.close())
  const inode = lstatSync(socket).ino

  await assert.rejects(run(process.execPath, [cli, 'serve', '--socket', socket], { env, timeout: 4000 }),
    error => error.code === 1 && /an app-server already listens/.test(error.stderr))
  assert.equal(server.requests[0]?.method, 'initialize')
  assert.equal(lstatSync(socket).ino, inode)
  assert.equal(existsSync(env.FIXTURE_READY), false)
})

test('serve: replaces a socket left behind without a listener', async t => {
  const { env, socket } = setup()
  await leaveStaleSocket(socket, env)
  await startAndStop(t, socket, env)
})

function linkedSocket(socket, env) {
  const daemonDir = join(env.XDG_RUNTIME_DIR, 'daemon')
  mkdirSync(daemonDir)
  const target = join(daemonDir, 'backend.sock')
  symlinkSync(target, socket)
  return target
}

test('serve: probes through a Codex socket link and keeps the live listener', async t => {
  const { env, socket } = setup()
  const target = linkedSocket(socket, env)
  const server = await fakeAppServer(target, () => ({}))
  t.after(() => server.close())

  await assert.rejects(run(process.execPath, [cli, 'serve', '--socket', socket], { env, timeout: 4000 }),
    error => error.code === 1 && /an app-server already listens/.test(error.stderr))
  assert.equal(server.requests[0]?.method, 'initialize')
  assert.equal(readlinkSync(socket), target)
  assert.equal(existsSync(env.FIXTURE_READY), false)
})

for (const stale of [true, false]) {
  test(`serve: removes only the link when the Codex socket ${stale ? 'refuses connections' : 'is missing'}`, async t => {
    const { env, socket } = setup()
    const target = linkedSocket(socket, env)
    if (stale) await leaveStaleSocket(target, env)
    const identity = lstatSync(target, { throwIfNoEntry: false })

    await startAndStop(t, socket, env)
    assert.equal(lstatSync(socket, { throwIfNoEntry: false }), undefined)
    assert.equal(lstatSync(target, { throwIfNoEntry: false })?.ino, identity?.ino)
  })
}
