import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as quota from '../lib/appserver.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const PRIMARY = { usedPercent: 42, windowDurationMins: 300, resetsAt: 1794900000 }
const SECONDARY = { usedPercent: 98, windowDurationMins: 10080, resetsAt: 1795400000 }
const SNAPSHOT = { limitId: 'codex', planType: 'pro', primary: PRIMARY, secondary: SECONDARY }

async function setup(t, response, error) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, 'app.sock')
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'initialize') return {}
    assert.equal(request.method, 'account/rateLimits/read')
    if (error) throw new Error(error)
    return response
  })
  t.after(server.close)
  return { env, socket, server }
}

async function cli(state, args = []) {
  const child = spawn(process.execPath, [CLI, 'quota', '--socket', state.socket, ...args], {
    env: state.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, stdout, stderr }
}

test('quota: read one server-account snapshot without enabling capabilities or mutating account state', async t => {
  const state = await setup(t, { rateLimits: SNAPSHOT, ordinaryUsageAllowed: false, accountId: 'snapshot-account' })
  const result = await quota.readQuota(state.socket)
  assert.equal(result.scope, 'shared-app-server-account')
  assert.equal(result.ordinary_usage_allowed, false)
  assert.equal(result.account_id, 'snapshot-account')
  assert.deepEqual(result.rate_limits, SNAPSHOT)
  assert.equal(result.rate_limits_by_limit_id, null)
  assert.ok(Number.isSafeInteger(result.fetched_at))
  assert.match(result.hint, /account.*not.*thread/i)
  assert.deepEqual(state.server.requests.map(r => r.method), ['initialize', 'account/rateLimits/read'])
  assert.deepEqual(state.server.requests[1].params, { excludeResetCreditDetails: true })
})

test('quota: retain every bucket without replacing the legacy snapshot', async t => {
  const buckets = { codex: SNAPSHOT, other: { ...SNAPSHOT, limitId: 'other', primary: { usedPercent: 6 } } }
  const state = await setup(t, { rateLimits: SNAPSHOT, rateLimitsByLimitId: buckets, ordinaryUsageAllowed: true })
  const result = await quota.readQuota(state.socket)
  assert.deepEqual(result.rate_limits_by_limit_id, buckets)
  assert.deepEqual(result.rate_limits, SNAPSHOT)
  assert.equal(result.ordinary_usage_allowed, true)
})

test('quota: missing windows and permission stay unknown rather than becoming zero or allowed', async t => {
  for (const snapshot of [{}, { primary: null, secondary: null }]) {
    const state = await setup(t, { rateLimits: snapshot, rateLimitsByLimitId: null })
    const result = await quota.readQuota(state.socket)
    assert.deepEqual(result.rate_limits, snapshot)
    assert.equal(result.ordinary_usage_allowed, null)
    assert.equal(result.rate_limits_by_limit_id, null)
  }
})

test('quota: preserve percentages and reset units without inferring recovery', async t => {
  const snapshot = { primary: { usedPercent: 110, resetsAt: 1, windowDurationMins: null } }
  const state = await setup(t, { rateLimits: snapshot, ordinaryUsageAllowed: false })
  const result = await quota.readQuota(state.socket)
  assert.deepEqual(result.rate_limits, snapshot)
  assert.equal(result.ordinary_usage_allowed, false)
})

test('quota: reject malformed snapshots and window values', async t => {
  for (const response of [
    null, {}, { rateLimits: null }, { rateLimits: [] },
    { rateLimits: { primary: {} } }, { rateLimits: { secondary: { usedPercent: '40' } } },
    { rateLimits: { primary: { usedPercent: 1.5 } } },
    { rateLimits: { primary: { usedPercent: 1, resetsAt: 'later' } } },
    { rateLimits: { primary: { usedPercent: 1, windowDurationMins: -1 } } },
    { rateLimits: {}, rateLimitsByLimitId: [] }, { rateLimits: {}, rateLimitsByLimitId: { codex: null } },
    { rateLimits: {}, ordinaryUsageAllowed: 'yes' }, { rateLimits: {}, accountId: 42 },
  ]) {
    const state = await setup(t, response)
    await assert.rejects(quota.readQuota(state.socket), /quota.*response/i)
  }
})

test('quota: authentication and unsupported endpoint errors remain failures without retry', async t => {
  for (const error of ['ChatGPT authentication required', 'method not found', 'backend unavailable']) {
    const state = await setup(t, {}, error)
    await assert.rejects(quota.readQuota(state.socket), new RegExp(error))
    assert.deepEqual(state.server.requests.map(r => r.method), ['initialize', 'account/rateLimits/read'])
  }
})

test('quota: CLI routes the explicit socket and prints the snapshot', async t => {
  const state = await setup(t, { rateLimits: SNAPSHOT })
  const out = await cli(state)
  assert.equal(out.code, 0, out.stderr)
  assert.equal(JSON.parse(out.stdout).rate_limits.secondary.usedPercent, 98)
  assert.equal(JSON.parse(out.stdout).scope, 'shared-app-server-account')
})

test('quota: CLI never prints success JSON when the read fails', async t => {
  const state = await setup(t, {}, 'ChatGPT authentication required')
  const out = await cli(state)
  assert.equal(out.code, 1)
  assert.equal(out.stdout, '')
  assert.match(out.stderr, /ChatGPT authentication required/)
})

test('quota: help and invalid arguments have no account side effects', async t => {
  const state = await setup(t, { rateLimits: SNAPSHOT })
  const help = await cli(state, ['--help'])
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /^  clodeks quota/)
  const invalid = await cli(state, ['unused-thread'])
  assert.notEqual(invalid.code, 0)
  assert.deepEqual(state.server.requests, [])
})

test('quota: validate credit and spend-control fields before returning them', async t => {
  for (const snapshot of [
    { credits: { hasCredits: null, unlimited: 'yes' } },
    { credits: { hasCredits: true, unlimited: false, balance: 10 } },
    { spendControlReached: 'false' }, { limitId: 42 }, { planType: [] },
    { individualLimit: { limit: '100', used: '20', remainingPercent: '80', resetsAt: 123 } },
  ]) {
    const state = await setup(t, { rateLimits: snapshot })
    await assert.rejects(quota.readQuota(state.socket), /quota.*response/i)
  }
})

test('quota: preserve valid credit and spend-control information with the usage windows', async t => {
  const snapshot = {
    ...SNAPSHOT, credits: { hasCredits: true, unlimited: false, balance: '10' },
    spendControlReached: false, rateLimitReachedType: null,
    individualLimit: { limit: '100', used: '20', remainingPercent: 80, resetsAt: 123 },
  }
  const state = await setup(t, { rateLimits: snapshot })
  assert.deepEqual((await quota.readQuota(state.socket)).rate_limits, snapshot)
})
