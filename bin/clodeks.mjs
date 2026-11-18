#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { connectAppServer, explainNoThreads, listPendingApprovals, listThreads, readQuota, MAX_QUEUE_CHARS, resolveThread } from '../lib/appserver.mjs'
import { listJobs } from '../lib/jobs.mjs'
import { runExec, SANDBOXES } from '../lib/exec.mjs'
import { codexPromptFor, inboxSocketFor, markExposedThread, serveInbox, setExposed, startInboxDaemon } from '../lib/inbox.mjs'
import { claudeConfigDirs, defaultAppSocket, privateRuntimeDir, resolveCodex } from '../lib/paths.mjs'
import { readState, sharedStatus } from '../lib/status.mjs'
import { DEFAULT_MIN_LOADED, recycleIfIdle } from '../lib/recycle.mjs'
import { acquireRecycleLock, withRecycleDelivery } from '../lib/recycle-lock.mjs'
import { offBand, writeBand } from '../lib/band.mjs'
import { appendToOutbox, listClaudeSessions, resolveClaudeTarget, sendToClaude } from '../lib/peers.mjs'
import { queueItemSummary, readQueueSnapshot, requireIdleQueue } from '../lib/queue.mjs'
import { declinePendingApproval } from '../lib/pending-decline.mjs'
import { readFolderTrust, trustFolder } from '../lib/trust.mjs'
import { briefHeading, readLaunchWindow } from '../lib/tui-identity.mjs'
import { observeBriefLaunch } from '../lib/tui-launch.mjs'
import { deliverMessage, INTERRUPT_BUDGET_MS } from '../lib/messages.mjs'
import { createLaunchRecord } from '../lib/launch-record.mjs'
import { appServerUmask, callerUmask } from '../lib/umask.mjs'
import { prepareAddDirs } from '../lib/add-dirs.mjs'
import { DEFAULT_PRESSURE_LIMITS, parseGate, waitForGate } from '../lib/gate.mjs'
import { tuiSubcommand } from '../lib/tui-args.mjs'
import { tuiReplyContext } from '../lib/tui-reply.mjs'
import { PR_BODY_CONTEXT } from '../lib/pr-body-context.mjs'
import { readStdin } from '../lib/stdin.mjs'
import { parseRunLimits } from '../lib/run-guard.mjs'
import { validateIsolatedLoopback } from '../lib/loopback.mjs'
import { validateNetworkHosts } from '../lib/network-host.mjs'
import { idleQueueHint, threadActivityHint, threadStatusText } from '../lib/thread-activity.mjs'

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CODEX_SUBCOMMANDS = new Set([
  'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'plugin',
  'app-server', 'remote-control', 'completion', 'update', 'doctor', 'sandbox', 'debug',
  'apply', 'a', 'resume', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db',
  'unarchive', 'fork', 'cloud', 'exec-server', 'features', 'help',
])

const USAGE = `clodeks: Claude Code and Codex CLI bridge

  clodeks run [--schema F | --schema-json J] [--cwd D] [--sandbox S | --write] [--model M] [--effort E]
             [--timeout SEC] [--resume ID] [--ephemeral] [--hooks] [--relay] [--add-dir D]... [--git | --push]
             [--min-memavail SIZE] [--max-rss SIZE] [--max-minutes N]
             [--loopback-isolated | --network-host HOST]...
             [--prompt TEXT] [--retain-report NAME]... [--wait-gate LIMITS] [--gate-timeout DURATION] [--gate-jitter SEC]
      Runtime guards stop only this run group. RSS sums group members. Memory guards require Linux.
      One Codex turn. The prompt comes from --prompt or stdin. Prints one JSON result line.
      --retain-report copies a named .md or .txt report from private scratch or temp before cleanup.
      At most eight basenames and one MiB total. Private state reports expire after seven days.
      --relay lets the run message its parent Claude session (claude-send --to self). Needs --write.
      --add-dir makes one more folder writable. Repeat it for more. Needs --write.
      --git makes the repo's git dirs writable, so Codex can commit, and fetches before the run.
      --push also pushes the branch after a good run. clodeks fetches and pushes outside the
      sandbox. --network-host grants only named-host access. Both need --write.
      --loopback-isolated allows private per-command loopback sockets. Host loopback stays unreachable.
      It requires Linux, tested Codex 0.169.0, and no managed requirements. Wildcard and IPv6 binds stay private.
      --network-host permits an exact public DNS host through the managed proxy. Repeat for more hosts.
      It requires Linux and tested Codex 0.169.0. Admission logs are best effort and complete is false.
      Run and TUI check memory PSI and the swap-in rate before launch.
      Without --wait-gate, the same limit must fail three samples to refuse launch.
      --wait-gate waits for the limits. --gate-timeout defaults to 60m.
      Keys: memavail=SIZE, load=N, psi=N, psifull=N, swapin=N, swap=SIZE.
      Default ceilings: psi=20%, psifull=5%, swapin=2000 pages/s.
      Use off for psi, psifull, swapin, or swap. The swap limit is opt-in.
      --gate-jitter sets the random delay ceiling in seconds (default 15, zero allowed).
      K, M, G, and T mean binary units. Gate refusals and timeouts exit 75.

  clodeks serve [--socket P]          Run the shared Codex app-server (foreground).
  clodeks tui [--socket P] [--cwd D] [--brief F] [--reply-to T] [--expose] [--trust] [--permissions ask|auto|read-only]
              [--wait-gate LIMITS] [--gate-timeout DURATION] [--gate-jitter SEC] [-- ARGS]
      Start an interactive Codex TUI on the shared app-server. --brief F starts it on the text of F.
      --brief does not skip the folder trust prompt. For an unattended launch in a folder you trust:
        clodeks tui --cwd DIR --trust --brief FILE
      New TUI sessions default to ask (workspace write with approval on request).
      auto uses Codex automatic approval review. read-only prevents workspace writes.
      Forwarded Codex subcommands keep their own permission settings.
      --cwd selects an existing primary workspace for a new TUI session. It defaults to the launch folder.
      For resume, --cwd is ignored with a warning. The saved workspace and permissions apply.
      --trust persists trust for the selected workspace on the shared server before a new TUI starts.
      --reply-to T adds a Claude reply route to a new brief launch. T uses claude-send target syntax.
      --expose marks the confirmed brief thread for inboxd. A running inboxd serves its inbox on the next poll.
  clodeks threads [--socket P] [--limit N] [--all] [--json] [--hint]
      List Codex threads on the shared app-server. --hint with --json prints {threads, hint}.
      Working and idle counts differ. Client attachment stays unknown. Idle age needs a terminal turn timestamp.
      For private one-shot runs, use clodeks jobs. Those jobs cannot receive codex_send messages.
  clodeks close THREAD [--socket P] | close --idle [--dry-run] [--older-than DURATION]
      Every form of close refuses on Codex 0.169.0, including --idle, --dry-run, and --older-than.
      The protocol has no safe conditional thread/unload RPC.
      No thread is archived, unsubscribed, or changed. Use threads for read-only activity.
  clodeks recycle --if-idle [--dry-run] [--min-loaded N]
      Recycle the managed user service after ten verified quiet minutes. Default minimum: 10 idle threads.
      Approvals and in-flight deliveries defer it. One restart per hour at most.
      --dry-run reports eligibility and records observations without restarting.
  clodeks queue list THREAD [--show-text] [--socket P]
  clodeks queue clear THREAD [--id ID] [--dry-run] [--socket P]
      Inspect or clear queued submissions for a persistent idle thread.
      Clear prints the snapshot before deletion. Dry run only prints the snapshot.
  clodeks jobs [--all]
      Print private one-shot run metadata as JSON. Read only. --all includes stale records.
      Completed runs leave no history. These jobs cannot receive shared app-server messages.
  clodeks pending [--socket P]
      List approval waits and manual recovery commands without attaching.
  clodeks pending decline THREAD [--dry-run] [--socket P]
      Preview an orphaned command or file approval that is at least 30 minutes old.
      Decline that request and detach. Dry run previews and detaches without an answer.
  clodeks quota [--socket P]
      Print account quota as JSON from the selected shared app-server. Missing values remain unknown.
  clodeks send THREAD MESSAGE... [--socket P] [--priority queue|interrupt|steer|auto] [--clear-queue] [--replace-queued] [--reply-to T] [--from-name N] [--raw] [--allow-stored]
      Queue a message into a live Codex thread. Inside Claude, replies come back to that session.
      interrupt stops the current turn and starts the urgent input. Idle threads use normal queue delivery.
      steer appends input to the exact active turn. It confirms acceptance only and refuses idle threads.
      auto steers an active turn and queues idle input. Exact duplicates use the resolved reply route.
      --replace-queued deletes only this sender's tagged snapshot entries. It requires a reply route.
      Queue counts are observations. Unknown counts stay null. Queued delivery does not confirm a started turn.
      --clear-queue requires interrupt priority and deletes queued snapshot entries before delivery.
      A stored thread has no runner, so send refuses it unless --allow-stored is given.
  clodeks inbox THREAD [--socket P]   Serve a Claude-facing inbox socket for a Codex thread.
  clodeks expose THREAD | unexpose THREAD [--socket P]
      Let Claude sessions message a thread through inboxd, or stop it.
  clodeks inboxd [--socket P] [--interval SEC] [--all]
      Serve an inbox for every exposed live thread (--all: every live thread).

  clodeks peers [--json] [--diagnostics]
      List live Claude sessions across account folders. Text output lists searched registries.
      --json keeps the session array. Add --diagnostics for {sessions, searched_registries}.
  clodeks claude-send --to T [--socket P] [--message M] [--from-name N] [--reply-thread THREAD]
      Message a Claude session. T is self, a session name, a session id, a pid or uds:PATH.

  clodeks status [--json] [--band]    Services, app-server, threads and the inboxd heartbeat.
      --band also writes the clodeks-off item for the chrysaki band.
  clodeks status --band-only          Publish the off item if the inboxd heartbeat is stale.
  clodeks doctor                      Check the setup.
`

function parseCommandArgs(config) {
  const parsed = parseArgs({
    ...config,
    options: { ...config.options, help: { type: 'boolean', short: 'h', default: false } },
  })
  if (parsed.values.help) {
    const command = process.argv[2] === 'unexpose' ? 'expose' : process.argv[2]
    const section = USAGE.split(/(?=^  clodeks )/m).find(text => text.startsWith(`  clodeks ${command} `))
    process.stdout.write(`${(section ?? USAGE).trimEnd()}\n\n  -h, --help  Show this command help.\n`)
    process.exit(0)
  }
  return parsed
}

function fail(message, code = 1) {
  process.stderr.write(`clodeks: ${message}\n`)
  process.exit(code)
}

function positiveNumber(value, flag) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) fail(`${flag} must be a positive number`, 2)
  return n
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function launchGate(values) {
  try {
    return { ...DEFAULT_PRESSURE_LIMITS, ...parseGate(values['wait-gate'], values['gate-timeout'], values['gate-jitter']) }
  } catch (err) {
    fail(err.message, 2)
  }
}

async function holdForGate(gate, runResult = false) {
  try {
    const report = await waitForGate(gate, { onNotice: message => process.stderr.write(`clodeks gate: ${message}\n`) })
    const { waited_ms, wait_reasons, jitter_ms, psi_some_avg10, psi_full_avg10, swap_in_pages_per_sec, swap_used_bytes } = report
    return { waited_ms, wait_reasons, jitter_ms, psi_some_avg10, psi_full_avg10, swap_in_pages_per_sec, swap_used_bytes }
  } catch (err) {
    if (runResult) printJson({
      ok: false, thread_id: null, result: null, text: '', usage: null, commands_run: 0,
      files_changed: [], exit_code: null, duration_ms: err.gate?.waited_ms ?? 0,
      error: err.message, gate: err.gate,
    })
    fail(err.message, ['GATE_TIMEOUT', 'GATE_REFUSED'].includes(err.code) ? 75 : 1)
  }
}

async function cmdRun(argv) {
  const { values } = parseCommandArgs({
    args: argv,
    options: {
      schema: { type: 'string' },
      'schema-json': { type: 'string' },
      cwd: { type: 'string' },
      sandbox: { type: 'string', default: 'read-only' },
      write: { type: 'boolean', default: false },
      'loopback-isolated': { type: 'boolean', default: false },
      'network-host': { type: 'string', multiple: true, default: [] },
      model: { type: 'string' },
      effort: { type: 'string' },
      timeout: { type: 'string', default: '900' },
      'min-memavail': { type: 'string' },
      'max-rss': { type: 'string' },
      'max-minutes': { type: 'string' },
      resume: { type: 'string' },
      ephemeral: { type: 'boolean', default: false },
      hooks: { type: 'boolean', default: false },
      relay: { type: 'boolean', default: false },
      'add-dir': { type: 'string', multiple: true, default: [] },
      'retain-report': { type: 'string', multiple: true, default: [] },
      git: { type: 'boolean', default: false },
      push: { type: 'boolean', default: false },
      prompt: { type: 'string' },
      'wait-gate': { type: 'string' },
      'gate-timeout': { type: 'string' },
      'gate-jitter': { type: 'string' },
    },
  })
  const gate = launchGate(values)
  let resourceLimits
  try {
    resourceLimits = parseRunLimits({ minMemavail: values['min-memavail'], maxRss: values['max-rss'], maxMinutes: values['max-minutes'] })
  } catch (err) { fail(err.message, 2) }
  const sandbox = values.write ? 'workspace-write' : values.sandbox
  if (!SANDBOXES.includes(sandbox)) fail(`--sandbox must be one of ${SANDBOXES.join(', ')}`, 2)
  if (values['loopback-isolated']) {
    try { validateIsolatedLoopback(sandbox) } catch (err) { fail(err.message, 2) }
  }
  let networkHosts
  try {
    networkHosts = validateNetworkHosts({ sandbox, networkHosts: values['network-host'], loopbackIsolated: values['loopback-isolated'] })
  } catch (err) { fail(err.message, 2) }
  const timeoutSec = Number(values.timeout)
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) fail('--timeout must be a positive number of seconds', 2)
  if (values.schema && values['schema-json'] !== undefined) fail('use --schema or --schema-json, not both', 2)
  // clodeks reads the schema file itself, so a /dev/fd path from a heredoc works. Codex
  // gets a copy in the run folder.
  let schemaJson = values['schema-json']
  if (values.schema) {
    try {
      schemaJson = readFileSync(resolve(values.schema), 'utf8')
    } catch (err) {
      fail(`cannot read the schema file ${values.schema}: ${err.code ?? err.message}`, 2)
    }
  }
  if (schemaJson !== undefined) {
    try {
      const parsed = JSON.parse(schemaJson)
      if (parsed?.type !== 'object') fail('the schema must be a JSON schema with "type": "object"', 2)
    } catch {
      fail('the schema is not valid JSON', 2)
    }
  }
  const cwd = resolve(values.cwd ?? process.cwd())
  if (!existsSync(cwd)) fail(`cwd not found: ${cwd}`, 2)
  const prompt = values.prompt ?? await readStdin()
  if (!prompt.trim()) fail('empty prompt: pass --prompt or pipe it on stdin', 2)
  let addDirs
  try {
    addDirs = prepareAddDirs(values['add-dir'].map(d => resolve(d)), { cwd, sandbox })
  } catch (err) {
    fail(err.message, 2)
  }

  const gateReport = await holdForGate(gate, true)
  process.stderr.write(`clodeks run: caller umask ${callerUmask() ?? 'unknown'}. The worker shell umask is unmeasured.\n`)
  const result = await runExec({
    prompt,
    schemaJson,
    cwd,
    sandbox,
    loopbackIsolated: values['loopback-isolated'],
    networkHosts,
    model: values.model,
    effort: values.effort,
    timeoutMs: timeoutSec * 1000,
    resourceLimits,
    resume: values.resume,
    ephemeral: values.ephemeral,
    hooks: values.hooks,
    relay: values.relay,
    addDirs,
    retainReports: values['retain-report'],
    git: values.git || values.push,
    push: values.push,
  })
  printJson({ ...result, gate: gateReport })
  process.exitCode = result.ok ? 0 : 1
}

// A refused connection can leave an old socket file. A listener can still own an unanswered socket.
async function clearStaleSocket(socket) {
  const before = lstatSync(socket, { throwIfNoEntry: false })
  if (!before) return
  if (!before.isSocket() && !before.isSymbolicLink()) throw new Error(`${socket} is not a Unix socket`)

  let probe
  try {
    probe = await connectAppServer(socket, { deadlineMs: Date.now() + 1500 })
  } catch (error) {
    const current = lstatSync(socket, { throwIfNoEntry: false })
    if (!current) return
    if (before.dev !== current.dev || before.ino !== current.ino || before.ctimeMs !== current.ctimeMs) {
      throw new Error(`the socket at ${socket} changed during the probe. Retry serve.`)
    }
    // Codex can leave a link to its private socket. Unlink the requested path itself.
    const target = current.isSymbolicLink() ? statSync(socket, { throwIfNoEntry: false }) : current
    if (target && !target.isSocket()) throw new Error(`${socket} is not a Unix socket`)
    if (target && error.code !== 'ECONNREFUSED') {
      throw new Error(`the listener on ${socket} did not answer the app-server probe. Check the existing listener before you retry.`)
    }
    if (process.getuid && current.uid !== process.getuid()) {
      throw new Error(`the stale socket at ${socket} belongs to another user`)
    }
    unlinkSync(socket)
    return
  }
  probe.close({ immediate: true })
  throw new Error(`an app-server already listens on ${socket}`)
}

async function cmdServe(argv) {
  const { values } = parseCommandArgs({ args: argv, options: { socket: { type: 'string' } } })
  const socket = values.socket ?? defaultAppSocket()
  if (values.socket) mkdirSync(dirname(socket), { recursive: true, mode: 0o700 })
  else privateRuntimeDir()
  await clearStaleSocket(socket)
  const child = spawn(resolveCodex(), ['app-server', '--listen', `unix://${socket}`], { stdio: 'inherit' })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  process.on('SIGHUP', terminate)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 0))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    process.off('SIGHUP', terminate)
  }
}

async function cmdTui(argv) {
  const { values, positionals } = parseCommandArgs({
    args: argv,
    options: {
      socket: { type: 'string' },
      brief: { type: 'string' },
      'reply-to': { type: 'string' },
      expose: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      trust: { type: 'boolean', default: false },
      permissions: { type: 'string', default: 'ask' },
      'wait-gate': { type: 'string' },
      'gate-timeout': { type: 'string' },
      'gate-jitter': { type: 'string' },
    },
    allowPositionals: true,
  })
  const gate = launchGate(values)
  const forwardedSubcommand = tuiSubcommand(positionals, CODEX_SUBCOMMANDS)
  if (values['reply-to'] !== undefined) {
    if (!values.brief) fail('--reply-to requires --brief', 2)
    if (forwardedSubcommand) fail('--reply-to is only supported for a new TUI session', 2)
  }
  const forwardedCwd = positionals.some(arg => arg.startsWith('-C') ||
    arg === '--cd' || arg.startsWith('--cd=') || arg === '--worktree')
  if (values.expose) {
    if (!values.brief) fail('--expose requires --brief', 2)
    if (forwardedSubcommand) fail('--expose is only supported for a new TUI session', 2)
    if (forwardedCwd) fail('--expose cannot be combined with forwarded cwd flags. Use --cwd instead.', 2)
  }
  let cwd = process.cwd()
  if (values.cwd !== undefined) {
    if (forwardedSubcommand && forwardedSubcommand !== 'resume') fail('--cwd is only supported for a new TUI session', 2)
    if (forwardedCwd) fail('--cwd cannot be combined with forwarded cwd flags', 2)
    if (forwardedSubcommand === 'resume') {
      process.stderr.write('clodeks tui: ignoring --cwd for resume. The saved workspace and permissions apply.\n')
    } else {
      if (!values.cwd) fail('--cwd needs an existing folder', 2)
      try {
        cwd = realpathSync(resolve(values.cwd))
        if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
      } catch {
        fail(`--cwd needs an existing folder: ${values.cwd}`, 2)
      }
    }
  }
  if (values.trust && forwardedSubcommand) {
    fail('--trust is only supported for a new TUI session', 2)
  }
  if (!['ask', 'auto', 'read-only'].includes(values.permissions)) {
    fail('--permissions must be one of ask, auto, read-only', 2)
  }
  const sandbox = values.permissions === 'read-only' ? 'read-only' : 'workspace-write'
  // Remote resume rejects permission overrides. Forward subcommands without TUI defaults.
  // Config defaults let explicit Codex flags after -- take precedence for new sessions.
  const permissions = forwardedSubcommand ? [] : [
    '-c', `sandbox_mode="${sandbox}"`,
    ...(values.permissions === 'auto' ? ['--approve-for-me'] : ['-c', 'approval_policy="on-request"']),
  ]
  const socket = values.socket ?? defaultAppSocket()
  // A brief goes in as the first prompt. A paste into the TUI composer is not submitted.
  const brief = []
  let launchId
  let briefName
  let tmuxWindowName
  if (values.brief) {
    let text
    try {
      text = readFileSync(values.brief, 'utf8')
    } catch (err) {
      fail(`cannot read the brief ${values.brief}: ${err.code ?? err.message}`, 2)
    }
    if (!text.trim()) fail(`the brief ${values.brief} is empty`, 2)
    briefName = briefHeading(text)
    tmuxWindowName = readLaunchWindow()
    if (!forwardedSubcommand) text = `${PR_BODY_CONTEXT}\n\n${text}`
    if (values['reply-to'] !== undefined) {
      try {
        text = `${tuiReplyContext(values['reply-to'], socket)}\n${text}`
      } catch (err) {
        fail(`--reply-to: ${err.message}`, 2)
      }
    }
    if (!forwardedSubcommand) {
      launchId = randomUUID()
      text = `[clodeks launch ${launchId}]\n${text}`
    }
    if (text.length > MAX_QUEUE_CHARS) fail(`the brief is ${text.length} characters. One argument takes at most ${MAX_QUEUE_CHARS}.`, 2)
    brief.push(text)
  }
  const gateReport = await holdForGate(gate)
  return withRecycleDelivery(socket, () => launchTui({
    values, positionals, cwd, socket, gateReport, permissions, brief, launchId,
    briefName, tmuxWindowName, forwardedCwd, forwardedSubcommand,
  }))
}

async function launchTui({
  values, positionals, cwd, socket, gateReport, permissions, brief, launchId,
  briefName, tmuxWindowName, forwardedCwd, forwardedSubcommand,
}) {
  if (!existsSync(socket)) throw new Error(`no app-server at ${socket}. Start it with: clodeks serve`)
  const codex = resolveCodex()
  let terminalOwned = false
  const notice = message => {
    if (!terminalOwned) process.stderr.write(`clodeks tui: ${message}\n`)
  }
  const workerMask = await appServerUmask(socket)
  const workerMaskText = workerMask.worker_shell_umask
    ? `worker shell umask ${workerMask.worker_shell_umask} (source app-server). Shell startup can change it.`
    : 'worker shell umask is unmeasured.'
  notice(`caller umask ${callerUmask() ?? 'unknown'}. The ${workerMaskText}`)
  if (values.trust) await trustFolder(socket, cwd)
  else if (launchId) {
    if (forwardedCwd) {
      notice('cannot check cwd trust with forwarded cwd flags. Use --cwd for a trust check.')
    } else {
      try {
        if (await readFolderTrust(socket, cwd) === 'prompt') {
          notice('cwd is not trusted, the Codex trust dialog will wait for a key press, add --trust for an unattended launch')
        }
      } catch {
        notice('cannot check cwd trust. The Codex trust dialog may wait for a key press. Add --trust for an unattended launch.')
      }
    }
  }
  let record
  let recordWriteFailed = false
  if (launchId) {
    const onError = err => {
      recordWriteFailed = true
      notice(`cannot persist launch record: ${err.message}`)
    }
    try {
      record = createLaunchRecord({ launchId, cwd, briefPath: resolve(values.brief), onError, workerMask, gate: gateReport, expose: values.expose, tmuxWindowName })
      notice(`launch record ${record.path}`)
    } catch (err) {
      onError(err)
    }
  }
  let exposureMarked = false
  const aliasWarning = message => {
    record?.unavailable(message)
    if (values.expose) record?.exposure('unavailable', message)
    notice(message)
  }
  let observer
  if (launchId && forwardedCwd) {
    aliasWarning('alias observation skipped because forwarded cwd flags can change the launch folder.')
  } else if (launchId) {
    try {
      observer = await observeBriefLaunch(socket, {
        cwd, brief: brief[0], launchId, name: briefName,
        onName: (name, error) => record?.naming(name, error),
        onAlias: (alias, threadId) => {
          record?.identified(alias, threadId)
          if (values.expose) {
            try {
              markExposedThread(threadId, true)
              exposureMarked = true
              record?.exposure('marked')
            } catch (err) {
              record?.exposure('failed', err.message)
            }
          }
        },
        onWarning: aliasWarning,
      })
    } catch (err) {
      aliasWarning(`brief thread alias is unavailable: ${err.message}`)
    }
  }
  terminalOwned = true
  // Explicit remote -C becomes a resume cwd override in Codex 0.169.0.
  const cwdArgs = forwardedSubcommand === 'resume' ? [] : ['-C', cwd]
  const child = spawn(codex, ['--remote', `unix://${socket}`, ...cwdArgs, ...permissions, ...positionals, ...brief], { stdio: 'inherit' })
  child.on('error', err => {
    terminalOwned = false
    observer?.close()
    record?.unavailable(`cannot start Codex: ${err.message}`)
    record?.finished()
    fail(`cannot start Codex: ${err.message}`)
  })
  child.on('close', code => {
    observer?.close()
    record?.finished()
    terminalOwned = false
    if (recordWriteFailed) notice('launch record writes failed during this session. Check the record before using its alias.')
    if (values.expose && !exposureMarked) notice('inbox exposure did not complete. Check the launch record or use clodeks expose THREAD.')
    process.exit(code ?? 0)
  })
}

async function cmdThreads(argv) {
  const { values } = parseCommandArgs({
    args: argv,
    options: {
      socket: { type: 'string' },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      hint: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' },
    },
  })
  const socket = values.socket ?? defaultAppSocket()
  const listed = await listThreads(socket, { all: values.all, includeActivity: true, limit: positiveNumber(values.limit, '--limit') })
  // A thread with a running inbox is reachable from Claude with SendMessage to this address.
  const threads = listed.map(t => ({ ...t, inbox: existsSync(inboxSocketFor(t.alias)) ? `uds:${inboxSocketFor(t.alias)}` : null }))
  // An empty list says why, so a caller does not read it as "no Codex work runs".
  const hint = threads.some(t => t.loaded) ? threadActivityHint(threads) : await explainNoThreads(socket)
  if (values.json) return printJson(values.hint ? { threads, hint } : threads)
  if (threads.length === 0) return console.log(hint)
  console.log(hint)
  for (const t of threads) {
    const idleAge = t.status === 'idle' ? `  idle age ${t.idle_age_seconds === null ? 'unknown' : `${t.idle_age_seconds}s`}` : ''
    const status = threadStatusText(t)
    console.log(`${t.alias.padEnd(16)} ${status.padEnd(9)} ${t.loaded ? 'loaded' : 'stored'}${idleAge}  queued ${t.queued_count ?? 'unknown'}  client unknown  ${t.inbox ? 'inbox ' : '      '} ${t.cwd}  caller umask ${t.caller_umask ?? 'unknown'}  worker shell umask ${t.worker_shell_umask ?? 'unknown'} (source ${t.worker_shell_umask_source ?? 'unknown'})  ${t.preview.slice(0, 60)}`)
  }
}

function cmdClose(argv) {
  parseCommandArgs({ args: argv, allowPositionals: true, options: {
    socket: { type: 'string' }, idle: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'older-than': { type: 'string' },
  } })
  fail('Codex 0.169.0 has no safe conditional thread/unload RPC. Close is unavailable. No thread changed.', 2)
}

async function cmdRecycle(argv) {
  const { values } = parseCommandArgs({ args: argv, options: {
    'if-idle': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'min-loaded': { type: 'string' },
  } })
  if (!values['if-idle']) fail('use clodeks recycle --if-idle', 2)
  const minimum = values['min-loaded'] ?? process.env.CLODEKS_RECYCLE_MIN_LOADED ?? String(DEFAULT_MIN_LOADED)
  if (!/^[1-9]\d*$/.test(minimum) || !Number.isSafeInteger(Number(minimum))) {
    fail('minimum loaded threads must be a positive integer', 2)
  }
  const result = await recycleIfIdle({ socket: defaultAppSocket(), dryRun: values['dry-run'], minLoaded: Number(minimum) })
  printJson(result)
  if (result.outcome === 'failed') process.exitCode = 1
}

function cmdJobs(argv) {
  const { values } = parseCommandArgs({ args: argv, options: { all: { type: 'boolean', default: false } } })
  printJson(listJobs({ all: values.all }))
}

async function cmdQueue(argv) {
  const { values, positionals: [action, ref, ...extra] } = parseCommandArgs({
    args: argv,
    options: {
      socket: { type: 'string' },
      id: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'show-text': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })
  const clear = action === 'clear'
  if ((!clear && action !== 'list') || !ref?.trim() || extra.length) {
    fail('Use clodeks queue list THREAD or clodeks queue clear THREAD.', 2)
  }
  if ((!clear && (values.id !== undefined || values['dry-run'])) || (clear && values['show-text'])) {
    fail('Use --id and --dry-run with clear. Use --show-text with list.', 2)
  }
  if (values.id !== undefined && !values.id.trim()) fail('--id needs a submission ID.', 2)

  const socket = values.socket ?? defaultAppSocket()
  const mutate = clear && !values['dry-run']
  const lease = mutate ? await acquireRecycleLock(socket, { mode: 'exclusive' }) : null
  if (mutate && !lease) throw new Error('Delivery, queue clearing, or recycle is in progress. Try again later.')
  let client
  try {
    const deadlineMs = Date.now() + INTERRUPT_BUDGET_MS
    const threadId = THREAD_ID.test(ref) ? ref.toLowerCase() : (await resolveThread(socket, ref, { deadlineMs })).id
    client = await connectAppServer(socket, { deadlineMs })
    await requireIdleQueue(client, threadId)
    const snapshot = await readQueueSnapshot(client, threadId)
    const items = values.id === undefined ? snapshot : snapshot.filter(item => item.id === values.id)
    if (values.id !== undefined && !items.length) throw new Error(`Queue submission ${values.id} is missing.`)

    const now = Date.now()
    const entries = items.map(item => queueItemSummary(item, { now, preview: clear || values['show-text'] }))
    const output = { thread_id: threadId, entries, ...(clear ? { dry_run: values['dry-run'] } : {}) }
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(output) + '\n',
      err => err ? reject(err) : resolve()))
    if (!mutate) return
    for (const item of items) {
      await requireIdleQueue(client, threadId)
      try {
        const response = await client.request('thread/queue/delete', { threadId, queuedSubmissionId: item.id })
        if (response?.deleted !== true) throw new Error('The server did not confirm deletion.')
      } catch (err) {
        throw new Error(`Queue submission ${item.id} deletion is unconfirmed. ${err.message}`, { cause: err })
      }
      process.stderr.write(`clodeks queue: deleted ${JSON.stringify(item.id)} from ${JSON.stringify(threadId)}.\n`)
    }
  } finally {
    client?.close()
    lease?.close()
  }
}

async function cmdSend(argv) {
  const { values, positionals } = parseCommandArgs({
    args: argv,
    options: {
      socket: { type: 'string' },
      'reply-to': { type: 'string' },
      'from-name': { type: 'string' },
      raw: { type: 'boolean', default: false },
      'allow-stored': { type: 'boolean', default: false },
      priority: { type: 'string', default: 'queue' },
      'clear-queue': { type: 'boolean', default: false },
      'replace-queued': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })
  const [ref, ...words] = positionals
  if (!['queue', 'interrupt', 'steer', 'auto'].includes(values.priority)) fail('--priority must be queue, interrupt, steer, or auto', 2)
  if (values['clear-queue'] && values.priority !== 'interrupt') fail('--clear-queue requires --priority interrupt', 2)
  if (values['replace-queued'] && (values['clear-queue'] || values.priority === 'interrupt')) fail('--replace-queued cannot combine with interrupt or --clear-queue', 2)
  if (!ref) fail('usage: clodeks send THREAD MESSAGE...', 2)
  const body = words.join(' ') || await readStdin()
  if (!body.trim()) fail('empty message', 2)
  const socket = values.socket ?? defaultAppSocket()
  await withRecycleDelivery(socket, async lockFd => {
    const deadlineMs = Date.now() + INTERRUPT_BUDGET_MS
    const thread = await resolveThread(socket, ref, values.priority !== 'queue' ? { deadlineMs } : {})
    // codex queue accepts a message for a stored thread, but no client runs it until someone
    // resumes the thread. The message would sit there unseen.
    if (!thread.loaded && !values['allow-stored']) {
      throw new Error(
        `${thread.alias} is not loaded (status ${thread.status}), so nothing would run this message. ` +
          `Resume it first: clodeks tui -- resume ${thread.id}. Or pass --allow-stored to queue it anyway.`,
      )
    }
    // Inside a Claude session the reply address defaults to that session's own inbox.
    let replyTo = values['reply-to'] ?? (process.env.CLAUDE_CODE_MESSAGING_SOCKET ? `uds:${process.env.CLAUDE_CODE_MESSAGING_SOCKET}` : undefined)
    if (replyTo && !replyTo.startsWith('uds:')) replyTo = `uds:${resolveClaudeTarget(replyTo).socket}`
    const message = values.raw ? body : codexPromptFor({ body, fromName: values['from-name'] ?? null, fromAddress: replyTo ?? null }, thread.alias, socket)
    const delivery = await deliverMessage(socket, thread.id, message, { priority: values.priority, clearQueue: values['clear-queue'], replaceQueued: values['replace-queued'],
      ...((values.priority === 'auto' || values['replace-queued']) ? { sender: replyTo } : {}), deadlineMs, lockFd })
    printJson({ ok: true, thread_id: thread.id, alias: thread.alias, reply_to: replyTo ?? null, ...delivery })
  })
}

async function cmdQuota(argv) {
  const { values } = parseCommandArgs({ args: argv, options: { socket: { type: 'string' } } })
  printJson(await readQuota(values.socket ?? defaultAppSocket()))
}

async function cmdPending(argv) {
  const { values, positionals: [action, ref, ...extra] } = parseCommandArgs({
    args: argv, allowPositionals: true,
    options: { socket: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  })
  const socket = values.socket ?? defaultAppSocket()
  if (action === undefined && !values['dry-run']) {
    printJson(await listPendingApprovals(socket))
    return
  }
  if (action !== 'decline' || !ref?.trim() || extra.length) {
    fail('Use clodeks pending decline THREAD with an explicit thread.', 2)
  }
  const threadId = THREAD_ID.test(ref) ? ref.toLowerCase() : (await resolveThread(socket, ref)).id
  await declinePendingApproval(socket, threadId, {
    dryRun: values['dry-run'],
    print: result => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result) + '\n',
      err => err ? reject(err) : resolve())),
  })
}

async function cmdInboxd(argv) {
  const { values } = parseCommandArgs({
    args: argv,
    options: { socket: { type: 'string' }, interval: { type: 'string', default: '5' }, all: { type: 'boolean', default: false } },
  })
  const appSocket = values.socket ?? defaultAppSocket()
  const daemon = startInboxDaemon({
    appSocket,
    all: values.all,
    intervalMs: positiveNumber(values.interval, '--interval') * 1000,
    log: line => process.stderr.write(`clodeks inboxd: ${line}\n`),
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { daemon.close(); process.exit(0) })
}

async function cmdInbox(argv) {
  const { values, positionals } = parseCommandArgs({ args: argv, options: { socket: { type: 'string' } }, allowPositionals: true })
  const [ref] = positionals
  if (!ref) fail('usage: clodeks inbox THREAD', 2)
  const appSocket = values.socket ?? defaultAppSocket()
  const thread = await resolveThread(appSocket, ref)
  const inbox = await serveInbox({
    alias: thread.alias,
    threadId: thread.id,
    appSocket,
    onMessage: msg => process.stderr.write(`clodeks inbox: queued a message from ${msg.fromName ?? 'a Claude session'}\n`),
    onError: err => process.stderr.write(`clodeks inbox: ${err.message}\n`),
  })
  process.stderr.write(`clodeks inbox: ${thread.alias} listens on uds:${inbox.path}\n`)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { inbox.close(); process.exit(0) })
}

async function cmdExpose(argv, isExposed) {
  const { values, positionals } = parseCommandArgs({ args: argv, options: { socket: { type: 'string' } }, allowPositionals: true })
  const [ref] = positionals
  if (!ref) fail(`usage: clodeks ${isExposed ? 'expose' : 'unexpose'} THREAD`, 2)
  const thread = await setExposed(values.socket ?? defaultAppSocket(), ref, isExposed)
  printJson({ ok: true, thread_id: thread.id, alias: thread.alias, exposed: isExposed, inbox: isExposed ? `uds:${inboxSocketFor(thread.alias)}` : null })
}

function cmdPeers(argv) {
  const { values } = parseCommandArgs({ args: argv, options: {
    json: { type: 'boolean', default: false }, diagnostics: { type: 'boolean', default: false },
  } })
  const configDirs = claudeConfigDirs()
  const sessions = listClaudeSessions(process.env, configDirs)
  const searched = configDirs.map(dir => join(dir, 'sessions'))
  if (values.json) return printJson(values.diagnostics ? { sessions, searched_registries: searched } : sessions)
  console.log(`Searched registries: ${searched.join(', ')}`)
  if (sessions.length === 0) return console.log('No live Claude sessions with an inbox. A sandbox can hide host processes.')
  for (const s of sessions) {
    console.log(`${(s.name ?? '(unnamed)').padEnd(28)} ${String(s.pid).padEnd(8)} ${(s.status ?? '').padEnd(8)} ${s.cwd}${s.is_self ? '  (parent)' : ''}`)
  }
}

async function cmdClaudeSend(argv) {
  const { values } = parseCommandArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      message: { type: 'string' },
      'from-name': { type: 'string' },
      'reply-thread': { type: 'string' },
      socket: { type: 'string' },
    },
  })
  if (!values.to) fail('--to is required', 2)
  // A heredoc ends with a newline that is not part of the message.
  const body = values.message ?? (await readStdin()).replace(/\n+$/, '')
  if (!body.trim()) fail('empty message', 2)
  // Inside a `clodeks run --relay` subagent the sandbox blocks sockets. The parent clodeks run
  // forwards what this writes to the outbox.
  if ((values.to === 'self' || values.to === 'parent') && process.env.CLODEKS_OUTBOX) {
    return printJson({ ok: true, ...appendToOutbox(process.env.CLODEKS_OUTBOX, { body, fromName: values['from-name'] }) })
  }
  const target = resolveClaudeTarget(values.to)
  let fromName = values['from-name'] ?? process.env.CLODEKS_FROM_NAME ?? 'codex'
  let reply = null
  let outgoing = body
  if (values['reply-thread']) {
    const appSocket = resolve(values.socket ?? defaultAppSocket())
    const thread = await resolveThread(appSocket, values['reply-thread'])
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    const command = `clodeks send --socket ${quote(appSocket)} -- ${quote(thread.id)} 'your reply'`
    reply = { reply_thread: thread.id, reply_alias: thread.alias, reply_command: command }
    outgoing = [
      '[clodeKs reply route]',
      `Reply with codex_send using thread ${JSON.stringify(thread.id)} and message "<your reply>".`,
      'If that tool uses a different app-server, use this CLI command:',
      command,
      'The reply requires a loaded thread. This message advertises no Codex inbox socket.',
      '', body,
    ].join('\n')
    if (!values['from-name']) fromName = thread.alias
  }
  const sent = await sendToClaude({ socket: target.socket, body: outgoing, fromName, isOwnParent: target.isOwnParent })
  printJson({ ok: true, ...sent, from_name: fromName, reply_address: null, ...(reply ?? {}) })
}

function publishOffBand(wasFresh) {
  try {
    // A new inboxd can clear the off item while a status read runs. Check again before writing it.
    if (wasFresh) writeBand(offBand(false, Date.now()))
    else if (readState() === null) writeBand(offBand(true, Date.now()))
  } catch (err) {
    process.stderr.write(`clodeks: band file: ${err.message}\n`)
  }
}

async function cmdStatus(argv) {
  const { values } = parseCommandArgs({
    args: argv,
    options: { json: { type: 'boolean' }, band: { type: 'boolean' }, 'band-only': { type: 'boolean' } },
  })
  if (values['band-only']) {
    if (values.json || values.band) fail('--band-only cannot combine with --json or --band', 2)
    return publishOffBand(false)
  }
  const st = await sharedStatus()
  if (values.band) publishOffBand(st.inboxd.fresh)
  if (values.json) return printJson(st)
  const svc = s => `${s.unit.replace('.service', '')}: ${s.enabled}, ${s.active}`
  console.log(svc(st.services.appserver))
  console.log(svc(st.services.inboxd))
  console.log(`app-server: ${st.app_server.up ? 'up' : `down (${st.app_server.error})`}  inboxd heartbeat: ${st.inboxd.fresh ? 'fresh' : 'none'}`)
  console.log(`threads: ${st.counts.active} working, ${st.counts.idle ?? 'unknown'} idle, ${st.counts.other ?? 'unknown'} other, ${st.counts.exposed} exposed. ${idleQueueHint(st.counts)}. Client attachment unknown.  codex: ${st.codex.version ?? 'missing'}`)
}

async function cmdDoctor(argv) {
  parseCommandArgs({ args: argv })
  const checks = []
  try {
    const codex = resolveCodex()
    const out = await new Promise(res => {
      const c = spawn(codex, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      let s = ''
      c.stdout.on('data', d => (s += d))
      c.on('close', () => res(s.trim()))
      c.on('error', () => res('error'))
    })
    checks.push(['codex', true, `${codex} (${out})`])
  } catch (err) {
    checks.push(['codex', false, err.message])
  }
  const socket = defaultAppSocket()
  if (existsSync(socket)) {
    try {
      const threads = await listThreads(socket, { all: false })
      checks.push(['app-server', true, `${socket}, ${threads.length} live thread(s)`])
    } catch (err) {
      checks.push(['app-server', false, `${socket}: ${err.message}`])
    }
  } else {
    checks.push(['app-server', false, `${socket} missing. Run: clodeks serve (or enable systemd/clodeks-appserver.service)`])
  }
  checks.push(['parent claude', Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET), process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? 'not inside a Claude session'])
  checks.push(['claude peers', true, `${listClaudeSessions().length} live session(s)`])
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${detail}`)
}

const COMMANDS = {
  run: cmdRun,
  serve: cmdServe,
  tui: cmdTui,
  threads: cmdThreads,
  close: cmdClose,
  recycle: cmdRecycle,
  jobs: cmdJobs,
  pending: cmdPending,
  quota: cmdQuota,
  queue: cmdQueue,
  send: cmdSend,
  inbox: cmdInbox,
  inboxd: cmdInboxd,
  expose: argv => cmdExpose(argv, true),
  unexpose: argv => cmdExpose(argv, false),
  peers: cmdPeers,
  'claude-send': cmdClaudeSend,
  status: cmdStatus,
  doctor: cmdDoctor,
}

const [command, ...rest] = process.argv.slice(2)
if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(USAGE)
} else if (!COMMANDS[command]) {
  fail(`unknown command "${command}"\n\n${USAGE}`, 2)
} else {
  Promise.resolve(COMMANDS[command](rest)).catch(err => fail(err.message, err.code === 'STDIN_TIMEOUT' ? 2 : 1))
}
