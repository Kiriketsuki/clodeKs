import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

async function settlesBefore(promise, ms) {
  return Promise.race([promise.then(() => true), delay(ms, false, { ref: false })])
}

function signalFixture(child, socket, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const address = `unix://${socket}`
  assert.match(socket, /^\/tmp\/cktest-[^/]+\/env-[^/]+\/private\.sock$/)
  assert.ok(child.spawnargs.includes(address), 'cleanup must verify the requested fixture socket')
  try {
    const args = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0')
    const status = readFileSync(`/proc/${child.pid}/status`, 'utf8')
    if (args.length === 1 && args[0] === '') return
    assert.ok(args.includes(address), 'cleanup must verify the private fixture socket')
    assert.equal(Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), process.pid, 'cleanup must verify the fixture parent')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  child.kill(signal)
}

async function stopFixture(child, exited, socket) {
  if (!child) return
  try {
    signalFixture(child, socket, 'SIGTERM')
    if (await settlesBefore(exited, 1500)) return
    signalFixture(child, socket, 'SIGKILL')
    assert.ok(await settlesBefore(exited, 1500), 'the owned approval fixture did not exit')
  } finally {
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
  }
}

async function stopModel(model) {
  if (!model.listening) return
  const closed = new Promise(resolve => model.close(resolve))
  model.closeAllConnections()
  assert.ok(await settlesBefore(closed, 1500), 'the local model fixture did not close')
}

export async function closeNativeApprovalFixture({ child, exited, socket, ws, model }) {
  ws?.destroy()
  const outcomes = await Promise.allSettled([stopFixture(child, exited, socket), stopModel(model)])
  const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason)
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'approval fixture cleanup failed')
}
