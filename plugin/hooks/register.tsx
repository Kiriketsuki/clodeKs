import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClodeksStatus, CodexThread, InboxHeartbeat } from '../types'

// The mod runs the `clodeks` CLI for all Codex work. A mod has no sockets of its own and its
// child processes take stdin only once, so it cannot hold an app-server connection itself.

const PANE = 'clodeks-panel'
const POLL_MS = 10000
const STALE_POLL_MS = 60000
// Match the heartbeat lifetime in lib/status.mjs.
const HEARTBEAT_MAX_AGE_MS = 20000
const BAND_WRITE_TIMEOUT_MS = 5000
const RUN_TIMEOUT_MS = 20000
const SEND_TIMEOUT_MS = 35000
const INTERRUPT_TIMEOUT_MS = 60000
const BIN = 'clodeks'
const UNITS = ['clodeks-appserver.service', 'clodeks-inboxd.service']

const statusAtom = atom({ plugin: 'clodeks', key: 'status' } as const, null as ClodeksStatus | null)
const errorAtom = atom({ plugin: 'clodeks', key: 'lastError' } as const, null as string | null)

const HELP = [
  '/codex               List loaded Codex threads',
  '/codex all           List stored threads too',
  '/codex send T MSG    Queue MSG into thread T. Codex replies to this session.',
  '/codex status        Show whether clodeKs is enabled and running',
  '/codex panel         Open the clodeKs panel',
].join('\n')

function threadStatusText(thread: CodexThread): string {
  if (thread.status === 'idle' && (thread.queued_count ?? 0) > 0) return 'idle (queued work)'
  if (thread.status !== 'active') return thread.status
  const waits = []
  if (thread.active_flags?.includes('waitingOnApproval')) waits.push('waiting on approval')
  if (thread.active_flags?.includes('waitingOnUserInput')) waits.push('waiting on user input')
  return `working${waits.length ? ` (${waits.join(', ')})` : ''}`
}

function formatThreads({ threads: list, hint }: ThreadList): string {
  const text = list
    .map(t => `${t.alias}  ${threadStatusText(t)}${t.loaded ? '' : ' (stored)'}${t.status === 'idle' ? `  idle age ${t.idle_age_seconds == null ? 'unknown' : `${t.idle_age_seconds}s`}` : ''}  queued ${t.queued_count ?? 'unknown'}  client unknown  ${t.cwd}\n  caller umask ${t.caller_umask ?? 'unknown'}${t.inbox ? `\n  inbox: ${t.inbox}` : ''}${t.preview ? `\n  ${t.preview}` : ''}`)
    .join('\n')
  // The hint separates loaded activity or explains why no thread is loaded.
  return [text, hint].filter(Boolean).join('\n\n')
}

function isServiceUp(st: ClodeksStatus): boolean {
  return st.services.appserver.active === 'active' && st.services.inboxd.active === 'active'
}

function formatStatus(st: ClodeksStatus): string {
  const svc = (name: string, s: ClodeksStatus['services']['appserver']) => `${name}: ${s.enabled}, ${s.active}`
  return [
    `Enabled   mod loaded  ${svc('app-server unit', st.services.appserver)}  ${svc('inboxd unit', st.services.inboxd)}`,
    `Running   app-server ${st.app_server.up ? 'up' : `down (${st.app_server.error ?? 'unknown'})`}  inboxd heartbeat ${st.inboxd.fresh ? 'fresh' : 'none'}  codex ${st.codex.version ?? 'missing'}`,
    `Threads   ${formatCounts(st.counts)}. Client attachment unknown.`,
  ].join('\n')
}

function formatCounts(counts: ClodeksStatus['counts']): string {
  return `${counts.active} working, ${counts.idle ?? 'unknown'} idle, ${counts.other ?? 'unknown'} other, ${counts.exposed} exposed. ${counts.idle_queued ?? 'unknown'} idle with queued work, ${counts.idle_queue_unknown ?? 'unknown'} idle with unknown queue depth`
}

async function runClodeks($: EngineInterface, args: string[], stdin?: string, timeoutMs = RUN_TIMEOUT_MS): Promise<string> {
  const ran = await $.process.run([BIN, ...args], { timeoutMs, ...(stdin === undefined ? {} : { stdin }) })
  if (ran.exitCode !== 0) {
    throw new Error((ran.stderr || ran.stdout || `clodeks exited ${ran.exitCode}`).trim().split('\n').slice(-2).join(' '))
  }
  return ran.stdout
}

type ThreadList = { threads: CodexThread[]; hint: string | null }

async function fetchThreads($: EngineInterface, all: boolean): Promise<ThreadList> {
  const out = await runClodeks($, ['threads', '--json', '--hint', ...(all ? ['--all'] : [])])
  return JSON.parse(out) as ThreadList
}

// Module state resets on each reload. That is fine: it only guards against overlap and redraws.
let isRefreshing = false
let lastSnapshot = ''

async function fetchStatus($: EngineInterface): Promise<ClodeksStatus> {
  return JSON.parse(await runClodeks($, ['status', '--json', '--band'])) as ClodeksStatus
}

async function publishStatus($: EngineInterface, st: ClodeksStatus): Promise<void> {
  const snapshot = JSON.stringify({ ...st, at: 0 })
  if (snapshot === lastSnapshot) return
  await update($, statusAtom, () => st)
  await update($, errorAtom, () => null)
  lastSnapshot = snapshot
}

// Explicit refreshes also read service state and the Codex version.
async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await publishStatus($, await fetchStatus($))
  } catch (err) {
    const message = String((err as Error).message ?? err)
    try {
      if (lastSnapshot !== `error:${message}`) {
        lastSnapshot = `error:${message}`
        await update($, statusAtom, () => null)
        await update($, errorAtom, () => message)
      }
    } catch {
      // The session or the module is gone. The next load refreshes again.
    }
  } finally {
    isRefreshing = false
  }
}

async function readHeartbeat($: EngineInterface): Promise<InboxHeartbeat | null> {
  try {
    let base = await $.env.get('XDG_RUNTIME_DIR')
    if (!base?.startsWith('/')) {
      const procStatus = await $.fs.read('/proc/self/status')
      const uid = /^Uid:\s+(\d+)/m.exec(procStatus)?.[1]
      if (!uid) return null
      base = `/tmp/clodeks-${uid}`
    }
    const path = `${base.replace(/\/+$/, '')}/clodeks/state.json`
    const [text, now] = await Promise.all([$.fs.read(path), $.clock.now()])
    const heartbeat: InboxHeartbeat | null = JSON.parse(text)
    if (heartbeat?.v !== 1 || !Number.isFinite(heartbeat.at) ||
        heartbeat.at > now || now - heartbeat.at > HEARTBEAT_MAX_AGE_MS ||
        !Number.isInteger(heartbeat.pid) || heartbeat.pid <= 0 ||
        typeof heartbeat.app_server?.up !== 'boolean' ||
        (heartbeat.app_server.error !== null && typeof heartbeat.app_server.error !== 'string') ||
        !Number.isInteger(heartbeat.counts?.active) ||
        !Number.isInteger(heartbeat.counts.exposed)) return null
    if (heartbeat.threads !== undefined && (!Array.isArray(heartbeat.threads) ||
        !heartbeat.threads.every(thread => thread && typeof thread.id === 'string' &&
          typeof thread.preview === 'string' && typeof thread.alias === 'string' &&
          typeof thread.status === 'string' && typeof thread.cwd === 'string'))) return null
    return heartbeat
  } catch {
    return null
  }
}

async function pollBand($: EngineInterface): Promise<boolean> {
  const heartbeat = await readHeartbeat($)
  try {
    const current = await read($, statusAtom)
    if (current && !isRefreshing) {
      const inboxd = { fresh: heartbeat !== null, pid: heartbeat?.pid ?? null }
      const next = heartbeat ? {
        ...current,
        at: heartbeat.at,
        app_server: { ...current.app_server, up: heartbeat.app_server.up, error: heartbeat.app_server.error },
        counts: heartbeat.counts,
        threads: heartbeat.threads ?? current.threads,
        inboxd,
      } : { ...current, inboxd }
      await publishStatus($, next)
    }
  } catch {
    // The pane can close while the poll reads its state.
  }
  if (heartbeat) return true
  await runClodeks($, ['status', '--band-only'], undefined, BAND_WRITE_TIMEOUT_MS).catch(() => {})
  return false
}

async function startServices($: EngineInterface): Promise<void> {
  try {
    await $.process.run(['systemctl', '--user', 'start', ...UNITS], { timeoutMs: RUN_TIMEOUT_MS })
  } catch {
    // The panel shows the result of the next refresh.
  }
  await refresh($)
}

// One timer chain per load. A reload drops the old chain's timers.
function schedulePoll($: EngineInterface, delayMs: number): void {
  $.clock.after(delayMs, async () => {
    const fresh = await pollBand($)
    schedulePoll($, fresh ? POLL_MS : STALE_POLL_MS)
  })
}

// Codex replies to the session that sent the message, through that session's inbox socket.
async function replyArgs($: EngineInterface): Promise<string[]> {
  const socket = await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')
  return socket ? ['--reply-to', `uds:${socket}`] : []
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'codex',
      description: 'List Codex threads, message one, or open the clodeKs panel',
      argumentHint: '[all | send THREAD MESSAGE | status | panel]',
    })
    await $.tool.register({
      name: 'codex_threads',
      description:
        'Lists loaded Codex CLI threads on the shared app-server: alias, status, queued_count, cwd, first prompt, and inbox address. ' +
        'Returns {threads, hint}. The hint separates working, idle, and other loaded states. Client attachment stays unknown. ' +
        'Idle age uses the latest terminal turn completedAt. Missing timestamps stay unknown. Snapshots can race changes. ' +
        'When no thread is loaded, hint describes stored threads or unreachable private TUIs. ' +
        'source identifies confirmed wrapper launches as clodeks-tui. Ambiguous vscode origins stay null. backend_source keeps the backend label. ' +
        'For private one-shot run metadata, use codex_jobs. Those jobs cannot receive codex_send messages. ' +
        'Send to a thread with codex_send, or with SendMessage to its inbox address (uds:...). Codex replies arrive as cross-session messages.',
      inputSchema: {
        type: 'object',
        properties: { all: { type: 'boolean', description: 'Include stored threads that are not loaded' } },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'codex_jobs',
      description:
        'Reads private one-shot clodeks run job metadata: PID, cwd, start, elapsed time, state, and thread ID when known. ' +
        'Returns {jobs, errors, hint}. Errors mean discovery is incomplete. Completed runs leave no history. ' +
        'Private exec jobs cannot receive shared app-server messages through codex_send. This tool does not control processes.',
      inputSchema: {
        type: 'object',
        properties: { all: { type: 'boolean', description: 'Include stale records whose process identity no longer matches' } },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'codex_pending',
      description:
        'Lists loaded Codex threads that await approval, with alias, cwd, and active flags. ' +
        'Returns unconfirmed display command candidates from current-turn history and a same-server resume_command. ' +
        'History can be redacted, unavailable, or truncated. Candidates do not identify an exact approval request. ' +
        'Request IDs remain unavailable. Never approve from candidates alone. ' +
        'Does not resume threads or answer prompts. Run resume_command in a terminal if the owning Codex client is gone.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'codex_quota',
      description:
        'Reads quota for the selected shared app-server account. Returns usage windows, reset times, and backend usage permission. ' +
        'This is not a per-thread or all-account view. Missing values stay unknown. Percentages do not prove usage permission. ' +
        'This explicit read does not change authentication, consume reset credits, or start a model turn.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'codex_send',
      description:
        'Queues a message into a live Codex CLI thread (alias like codex-1a2b3c4d, exact name, or thread ID). Default sends keep the original queue CLI. Idle acknowledgements add observed_status and a client hint. Only auto can return queued-idle. ' +
        'Refuses a stored (not loaded) thread or a thread that awaits approval. ' +
        'queued_count observes pending entries. A null count means queue depth is unavailable. ' +
        'Use priority auto to steer active turns or queue idle input, with exact sender-scoped duplicate checks. ' +
        'Set replace_queued to replace only tagged queued snapshot entries from this reply route. Legacy and other senders stay unchanged. ' +
        'Use priority steer to append input to the exact active turn without stopping tools. Acceptance does not confirm that the model read it. ' +
        'Steer refuses idle threads and never falls back to queue or interrupt. ' +
        'Use priority interrupt for urgent input after stopping the active turn. Set clear_queue to delete existing queued snapshot entries first. ' +
        'Concurrent new submissions stay outside that snapshot. Idle threads keep normal queue order. ' +
        'The message tells Codex how to reply to this session, so the answer arrives later as a cross-session message.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: 'Thread alias, unique exact name, or ID from codex_threads' },
          message: { type: 'string', description: 'What Codex should read' },
          priority: { type: 'string', enum: ['queue', 'interrupt', 'steer', 'auto'], description: 'queue by default. auto steers active turns and queues idle input. steer and auto confirm acceptance only.' },
          replace_queued: { type: 'boolean', description: 'Replace tagged queued snapshot entries from this reply route. Default false. Cannot combine with interrupt or clear_queue.' },
          clear_queue: { type: 'boolean', description: 'With interrupt priority, delete queued snapshot entries before delivery. Default false.' },
        },
        required: ['thread', 'message'],
      },
      isDeferred: false,
    })
    schedulePoll($, 0)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__clodeks__codex_threads' }, async ($, e: any) => {
    try {
      // An empty list carries a hint, so the caller learns why nothing is live.
      return { result: JSON.stringify(await fetchThreads($, Boolean(e.all)), null, 1) }
    } catch (err) {
      return { deny: `clodeks: ${(err as Error).message ?? err}` }
    }
  }).catch(() => ({ deny: 'clodeks: the codex_threads hook failed. Run clodeks doctor.' }))

  on('tool.call', { tool: 'mcp__clodeks__codex_send' }, async ($, e: any) => {
    try {
      if (e.priority !== undefined && !['queue', 'interrupt', 'steer', 'auto'].includes(e.priority)) {
        return { deny: 'clodeks: priority must be queue, interrupt, steer, or auto' }
      }
      if (e.clear_queue !== undefined && typeof e.clear_queue !== 'boolean') return { deny: 'clodeks: clear_queue must be boolean' }
      if (e.clear_queue && e.priority !== 'interrupt') return { deny: 'clodeks: clear_queue requires interrupt priority' }
      if (e.replace_queued !== undefined && typeof e.replace_queued !== 'boolean') return { deny: 'clodeks: replace_queued must be boolean' }
      if (e.replace_queued && (e.clear_queue || e.priority === 'interrupt')) return { deny: 'clodeks: replace_queued cannot combine with interrupt or clear_queue' }
      const replaceQueued = e.replace_queued === true ? ['--replace-queued'] : []
      const priority = e.priority === undefined ? [] : ['--priority', String(e.priority)]
      const clearQueue = e.clear_queue === true ? ['--clear-queue'] : []
      const out = await runClodeks($, ['send', ...priority, ...clearQueue, ...replaceQueued, ...(await replyArgs($)), '--', String(e.thread)], String(e.message),
        e.priority === 'interrupt' || e.priority === 'steer' || e.priority === 'auto' || e.replace_queued ? INTERRUPT_TIMEOUT_MS : SEND_TIMEOUT_MS)
      void refresh($)
      return { result: out.trim() }
    } catch (err) {
      return { deny: `clodeks: ${(err as Error).message ?? err}` }
    }
  }).catch(() => ({ deny: 'clodeks: the codex_send hook failed. Run clodeks doctor.' }))

  on('tool.call', { tool: 'mcp__clodeks__codex_jobs' }, async ($, e) => {
    try {
      if (e.all !== undefined && typeof e.all !== 'boolean') return { deny: 'clodeks: all must be boolean' }
      return { result: (await runClodeks($, ['jobs', ...(e.all ? ['--all'] : [])])).trim() }
    } catch (err) {
      return { deny: `clodeks: ${(err as Error).message ?? err}` }
    }
  }).catch(() => ({ deny: 'clodeks: the codex_jobs hook failed. Run clodeks doctor.' }))

  on('tool.call', { tool: 'mcp__clodeks__codex_quota' }, async $ => {
    try {
      return { result: (await runClodeks($, ['quota'])).trim() }
    } catch (err) {
      return { deny: `clodeks: ${(err as Error).message ?? err}` }
    }
  }).catch(() => ({ deny: 'clodeks: the codex_quota hook failed. Run clodeks doctor.' }))

  on('tool.call', { tool: 'mcp__clodeks__codex_pending' }, async $ => {
    try {
      return { result: (await runClodeks($, ['pending'])).trim() }
    } catch (err) {
      return { deny: `clodeks: ${(err as Error).message ?? err}` }
    }
  }).catch(() => ({ deny: 'clodeks: the codex_pending hook failed. Run clodeks doctor.' }))

  on('command.run', { command: 'codex' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    try {
      if (sub === '' || sub === 'list' || sub === 'all') {
        return { text: formatThreads(await fetchThreads($, sub === 'all')) }
      }
      if (sub === 'send') {
        const [thread] = rest
        // Keep the message as typed: everything after the thread, whitespace included.
        const message = e.args.trim().replace(/^send\s+\S+\s*/, '')
        if (!thread || message === '') return { text: 'Usage: /codex send THREAD MESSAGE' }
        const out = JSON.parse(await runClodeks($, ['send', ...(await replyArgs($)), '--', thread], message, SEND_TIMEOUT_MS))
        void refresh($)
        if (out.observed_status === 'idle' || out.delivery === 'queued-idle') return { text: `Queued into ${out.alias} (idle). ${out.hint ?? 'A turn start is unconfirmed.'}` }
        return { text: `Queued into ${out.alias}. The reply arrives here as a cross-session message.` }
      }
      if (sub === 'status') {
        return { text: formatStatus(await fetchStatus($)) }
      }
      if (sub === 'panel' || sub === 'pane') {
        void refresh($)
        await $.ui.open({ id: PANE, title: 'clodeKs' })
        return { text: 'clodeKs panel opened.' }
      }
      return { text: HELP }
    } catch (err) {
      return { text: `clodeks: ${(err as Error).message ?? err}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const st = await read($, statusAtom)
    const error = await read($, errorAtom)
    if (st === null) {
      return (
        <Box flexDirection="column">
          <Text color="red">{error ?? 'Reading clodeKs status...'}</Text>
          <Text dimColor>Check that clodeks is on PATH: clodeks doctor</Text>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
      )
    }
    const mark = (isOk: boolean) => (isOk ? '●' : '○')
    const svc = st.services
    const isEnabled = svc.appserver.enabled === 'enabled' && svc.inboxd.enabled === 'enabled'
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Enabled  </Text>
          <Text color="green">{mark(true)} mod</Text>
          <Text color={svc.appserver.enabled === 'enabled' ? 'green' : 'yellow'}>  {mark(svc.appserver.enabled === 'enabled')} app-server unit</Text>
          <Text color={svc.inboxd.enabled === 'enabled' ? 'green' : 'yellow'}>  {mark(svc.inboxd.enabled === 'enabled')} inboxd unit</Text>
        </Text>
        <Text>
          <Text bold>Running  </Text>
          <Text color={st.app_server.up ? 'green' : 'red'}>{mark(st.app_server.up)} app-server</Text>
          <Text color={st.inboxd.fresh ? 'green' : 'red'}>  {mark(st.inboxd.fresh)} inboxd</Text>
          <Text dimColor>  codex {st.codex.version ?? 'missing'}</Text>
        </Text>
        <Text>
          <Text bold>Threads  </Text>
          {formatCounts(st.counts)}
        </Text>
        <Text dimColor>Client attachment unknown.</Text>
        {!st.app_server.up && st.app_server.error !== null && <Text dimColor>  {st.app_server.error}</Text>}
        <Text dimColor>{'─'.repeat(Math.max(10, Math.min(60, (e.props.bodyColumns ?? 40) - 2)))}</Text>
        {st.threads.length === 0 && <Text dimColor>No loaded Codex threads. Start one with: clodeks tui</Text>}
        {st.threads.map(t => (
          <Box key={t.id} flexDirection="column">
            <Text bold={t.status === 'active'}>
              {t.alias} <Text dimColor>{t.status}{t.exposed ? '  exposed' : ''}</Text>
            </Text>
            <Text dimColor>  {t.cwd}</Text>
            {t.preview !== '' && <Text dimColor>  {t.preview.slice(0, 80)}</Text>}
          </Box>
        ))}
        <Box>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          {(!isServiceUp(st) || !isEnabled) && (
            <Button key="start" label="Start services" onPress={() => startServices($)} />
          )}
        </Box>
      </Box>
    )
  })
}
