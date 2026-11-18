import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as masks from '../lib/umask.mjs'
import { listThreads } from '../lib/appserver.mjs'
import { createLaunchRecord } from '../lib/launch-record.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const UNKNOWN = { worker_shell_umask: null, worker_shell_umask_source: null }
const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'

test('app-server mask: reads the socket owner under 022 and 077 without changing it', async t => {
  assert.equal(typeof masks.appServerUmask, 'function')
  for (const mask of ['0022', '0077']) {
    const env = testEnv()
    const socket = join(env.XDG_RUNTIME_DIR, 'custom.sock')
    const script = `import { createServer } from 'node:net'\n` +
      `createServer(c => c.on('error', () => {})).listen(process.argv[1], () => console.log('ready'))`
    const child = spawn('/bin/sh', ['-c', 'umask "$1"\nshift\nexec "$@"',
      'mask-server-test', mask, process.execPath, '--input-type=module', '-e', script, socket],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => child.kill())
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`fixture exited ${code}`)))
      child.stdout.once('data', resolve)
    })
    const before = masks.callerUmask(`/proc/${child.pid}/status`)
    assert.deepEqual(await masks.appServerUmask(socket, { env }), {
      worker_shell_umask: mask, worker_shell_umask_source: 'app-server',
    })
    assert.equal(masks.callerUmask(`/proc/${child.pid}/status`), before)
    child.kill()
  }
})

test('app-server mask: unavailable sockets and failed probes remain unknown', async t => {
  assert.equal(typeof masks.appServerUmask, 'function')
  const env = testEnv()
  assert.deepEqual(await masks.appServerUmask(join(env.XDG_RUNTIME_DIR, 'missing'), { env }), UNKNOWN)
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, () => ({}))
  t.after(() => server.close())
  assert.deepEqual(await masks.appServerUmask(socket, { env, probe: async () => { throw new Error('unavailable') } }), UNKNOWN)
  assert.deepEqual(await masks.appServerUmask(socket, { env, timeoutMs: 0,
    probe: async () => { assert.fail('an expired deadline must skip the probe') } }), UNKNOWN)
  for (const output of ['', '{}', 'null', '{"mask":"022"}', '{"mask":"0077","pid":0}',
    '{"mask":"0077","pid":123,"stable":false}', '{"mask":"0077","pid":123,"stable":true,"extra":1}']) {
    assert.deepEqual(await masks.appServerUmask(socket, { env, probe: async () => output }), UNKNOWN)
  }
})

test('app-server mask: process races, foreign owners, and missing status stay unknown', () => {
  const helper = fileURLToPath(new URL('../lib/umask-peer.py', import.meta.url))
  const script = `
import importlib.util
import os
import struct
import sys
from unittest.mock import MagicMock, patch
spec = importlib.util.spec_from_file_location('mask_probe', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
credentials = struct.pack('3i', 123, os.getuid(), os.getgid())
peer = MagicMock()
peer.__enter__.return_value = peer
peer.getsockopt.return_value = credentials
with patch.object(module.socket, 'socket', return_value=peer), patch.object(module.Path, 'read_text', return_value='Umask:\\t0077\\n'):
    with patch.object(module, 'process_start', side_effect=['old', 'new']):
        assert module.measure('/fake') is None
    with patch.object(module, 'process_start', side_effect=['same', 'same', 'new', 'new']):
        assert module.measure('/fake') is None
    with patch.object(module, 'process_start', return_value='same'):
        peer.getsockopt.side_effect = [credentials, struct.pack('3i', 456, os.getuid(), os.getgid())]
        assert module.measure('/fake') is None
        peer.getsockopt.side_effect = None
        with patch.object(module.Path, 'read_text', return_value='Name:\\tnode\\n'):
            assert module.measure('/fake') is None
    peer.getsockopt.return_value = struct.pack('3i', 123, os.getuid() + 1, os.getgid())
    assert module.measure('/fake') is None
print('race and access checks passed')
`
  const result = spawnSync('python3', ['-B', '-c', script, helper], { encoding: 'utf8', timeout: 5000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /race and access checks passed/)
})

test('app-server mask: launch records retain the measured source', () => {
  const env = testEnv()
  const record = createLaunchRecord({
    launchId: 'f5d1e737-52c1-402a-b1d2-fc89e90cdd40', cwd: '/workspace', briefPath: '/brief',
    workerMask: { worker_shell_umask: '0077', worker_shell_umask_source: 'app-server' },
    onError: assert.ifError,
  }, env)
  const value = JSON.parse(readFileSync(record.path, 'utf8'))
  assert.equal(value.worker_shell_umask, '0077')
  assert.equal(value.worker_shell_umask_source, 'app-server')
})

test('app-server mask: live thread discovery measures the connected server only', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'custom.sock')
  const server = await fakeAppServer(socket, ({ method }) => {
    if (method === 'thread/loaded/list') return { data: [ID] }
    if (method === 'thread/list') return { data: [
      { id: ID, status: { type: 'idle' } }, { id: 'stored-thread', status: { type: 'idle' } },
    ] }
    return {}
  })
  t.after(() => server.close())
  const [live, stored] = await listThreads(socket, { all: true, env })
  assert.equal(live.worker_shell_umask, masks.callerUmask())
  assert.equal(live.worker_shell_umask_source, 'app-server')
  assert.equal(live.caller_umask, null)
  assert.equal(stored.worker_shell_umask, null)
  assert.equal(stored.worker_shell_umask_source, null)
  assert.ok(server.requests.every(r => ['initialize', 'thread/loaded/list', 'thread/list', 'thread/queue/list'].includes(r.method)))
})

test('app-server mask: a replaced listener leaves the RPC owner mask unknown', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const replacementMask = masks.callerUmask() === '0022' ? '0077' : '0022'
  const server = await fakeAppServer(socket, async ({ method }) => {
    if (method === 'thread/loaded/list') return { data: [ID] }
    if (method !== 'thread/list') return {}
    renameSync(socket, `${socket}.old`)
    const script = `import { createServer } from 'node:net'\n` +
      `createServer(c => c.on('error', () => {})).listen(process.argv[1], () => console.log('ready'))`
    const child = spawn('/bin/sh', ['-c', 'umask "$1"\nshift\nexec "$@"',
      'mask-replacement-test', replacementMask, process.execPath, '--input-type=module', '-e', script, socket],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => child.kill())
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`fixture exited ${code}`)))
      child.stdout.once('data', resolve)
    })
    return { data: [{ id: ID, status: { type: 'idle' } }] }
  })
  t.after(() => server.close())
  const [thread] = await listThreads(socket, { env })
  assert.equal(thread.worker_shell_umask, null)
  assert.equal(thread.worker_shell_umask_source, null)
})
