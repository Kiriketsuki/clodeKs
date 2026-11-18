import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { fetchGit, finishGit, prepareGit } from './git.mjs'
import { changedFiles, snapshotFiles } from './file-changes.mjs'
import { privateRuntimeDir, resolveCodex, runtimeDir } from './paths.mjs'
import { sendToClaude } from './peers.mjs'
import { callerUmask } from './umask.mjs'
import { buildRunPrompt } from './run-context.mjs'
import { ownedDiskUsage, workspaceGrowth } from './run-disk.mjs'
import { cleanupRunFolder } from './run-cleanup.mjs'
import { sweepOrphanRuns } from './orphan-cleanup.mjs'
import { createJobRecord } from './jobs.mjs'
import { startRunGuard, waitForRunPreflight } from './run-guard.mjs'
import { isolatedLoopbackSettings, validateIsolatedLoopback, verifyIsolatedLoopback } from './loopback.mjs'
import { readonlyTempSettings, verifyReadonlyTemp } from './readonly-temp.mjs'
import { createNetworkAudit } from './network-audit.mjs'
import { networkHostSettings, validateNetworkHosts, verifyNetworkHosts } from './network-host.mjs'
import { pruneReports, retainReports, validateRetainReports } from './retained-reports.mjs'
import { readStoppedOutputFile, stoppedOutput } from './stopped-output.mjs'

export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
const KILL_GRACE_MS = 5000
const STREAM_DRAIN_MS = 2000
const RELAY_POLL_MS = 300
const MAX_RELAY_BODY = 100_000

// Builds the argv for one `codex exec` call. Pure, so tests can check it.
// The prompt always goes on stdin as `-`. A prompt argument with an open stdin makes Codex
// wait for stdin and append it, which hangs a piped call.
export function buildExecArgs(opts) {
  const args = ['exec']
  if (opts.resume) args.push('resume', opts.resume)
  args.push('--json', '--skip-git-repo-check')
  // Your Codex hooks (vault sync, auto-push) must not fire once per subagent.
  if (!opts.hooks) args.push('-c', 'features.hooks=false')
  args.push('-c', 'approval_policy="never"')
  if (opts.networkHosts?.length) {
    args.push(...networkHostSettings(opts).flatMap(value => ['-c', value]))
    if (!opts.resume) args.push('-C', opts.cwd)
  } else if (opts.loopbackIsolated) {
    args.push(...isolatedLoopbackSettings(opts, opts.loopbackProfile).flatMap(value => ['-c', value]))
    if (!opts.resume) args.push('-C', opts.cwd)
  } else if (opts.sandbox === 'read-only' && opts.tempDir) {
    args.push(...readonlyTempSettings(opts).flatMap(value => ['-c', value]))
    if (!opts.resume) args.push('-C', opts.cwd)
  } else if (opts.resume) {
    // `exec resume` has no -s and no -C. The config key sets the sandbox, and spawn sets the cwd.
    args.push('-c', `sandbox_mode="${opts.sandbox}"`)
  } else {
    args.push('-s', opts.sandbox, '-C', opts.cwd)
  }
  // Extra writable roots: the relay outbox, the git dirs of a --git run and each --add-dir.
  // Named profiles carry their own roots. Other writable runs use the legacy root list.
  // Only --network-host grants named external destinations. Host sockets stay blocked.
  const roots = [...new Set([opts.outboxDir, ...(opts.gitDirs ?? []), ...(opts.addDirs ?? [])].filter(Boolean))]
  if (roots.length && !opts.loopbackIsolated && !opts.tempDir && !opts.networkHosts?.length) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`)
  if (opts.model) args.push('-m', opts.model)
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`)
  if (opts.ephemeral) args.push('--ephemeral')
  if (opts.schema) args.push('--output-schema', opts.schema)
  if (opts.outFile) args.push('-o', opts.outFile)
  args.push('-')
  return args
}

// Folds the JSONL event stream of `codex exec --json` into one summary. Pure.
export function foldEvents(lines) {
  const state = {
    threadId: null,
    lastMessage: null,
    messageUpdate: null,
    lastCommandOutput: null,
    usage: null,
    error: null,
    isTurnCompleted: false,
    isTurnFailed: false,
    commands: 0,
    fileChanges: [],
  }
  for (const line of lines) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'thread.started') state.threadId = ev.thread_id ?? state.threadId
    else if (ev.type === 'turn.completed') {
      state.usage = ev.usage ?? state.usage
      state.isTurnCompleted = true
    } else if (ev.type === 'turn.failed') {
      state.error = ev.error?.message ?? 'turn failed'
      state.isTurnFailed = true
    } else if (ev.type === 'error' && !state.isTurnFailed) {
      // Codex also reports stream retries as error events. A later turn.completed overrides them.
      state.error = ev.message ?? 'codex error'
    } else if (['item.started', 'item.updated', 'item.completed'].includes(ev.type) && ev.item) {
      const item = ev.item
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        if (ev.type === 'item.completed') { state.lastMessage = item.text; state.messageUpdate = null }
        else state.messageUpdate = item.text
      } else if (item.type === 'command_execution') {
        if (ev.type === 'item.completed') state.commands += 1
        if (typeof item.aggregated_output === 'string') state.lastCommandOutput = item.aggregated_output
      } else if (ev.type === 'item.completed' && item.type === 'file_change' && Array.isArray(item.changes)) {
        for (const change of item.changes) if (change?.path) state.fileChanges.push(change.path)
      }
    }
  }
  if (state.isTurnCompleted && !state.isTurnFailed) state.error = null
  return state
}

// Turns a folded stream, the output file text and the exit status into the clodeks result.
export function buildResult({ folded, outText, outTruncated, exitCode, timedOut, resourceStop, wantsJson, durationMs }) {
  const stopped = Boolean(timedOut || resourceStop)
  const partial = stopped ? stoppedOutput(folded, outText, outTruncated) : undefined
  const text = stopped ? (partial.items.find(item => item.source !== 'command_output' && item.text)?.text ?? '') : (outText ?? folded.lastMessage ?? '').trim()
  let result = null
  let error = folded.error
  if (timedOut) error = 'timeout'
  else if (resourceStop) error = `resource limit: ${resourceStop.reason}`
  else if (exitCode !== 0 && !error) error = `codex exited ${exitCode}`
  if (wantsJson && (!error || (stopped && text))) {
    try {
      result = JSON.parse(text)
    } catch {
      if (!stopped) error = 'output is not valid JSON'
    }
  } else if (!wantsJson && (!error || (stopped && text))) {
    // With no schema the answer is the text. A caller can always read `result`.
    result = text
  }
  return {
    ok: !error,
    thread_id: folded.threadId,
    result,
    text,
    usage: folded.usage,
    commands_run: folded.commands,
    files_changed: [...new Set(folded.fileChanges)],
    exit_code: exitCode,
    duration_ms: durationMs,
    error: error ?? null,
    ...(stopped ? { result_partial: true, partial_output: partial } : {}),
  }
}

function failure(started, error) {
  return { ok: false, thread_id: null, result: null, text: '', usage: null, commands_run: 0, files_changed: [], exit_code: null, duration_ms: Date.now() - started, error }
}

// Forwards lines that the sandboxed run appends to its outbox to the parent Claude session.
function startRelay({ file, parentSocket, env, getFromName }) {
  let offset = 0
  let sent = 0
  let lastError = null
  let chain = Promise.resolve()
  const drain = () => {
    let data
    try {
      data = readFileSync(file)
    } catch {
      return chain
    }
    const end = data.lastIndexOf(0x0a) + 1
    if (end <= offset) return chain
    const text = data.subarray(offset, end).toString('utf8')
    offset = end
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.body !== 'string' || !msg.body.trim()) continue
      const body = msg.body.slice(0, MAX_RELAY_BODY)
      chain = chain
        .then(() => sendToClaude({ socket: parentSocket, body, fromName: getFromName(), isOwnParent: true }, env))
        .then(() => {
          sent += 1
        })
        .catch(err => {
          lastError = err.message
        })
    }
    return chain
  }
  const timer = setInterval(drain, RELAY_POLL_MS)
  return {
    stop: async () => {
      clearInterval(timer)
      await drain()
      return { sent, error: lastError }
    },
  }
}

// Runs one Codex turn and resolves the clodeks result. It never rejects: every failure is
// `ok: false` with `error`, so a wrapper agent always has something to return.
export async function runExec(opts, env = process.env, guardDependencies = {}) {
  let networkHosts
  try { networkHosts = validateNetworkHosts(opts) } catch (err) { return failure(Date.now(), err.message) }
  let reportNames
  try { reportNames = validateRetainReports(opts) } catch (err) {
    return { ...failure(Date.now(), err.message), reports: { retained: [], skipped: [], prune_errors: [] } }
  }
  opts = { ...opts, networkHosts, retainReports: reportNames }
  const orphanCleanup = sweepOrphanRuns(env)
  const pruneErrors = pruneReports(env)
  const network = networkHosts.length
    ? { allowed_hosts: networkHosts, audit_scope: 'admission', requests: null, complete: false, truncated: false } : undefined
  const mask = callerUmask()
  let job
  let metadataError
  const onError = err => { metadataError = `Job metadata unavailable: ${err.message}` }
  try { job = createJobRecord({ cwd: opts.cwd, onError }, env) } catch (err) { onError(err) }
  let result
  try {
    result = await runExecInner(opts, env, job, guardDependencies)
  } finally {
    job?.finished()
  }
  return { ...result, orphan_cleanup: orphanCleanup, reports: { retained: [], skipped: reportNames.map(name => ({ name, reason: 'Report source folder is unavailable' })),
    ...result.reports, prune_errors: pruneErrors }, caller_umask: mask, worker_shell_umask: null,
    ...(metadataError ? { job_metadata_error: metadataError } : {}),
    ...(network ? { network: result.network ?? network } : {}) }
}

async function runExecInner(opts, env, job, guardDependencies) {
  const started = Date.now()
  if (opts.loopbackIsolated) {
    try { validateIsolatedLoopback(opts.sandbox) } catch (err) { return failure(started, err.message) }
  }
  if (opts.resourceLimits) {
    const stopped = await waitForRunPreflight(opts.resourceLimits, guardDependencies)
    if (stopped) return { ...failure(started, `resource limit: ${stopped.reason}`), resource_stop: stopped }
  }
  let codex
  let work
  try {
    codex = resolveCodex(env)
    work = mkdtempSync(join(privateRuntimeDir(env), 'run-'))
    job?.folder(work)
  } catch (err) {
    return failure(started, err.message)
  }
  const cleanup = () => cleanupRunFolder(work)
  let tempFolderUnavailable
  let reportSource
  let expectedSource
  const finish = result => {
    const reports = retainReports({ names: opts.retainReports, sourceDir: reportSource, expectedSource, env,
      groupAlive: result.worker_group_alive })
    const owned = ownedDiskUsage(work)
    const cleanupError = cleanup()
    return { ...result, reports, duration_ms: Date.now() - started, disk_usage: { ...result.disk_usage, owned }, ...(cleanupError ? { cleanup_error: cleanupError } : {}),
      ...(tempFolderUnavailable ? { temp_folder_unavailable: tempFolderUnavailable } : {}) }
  }

  try {
    if (opts.relay && !env.CLAUDE_CODE_MESSAGING_SOCKET) {
      return finish(failure(started, '--relay needs a parent Claude session (CLAUDE_CODE_MESSAGING_SOCKET is not set)'))
    }
    for (const [flag, isSet] of [['--relay', opts.relay], ['--git', opts.git], ['--add-dir', opts.addDirs?.length]]) {
      if (isSet && opts.sandbox === 'read-only') {
        return finish(failure(started, `${flag} needs a writable sandbox. Add --write.`))
      }
    }
    let gitState = null
    if (opts.git) gitState = await prepareGit(opts.cwd, { fetch: false }, env)
    const outFile = join(work, 'last-message.txt')
    let schema = opts.schema
    if (opts.schemaJson) {
      schema = join(work, 'schema.json')
      writeFileSync(schema, opts.schemaJson)
    }
    let outboxDir
    const childEnv = { ...env }
    if (opts.relay) {
      outboxDir = join(work, 'outbox')
      mkdirSync(outboxDir, { mode: 0o700 })
      childEnv.CLODEKS_OUTBOX = join(outboxDir, 'messages.ndjson')
    }
    const scratchDir = opts.sandbox === 'workspace-write' ? join(work, 'scratch') : undefined
    if (scratchDir) mkdirSync(scratchDir, { mode: 0o700 })
    const tempDir = opts.sandbox === 'read-only' ? join(work, 'tmp') : undefined
    let launchOpts = { ...opts, schema, outFile, outboxDir, gitDirs: gitState?.gitDirs, scratchDir, tempDir,
      ...(tempDir ? { permissionProfile: `clodeks_readonly_${randomUUID().replaceAll('-', '')}` } : {}),
      addDirs: [...(opts.addDirs ?? []), ...(scratchDir ? [scratchDir] : [])],
      ...(opts.loopbackIsolated ? { loopbackProfile: `clodeks_loopback_${randomUUID().replaceAll('-', '')}` } : {}) }
    if (opts.networkHosts?.length) {
      childEnv.RUST_LOG = `${env.RUST_LOG || 'error,opentelemetry_sdk=off,opentelemetry_otlp=off'},codex_otel.network_proxy=info`
      launchOpts = { ...launchOpts, homeDir: env.HOME, codexHome: env.CODEX_HOME, networkProfile: `clodeks_network_${randomUUID().replaceAll('-', '')}` }
      await verifyNetworkHosts(codex, opts.cwd, networkHostSettings(launchOpts), childEnv)
    } else if (opts.loopbackIsolated) {
      await verifyIsolatedLoopback(codex, opts.cwd, isolatedLoopbackSettings(launchOpts, launchOpts.loopbackProfile), childEnv)
    } else if (tempDir) {
      try {
        await verifyReadonlyTemp(codex, opts.cwd, readonlyTempSettings(launchOpts), childEnv)
      } catch (err) {
        tempFolderUnavailable = err.message
        launchOpts = { ...launchOpts, tempDir: undefined, permissionProfile: undefined, tempFolderUnavailable }
      }
    }
    if (launchOpts.tempDir) mkdirSync(launchOpts.tempDir, { mode: 0o700 })
    const workerTemp = launchOpts.tempDir ?? scratchDir
    reportSource = workerTemp
    expectedSource = workerTemp ? lstatSync(workerTemp) : undefined
    if (workerTemp) {
      childEnv.TMPDIR = workerTemp
      childEnv.TEMP = workerTemp
      childEnv.TMP = workerTemp
      childEnv.TMPPREFIX = join(workerTemp, 'zsh')
    }
    const args = buildExecArgs(launchOpts)
    if (gitState && opts.fetch !== false) gitState = await fetchGit(opts.cwd, gitState, env)
    const roots = [opts.cwd, ...(opts.addDirs ?? [])]
    const snapshotOptions = { excludePaths: [work, join(runtimeDir(env), 'jobs')],
      includeSizes: opts.sandbox === 'workspace-write' }
    const before = opts.sandbox === 'read-only' ? null : snapshotFiles(roots, snapshotOptions)
    const result = await spawnCodex({ codex, args, opts: launchOpts, childEnv, outFile, schema, started, env, job, guardDependencies, cleanup })
    const partialFiles = result.error === 'timeout' || result.resource_stop
    const after = before && (opts.sandbox === 'workspace-write' || partialFiles) ? snapshotFiles(roots, snapshotOptions) : null
    if (opts.sandbox === 'workspace-write') result.disk_usage = { workspace_growth: workspaceGrowth(before, after) }
    if (partialFiles && before) {
      result.files_changed = [...new Set([
        ...result.files_changed.map(path => resolve(opts.cwd, path)), ...changedFiles(before, after),
      ])].sort()
      result.files_changed_scan = {
        roots: before.roots, complete: before.complete && after.complete,
        errors: [...before.errors, ...after.errors], ignored_directories: ['.git'], excluded_paths: [work],
      }
      result.duration_ms = Date.now() - started
    }
    if (gitState) {
      result.git = await finishGit(opts.cwd, gitState, { push: opts.push, runOk: result.ok, groupAlive: result.worker_group_alive }, env)
      if (result.git.pushed) {
        const note = `clodeks pushed ${result.git.head_after} to ${gitState.remoteBranch}`
        result.text = [result.text, note].filter(Boolean).join('\n')
        if (!schema) result.result = result.text
      }
      result.duration_ms = Date.now() - started
    }
    return finish(result)
  } catch (err) {
    return finish(failure(started, err.message))
  }
}

// Waits until no process is left in the group. Signal 0 only tests that the group exists.
async function groupGone(pid, waitMs = 3000) {
  const end = Date.now() + waitMs
  for (;;) {
    try {
      process.kill(-pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= end) return false
    await new Promise(r => setTimeout(r, 25))
  }
}

function spawnCodex({ codex, args, opts, childEnv, outFile, schema, started, env, job, guardDependencies, cleanup }) {
  return new Promise(resolve => {
    const executionStarted = performance.now()
    const budget = { limitMs: Math.min(opts.timeoutMs, opts.resourceLimits?.maxMs ?? Infinity), startedAt: Date.now() }
    let stopElapsed = null
    // A process group of its own, so a timeout also kills the tools Codex started.
    const child = spawn(codex, args, { cwd: opts.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const lines = []
    let pending = ''
    let stderr = ''
    const keepStderr = chunk => { stderr = (stderr + chunk).slice(-8000) }
    const networkAudit = opts.networkHosts?.length ? createNetworkAudit(keepStderr) : null
    let timedOut = false
    let resourceStop
    let guard
    let leaderExited = false
    let killTimer
    let isDone = false
    let threadId = null

    const relay = childEnv.CLODEKS_OUTBOX
      ? startRelay({
          file: childEnv.CLODEKS_OUTBOX,
          parentSocket: env.CLAUDE_CODE_MESSAGING_SOCKET,
          env,
          getFromName: () => (threadId ? `codex-${threadId.replace(/-/g, '').slice(-8)}` : 'codex-subagent'),
        })
      : null

    const killGroup = sig => {
      try {
        process.kill(-child.pid, sig)
      } catch {
        // The group already exited.
      }
    }
    // The child has its own process group, so Ctrl-C on clodeks does not reach it. Forward it.
    const onSignal = sig => {
      killGroup('SIGTERM')
      cleanup()
      setTimeout(() => process.kill(process.pid, sig), 100).unref()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    const unhook = () => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }

    const stop = reason => {
      if (isDone || leaderExited || timedOut || resourceStop) return
      stopElapsed = Math.max(0, performance.now() - executionStarted)
      if (reason) resourceStop = reason
      else timedOut = true
      guard?.close()
      clearTimeout(timer)
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref()
    }
    child.once('spawn', () => {
      job?.running(child.pid)
      guard = startRunGuard(opts.resourceLimits, child.pid, stop, guardDependencies)
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop()
      lines.push(...parts)
      for (const part of parts) {
        if (!threadId && part.includes('"thread.started"')) {
          try {
            const event = JSON.parse(part)
            if (event.type === 'thread.started' && typeof event.thread_id === 'string' &&
                event.thread_id.length > 0 && event.thread_id.length <= 512) {
              threadId = event.thread_id
              job?.identified(threadId)
            }
          } catch {
            // Not JSON. foldEvents skips it too.
          }
        }
        opts.onEvent?.(part)
      }
    })
    // Codex prints harmless ERROR lines (system skills, File exists) on every run.
    // Stderr is kept only for the error text when the exit status says the run failed.
    child.stderr.on('data', chunk => {
      if (networkAudit) networkAudit.write(chunk)
      else keepStderr(chunk)
    })

    const timer = setTimeout(() => stop(null), opts.timeoutMs)

    const finish = async exitCode => {
      if (isDone) return
      isDone = true
      job?.finishing()
      clearTimeout(timer)
      guard?.close()
      clearTimeout(killTimer)
      // A timed-out leader can exit while a tool ignores TERM. Stop that group before the disk snapshot.
      if (timedOut || resourceStop) killGroup('SIGKILL')
      // Git inspection and report retention need a stopped worker group. A descendant could
      // otherwise write after the checks. A setsid escape is out of reach.
      let groupAlive = false
      if (opts.gitDirs || opts.retainReports?.length) {
        killGroup('SIGKILL')
        groupAlive = !(await groupGone(child.pid))
      }
      unhook()
      if (pending) lines.push(pending)
      const relayed = relay ? await relay.stop() : null
      let outText
      let outTruncated = false
      if (timedOut || resourceStop) {
        const output = readStoppedOutputFile(outFile)
        outText = output.text
        outTruncated = output.truncated
      } else try {
        outText = readFileSync(outFile, 'utf8')
      } catch {
        outText = undefined
      }
      const folded = foldEvents(lines)
      const result = buildResult({ folded, outText, outTruncated, exitCode, timedOut, resourceStop,
        wantsJson: Boolean(schema), durationMs: Date.now() - started })
      result.execution_budget = { scope: 'worker_execution', limit_ms: budget.limitMs,
        elapsed_ms: Math.max(0, performance.now() - executionStarted), stop_elapsed_ms: stopElapsed }
      if (groupAlive) result.worker_group_alive = true
      if (networkAudit) result.network = { allowed_hosts: opts.networkHosts, audit_scope: 'admission',
        requests: networkAudit.finish(), complete: false, truncated: networkAudit.truncated }
      if (resourceStop) result.resource_stop = resourceStop
      if (relayed) {
        result.messages_relayed = relayed.sent
        if (relayed.error) result.relay_error = relayed.error
      }
      if (!result.ok && exitCode !== 0 && !folded.error) {
        result.stderr_tail = stderr.split('\n').filter(l => !/failed to install system skills/.test(l)).slice(-15).join('\n')
      }
      resolve(result)
    }

    child.on('error', err => {
      if (isDone) return
      isDone = true
      job?.finishing()
      clearTimeout(timer)
      guard?.close()
      clearTimeout(killTimer)
      unhook()
      relay?.stop()
      resolve(failure(started, `spawn failed: ${err.message}`))
    })
    // A tool Codex left running can hold stdout open after Codex exits. Stop waiting for it.
    child.on('exit', code => {
      leaderExited = true
      guard?.close()
      clearTimeout(timer)
      job?.finishing()
      setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code ?? 1)
      }, STREAM_DRAIN_MS).unref()
    })
    child.on('close', code => finish(code ?? 1))

    child.stdin.on('error', () => {
      // Codex can exit before it reads stdin. The exit handler reports that run.
    })
    child.stdin.end(buildRunPrompt({ ...opts, executionBudget: budget }, childEnv))
  })
}
