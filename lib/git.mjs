import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { baselineFindings, fileHash, inspectGitFiles, inspectGitState, snapshotGitFiles, snapshotGitState } from './git-guard.mjs'

const GIT_TIMEOUT_MS = 120_000
const CONTEXT_TIMEOUT_MS = 2000
const CONTEXT_MAX_BYTES = 64 * 1024
const CONTEXT_MAX_PATHS = 5
const PATH_MAX_POINTS = 512
const POINTER_MAX_BYTES = 8192
// Git reads these files and runs what they name. A run that can write the git dir can change
// them, so clodeks hashes them before the run and pushes only when they still match.
const CONTROL_FILES = ['config', 'config.worktree']
const CONTROL_DIRS = ['hooks']
// Hooks never run for the git commands clodeks runs outside the sandbox.
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'push.recurseSubmodules=no']

export function git(cwd, args, env = process.env, limits = {}) {
  return new Promise(done => {
    const child = spawn('git', ['-C', cwd, ...SAFE_GIT, ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let bytes = 0
    let readError
    const timer = setTimeout(() => {
      if (limits.timeoutMs) readError = 'worktree metadata timeout'
      child.kill(limits.timeoutMs ? 'SIGKILL' : 'SIGTERM')
    }, limits.timeoutMs ?? GIT_TIMEOUT_MS)
    if (limits.maxBytes) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
    }
    const collect = (chunk, stderr) => {
      if (readError) return
      bytes += Buffer.byteLength(chunk)
      if (limits.maxBytes && bytes > limits.maxBytes) {
        readError = 'worktree metadata output limit exceeded'
        child.kill('SIGKILL')
        return
      }
      if (stderr) err += chunk
      else out += chunk
    }
    child.stdout.on('data', c => collect(c, false))
    child.stderr.on('data', c => collect(c, true))
    child.on('error', e => {
      clearTimeout(timer)
      done({ code: 1, out: '', err: e.message, ...(limits.maxBytes ? { read_error: `worktree metadata spawn failure (${e.code ?? 'unknown'})` } : {}) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      done({ code: readError ? 1 : code ?? 1, out: limits.raw ? out : out.trim(), err: err.trim(),
        ...(readError ? { read_error: readError } : {}) })
    })
  })
}

// These paths come from writable Git metadata. Escape controls before callers display them.
function displayGitPath(path) {
  const pieces = []
  let points = 0
  for (const char of path) {
    const code = char.codePointAt(0)
    const escaped = char === '\\' ? '\\\\' : /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char)
      ? code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}` : char
    const count = Array.from(escaped).length
    if (points + count > PATH_MAX_POINTS) {
      while (points > PATH_MAX_POINTS - 3) points -= Array.from(pieces.pop()).length
      return { text: `${pieces.join('')}...`, truncated: true }
    }
    pieces.push(escaped)
    points += count
  }
  return { text: pieces.join(''), truncated: false }
}

function parseWorktrees(output) {
  if (!output || !output.endsWith('\0\0')) throw new Error('worktree metadata is malformed')
  return output.slice(0, -2).split('\0\0').map(record => {
    const fields = record.split('\0')
    const path = fields[0]?.startsWith('worktree ') ? fields[0].slice(9) : ''
    const branches = fields.filter(field => field.startsWith('branch '))
    if (!isAbsolute(path) || branches.length > 1 || fields.slice(1).some(field =>
      !/^(?:HEAD |branch refs\/heads\/|detached$|bare$|locked(?: |$)|prunable(?: |$))/.test(field))) {
      throw new Error('worktree metadata is malformed')
    }
    return { path, branch: branches[0]?.slice(7), prunable: fields.some(field => /^prunable(?: |$)/.test(field)), bare: fields.includes('bare') }
  })
}

async function readWorktreeMetadata(cwd, env) {
  // Repo-local config still loads. These overrides disable command helpers and inherited config.
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')))
  let metadata
  try {
    metadata = await git(cwd, ['--no-pager', '-c', 'protocol.allow=never', 'worktree', 'list', '--porcelain', '-z'], {
      ...clean, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat',
    }, { timeoutMs: CONTEXT_TIMEOUT_MS, maxBytes: CONTEXT_MAX_BYTES, raw: true })
  } catch { metadata = { code: 1, read_error: 'worktree metadata unavailable' } }
  let trees = []
  let error = metadata.read_error ?? (metadata.code !== 0 ? `worktree metadata exit ${metadata.code}` : null)
  if (!error) {
    try { trees = parseWorktrees(metadata.out) } catch (err) { error = err.message }
  }
  return { trees, error }
}

// Read only pointer files covered by the before snapshot. Bound reads and verify their hashes.
function pointerBefore(path, snapshot, budget) {
  const expected = snapshot.pointers[path]
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || budget.left <= 0) return null
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    const limit = Math.min(POINTER_MAX_BYTES, budget.left)
    if (!st.isFile() || st.size > limit) return null
    const data = Buffer.alloc(limit + 1)
    let length = 0
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null)
      if (!count) break
      length += count
    }
    budget.left -= length
    if (length > limit) return null
    const bytes = data.subarray(0, length)
    return createHash('sha256').update(bytes).digest('hex') === expected ? bytes.toString('utf8') : null
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

function worktreesBefore(snapshot) {
  const known = []
  const budget = { left: CONTEXT_MAX_BYTES }
  for (const path of Object.keys(snapshot.pointers)) {
    if (!/\/worktrees\/[^/]+\/gitdir$/.test(path)) continue
    const pointer = pointerBefore(path, snapshot, budget)?.replace(/\n$/, '')
    const head = pointerBefore(join(dirname(path), 'HEAD'), snapshot, budget)
    const branch = /^ref: (refs\/heads\/[^\r\n]+)\n?$/.exec(head ?? '')?.[1]
    if (pointer && isAbsolute(pointer) && basename(pointer) === '.git' && branch) known.push({ path: dirname(pointer), branch })
    if (budget.left <= 0) break
  }
  return known
}

async function withWorktreeContext(cwd, found, state, env, changed) {
  const moved = finding => finding.class === 'refs_moved' && finding.path.startsWith('refs/heads/')
  if (!found.some(moved)) return found
  const { trees, error: readError } = changed.length ? { trees: [], error: 'worktree context skipped because Git config or hooks changed' }
    : await readWorktreeMetadata(cwd, env)
  const error = readError ?? state.worktreeBaselineError
  const known = new Set((state.worktreesBefore ?? []).map(tree => JSON.stringify([tree.path, tree.branch])))
  const byBranch = new Map()
  for (const tree of trees) {
    if (tree.prunable || tree.bare || !known.has(JSON.stringify([tree.path, tree.branch])) ||
      (state.top && resolve(tree.path) === resolve(state.top))) continue
    const paths = byBranch.get(tree.branch) ?? new Set()
    paths.add(tree.path)
    byBranch.set(tree.branch, paths)
  }
  return found.map(finding => {
    if (!moved(finding)) return finding
    const paths = [...(byBranch.get(finding.path) ?? [])]
    const shown = paths.slice(0, CONTEXT_MAX_PATHS).map(displayGitPath)
    const worktrees = shown.map(path => path.text)
    const ref = displayGitPath(finding.path).text
    return { ...finding, worktrees, worktrees_truncated: paths.length > CONTEXT_MAX_PATHS || shown.some(path => path.truncated),
      message: `Ref moved during the run: ${ref}${worktrees.length ? `, also checked out in ${worktrees.map(path => JSON.stringify(path)).join(', ')}` : ''}.`,
      ...(error ? { worktree_context_error: error } : {}) }
  })
}

async function gitValue(cwd, args, env) {
  const r = await git(cwd, args, env)
  return r.code === 0 && r.out ? r.out : null
}

const hashFile = path => fileHash(path)

// Hashes the files that make git run commands. Pure apart from the reads.
export function snapshotControl(gitDirs) {
  const snap = {}
  for (const dir of gitDirs) {
    for (const name of CONTROL_FILES) snap[join(dir, name)] = hashFile(join(dir, name))
    for (const sub of CONTROL_DIRS) {
      const base = join(dir, sub)
      let entries = []
      try {
        if (statSync(base).isDirectory()) entries = readdirSync(base)
      } catch {
        // No such folder. A folder that appears later shows up as new entries.
      }
      for (const entry of entries) snap[join(base, entry)] = hashFile(join(base, entry))
      snap[`${base}/`] = entries.sort().join('\n')
    }
  }
  return snap
}

export function changedControl(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter(k => before[k] !== after[k]).sort()
}

// Reads the repo at `cwd` before a `--git` run: its git dirs, the branch and where it pushes.
// It fetches the push remote outside the sandbox, so Codex sees fresh remote refs without
// network access of its own.
export async function prepareGit(cwd, { fetch = true } = {}, env = process.env) {
  const gitDir = await gitValue(cwd, ['rev-parse', '--absolute-git-dir'], env)
  if (!gitDir) throw new Error(`--git: ${cwd} is not inside a git repository`)
  const common = await gitValue(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env)
  const gitDirs = [...new Set([gitDir, common ?? gitDir])]
  // File checks run before any further git command reads the git dirs.
  const guardFiles = snapshotGitFiles(gitDirs)
  refuseUnsafeStart(baselineFindings(guardFiles, { gitDir, commonDir: common ?? gitDir }))
  const branch = await gitValue(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env)
  let remote = null
  let remoteBranch = null
  if (branch) {
    remote = (await gitValue(cwd, ['config', `branch.${branch}.remote`], env)) ?? 'origin'
    const merge = await gitValue(cwd, ['config', `branch.${branch}.merge`], env)
    remoteBranch = merge ? merge.replace(/^refs\/heads\//, '') : branch
  }
  const top = await gitValue(cwd, ['rev-parse', '--show-toplevel'], env)
  const knownWorktrees = worktreesBefore(guardFiles)
  let worktreeBaselineError
  if (top && branch) knownWorktrees.push({ path: top, branch: `refs/heads/${branch}` })
  if (gitDirs.length > 1) {
    // Git lists the primary checkout first. Capture it before the worker can add admin entries.
    const baseline = await readWorktreeMetadata(cwd, env)
    if (baseline.error) worktreeBaselineError = `pre-run ${baseline.error}`
    const primary = baseline.trees[0]
    const head = pointerBefore(join(common, 'HEAD'), guardFiles, { left: POINTER_MAX_BYTES })
    if (primary?.branch && !primary.prunable && !primary.bare && head === `ref: ${primary.branch}\n`) knownWorktrees.push(primary)
  }
  const state = {
    gitDirs,
    guardFiles,
    top,
    worktreesBefore: knownWorktrees,
    worktreeBaselineError,
    branch,
    remote,
    remoteBranch,
    headBefore: await gitValue(cwd, ['rev-parse', 'HEAD'], env),
    control: snapshotControl(gitDirs),
    fetched: false,
    fetchError: null,
  }
  return fetch ? fetchGit(cwd, state, env) : withGuard(cwd, state, env)
}

function refuseUnsafeStart(found) {
  if (!found.length) return
  const list = found.slice(0, 10).map(u => `${u.class} ${u.path}`).join(', ')
  throw new Error(`--git: the repo already has unsafe git state (${list}). Inspect and clean it before you run.`)
}

// The guard snapshot of refs and gitlinks comes after the fetch, because a fetch moves remote refs.
// A failed read of the refs fails closed: the run does not start.
async function withGuard(cwd, state, env) {
  const guardState = await snapshotGitState(state.top, args => git(cwd, args, env))
  if (guardState.error) refuseUnsafeStart([{ class: 'inspect_error', path: `git ${guardState.error}` }])
  return { ...state, guardState }
}

// Keep network activity separate so callers can verify the complete write scope first.
export async function fetchGit(cwd, state, env = process.env) {
  if (!state.remote) return state.guardState ? state : withGuard(cwd, state, env)
  const r = await git(cwd, ['fetch', '--quiet', state.remote], env)
  return withGuard(cwd, { ...state, fetched: r.code === 0,
    fetchError: r.code === 0 ? null : r.err.split('\n').slice(-2).join(' ') || `git fetch exited ${r.code}` }, env)
}

// Looks for git state the run left behind. File checks come first and run no git command, so a
// planted symlink or pointer is found before any host git call reads it. Any error is unsafe.
async function inspectRun(cwd, state, env, changed) {
  try {
    if (!state.guardFiles || !state.guardState) return [{ class: 'inspect_error', path: state.gitDirs[0] }]
    const found = inspectGitFiles(state.guardFiles, snapshotGitFiles(state.gitDirs))
    if (found.length) return found
    const after = await snapshotGitState(state.top, args => git(cwd, args, env))
    const findings = inspectGitState(state.guardState, after, { branch: state.branch, gitDir: state.gitDirs[0] })
    return await withWorktreeContext(cwd, findings, state, env, changed)
  } catch (err) {
    return [{ class: 'inspect_error', path: state.gitDirs[0], message: err.message }]
  }
}

const UNSAFE_WARNING = 'unsafe git state remains in the repo. Inspect unsafe_git_state before you run git there.'

// Reports what the run did to the repo, and pushes the branch when asked. The push target
// comes from before the run, and a changed config or hook stops the push.
export async function finishGit(cwd, state, { push = false, runOk = true, groupAlive = false } = {}, env = process.env) {
  const changed = changedControl(state.control, snapshotControl(state.gitDirs))
  const unsafe = await inspectRun(cwd, state, env, changed)
  if (groupAlive) unsafe.push({ class: 'inspect_error', path: 'worker process group still running' })
  const hostGitOk = !unsafe.some(u => u.class !== 'refs_moved' && u.class !== 'gitlink')
  const tip = state.branch && hostGitOk ? await gitValue(cwd, ['rev-parse', `refs/heads/${state.branch}`], env) : null
  const report = {
    branch: state.branch,
    remote: state.remote,
    head_before: state.headBefore,
    head_after: tip ?? (hostGitOk ? await gitValue(cwd, ['rev-parse', 'HEAD'], env) : null),
    fetched: state.fetched,
    fetch_error: state.fetchError,
    changed_control_files: changed,
    unsafe_git_state: unsafe,
    ...(unsafe.length && !push ? { warning: [UNSAFE_WARNING, ...unsafe.filter(u => u.class === 'refs_moved' && u.message).slice(0, 5).map(u => u.message)].join(' ') } : {}),
    pushed: false,
    push_error: null,
  }
  if (!push) return report
  if (!runOk) report.push_error = 'not pushed: the run failed'
  else if (!state.branch) report.push_error = 'not pushed: HEAD was detached before the run'
  else if (unsafe.length) report.push_error = `not pushed: the run left unsafe git state. ${UNSAFE_WARNING.replace(/^unsafe git state remains in the repo\. /, '')}`
  else if (changed.length) report.push_error = 'not pushed: the run changed git config or hooks. Review changed_control_files.'
  else if (!tip) report.push_error = `not pushed: branch ${state.branch} is gone`
  else if (tip === state.headBefore) report.push_error = null
  else {
    const r = await git(cwd, ['push', '--no-verify', '--porcelain', state.remote, `refs/heads/${state.branch}:refs/heads/${state.remoteBranch}`], env)
    report.pushed = r.code === 0
    if (r.code !== 0) report.push_error = (r.err || r.out).split('\n').slice(-3).join(' ') || `git push exited ${r.code}`
  }
  return report
}
