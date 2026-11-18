import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runExec } from '../lib/exec.mjs'
import { serveInbox, startInboxDaemon } from '../lib/inbox.mjs'
import { privateRuntimeDir } from '../lib/paths.mjs'
import { buildState, readState, stateFile, STATE_FRESH_MS } from '../lib/status.mjs'
import { parseFrame } from '../lib/peers.mjs'
import { testEnv } from './helpers/env.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const root = testEnv().XDG_RUNTIME_DIR

function envFor(extra = {}) {
  return testEnv({ CLODEKS_CODEX_BIN: FAKE, ...extra })
}

// A stand-in for a Claude session inbox. Resolves the parsed frames it receives.
function fakeClaudeInbox(path) {
  const frames = []
  const server = createServer(conn => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const msg = parseFrame(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (msg) frames.push(msg)
      }
    })
  })
  return new Promise(resolve => server.listen(path, () => resolve({ frames, close: () => server.close() })))
}

test('relay: a sandboxed run reaches its parent session through the outbox', async () => {
  const env = envFor({ FAKE_MODE: 'relay' })
  const parentPath = join(env.XDG_RUNTIME_DIR, 'parent.sock')
  const parent = await fakeClaudeInbox(parentPath)
  env.CLAUDE_CODE_MESSAGING_SOCKET = parentPath
  const result = await runExec({ prompt: 'x', cwd: root, sandbox: 'workspace-write', relay: true, timeoutMs: 10000 }, env)
  for (let i = 0; i < 40 && parent.frames.length === 0; i++) await new Promise(r => setTimeout(r, 50))
  parent.close()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.relay_error, undefined)
  assert.equal(result.messages_relayed, 1)
  assert.equal(parent.frames.length, 1)
  assert.equal(parent.frames[0].body, 'progress: half done')
  assert.equal(parent.frames[0].fromName, 'codex-320152fd')
})

test('relay: refused without a parent session or with a read-only sandbox', async () => {
  const env = envFor({ FAKE_MODE: 'relay' })
  delete env.CLAUDE_CODE_MESSAGING_SOCKET
  const noParent = await runExec({ prompt: 'x', cwd: root, sandbox: 'workspace-write', relay: true, timeoutMs: 5000 }, env)
  assert.match(noParent.error, /needs a parent Claude session/)
  env.CLAUDE_CODE_MESSAGING_SOCKET = '/nonexistent.sock'
  const readOnly = await runExec({ prompt: 'x', cwd: root, sandbox: 'read-only', relay: true, timeoutMs: 5000 }, env)
  assert.match(readOnly.error, /needs a writable sandbox/)
})

test('timeout: kills the whole process group, tools included', async () => {
  const env = envFor({ FAKE_MODE: 'hang' })
  const t0 = Date.now()
  const result = await runExec({ prompt: 'x', cwd: root, sandbox: 'read-only', timeoutMs: 800 }, env)
  assert.equal(result.error, 'timeout')
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`)
})

test('exit: a tool that outlives codex does not hold the result', async () => {
  const env = envFor({ FAKE_MODE: 'exit-leaves-child' })
  const t0 = Date.now()
  const result = await runExec({ prompt: 'x', cwd: root, sandbox: 'read-only', timeoutMs: 20000 }, env)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.text, 'done')
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`)
})

test('runExec: a missing codex is a result, not a throw', async () => {
  const env = envFor({ CLODEKS_CODEX_BIN: '', PATH: '/nonexistent' })
  const result = await runExec({ prompt: 'x', cwd: root, sandbox: 'read-only', timeoutMs: 1000 }, env)
  assert.equal(result.ok, false)
  assert.match(result.error, /codex not found/)
})

test('inbox: a second server for the same alias is refused, and closing it keeps the first', async () => {
  const env = envFor()
  const first = await serveInbox({ alias: 'codex-aaaaaaaa', threadId: 't', appSocket: '/nonexistent' }, env)
  await assert.rejects(serveInbox({ alias: 'codex-aaaaaaaa', threadId: 't', appSocket: '/nonexistent' }, env), /already served/)
  first.close()
  const again = await serveInbox({ alias: 'codex-aaaaaaaa', threadId: 't', appSocket: '/nonexistent' }, env)
  again.close()
})

test('heartbeat: inboxd writes up: false while the app-server is down, and removes the file on stop', async () => {
  const env = envFor()
  const daemon = startInboxDaemon({ appSocket: join(env.XDG_RUNTIME_DIR, 'none.sock'), intervalMs: 100 }, env)
  let state = null
  for (let i = 0; i < 40 && state === null; i++) {
    await new Promise(r => setTimeout(r, 50))
    state = readState(env)
  }
  assert.ok(state, 'no heartbeat written')
  assert.equal(state.app_server.up, false)
  assert.equal(state.counts.live, 0)
  assert.equal(state.pid, process.pid)
  daemon.close()
  assert.equal(existsSync(stateFile(env)), false)
})

test('heartbeat: a stale or foreign file reads as no heartbeat', () => {
  const env = envFor()
  privateRuntimeDir(env)
  const now = Date.now()
  const state = buildState({ at: now - STATE_FRESH_MS - 1, pid: 1, appUp: true, error: null, threads: [], exposedIds: new Set(), inboxes: 0 })
  writeFileSync(stateFile(env), JSON.stringify(state))
  assert.equal(readState(env, now), null)
  writeFileSync(stateFile(env), JSON.stringify({ ...state, at: now }))
  assert.equal(readState(env, now).app_server.up, true)
  writeFileSync(stateFile(env), JSON.stringify({ ...state, at: now, v: 2 }))
  assert.equal(readState(env, now), null)
})

// A clone of a bare remote, with one commit on main that tracks origin/main.
function gitRepo(name) {
  const dir = mkdtempSync(join(root, `${name.slice(0, 4)}-`))
  const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'remote.git')])
  execFileSync('git', ['clone', '-q', join(dir, 'remote.git'), join(dir, 'work')], { stdio: 'ignore' })
  const work = join(dir, 'work')
  sh(work, 'config', 'user.email', 't@example.com')
  sh(work, 'config', 'user.name', 'test')
  sh(work, 'checkout', '-q', '-b', 'main')
  sh(work, 'commit', '-q', '--allow-empty', '-m', 'init')
  sh(work, 'push', '-q', '-u', 'origin', 'main')
  return { work, remote: join(dir, 'remote.git'), sh }
}

test('no schema: result holds the answer text', async () => {
  const r = await runExec({ prompt: 'echo me', cwd: root, sandbox: 'read-only', timeoutMs: 20000 }, envFor({ FAKE_MODE: 'echo' }))
  assert.equal(r.ok, true)
  assert.match(r.result, /clodeKs read-only context/)
  assert.ok(r.result.endsWith('\n\nCaller task\n\necho me'))
  assert.equal(r.result, r.text)
})

test('read-only: new and resumed workers receive the limit before the unchanged task', async () => {
  const prompt = 'Review only.\nRun pytest if possible.\n'
  for (const resume of [undefined, '01a11f22-ed3b-7b43-9b60-da49320152fd']) {
    const r = await runExec({ prompt, cwd: root, sandbox: 'read-only', resume, timeoutMs: 5000 }, envFor({ FAKE_MODE: 'echo' }))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.match(r.text, /Caches and build output inside the repository still need write access/)
    assert.ok(r.text.endsWith('\n\nCaller task\n\n' + prompt.trimEnd()))
  }
})

test('git: --push fetches, opens the git dir to the run and pushes the new commit', async () => {
  const { work, remote, sh } = gitRepo('push')
  const r = await runExec({ prompt: 'commit', cwd: work, sandbox: 'workspace-write', git: true, push: true, timeoutMs: 20000 }, envFor({ FAKE_MODE: 'commit' }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.git.fetched, true)
  assert.equal(r.git.pushed, true, r.git.push_error)
  assert.notEqual(r.git.head_after, r.git.head_before)
  assert.equal(sh(remote, 'rev-parse', 'main'), r.git.head_after)
  assert.equal(r.text, `committed\nclodeks pushed ${r.git.head_after} to main`)
  assert.equal(r.result, r.text)
})

test('git: the push note names the destination branch and preserves a structured result', async () => {
  const { work, remote, sh } = gitRepo('dest')
  sh(work, 'config', 'branch.main.merge', 'refs/heads/published')
  const r = await runExec({
    prompt: 'commit', cwd: work, sandbox: 'workspace-write', git: true, push: true, timeoutMs: 20000,
    schemaJson: JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } } }),
  }, envFor({ FAKE_MODE: 'commit-json' }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.git.pushed, true, r.git.push_error)
  assert.equal(sh(remote, 'rev-parse', 'published'), r.git.head_after)
  assert.equal(r.text, `{"answer":"committed"}\nclodeks pushed ${r.git.head_after} to published`)
  assert.deepEqual(r.result, { answer: 'committed' })
})

test('git: no-op and disabled pushes do not add a push note', async () => {
  for (const push of [true, false]) {
    const { work } = gitRepo('noop')
    const r = await runExec({ prompt: 'unchanged', cwd: work, sandbox: 'workspace-write', git: true, push, timeoutMs: 20000 }, envFor({ FAKE_MODE: 'echo' }))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.git.pushed, false)
    assert.doesNotMatch(r.text, /clodeks pushed/)
    assert.ok(r.text.endsWith('\n\nCaller task\n\nunchanged'))
    assert.equal(r.result, r.text)
  }
})

test('git: a planted hook stops the push and is reported', async () => {
  const { work, remote, sh } = gitRepo('tamp')
  const before = sh(remote, 'rev-parse', 'main')
  const r = await runExec({ prompt: 'commit', cwd: work, sandbox: 'workspace-write', git: true, push: true, timeoutMs: 20000 }, envFor({ FAKE_MODE: 'tamper' }))
  assert.equal(r.git.pushed, false)
  assert.doesNotMatch(r.text, /clodeks pushed/)
  assert.match(r.git.push_error, /changed git config or hooks/)
  assert.ok(r.git.changed_control_files.some(f => f.endsWith('hooks/pre-push')))
  assert.equal(sh(remote, 'rev-parse', 'main'), before)
})

test('git: --git and --add-dir need a writable sandbox', async () => {
  const r1 = await runExec({ prompt: 'x', cwd: root, sandbox: 'read-only', git: true, timeoutMs: 1000 }, envFor())
  assert.match(r1.error, /--git needs a writable sandbox/)
  const r2 = await runExec({ prompt: 'x', cwd: root, sandbox: 'read-only', addDirs: ['/tmp'], timeoutMs: 1000 }, envFor())
  assert.match(r2.error, /--add-dir needs a writable sandbox/)
})

test('git: new and resumed runs receive Git-hook context before the unchanged caller task', async () => {
  for (const resume of [undefined, '01a11f22-ed3b-7b43-9b60-da49320152fd']) {
    const { work } = gitRepo('hctx')
    const prompt = 'Keep the installed hooks.\nCommit the requested patch.\n'
    const capture = join(work, 'received-prompt.txt')
    const r = await runExec({
      prompt, cwd: work, sandbox: 'workspace-write', git: true, fetch: false, resume, timeoutMs: 5000,
    }, envFor({ FAKE_MODE: 'capture-prompt', FAKE_PROMPT_RECORD: capture }))
    assert.equal(r.ok, true, JSON.stringify(r))
    const received = readFileSync(capture, 'utf8')
    assert.match(received, /Installed Git hooks run as Git subprocesses/)
    assert.match(received, /explicit caller authorization/)
    assert.match(received, /--hooks controls Codex lifecycle hooks/)
    const marker = '\n\nCaller task\n\n'
    const boundary = received.indexOf(marker)
    assert.ok(boundary > 0, received)
    assert.equal(received.slice(boundary + marker.length), prompt)
  }
})

test('git: an installed commit hook remains enabled for worker-run Git commands', async () => {
  const { work, sh } = gitRepo('hook')
  sh(work, 'config', 'core.hooksPath', '.git/hooks')
  writeFileSync(join(work, '.git', 'hooks', 'commit-msg'),
    '#!/bin/sh\nprintf "%s\\n" "hook ran" > hook-ran.txt\n', { mode: 0o755 })
  const r = await runExec({ prompt: 'commit', cwd: work, sandbox: 'workspace-write',
    git: true, fetch: false, timeoutMs: 5000 }, envFor({ FAKE_MODE: 'commit' }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(readFileSync(join(work, 'hook-ran.txt'), 'utf8'), 'hook ran\n')
  assert.deepEqual(r.git.changed_control_files, [])
})


test('run guard: a stopped run keeps its commit and final text but never pushes', async () => {
  const { work, remote, sh } = gitRepo('guard')
  const before = sh(remote, 'rev-parse', 'main')
  const result = await runExec({ prompt: 'commit', cwd: work, sandbox: 'workspace-write',
    git: true, push: true, timeoutMs: 10000, resourceLimits: { minMemavailBytes: 100 },
  }, envFor({ FAKE_MODE: 'commit-hang' }), {
    preflight: () => {}, pollMs: 10,
    sample: () => ({ memavailBytes: existsSync(join(work, 'committed.txt')) ? 99 : 100 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.resource_stop.reason, 'min_memavail')
  assert.equal(result.result, 'committed')
  assert.equal(result.result_partial, true)
  assert.equal(result.text, 'committed')
  assert.notEqual(result.git.head_after, before)
  assert.equal(result.git.pushed, false)
  assert.match(result.git.push_error, /run failed/)
  assert.equal(sh(remote, 'rev-parse', 'main'), before)
  assert.ok(result.files_changed.includes(join(work, 'committed.txt')))
})


test('git: cleanup failure preserves a push that already reached the remote', async () => {
  const { work, remote, sh } = gitRepo('cleanup-push')
  const env = envFor({ FAKE_MODE: 'commit-cleanup-failure' })
  try {
    const result = await runExec({ prompt: 'commit', cwd: work, sandbox: 'workspace-write', git: true, push: true, timeoutMs: 5000 }, env)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.git.pushed, true)
    assert.equal(result.git.head_after, sh(remote, 'rev-parse', 'main'))
    assert.match(result.text, /clodeks pushed/)
    assert.match(result.cleanup_error, /EACCES/)
  } finally { chmodSync(join(env.XDG_RUNTIME_DIR, 'clodeks'), 0o700) }
})
