import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { listPendingApprovals } from '../lib/appserver.mjs'
import { fakeAppServer } from './helpers/appserver.mjs'
import { testEnv } from './helpers/env.mjs'

const ID = '01a11f22-ed3b-7b43-9b60-da491234abcd'
const TURN = 'active-turn'
const WAITING = { type: 'active', activeFlags: ['waitingOnApproval'] }
const commandItem = (id, command, status = 'inProgress') => ({ turnId: TURN,
  item: { type: 'commandExecution', id, command, cwd: '/work', status } })

async function setup(t, detail, ids = [ID], readThread) {
  const env = testEnv()
  const socket = join(env.XDG_RUNTIME_DIR, "a'pp.sock")
  const server = await fakeAppServer(socket, request => {
    if (request.method === 'initialize') return {}
    if (request.method === 'thread/loaded/list') return { data: ids }
    if (request.method === 'thread/read') return readThread ? readThread(request.params.threadId)
      : { thread: { id: request.params.threadId, cwd: '/work', status: WAITING } }
    return detail(request)
  })
  t.after(server.close)
  return { env, socket, server }
}

const details = entries => request => request.method === 'thread/turns/list'
  ? { data: [{ id: TURN, status: 'inProgress' }] }
  : { data: entries, nextCursor: null }

test('pending recovery: preserves display command bytes as unconfirmed current-turn candidates', async t => {
  const command = 'clodeks claude-send --message \'1. Read `x`\n2. Say "done" ($x)\''
  const { socket, server } = await setup(t, details([
    commandItem('old', 'old command', 'completed'), commandItem('waiting', command),
    { turnId: TURN, item: { type: 'agentMessage', id: 'text', text: 'not a command' } },
  ]))
  const out = await listPendingApprovals(socket)
  assert.deepEqual(out.pending[0].command_candidates, [{ item_id: 'waiting', turn_id: TURN,
    command, cwd: '/work', approval_confirmed: false }])
  assert.equal(out.pending[0].details_available, false)
  assert.equal(out.pending[0].request_id, null)
  assert.equal(out.pending[0].commands_truncated, false)
  assert.equal(out.pending[0].command_details_error, null)
  assert.match(out.hint, /unconfirmed.*history/i)
  assert.match(out.hint, /owning Codex client/i)
  assert.deepEqual(server.requests.map(r => r.method), [
    'initialize', 'thread/loaded/list', 'thread/read', 'thread/turns/list', 'thread/items/list',
  ])
  assert.deepEqual(server.requests[3].params, { threadId: ID, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
  assert.deepEqual(server.requests[4].params, { threadId: ID, turnId: TURN, limit: 100, sortDirection: 'desc' })
})

test('pending recovery: a shell-safe answer path preserves socket and thread identity', async t => {
  const { env, socket } = await setup(t, details([]))
  const pending = (await listPendingApprovals(socket)).pending[0]
  const bin = join(env.XDG_RUNTIME_DIR, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'clodeks'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 })
  assert.equal(typeof pending.resume_command, 'string')
  const run = spawnSync('/bin/sh', ['-c', pending.resume_command], {
    env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: 'utf8', timeout: 2000,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), ['tui', '--socket', socket, '--', 'resume', ID])
})

test('pending recovery: bounds history and reports truncation', async t => {
  const { socket, server } = await setup(t, request => request.method === 'thread/turns/list'
    ? { data: [{ id: TURN, status: 'inProgress' }] }
    : { data: [commandItem('waiting', 'display command')], nextCursor: 'older-items' })
  const pending = (await listPendingApprovals(socket)).pending[0]
  assert.equal(pending.commands_truncated, true)
  assert.equal(pending.command_candidates.length, 1)
  assert.equal(server.requests.filter(r => r.method === 'thread/items/list').length, 1)
})

test('pending recovery: unsupported history preserves status and recovery command', async t => {
  const { socket } = await setup(t, () => { throw new Error('history unsupported') })
  const pending = (await listPendingApprovals(socket)).pending[0]
  assert.equal(pending.thread_id, ID)
  assert.deepEqual(pending.command_candidates, [])
  assert.match(pending.command_details_error, /history unsupported/)
  assert.equal(pending.commands_truncated, null)
  assert.equal(typeof pending.resume_command, 'string')
})

test('pending recovery: never presents completed turns or wrong-turn items as current commands', async t => {
  for (const response of [
    request => request.method === 'thread/turns/list' ? { data: [{ id: TURN, status: 'completed' }] } : { data: [commandItem('old', 'old')] },
    details([{ ...commandItem('wrong', 'wrong'), turnId: 'old-turn' }]),
    details([commandItem('bad', null)]),
    () => ({ data: 'malformed' }),
  ]) {
    const { socket } = await setup(t, response)
    const pending = (await listPendingApprovals(socket)).pending[0]
    assert.deepEqual(pending.command_candidates, [])
    assert.equal(typeof pending.command_details_error, 'string')
  }
})

test('pending recovery: an empty history leaves command availability unknown', async t => {
  const { socket } = await setup(t, details([]))
  const pending = (await listPendingApprovals(socket)).pending[0]
  assert.deepEqual(pending.command_candidates, [])
  assert.equal(pending.details_available, false)
  assert.match(pending.command_details_error, /unavailable/i)
})

test('pending recovery: a shared detail deadline preserves multiple waits and recovery paths', async t => {
  const { socket, server } = await setup(t, () => new Promise(() => {}), [ID, `${ID}-other`])
  const timeout = Symbol('timeout')
  let timer
  const result = await Promise.race([
    listPendingApprovals(socket),
    new Promise(resolve => { timer = setTimeout(() => resolve(timeout), 2500) }),
  ])
  clearTimeout(timer)
  assert.notEqual(result, timeout, 'optional history must not hide approval recovery for 15 seconds')
  assert.equal(result.pending.length, 2)
  assert.equal(typeof result.pending[0].resume_command, 'string')
  assert.match(result.pending[0].command_details_error, /deadline/)
  assert.match(result.pending[1].command_details_error, /deadline/)
  assert.equal(server.requests.filter(r => r.method === 'thread/turns/list').length, 1)
})

test('pending recovery: metadata reads before the first wait do not spend the history budget', async t => {
  const other = `${ID}-idle`
  const { socket } = await setup(t, details([commandItem('waiting', 'display command')]), [other, ID], async id => {
    if (id === other) await new Promise(resolve => setTimeout(resolve, 1600))
    return { thread: { id, cwd: '/work', status: id === ID ? WAITING : { type: 'idle' } } }
  })
  const pending = (await listPendingApprovals(socket)).pending[0]
  assert.equal(pending.command_details_error, null)
  assert.equal(pending.command_candidates[0].command, 'display command')
})

test('pending recovery: a fast turn read and a hung item read still preserve recovery', async t => {
  const { socket, server } = await setup(t, request => request.method === 'thread/turns/list'
    ? { data: [{ id: TURN, status: 'inProgress' }] } : new Promise(() => {}))
  const timeout = Symbol('timeout')
  let timer
  const result = await Promise.race([
    listPendingApprovals(socket),
    new Promise(resolve => { timer = setTimeout(() => resolve(timeout), 2500) }),
  ])
  clearTimeout(timer)
  assert.notEqual(result, timeout, 'optional item history must respect the shared deadline')
  assert.equal(result.pending.length, 1)
  assert.equal(typeof result.pending[0].resume_command, 'string')
  assert.match(result.pending[0].command_details_error, /deadline/)
  assert.equal(server.requests.filter(r => r.method === 'thread/items/list').length, 1)
})
