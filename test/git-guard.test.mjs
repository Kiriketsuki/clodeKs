import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runExec } from '../lib/exec.mjs'
import { finishGit, prepareGit } from '../lib/git.mjs'
import { snapshotGitFiles } from '../lib/git-guard.mjs'
import { testEnv } from './helpers/env.mjs'

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
}

const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim()

// Builds a repo with a bare remote and one pushed commit.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'clodeks-guard-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '--bare', '-q', remote], { env: ENV })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV })
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  sh(repo, 'add', 'a.txt')
  sh(repo, 'commit', '-q', '-m', 'first')
  sh(repo, 'remote', 'add', 'origin', remote)
  sh(repo, 'push', '-q', '-u', 'origin', 'main')
  return { root, repo, remote }
}

// Simulates a run: snapshot, a good commit, then the mutation under test, then finishGit.
async function run(mutate, { push = true, runOk = true, env = ENV, setup } = {}) {
  const { repo, remote } = makeRepo()
  await setup?.(repo)
  const state = await prepareGit(repo, { fetch: false }, env)
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  sh(repo, 'add', 'b.txt')
  sh(repo, 'commit', '-q', '-m', 'work')
  await mutate(repo)
  const report = await finishGit(repo, state, { push, runOk }, env)
  return { report, repo, remote }
}

const gd = repo => join(repo, '.git')
const target = '/etc/hostname'
const classes = report => report.unsafe_git_state.map(u => `${u.class}:${u.path}`)

function expectRefused({ report }, cls, pathSuffix) {
  assert.equal(report.pushed, false)
  assert.match(report.push_error, /unsafe git state/)
  assert.ok(report.unsafe_git_state.some(u => u.class === cls && u.path.includes(pathSuffix)),
    `expected ${cls} ${pathSuffix}, got ${classes(report)}`)
}

function replaceWithLink(path) {
  try { unlinkSync(path) } catch { /* new file */ }
  symlinkSync(target, path)
}

test('symlinked index is refused', async () => {
  expectRefused(await run(repo => replaceWithLink(join(gd(repo), 'index'))), 'symlink', '.git/index')
})
test('symlinked reflog is refused', async () => {
  expectRefused(await run(repo => replaceWithLink(join(gd(repo), 'logs', 'HEAD'))), 'symlink', 'logs/HEAD')
})
test('symlinked MERGE_MSG is refused', async () => {
  expectRefused(await run(repo => replaceWithLink(join(gd(repo), 'MERGE_MSG'))), 'symlink', 'MERGE_MSG')
})
test('symlinked COMMIT_EDITMSG is refused', async () => {
  expectRefused(await run(repo => replaceWithLink(join(gd(repo), 'COMMIT_EDITMSG'))), 'symlink', 'COMMIT_EDITMSG')
})
test('symlink inside an objects subdirectory is refused', async () => {
  const out = await run(repo => {
    mkdirSync(join(gd(repo), 'objects', 'ab'), { recursive: true })
    symlinkSync(target, join(gd(repo), 'objects', 'ab', 'cdef'))
  })
  expectRefused(out, 'symlink', 'objects/ab/cdef')
})
test('rebase-merge state is refused', async () => {
  expectRefused(await run(repo => {
    mkdirSync(join(gd(repo), 'rebase-merge'))
    writeFileSync(join(gd(repo), 'rebase-merge', 'git-rebase-todo'), 'pick abc\n')
  }), 'operation_state', 'rebase-merge')
})
test('rebase-apply state is refused', async () => {
  expectRefused(await run(repo => mkdirSync(join(gd(repo), 'rebase-apply'))), 'operation_state', 'rebase-apply')
})
test('sequencer state is refused', async () => {
  expectRefused(await run(repo => mkdirSync(join(gd(repo), 'sequencer'))), 'operation_state', 'sequencer')
})
test('MERGE_HEAD is refused', async () => {
  expectRefused(await run(repo => writeFileSync(join(gd(repo), 'MERGE_HEAD'), `${sh(repo, 'rev-parse', 'HEAD')}\n`)),
    'operation_state', 'MERGE_HEAD')
})
test('new gitlink with a workspace .git file is refused', async () => {
  expectRefused(await run(repo => {
    sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${sh(repo, 'rev-parse', 'HEAD')},sub`)
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', '.git'), 'gitdir: /tmp/elsewhere\n')
  }), 'gitlink', 'sub')
})
test('changed .gitmodules is refused', async () => {
  expectRefused(await run(repo => writeFileSync(join(repo, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n')),
    'gitlink', '.gitmodules')
})
test('info/attributes is refused', async () => {
  expectRefused(await run(repo => {
    mkdirSync(join(gd(repo), 'info'), { recursive: true })
    writeFileSync(join(gd(repo), 'info', 'attributes'), '* filter=x\n')
  }), 'control_changed', 'info/attributes')
})
test('info/exclude change is refused', async () => {
  expectRefused(await run(repo => {
    mkdirSync(join(gd(repo), 'info'), { recursive: true })
    writeFileSync(join(gd(repo), 'info', 'exclude'), 'x\n')
  }), 'control_changed', 'info/exclude')
})
test('objects/info/alternates is refused', async () => {
  expectRefused(await run(repo => {
    mkdirSync(join(gd(repo), 'objects', 'info'), { recursive: true })
    writeFileSync(join(gd(repo), 'objects', 'info', 'alternates'), '/tmp/other/objects\n')
  }), 'control_changed', 'objects/info/alternates')
})
test('new refs/replace entry is refused', async () => {
  expectRefused(await run(repo => {
    const head = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'update-ref', `refs/replace/${sh(repo, 'rev-parse', 'HEAD~1')}`, head)
  }), 'refs_moved', 'refs/replace/')
})
test('a moved ref outside the run branch is refused', async () => {
  const out = await run(repo => {
    sh(repo, 'branch', 'other', 'HEAD')
  }, { push: true })
  assert.equal(out.report.pushed, true, 'a new branch alone is not unsafe')
  const moved = await (async () => {
    const { repo, remote } = makeRepo()
    sh(repo, 'branch', 'other', 'HEAD')
    const state = await prepareGit(repo, { fetch: false }, ENV)
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    sh(repo, 'add', 'c.txt')
    sh(repo, 'commit', '-q', '-m', 'work')
    sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
    return { report: await finishGit(repo, state, { push: true, runOk: true }, ENV), remote }
  })()
  expectRefused(moved, 'refs_moved', 'refs/heads/other')
})
test('changed commondir pointer is refused', async () => {
  expectRefused(await run(repo => writeFileSync(join(gd(repo), 'commondir'), '/tmp/elsewhere\n')),
    'control_changed', 'commondir')
})
test('a planted HEAD symlink stops every host git call', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'clodeks-guard-bin-'))
  const log = join(bin, 'calls.log')
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  const env = { ...ENV, PATH: `${bin}:${process.env.PATH}` }
  const { repo, remote } = makeRepo()
  const state = await prepareGit(repo, { fetch: false }, env)
  const remoteBefore = sh(remote, 'rev-parse', 'main')
  writeFileSync(log, '')
  replaceWithLink(join(gd(repo), 'HEAD'))
  const report = await finishGit(repo, state, { push: true, runOk: true }, env)
  assert.equal(report.pushed, false)
  assert.ok(report.unsafe_git_state.some(u => u.class === 'symlink'))
  assert.equal(readFileSync(log, 'utf8'), '', 'no host git call may run after planted state')
  assert.equal(sh(remote, 'rev-parse', 'main'), remoteBefore)
})
test('without --push the unsafe state is still reported with a warning', async () => {
  const { report } = await run(repo => mkdirSync(join(gd(repo), 'sequencer')), { push: false })
  assert.ok(report.unsafe_git_state.some(u => u.class === 'operation_state'))
  assert.match(report.warning, /Inspect unsafe_git_state/)
  assert.equal(report.pushed, false)
})
test('a failed run still reports unsafe state', async () => {
  const { report } = await run(repo => mkdirSync(join(gd(repo), 'sequencer')), { push: false, runOk: false })
  assert.ok(report.unsafe_git_state.length > 0)
})
test('an unreadable git dir fails closed as inspect_error', async t => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory modes')
  let locked
  const out = await run(repo => {
    locked = join(gd(repo), 'refs', 'heads', 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
  })
  chmodSync(locked, 0o700)
  assert.equal(out.report.pushed, false)
  assert.ok(out.report.unsafe_git_state.some(u => u.class === 'inspect_error' && u.path.endsWith('locked')),
    `got ${classes(out.report)}`)
})
test('a normal run still pushes and reports no unsafe state', async () => {
  const { report, remote, repo } = await run(() => {})
  assert.deepEqual(report.unsafe_git_state, [])
  assert.equal(report.warning, undefined)
  assert.equal(report.pushed, true)
  assert.equal(sh(remote, 'rev-parse', 'main'), sh(repo, 'rev-parse', 'main'))
})
test('adding a worktree and a branch is not unsafe', async () => {
  const out = await run(repo => sh(repo, 'worktree', 'add', '-q', '-b', 'wt', join(repo, '..', 'wt')))
  assert.deepEqual(out.report.unsafe_git_state, [])
  assert.equal(out.report.pushed, true)
})

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const CHILD = fileURLToPath(new URL('./fixtures/guard-child.mjs', import.meta.url))

test('HEAD pointer change is refused', async () => {
  expectRefused(await run(repo => writeFileSync(join(gd(repo), 'HEAD'), 'ref: refs/heads/other\n')), 'control_changed', '.git/HEAD')
})
test('objects/info/http-alternates is refused', async () => {
  expectRefused(await run(repo => {
    mkdirSync(join(gd(repo), 'objects', 'info'), { recursive: true })
    writeFileSync(join(gd(repo), 'objects', 'info', 'http-alternates'), 'http://example.invalid/objects\n')
  }), 'control_changed', 'http-alternates')
})
test('a packed-refs-only move is refused', async () => {
  const out = await run(repo => {
    const file = join(gd(repo), 'packed-refs')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^\w+ (refs\/heads\/other)$/m, `${sh(repo, 'rev-parse', 'HEAD')} $1`))
  }, { setup: repo => { sh(repo, 'branch', 'other', 'HEAD'); sh(repo, 'pack-refs', '--all', '--prune') } })
  expectRefused(out, 'refs_moved', 'refs/heads/other')
})
test('a gitlink in a nested path is refused', async () => {
  expectRefused(await run(repo => sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${sh(repo, 'rev-parse', 'HEAD')},a/b`)),
    'gitlink', 'a/b')
})
test('a sibling worktree pointer change is refused', async () => {
  const out = await run(repo => writeFileSync(join(gd(repo), 'worktrees', 'wt', 'commondir'), '/tmp/elsewhere\n'),
    { setup: repo => sh(repo, 'worktree', 'add', '-q', '-b', 'wt', join(repo, '..', 'wt')) })
  expectRefused(out, 'control_changed', 'worktrees/wt/commondir')
})
test('a sibling worktree HEAD change is refused', async () => {
  const out = await run(repo => writeFileSync(join(gd(repo), 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/main\n'),
    { setup: repo => sh(repo, 'worktree', 'add', '-q', '-b', 'wt', join(repo, '..', 'wt')) })
  expectRefused(out, 'control_changed', 'worktrees/wt/HEAD')
})

// A blocking read of a FIFO would hang the process, so these run in a child with a time limit.
function inChild(repo, special) {
  const out = execFileSync(process.execPath, [CHILD, repo, special], { env: ENV, encoding: 'utf8', timeout: 15000 })
  return JSON.parse(out)
}
for (const special of ['config', 'info/attributes', 'hooks/pre-push', 'refs/heads/pipe', 'HEAD']) {
  test(`a FIFO at ${special} is refused without opening it`, () => {
    const { repo } = makeRepo()
    const report = inChild(repo, special)
    assert.equal(report.pushed, false)
    assert.ok(report.unsafe_git_state.some(u => u.class === 'special_file' && u.path.endsWith(special)),
      JSON.stringify(report.unsafe_git_state))
  })
}

test('the walk caps entries and depth and reports inspect_error', () => {
  const { repo } = makeRepo()
  assert.ok(snapshotGitFiles([gd(repo)], { maxEntries: 3 }).errors.length > 0)
  assert.ok(snapshotGitFiles([gd(repo)], { maxDepth: 1 }).errors.length > 0)
  assert.equal(snapshotGitFiles([gd(repo)]).errors.length, 0)
})

test('a repo that already has unsafe state refuses to start', async () => {
  const cases = {
    'rebase-merge': repo => mkdirSync(join(gd(repo), 'rebase-merge')),
    symlink: repo => symlinkSync(target, join(gd(repo), 'MERGE_MSG')),
    commondir: repo => writeFileSync(join(gd(repo), 'commondir'), '/tmp/elsewhere\n'),
  }
  for (const [name, plant] of Object.entries(cases)) {
    const { repo } = makeRepo()
    plant(repo)
    await assert.rejects(prepareGit(repo, { fetch: false }, ENV), /already has unsafe git state|not inside a git repository/, name)
  }
})
test('a failed ref read before the run refuses to start', async () => {
  const { repo } = makeRepo()
  writeFileSync(join(gd(repo), 'packed-refs'), 'not a valid line\n')
  await assert.rejects(prepareGit(repo, { fetch: false }, ENV), /unsafe git state/)
})

test('a background writer is killed before the check and the push', async () => {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'commit-late-writer', ...Object.fromEntries(
    ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map(k => [k, ENV[k]])) })
  const { repo, remote } = makeRepo()
  const r = await runExec({ prompt: 'commit', cwd: repo, sandbox: 'workspace-write', git: true, push: true, timeoutMs: 20000 }, env)
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.git.pushed, true, r.git.push_error)
  assert.equal(sh(remote, 'rev-parse', 'main'), r.git.head_after)
  let planted = true
  try { readFileSync(join(gd(repo), 'hooks', 'pre-push')) } catch { planted = false }
  assert.equal(planted, false, 'the left-behind writer changed the git dir after the check')
})

function commitFile(repo, name = 'context.txt') {
  writeFileSync(join(repo, name), 'worktree context\n')
  sh(repo, 'add', name)
  sh(repo, 'commit', '-q', '-m', 'context change')
}

function movedFinding(report, ref = 'refs/heads/other') {
  assert.equal(report.pushed, false)
  const finding = report.unsafe_git_state.find(u => u.class === 'refs_moved' && u.path === ref)
  assert.ok(finding, JSON.stringify(report))
  return finding
}

function gitCapture(root, overrides = {}) {
  const bin = join(root, 'git-bin')
  mkdirSync(bin)
  const log = join(root, 'git-calls.jsonl')
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'PAGER']
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) }) + '\\n')
if (args.includes('worktree') && args.includes('--porcelain')) {
  const kind = process.env.FAKE_WORKTREE_KIND
  if (kind === 'hang') setInterval(() => {}, 1000)
  else if (kind === 'stdout-limit') process.stdout.write('x'.repeat(100000))
  else if (kind === 'stderr-limit') process.stderr.write('x'.repeat(100000))
  else if (kind === 'exit') process.exitCode = 3
  else process.stdout.write(JSON.parse(process.env.FAKE_WORKTREE_OUTPUT ?? '""'))
} else {
  const r = spawnSync(${JSON.stringify(real)}, args, { env: process.env })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exitCode = r.status ?? 1
}
`, { mode: 0o700 })
  return { log, env: { ...ENV, PATH: `${bin}:${ENV.PATH}`, ...overrides },
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }
}

test('worktree context: a sibling commit names the observed checkout without blaming a writer', async () => {
  const { root, repo } = makeRepo()
  const sibling = join(root, 'other worktree')
  sh(repo, 'worktree', 'add', '-q', '-b', 'other', sibling)
  const state = await prepareGit(repo, { fetch: false }, ENV)
  commitFile(sibling)
  const report = await finishGit(repo, state, { push: false }, ENV)
  const found = movedFinding(report)
  assert.deepEqual(found.worktrees, [sibling])
  assert.match(found.message, /ref moved during the run/i)
  assert.match(found.message, /also checked out in/)
  assert.doesNotMatch(found.message, /moved by|caused by|another session/)
  assert.ok(report.warning.includes(sibling))
})

test('worktree context: direct foreign-ref writes keep the same warning and push refusal', async () => {
  const { root, repo, remote } = makeRepo()
  const sibling = join(root, 'other')
  sh(repo, 'worktree', 'add', '-q', '-b', 'other', sibling)
  const state = await prepareGit(repo, { fetch: false }, ENV)
  commitFile(repo)
  sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
  const report = await finishGit(repo, state, { push: true }, ENV)
  const found = movedFinding(report)
  assert.deepEqual(found.worktrees, [sibling])
  assert.match(found.message, /also checked out in/)
  assert.match(report.push_error, /unsafe git state/)
  assert.equal(sh(remote, 'rev-parse', 'main'), state.headBefore)
})

test('worktree context: the primary checkout is reported when the run uses a linked worktree', async () => {
  const { root, repo } = makeRepo()
  const worker = join(root, 'worker')
  sh(repo, 'worktree', 'add', '-q', '-b', 'worker', worker)
  const state = await prepareGit(worker, { fetch: false }, ENV)
  commitFile(repo)
  const report = await finishGit(worker, state, { push: false }, ENV)
  assert.deepEqual(movedFinding(report, 'refs/heads/main').worktrees, [repo])
})

test('worktree context: an unmatched branch reports only the observed move', async () => {
  const { repo } = makeRepo()
  sh(repo, 'branch', 'other')
  const state = await prepareGit(repo, { fetch: false }, ENV)
  commitFile(repo)
  sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
  const report = await finishGit(repo, state, { push: false }, ENV)
  const found = movedFinding(report)
  assert.deepEqual(found.worktrees, [])
  assert.match(found.message, /ref moved during the run/i)
  assert.doesNotMatch(found.message, /also checked out in/)
})

test('worktree context: own-branch and replace-ref checks retain their existing behavior', async () => {
  const { root, repo } = makeRepo()
  const capture = gitCapture(root)
  const state = await prepareGit(repo, { fetch: false }, capture.env)
  commitFile(repo)
  const own = await finishGit(repo, state, { push: false }, capture.env)
  assert.deepEqual(own.unsafe_git_state, [])
  assert.equal(capture.calls().some(c => c.args.includes('worktree')), false)
  sh(repo, 'update-ref', `refs/replace/${state.headBefore}`, 'HEAD')
  const replace = await finishGit(repo, state, { push: true }, capture.env)
  assert.ok(replace.unsafe_git_state.some(u => u.class === 'refs_moved' && u.path.startsWith('refs/replace/')))
  assert.equal(replace.pushed, false)
  assert.equal(capture.calls().some(c => c.args.includes('worktree')), false)
})

async function capturedMove(kind, output = '', extra = {}) {
  const { root, repo } = makeRepo()
  sh(repo, 'branch', 'other')
  if (kind === 'output') {
    for (const [i, record] of output.split('\0\0').filter(Boolean).entries()) {
      const path = record.split('\0').find(field => field.startsWith('worktree '))?.slice(9)
      if (path) plantWorktree(repo, `observed-${i}`, path)
    }
  }
  const capture = gitCapture(root, { FAKE_WORKTREE_KIND: kind, FAKE_WORKTREE_OUTPUT: JSON.stringify(output), ...extra })
  const state = await prepareGit(repo, { fetch: false }, capture.env)
  commitFile(repo)
  sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
  const started = performance.now()
  const report = await finishGit(repo, state, { push: false }, capture.env)
  return { report, capture, elapsed: performance.now() - started }
}

test('worktree context: host diagnostics use hardened local Git options and a clean config environment', async () => {
  const output = 'worktree /observed\0branch refs/heads/other\0\0'
  const { report, capture } = await capturedMove('output', output, {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'test.sentinel', GIT_CONFIG_VALUE_0: 'synthetic value',
  })
  assert.deepEqual(movedFinding(report).worktrees, ['/observed'])
  const call = capture.calls().find(c => c.args.includes('worktree'))
  assert.ok(call)
  for (const value of ['--no-pager', 'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'protocol.allow=never', '--porcelain', '-z']) {
    assert.ok(call.args.includes(value), JSON.stringify(call.args))
  }
  assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(call.env.GIT_CONFIG_SYSTEM, '/dev/null')
  assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(call.env.GIT_CONFIG_COUNT, '0')
  assert.equal(call.env.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(call.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(call.env.GIT_OPTIONAL_LOCKS, '0')
})

function plantWorktree(repo, id, path, branch = 'other') {
  const admin = join(gd(repo), 'worktrees', id)
  mkdirSync(admin, { recursive: true })
  writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`)
  writeFileSync(join(admin, 'gitdir'), `${path}/.git\n`)
  writeFileSync(join(admin, 'commondir'), '../..\n')
  writeFileSync(join(admin, 'locked'), 'Keep synthetic diagnostic fixture metadata\n')
}

for (const control of ['config', 'config.worktree', 'hooks/context-review']) {
  test(`worktree review: changed ${control} skips context reads and preserves the finding`, async () => {
    const { root, repo } = makeRepo()
    sh(repo, 'branch', 'other')
    const capture = gitCapture(root)
    const state = await prepareGit(repo, { fetch: false }, capture.env)
    commitFile(repo)
    sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
    appendFileSync(join(gd(repo), control), '\n[context-review]\n value = true\n')
    writeFileSync(capture.log, '')
    const report = await finishGit(repo, state, { push: false }, capture.env)
    const found = movedFinding(report)
    assert.deepEqual(found.worktrees, [])
    assert.match(found.worktree_context_error, /changed.*config|changed.*control|config.*changed/)
    assert.equal(capture.calls().some(c => c.args.includes('worktree')), false)
  })
}

test('worktree review: a new planted admin directory cannot spoof an arbitrary checkout', async () => {
  const { root, repo } = makeRepo()
  sh(repo, 'branch', 'other')
  const capture = gitCapture(root, { FAKE_WORKTREE_KIND: 'output',
    FAKE_WORKTREE_OUTPUT: JSON.stringify('worktree /anything\0branch refs/heads/other\0\0') })
  const state = await prepareGit(repo, { fetch: false }, capture.env)
  commitFile(repo)
  sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
  plantWorktree(repo, 'planted', '/anything')
  const report = await finishGit(repo, state, { push: false }, capture.env)
  assert.deepEqual(movedFinding(report).worktrees, [])
  assert.doesNotMatch(report.warning, /also checked out in/)
})

test('worktree review: a new admin alias cannot claim a different branch at an old checkout path', async () => {
  const { root, repo } = makeRepo()
  const path = join(root, 'existing')
  sh(repo, 'branch', 'other')
  sh(repo, 'worktree', 'add', '-q', '-b', 'unrelated', path)
  const capture = gitCapture(root, { FAKE_WORKTREE_KIND: 'output',
    FAKE_WORKTREE_OUTPUT: JSON.stringify(`worktree ${path}\0branch refs/heads/other\0\0`) })
  const state = await prepareGit(repo, { fetch: false }, capture.env)
  commitFile(repo)
  sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
  plantWorktree(repo, 'planted-alias', path)
  const report = await finishGit(repo, state, { push: false }, capture.env)
  assert.deepEqual(movedFinding(report).worktrees, [])
})

test('worktree review: prunable entries cannot supply a checkout association', async () => {
  const { report } = await capturedMove('output', 'worktree /gone\0branch refs/heads/other\0prunable missing gitdir\0\0')
  assert.deepEqual(movedFinding(report).worktrees, [])
})

test('worktree review: a bare repository retains refs_moved when a linked checkout advances', async () => {
  const { root, remote } = makeRepo()
  sh(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const sibling = join(root, 'bare-linked')
  sh(remote, 'worktree', 'add', '-q', '-b', 'other', sibling)
  const state = await prepareGit(remote, { fetch: false }, ENV)
  assert.equal(state.top, null)
  commitFile(sibling)
  const report = await finishGit(remote, state, { push: false }, ENV)
  assert.deepEqual(movedFinding(report).worktrees, [sibling])
  assert.equal(report.unsafe_git_state.some(u => u.class === 'inspect_error'), false)
})

test('worktree review: escaping distinguishes backslashes and astral controls and counts code points', async () => {
  const plain = `/emoji/${'😀'.repeat(400)}`
  const escaped = '/escape\\literal\n' + String.fromCodePoint(0xe0001)
  const output = [plain, escaped].map(path => `worktree ${path}\0branch refs/heads/other\0\0`).join('')
  const { report } = await capturedMove('output', output)
  const found = movedFinding(report)
  assert.deepEqual(found.worktrees, [plain, '/escape\\\\literal\\u000a\\u{e0001}'])
  assert.equal(found.worktrees_truncated, false)
  assert.ok(found.worktrees.every(path => Array.from(path).length <= 512))
})

test('worktree review: a full 512 code point path stays intact and a longer path truncates', async () => {
  const path = '/' + '😀'.repeat(511)
  const output = [path, path + 'x'].map(value => `worktree ${value}\0branch refs/heads/other\0\0`).join('')
  const { report } = await capturedMove('output', output)
  const found = movedFinding(report)
  assert.equal(found.worktrees[0], path)
  assert.ok(Array.from(found.worktrees[1]).length <= 512)
  assert.ok(found.worktrees[1].endsWith('...'))
  assert.equal(found.worktrees_truncated, true)
})

test('worktree review: unavailable pre-run primary context remains explicit after a later successful read', async () => {
  const { root, repo } = makeRepo()
  const worker = join(root, 'linked')
  sh(repo, 'worktree', 'add', '-q', '-b', 'worker', worker)
  const capture = gitCapture(root, { FAKE_WORKTREE_KIND: 'exit',
    FAKE_WORKTREE_OUTPUT: JSON.stringify(`worktree ${repo}\0branch refs/heads/main\0\0`) })
  const state = await prepareGit(worker, { fetch: false }, capture.env)
  commitFile(repo)
  capture.env.FAKE_WORKTREE_KIND = 'output'
  const report = await finishGit(worker, state, { push: false }, capture.env)
  const found = movedFinding(report, 'refs/heads/main')
  assert.deepEqual(found.worktrees, [])
  assert.match(found.worktree_context_error, /pre-run.*exit/)
})

test('worktree context: path controls and newlines are escaped and path size and count are bounded', async () => {
  const paths = Array.from({ length: 10 }, (_, i) => `/observed ${i}\n\u001b[31m\u202e${'x'.repeat(1000)}`)
  const output = paths.map(path => `worktree ${path}\0branch refs/heads/other\0\0`).join('')
  const { report } = await capturedMove('output', output)
  const found = movedFinding(report)
  assert.equal(found.worktrees.length, 5)
  assert.equal(found.worktrees_truncated, true)
  for (const path of found.worktrees) {
    assert.ok(path.length <= 512)
    assert.doesNotMatch(path, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    assert.match(path, /\\u000a/)
  }
  assert.doesNotMatch(report.warning, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
  assert.ok(report.warning.length < 3500)
})

for (const kind of ['hang', 'stdout-limit', 'stderr-limit', 'exit', 'malformed']) {
  test(`worktree context: ${kind} diagnostics preserve the guard finding and name the unavailable context`, async () => {
    const { report, elapsed } = await capturedMove(kind, 'not a porcelain record')
    const found = movedFinding(report)
    assert.deepEqual(found.worktrees, [])
    assert.match(found.worktree_context_error, /timeout|limit|exit|malformed/)
    assert.ok(elapsed < 6000, `diagnostics took ${elapsed} ms`)
    assert.doesNotMatch(report.warning, /also checked out in/)
  })
}

test('worktree context: planted file state prevents all host Git calls even when a foreign ref moved', async () => {
  const { root, repo } = makeRepo()
  sh(repo, 'branch', 'other')
  const capture = gitCapture(root)
  const state = await prepareGit(repo, { fetch: false }, capture.env)
  commitFile(repo)
  sh(repo, 'update-ref', 'refs/heads/other', 'HEAD')
  replaceWithLink(join(gd(repo), 'HEAD'))
  writeFileSync(capture.log, '')
  const report = await finishGit(repo, state, { push: true }, capture.env)
  assert.equal(report.pushed, false)
  assert.ok(report.unsafe_git_state.some(u => u.class === 'symlink'))
  assert.deepEqual(capture.calls(), [])
})
