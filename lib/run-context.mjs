import { recipientContext } from './recipient-context.mjs'
import { PR_BODY_CONTEXT } from './pr-body-context.mjs'

const GIT_HOOK_CONTEXT = `clodeKs Git-hook context

Installed Git hooks run as Git subprocesses, not as agent-issued shell commands.
Do not infer a command-policy breach from a hook's own temporary file cleanup alone.
Keep installed Git hooks enabled. Do not modify, copy, bypass, or disable them without explicit caller authorization.
Report a hook failure or conflict before any retry. If the caller forbids a hook action, stop and report the conflict.
--hooks controls Codex lifecycle hooks. It does not control Git hooks.
clodeKs disables Git hooks for its own fetch and push only. That policy does not authorize worker bypasses.
Follow the caller's restrictions. This context grants no extra command permissions.`

const READ_ONLY_CONTEXT = `clodeKs read-only context

This run uses the read-only sandbox with no command approvals. It grants no writable folders.
Temporary files, caches, and build output also need write access. Tests that need them can fail before assertions run.
A request to run tests does not authorize write access. Do not change permissions or attempt a sandbox bypass.
Report checks that could not run and the exact failure. Do not describe them as passing tests.
If runtime proof needs writes, request a separate explicitly authorized writable run from the caller.`

const READ_ONLY_TEMP_CONTEXT = `clodeKs read-only context

This run uses read-only repository permissions with no command approvals. The repository stays read-only.
Only the private temporary folder below permits writes. TMPDIR, TEMP, and TMP point to that folder.
Temporary files can use that folder. Caches and build output inside the repository still need write access.
A request to run tests does not authorize repository writes. Do not change permissions or attempt a sandbox bypass.
Report checks that could not run and the exact failure. Do not describe them as passing tests.
If runtime proof needs repository writes, request a separate explicitly authorized writable run from the caller.`

const LOOPBACK_CONTEXT = `clodeKs isolated loopback context

Each shell command uses a private network namespace. Keep each test server and its clients in the same command process tree.
Namespace-local loopback sockets work. Host loopback, host Unix sockets, and external network access remain blocked.
Wildcard and IPv6 binds stay inside that namespace. This option grants no extra filesystem writes or command approvals.`

const PUSH_CONTEXT = `clodeKs push context

clodeKs performs the final push after a successful run. Commit the authorized changes and leave the final commit on the current branch.
Do not push from the worker. clodeKs reports the push result after the run.
This context grants no extra commit, push, or merge authority.`

function retainedReportContext(names, root) {
  if (!names?.length) return null
  if (!root) return `clodeKs retained report context\n\nRequested reports: ${JSON.stringify(names)}\nThe private report source is unavailable. Report that limit and keep repository permissions unchanged.`
  return `clodeKs retained report context\n\nThe caller requested only these report files: ${JSON.stringify(names.map(name => `${root}/${name}`))}\nWrite reports as plain text in those exact paths. Do not put secrets, credentials, or account data in reports.\nclodeKs copies only these files before private cleanup, with a one MiB total limit. Other scratch files are temporary.\nUse the reports field in the run result for retained paths. Reports expire after seven days.`
}

// Pure builders use explicit environments. TUI reply context uses the live launcher environment.
export function buildRunPrompt({ prompt, git, push, sandbox, loopbackIsolated, scratchDir, tempDir, tempFolderUnavailable, relay, networkHosts, retainReports, executionBudget }, env = {}) {
  const context = [sandbox === 'read-only' ? (tempDir ? READ_ONLY_TEMP_CONTEXT : READ_ONLY_CONTEXT) : null, git ? GIT_HOOK_CONTEXT : null,
    loopbackIsolated ? LOOPBACK_CONTEXT : null,
    networkHosts?.length ? `clodeKs network context\n\nOnly these exact public hosts permit proxy access: ${networkHosts.join(', ')}.\nRedirects need an allowed destination. Direct egress, local services, and Unix sockets remain blocked.\nAdmission logs are best effort. The run result always reports network.complete=false. Missing audit events produce network.requests=null.` : null,
    relay && env.CLAUDE_CODE_MESSAGING_SOCKET ? recipientContext(env.CLAUDE_CODE_MESSAGING_SOCKET, env) : null,
    push ? PUSH_CONTEXT : null,
    tempFolderUnavailable ? `Temporary folder unavailable: ${JSON.stringify(tempFolderUnavailable)}` : null,
    tempDir ? `clodeKs temporary context\n\nTemporary folder: ${JSON.stringify(tempDir)}\nclodeKs deletes this private folder after the run. Keep deliverables in the requested paths.` : null,
    scratchDir ? `clodeKs scratch context\n\nScratch folder: ${JSON.stringify(scratchDir)}\nUse this private folder for temporary notes and commit messages. clodeKs deletes it after the run.\nPut deliverables in the caller's requested paths.` : null,
    retainedReportContext(retainReports, scratchDir ?? tempDir),
    executionBudget ? `clodeKs execution budget\n\nWorker time cap: ${executionBudget.limitMs} ms. Deadline: ${new Date(executionBudget.startedAt + executionBudget.limitMs).toISOString()}.\nAt 80 percent of this cap, write any requested report path first. Then send a short progress message with completed work and remaining work.\nLeave time for a final response before the cap. A timeout or resource stop remains a failed run even when partial output survives.\nThis checkpoint is a preamble instruction. clodeKs cannot inject a live warning into this one-shot CLI turn.\nThis context grants no extra file, command, or send permissions.` : null,
    sandbox === 'workspace-write' || sandbox === 'danger-full-access' || push ? PR_BODY_CONTEXT : null,
  ].filter(Boolean)
  return context.length ? `${context.join('\n\n')}\n\nCaller task\n\n${prompt}` : prompt
}
