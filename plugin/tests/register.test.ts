import type { CommandRunInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const THREAD = {
  id: '01a11f22-ed3b-7b43-9b60-da49320152fd',
  alias: 'codex-320152fd',
  name: null,
  status: 'idle',
  loaded: true,
  cwd: '/work',
  preview: 'Reply with exactly: ready',
  caller_umask: '0022',
  updated_at: 1,
  source: 'vscode',
  inbox: 'uds:/run/user/1000/clodeks/inbox/codex-320152fd.sock',
}

// The engine stamps origin and presentation on a real run. The kit fills them in.
function codex(args: string): CommandRunInput {
  return { command: 'codex', args } as unknown as CommandRunInput
}

function ran(exitCode: number, stdout: string, stderr = '') {
  return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

test('/codex lists live threads with their inbox address', async ($, on) => {
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return ran(0, JSON.stringify({ threads: [THREAD], hint: null }))
  })
  const out = await $.command.run(codex(''))
  expect(out.text).toContain('codex-320152fd')
  expect(out.text).toContain('inbox: uds:/run/user/1000/clodeks/inbox/codex-320152fd.sock')
  expect(out.text).toContain('caller umask 0022')
  expect(calls[0]).toEqual(['clodeks', 'threads', '--json', '--hint'])
})

test('codex_threads says why the list is empty', async ($, on) => {
  const hint = 'No live Codex threads on the shared app-server.\n2 Codex TUI(s) run on a private app-server'
  on('process.run', () => ran(0, JSON.stringify({ threads: [], hint })))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_threads' } as never)
  expect(JSON.stringify(out)).toContain('private app-server')
  const text = await $.command.run(codex(''))
  expect(text.text).toContain('private app-server')
})

test('/codex send queues through clodeks with the message on stdin', async ($, on) => {
  const seen: { argv: string[]; stdin?: string }[] = []
  on('process.run', ($, e) => {
    seen.push({ argv: [...e.argv], stdin: e.init?.stdin })
    return ran(0, e.argv[1] === 'send' ? JSON.stringify({ ok: true, alias: 'codex-320152fd' }) : '[]')
  })
  on('env.get', () => ({ value: '/run/user/1000/cc-socks/42.sock' }))
  const out = await $.command.run(codex('send codex-320152fd run the tests  please'))
  expect(out.text).toContain('Queued into codex-320152fd')
  const send = seen.find(s => s.argv[1] === 'send')
  expect(send?.argv).toEqual(['clodeks', 'send', '--reply-to', 'uds:/run/user/1000/cc-socks/42.sock', '--', 'codex-320152fd'])
  expect(send?.stdin).toBe('run the tests  please')
})

test('/codex reports a clodeks failure as text, not a crash', async ($, on) => {
  on('process.run', () => ran(1, '', 'clodeks: No Codex app-server socket'))
  const out = await $.command.run(codex(''))
  expect(out.text).toContain('No Codex app-server socket')
})

test('codex_send tool queues with -- before the thread and reports the result', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => {
    seen.push([...e.argv])
    return ran(0, e.argv[1] === 'send' ? '{"ok":true,"alias":"codex-320152fd"}' : '[]')
  })
  on('env.get', () => ({ value: undefined }))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: '--raw', message: 'hello' } as never)
  expect(JSON.stringify(out)).toContain('codex-320152fd')
  expect(seen.find(a => a[1] === 'send')).toEqual(['clodeks', 'send', '--', '--raw'])
})

test('codex_send tool turns a clodeks failure into a refusal the model can read', async ($, on) => {
  on('process.run', () => ran(1, '', 'clodeks: No Codex thread matches "nope".'))
  on('env.get', () => ({ value: undefined }))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: 'nope', message: 'hello' } as never)
  expect(JSON.stringify(out)).toContain('No Codex thread matches')
})

test('codex_send forwards explicit interrupt priority before the thread separator', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => {
    seen.push([...e.argv])
    return ran(0, e.argv[1] === 'send' ? '{"ok":true,"delivery":"started"}' : '[]')
  })
  on('env.get', () => ({ value: undefined }))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias, message: 'Stop.', priority: 'interrupt' } as never)
  expect(JSON.stringify(out)).toContain('started')
  expect(seen.find(a => a[1] === 'send')).toEqual(['clodeks', 'send', '--priority', 'interrupt', '--', THREAD.alias])
})

test('codex_send refuses unknown priority before it runs a command', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => { seen.push([...e.argv]); return ran(0, '{}') })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias, message: 'Stop.', priority: 'urgent' } as never)
  expect(JSON.stringify(out)).toContain('priority')
  expect(seen.some(a => a[1] === 'send')).toBe(false)
})

test('codex_pending preserves unconfirmed commands and the owning-client recovery path', async ($, on) => {
  const calls: string[][] = []
  const command = 'clodeks claude-send --message \'1. Read `x`\n2. Say "done" ($x)\''
  const result = { pending: [{ alias: THREAD.alias, cwd: '/work', details_available: false,
    command_candidates: [{ command, approval_confirmed: false }], request_id: null,
    resume_command: "clodeks tui --socket '/run/app.sock' -- resume 'thread-id'" }], hint: 'Unconfirmed command history' }
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return ran(0, JSON.stringify(result))
  })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_pending' } as never)
  expect(JSON.stringify(out)).toContain(THREAD.alias)
  expect(JSON.stringify(out)).toContain('Unconfirmed command history')
  expect(JSON.parse((out as { result: string }).result).pending[0].command_candidates[0].command).toBe(command)
  expect(JSON.stringify(out)).toContain('resume_command')
  expect(calls[0]).toEqual(['clodeks', 'pending'])
})

test('codex_pending reports failed discovery as a refusal', async ($, on) => {
  on('process.run', () => ran(1, '', 'clodeks: cannot check thread status'))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_pending' } as never)
  expect(JSON.stringify(out)).toContain('cannot check thread status')
})

const STATUS = {
  v: 1,
  at: 1,
  services: {
    appserver: { unit: 'clodeks-appserver.service', enabled: 'enabled', active: 'active' },
    inboxd: { unit: 'clodeks-inboxd.service', enabled: 'enabled', active: 'inactive' },
  },
  app_server: { socket: '/run/user/1000/clodeks/app.sock', up: true, error: null },
  inboxd: { fresh: false, pid: null },
  codex: { bin: '/x/codex', version: '0.154.0' },
  counts: { live: 1, active: 0, idle: 1, other: 0, client_attachment: 'unknown', exposed: 1 },
  threads: [{ ...THREAD, exposed: true }],
}

test('the band poll reads a fresh heartbeat without starting the CLI', async ($, on) => {
  const now = 1794990000000
  const clock = mock.clock(on, { now })
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000' })
  on('command.register', async () => ({ value: { command: 'codex' } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  const paths: string[] = []
  const runs: string[][] = []
  on('fs.read', async (_$, e) => {
    paths.push(e.path)
    return { value: JSON.stringify({ v: 1, at: now, pid: 42, app_server: STATUS.app_server, counts: STATUS.counts }) }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return ran(0, JSON.stringify(STATUS))
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.advance(10000)

  expect(paths).toEqual(['/run/user/1000/clodeks/state.json', '/run/user/1000/clodeks/state.json'])
  expect(runs).toEqual([])
})

test('the band poll uses only a band write once per minute while the heartbeat is stale', async ($, on) => {
  const now = 1794990000000
  const clock = mock.clock(on, { now })
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000' })
  on('command.register', async () => ({ value: { command: 'codex' } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('fs.read', async () => ({
    value: JSON.stringify({ v: 1, at: now - 20001, pid: 42, app_server: STATUS.app_server, counts: STATUS.counts }),
  }))
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return ran(0, JSON.stringify(STATUS))
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.advance(59999)
  expect(runs).toEqual([['clodeks', 'status', '--band-only']])
  await clock.advance(1)
  expect(runs).toEqual([
    ['clodeks', 'status', '--band-only'],
    ['clodeks', 'status', '--band-only'],
  ])
})

test('the panel refreshes thread activity from the heartbeat after its initial status read', async ($, on) => {
  const now = 1794990000000
  const clock = mock.clock(on, { now })
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000' })
  on('command.register', async () => ({ value: { command: 'codex' } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', async () => ({
    value: JSON.stringify({
      v: 1, at: now, pid: 42, app_server: { up: true, error: null },
      counts: { ...STATUS.counts, active: 1, idle: 0 },
      threads: [{ ...THREAD, alias: 'codex-new', status: 'active' }],
    }),
  }))
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return ran(0, JSON.stringify(STATUS))
  })
  const panel = await $.ui.mount({ plugin: 'clodeks', surface: 'terminal', component: 'Pane', requestId: 'clodeks-panel', props: { bodyColumns: 80 } as never })
  await panel.press({ key: 'refresh' })
  expect(await panel.find({ text: /codex-320152fd/ })).toBeDefined()

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(await panel.find({ text: /1 working, 0 idle/ })).toBeDefined()
  expect(await panel.find({ text: /codex-new/ })).toBeDefined()
  expect(runs).toEqual([['clodeks', 'status', '--json', '--band']])
  await panel.unmount()
})

test('/codex status reports enabled and running state', async ($, on) => {
  on('process.run', () => ran(0, JSON.stringify(STATUS)))
  const out = await $.command.run(codex('status'))
  expect(out.text).toContain('app-server unit: enabled, active')
  expect(out.text).toContain('inboxd heartbeat none')
  expect(out.text).toContain('0 working, 1 idle, 0 other, 1 exposed')
  expect(out.text).toContain('Client attachment unknown')
})

test('the panel draws status and offers Start while a service is down', async ($, on) => {
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return ran(0, JSON.stringify(STATUS))
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clodeks', surface, component: 'Pane', requestId: 'clodeks-panel', props: { bodyColumns: 80 } as never })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /0 working, 1 idle, 0 other, 1 exposed/ })).toBeDefined()
    expect(await ui.find({ text: /codex-320152fd/ })).toBeDefined()
    expect(await ui.find({ key: 'start' })).toBeDefined()
    await ui.press({ key: 'start' })
    expect(runs.some(r => r[0] === 'systemctl' && r[2] === 'start')).toBe(true)
    expect(runs.some(r => r[1] === 'status' && r.includes('--band'))).toBe(true)
    await ui.unmount()
  }
})

test('/codex shows idle age and unknown client attachment with the activity hint', async ($, on) => {
  const hint = '1 loaded: 0 working, 1 idle, 0 other. Client attachment is unknown.'
  on('process.run', () => ran(0, JSON.stringify({ threads: [{ ...THREAD, idle_age_seconds: 49 }], hint })))
  const out = await $.command.run(codex(''))
  expect(out.text).toContain('idle age 49s')
  expect(out.text).toContain('client unknown')
  expect(out.text).toContain(hint)
})

test('codex_send forwards explicit queue clearing with interrupt priority', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => {
    seen.push([...e.argv])
    return ran(0, e.argv[1] === 'send' ? '{"ok":true,"delivery":"started"}' : '[]')
  })
  on('env.get', () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias, message: 'Stop.', priority: 'interrupt', clear_queue: true } as never)
  expect(seen.find(a => a[1] === 'send')).toEqual(['clodeks', 'send', '--priority', 'interrupt', '--clear-queue', '--', THREAD.alias])
})

test('codex_send refuses queue clearing without interrupt priority', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => { seen.push([...e.argv]); return ran(0, '{}') })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias, message: 'Stop.', clear_queue: true } as never)
  expect(JSON.stringify(out)).toContain('interrupt')
  expect(seen.some(a => a[1] === 'send')).toBe(false)
})

test('codex_send forwards steer priority and preserves acceptance details', async ($, on) => {
  const seen: { argv: string[]; stdin?: string }[] = []
  on('process.run', ($, e) => {
    seen.push({ argv: [...e.argv], stdin: e.init?.stdin })
    return ran(0, e.argv[1] === 'send' ? '{"ok":true,"delivery":"accepted","steered_turn_id":"active-turn"}' : '[]')
  })
  on('env.get', () => ({ value: undefined }))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias, message: 'Correct item 8.', priority: 'steer' } as never)
  expect(JSON.stringify(out)).toContain('accepted')
  expect(JSON.stringify(out)).toContain('active-turn')
  expect(seen.find(a => a.argv[1] === 'send')).toEqual({
    argv: ['clodeks', 'send', '--priority', 'steer', '--', THREAD.alias], stdin: 'Correct item 8.',
  })
})

test('codex_send refuses queue clearing with steer priority', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => { seen.push([...e.argv]); return ran(0, '{}') })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias, message: 'Correct item 8.', priority: 'steer', clear_queue: true } as never)
  expect(JSON.stringify(out)).toContain('clear_queue requires interrupt')
  expect(seen.some(a => a[1] === 'send')).toBe(false)
})

test('codex_quota reads the shared server snapshot only on request', async ($, on) => {
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return ran(0, '{"scope":"shared-app-server-account","rate_limits":{"primary":{"usedPercent":42}}}')
  })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_quota' } as never)
  expect(JSON.stringify(out)).toContain('shared-app-server-account')
  expect(calls).toEqual([['clodeks', 'quota']])
})

test('codex_quota reports unavailable authentication as a refusal', async ($, on) => {
  on('process.run', () => ran(1, '', 'clodeks: ChatGPT authentication required'))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_quota' } as never)
  expect(JSON.stringify(out)).toContain('ChatGPT authentication required')
})


test('codex_jobs reads private exec records and forwards the stale option', async ($, on) => {
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return ran(0, '{"jobs":[{"pid":123,"state":"running"}],"errors":[],"hint":"Private exec jobs cannot receive shared app-server messages."}')
  })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_jobs', all: true } as never)
  expect(JSON.stringify(out)).toContain('running')
  expect(calls).toEqual([['clodeks', 'jobs', '--all']])
})

test('codex_jobs reports a CLI failure as a refusal', async ($, on) => {
  on('process.run', () => ran(1, '', 'clodeks: job records unavailable'))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_jobs' } as never)
  expect(JSON.stringify(out)).toContain('job records unavailable')
})

test('codex_jobs refuses a non-boolean stale option before CLI execution', async ($, on) => {
  const calls: string[][] = []
  on('process.run', ($, e) => { calls.push([...e.argv]); return ran(0, '{}') })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_jobs', all: 'false' } as never)
  expect(JSON.stringify(out)).toContain('all must be boolean')
  expect(calls).toEqual([])
})

test('codex_send forwards auto priority and sender-scoped replacement', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => {
    seen.push([...e.argv])
    return ran(0, e.argv[1] === 'send' ? '{"ok":true,"delivery":"accepted","queued_count":0}' : '[]')
  })
  on('env.get', () => ({ value: '/run/user/1000/cc-socks/42.sock' }))
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias,
    message: 'New ruling.', priority: 'auto', replace_queued: true } as never)
  expect(JSON.stringify(out)).toContain('accepted')
  expect(seen.find(a => a[1] === 'send')).toEqual(['clodeks', 'send', '--priority', 'auto', '--replace-queued',
    '--reply-to', 'uds:/run/user/1000/cc-socks/42.sock', '--', THREAD.alias])
})

test('codex_send refuses malformed replacement before it runs a command', async ($, on) => {
  const seen: string[][] = []
  on('process.run', ($, e) => { seen.push([...e.argv]); return ran(0, '[]') })
  const out = await $.tool.call({ tool: 'mcp__clodeks__codex_send', thread: THREAD.alias,
    message: 'New ruling.', replace_queued: 'yes' } as never)
  expect(JSON.stringify(out)).toContain('replace_queued must be boolean')
  expect(seen.some(a => a[1] === 'send')).toBe(false)
})

test('/codex send shows an observed idle hint while delivery stays queued', async ($, on) => {
  on('process.run', ($, e) => ran(0, e.argv[1] === 'send'
    ? JSON.stringify({ ok: true, alias: THREAD.alias, delivery: 'queued', observed_status: 'idle', hint: 'A turn start is unconfirmed. Use the owning client.' }) : '[]'))
  on('env.get', () => ({ value: undefined }))
  const out = await $.command.run(codex(`send ${THREAD.alias} Read the ruling`))
  expect(out.text).toContain('(idle)')
  expect(out.text).toContain('start is unconfirmed')
})


test('/codex distinguishes queued idle work and unknown queue depth beside idle age', async ($, on) => {
  on('process.run', () => ran(0, JSON.stringify({ threads: [
    { ...THREAD, idle_age_seconds: 49, queued_count: 2 },
    { ...THREAD, idle_age_seconds: null, queued_count: null },
  ], hint: null })))
  const out = await $.command.run(codex(''))
  expect(out.text).toContain('idle (queued work)')
  expect(out.text).toContain('idle age 49s  queued 2')
  expect(out.text).toContain('idle age unknown  queued unknown')
})

test('/codex displays active approval and user input waits as working', async ($, on) => {
  on('process.run', () => ran(0, JSON.stringify({ threads: [
    { ...THREAD, status: 'active', active_flags: ['waitingOnApproval'] },
    { ...THREAD, status: 'active', active_flags: ['waitingOnUserInput'] },
  ], hint: null })))
  const out = await $.command.run(codex(''))
  expect(out.text).toContain('working (waiting on approval)')
  expect(out.text).toContain('working (waiting on user input)')
})

for (const extra of [{ idle_queued: 1, idle_queue_unknown: 2 }, {}]) {
  test(`/codex status preserves idle queue counts ${JSON.stringify(extra)}`, async ($, on) => {
    on('process.run', () => ran(0, JSON.stringify({ ...STATUS, counts: { ...STATUS.counts, ...extra } })))
    const out = await $.command.run(codex('status'))
    expect(out.text).toContain('idle_queued' in extra
      ? '1 idle with queued work, 2 idle with unknown queue depth'
      : 'unknown idle with queued work, unknown idle with unknown queue depth')
  })
}
