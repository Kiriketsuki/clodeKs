import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { testEnv } from './helpers/env.mjs'
import { closeNativeApprovalFixture } from './helpers/native-approval-cleanup.mjs'

test('approval fixture cleanup stops an owned child that ignores SIGTERM', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'private.sock')
  const model = createServer()
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {})
    process.stdout.write('ready')
    setTimeout(() => process.exit(4), 5500)
  `, `unix://${socket}`], { cwd: env.XDG_RUNTIME_DIR, env, stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = once(child, 'exit')
  t.after(() => exited)
  await once(child.stdout, 'data')

  const closed = await Promise.race([
    closeNativeApprovalFixture({ child, exited, socket, model }).then(() => true),
    delay(4000, false, { ref: false }),
  ])
  assert.equal(closed, true, 'fixture cleanup did not finish within four seconds')
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  assert.equal(model.listening, false)
})

test('approval fixture cleanup refuses a child whose socket does not match', async t => {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'private.sock')
  const otherSocket = join(env.XDG_RUNTIME_DIR, 'other.sock')
  const model = createServer()
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write('ready')
    setTimeout(() => {}, 750)
  `, `unix://${otherSocket}`], {
    cwd: env.XDG_RUNTIME_DIR, env, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exited = once(child, 'exit')
  const keepAlive = delay(1000)
  t.after(async () => { await Promise.race([exited, keepAlive]) })
  await once(child.stdout, 'data')

  await assert.rejects(closeNativeApprovalFixture({ child, exited, socket, model }), /verify the requested fixture socket/)
  assert.equal(child.killed, false)
  assert.equal(model.listening, false)
  assert.deepEqual(await exited, [0, null])
})
