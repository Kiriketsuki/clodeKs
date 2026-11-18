import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseGate, waitForGate } from '../lib/gate.mjs'

function harness(loads, random = () => 0.5) {
  let clock = 0
  let samples = 0
  const sleeps = []
  return {
    options: {
      now: () => clock,
      sample: () => ({ load1: loads[samples++] }),
      sleep: async ms => { sleeps.push(ms); clock += ms },
      random,
    },
    sleeps,
    samples: () => samples,
    clock: () => clock,
  }
}

test('gate jitter: parser defaults to fifteen seconds and accepts zero or fractional seconds', () => {
  assert.equal(parseGate('load=1').jitterMs, 15000)
  assert.equal(parseGate('load=1', '60m', '0').jitterMs, 0)
  assert.equal(parseGate('load=1', '60m', '2.5').jitterMs, 2500)
  for (const value of ['', '-1', 'NaN', 'Infinity', '1s', '1e3', '99999999999999999']) {
    assert.throws(() => parseGate('load=1', undefined, value), /gate-jitter/)
  }
  assert.throws(() => parseGate(undefined, undefined, '0'), /gate-jitter needs --wait-gate/)
})

test('gate jitter: ungated launches do not sample, sleep, or draw randomness', async () => {
  const unexpected = () => { throw new Error('ungated dependency called') }
  assert.deepEqual(await waitForGate(null, { sample: unexpected, sleep: unexpected, random: unexpected }), { waitedMs: 0 })
})

test('gate jitter: a passing sample waits a uniform fraction of the default then rechecks once', async () => {
  for (const fraction of [0, 0.25, 0.5, 0.999]) {
    const h = harness([0, 0], () => fraction)
    const result = await waitForGate({ loadMax: 1, timeoutMs: 20000 }, h.options)
    assert.equal(h.samples(), 2)
    assert.deepEqual(h.sleeps, fraction === 0 ? [] : [15000 * fraction])
    assert.equal(result.waited_ms, 15000 * fraction)
    assert.equal(result.jitter_ms, 15000 * fraction)
    assert.deepEqual(result.wait_reasons, [])
  }
})

test('gate jitter: the override sets the random ceiling and zero still rechecks', async () => {
  for (const jitterMs of [0, 2000]) {
    const h = harness([0, 0])
    const result = await waitForGate({ loadMax: 1, timeoutMs: 5000, jitterMs }, h.options)
    assert.equal(h.samples(), 2)
    assert.equal(result.jitter_ms, jitterMs / 2)
    assert.equal(result.waited_ms, jitterMs / 2)
  }
})

test('gate jitter: a failed recheck resumes waiting and keeps the original deadline', async () => {
  const h = harness([0, 2, 2, 0, 0])
  const result = await waitForGate({ loadMax: 1, timeoutMs: 6000, jitterMs: 2000 }, h.options)
  assert.equal(h.samples(), 5)
  assert.deepEqual(h.sleeps, [1000, 1000, 1000, 1000])
  assert.equal(result.waited_ms, 4000)
  assert.equal(result.jitter_ms, 2000)
  assert.deepEqual(result.wait_reasons, ['load1 2 is at or above 1'])
})

test('gate jitter: the timeout clips jitter and prevents the recheck and launch', async () => {
  const h = harness([0, 0])
  await assert.rejects(waitForGate({ loadMax: 1, timeoutMs: 500, jitterMs: 2000 }, h.options), error => {
    assert.equal(error.code, 'GATE_TIMEOUT')
    assert.deepEqual(error.gate, { waited_ms: 500, jitter_ms: 500, wait_reasons: [] })
    return true
  })
  assert.deepEqual(h.sleeps, [500])
  assert.equal(h.samples(), 1)
})

test('gate jitter: repeated failed rechecks cannot reset the timeout', async () => {
  const h = harness([0, 2, 0, 2])
  await assert.rejects(waitForGate({ loadMax: 1, timeoutMs: 2500, jitterMs: 2000 }, h.options), error => {
    assert.equal(error.code, 'GATE_TIMEOUT')
    assert.equal(error.gate.waited_ms, 2500)
    assert.equal(error.gate.jitter_ms, 1500)
    assert.deepEqual(error.gate.wait_reasons, ['load1 2 is at or above 1'])
    return true
  })
  assert.equal(h.samples(), 3)
})

test('gate jitter: measurement failures after jitter retain the delay and error reason', async () => {
  const h = harness([0])
  const sample = h.options.sample
  await assert.rejects(waitForGate({ loadMax: 1, timeoutMs: 5000, jitterMs: 2000 }, {
    ...h.options,
    sample: () => {
      if (h.samples()) throw new Error('resource gate cannot read load1')
      return sample()
    },
  }), error => {
    assert.deepEqual(error.gate, { waited_ms: 1000, jitter_ms: 1000, wait_reasons: ['resource gate cannot read load1'] })
    return true
  })
})

test('gate jitter: a late passing recheck cannot launch', async () => {
  const h = harness([0, 0])
  const sample = h.options.sample
  await assert.rejects(waitForGate({ loadMax: 1, timeoutMs: 1500, jitterMs: 2000 }, {
    ...h.options,
    sample: () => {
      const resources = sample()
      if (h.samples() === 2) h.options.sleep(600)
      return resources
    },
  }), error => error.code === 'GATE_TIMEOUT' && error.gate.waited_ms === 1600 && error.gate.jitter_ms === 1000)
})
