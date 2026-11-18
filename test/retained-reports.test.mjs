import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runExec } from '../lib/exec.mjs'
import { buildRunPrompt } from '../lib/run-context.mjs'
import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const CODEX = fileURLToPath(new URL('./fixtures/report-codex.mjs', import.meta.url))
const modulePath = '../lib/retained-reports.mjs'
function environment(extra = {}) {
  const env = testEnv({ CLODEKS_CODEX_BIN: CODEX, ...extra })
  return { ...env, XDG_STATE_HOME: join(env.XDG_RUNTIME_DIR, 'state') }
}
const options = env => ({ prompt: 'Review the code.', cwd: env.XDG_RUNTIME_DIR, sandbox: 'workspace-write', timeoutMs: 5000,
  retainReports: ['report.md'] })

function replaceFs(t, name, replacement) {
  const original = fs[name]
  t.mock.method(fs, name, (...args) => replacement(original, ...args))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

test('reports review: a scratch-root swap during open cannot redirect retained content', async t => {
  const { retainReports } = await import(modulePath)
  const env = environment()
  const sourceDir = join(env.XDG_RUNTIME_DIR, 'source')
  const foreign = join(env.XDG_RUNTIME_DIR, 'foreign')
  for (const folder of [sourceDir, foreign]) mkdirSync(folder)
  writeFileSync(join(sourceDir, 'report.md'), 'trusted report')
  writeFileSync(join(foreign, 'report.md'), 'foreign report')
  const expectedSource = lstatSync(sourceDir)
  replaceFs(t, 'openSync', (original, path, ...args) => {
    if (!String(path).endsWith('/report.md')) return original(path, ...args)
    renameSync(sourceDir, `${sourceDir}-old`)
    symlinkSync(foreign, sourceDir)
    try { return original(path, ...args) }
    finally { fs.unlinkSync(sourceDir); renameSync(`${sourceDir}-old`, sourceDir) }
  })
  const result = retainReports({ names: ['report.md'], sourceDir, expectedSource, env })
  assert.equal(result.retained.length, 1, JSON.stringify(result))
  assert.equal(readFileSync(result.retained[0].path, 'utf8'), 'trusted report')
})

test('reports review: unavailable proc descriptors skip retention with a named reason', async t => {
  const { retainReports } = await import(modulePath)
  const env = environment()
  writeFileSync(join(env.XDG_RUNTIME_DIR, 'report.md'), 'report')
  replaceFs(t, 'realpathSync', (original, path, ...args) => {
    if (String(path).startsWith('/proc/self/fd/')) throw Object.assign(new Error('no proc'), { code: 'ENOENT' })
    return original(path, ...args)
  })
  const result = retainReports({ names: ['report.md'], sourceDir: env.XDG_RUNTIME_DIR, env })
  assert.deepEqual(result.retained, [])
  assert.match(result.skipped[0].reason, /\/proc.*unavailable|unavailable.*\/proc/)
})

for (const partial of [false, true]) {
  test(`reports review: marker failure skips all names and removes the empty run folder, partial=${partial}`, async t => {
    const { retainReports } = await import(modulePath)
    const env = environment()
    for (const name of ['report.md', 'second.txt']) writeFileSync(join(env.XDG_RUNTIME_DIR, name), 'report')
    replaceFs(t, 'writeFileSync', (original, path, ...args) => {
      if (String(path).endsWith('/.clodeks-report')) {
        if (partial) original(path, ...args)
        throw Object.assign(new Error('marker refusal'), { code: 'EACCES' })
      }
      return original(path, ...args)
    })
    const result = retainReports({ names: ['report.md', 'second.txt'], sourceDir: env.XDG_RUNTIME_DIR, env })
    assert.deepEqual(result.retained, [])
    assert.deepEqual(result.skipped.map(x => x.name), ['report.md', 'second.txt'])
    assert.ok(result.skipped.every(x => /marker.*EACCES/.test(x.reason)))
    assert.deepEqual(readdirSync(join(env.XDG_STATE_HOME, 'clodeks/reports')), [])
  })
}

test('reports review: option-validation failures preserve the reports envelope', async () => {
  const env = environment()
  const result = await runExec({ ...options(env), retainReports: ['../invalid.md'] }, env)
  assert.equal(result.ok, false)
  assert.deepEqual(result.reports, { retained: [], skipped: [], prune_errors: [] })
})

test('reports review: pruning checks lstat when directory entries have an unknown type', async t => {
  const { retainReports, pruneReports } = await import(modulePath)
  const env = environment()
  writeFileSync(join(env.XDG_RUNTIME_DIR, 'report.md'), 'report')
  const retained = retainReports({ names: ['report.md'], sourceDir: env.XDG_RUNTIME_DIR, env }).retained[0]
  const folder = join(retained.path, '..')
  const old = new Date(Date.now() - 8 * 86400_000)
  utimesSync(folder, old, old)
  replaceFs(t, 'opendirSync', (original, ...args) => {
    const dir = original(...args)
    return { closeSync: () => dir.closeSync(), readSync: () => {
      const entry = dir.readSync()
      return entry && { ...entry, isDirectory: () => false }
    } }
  })
  assert.deepEqual(pruneReports(env), [])
  assert.equal(existsSync(folder), false)
})

for (const sandbox of ['workspace-write', 'read-only']) {
  test(`reports: ${sandbox} report survives private cleanup with private state permissions`, async () => {
    const env = environment()
    const result = await runExec({ ...options(env), sandbox }, env)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.reports?.retained.length, 1)
    const report = result.reports.retained[0]
    assert.equal(report.name, 'report.md')
    assert.equal(readFileSync(report.path, 'utf8'), 'review result\n')
    assert.equal(report.bytes, 14)
    assert.ok(report.path.startsWith(join(env.XDG_STATE_HOME, 'clodeks/reports/run-')))
    assert.equal(statSync(report.path).mode & 0o777, 0o600)
    assert.equal(statSync(join(report.path, '..')).mode & 0o777, 0o700)
    assert.equal(existsSync(JSON.parse(result.text).source), false)
    assert.deepEqual(result.reports.skipped, [])
    const seen = JSON.parse(result.text)
    assert.match(seen.prompt, /Do not put secrets/)
    assert.ok(seen.prompt.includes(join(seen.source, 'report.md')))
    assert.equal(seen.prompt.includes(join(env.XDG_STATE_HOME, 'clodeks/reports')), false)
  })
}

test('reports: no flag retains nothing even when result text names a report', async () => {
  const env = environment()
  const result = await runExec({ ...options(env), retainReports: [] }, env)
  assert.equal(result.ok, true)
  assert.deepEqual(result.reports, { retained: [], skipped: [], prune_errors: [] })
  assert.equal(existsSync(join(env.XDG_STATE_HOME, 'clodeks/reports')), false)
})

test('reports: concurrent runs retain independent report copies', async () => {
  const env = environment()
  const results = await Promise.all([runExec(options(env), env), runExec(options(env), env)])
  assert.ok(results.every(r => r.reports?.retained.length === 1))
  assert.notEqual(results[0].reports.retained[0].path, results[1].reports.retained[0].path)
})

for (const kind of ['symlink', 'hardlink', 'directory', 'fifo', 'missing', 'oversized', 'root-symlink']) {
  test(`reports: ${kind} is skipped without changing successful run status`, async () => {
    const env = environment({ FAKE_REPORT_KIND: kind })
    const result = await runExec(options(env), env)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.reports?.retained, [])
    assert.equal(result.reports.skipped[0].name, 'report.md')
    assert.match(result.reports.skipped[0].reason, /link|regular|missing|limit|source/)
    assert.equal(existsSync(JSON.parse(result.text).source), false)
  })
}

test('reports: the total retained byte cap applies across named files', async () => {
  const env = environment({ FAKE_REPORT_KIND: 'total' })
  const result = await runExec({ ...options(env), retainReports: ['report.md', 'second.txt'] }, env)
  assert.equal(result.ok, true)
  assert.equal(result.reports?.retained.length, 1)
  assert.equal(result.reports.retained[0].bytes, 700_000)
  assert.match(result.reports.skipped[0].reason, /limit/)
})

test('reports: a failed worker still retains a bounded report', async () => {
  const env = environment({ FAKE_REPORT_FAIL: '1' })
  const result = await runExec(options(env), env)
  assert.equal(result.ok, false)
  assert.equal(result.reports?.retained.length, 1)
})

test('reports: a timeout retains its named report after the private group stops', async () => {
  const env = environment({ FAKE_REPORT_HANG: '1' })
  const result = await runExec({ ...options(env), timeoutMs: 700 }, env)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.equal(result.reports?.retained.length, 1)
  assert.equal(existsSync(JSON.parse(result.text).source), false)
})

test('reports: a plain replacement of the original source root is refused', async () => {
  const { retainReports } = await import(modulePath)
  const env = environment()
  const sourceDir = join(env.XDG_RUNTIME_DIR, 'source')
  mkdirSync(sourceDir)
  const expectedSource = lstatSync(sourceDir)
  renameSync(sourceDir, `${sourceDir}-old`)
  mkdirSync(sourceDir)
  writeFileSync(join(sourceDir, 'report.md'), 'replacement')
  const result = retainReports({ names: ['report.md'], sourceDir, expectedSource, env })
  assert.deepEqual(result.retained, [])
  assert.match(result.skipped[0].reason, /source folder changed/)
})

test('reports: a run with no retention flag still prunes expired owned reports', async () => {
  const { retainReports } = await import(modulePath)
  const env = environment()
  writeFileSync(join(env.XDG_RUNTIME_DIR, 'report.md'), 'old report')
  const oldReport = retainReports({ names: ['report.md'], sourceDir: env.XDG_RUNTIME_DIR, env }).retained[0]
  const folder = join(oldReport.path, '..')
  const old = new Date(Date.now() - 8 * 86400_000)
  utimesSync(folder, old, old)
  const result = await runExec({ ...options(env), retainReports: [] }, env)
  assert.equal(result.ok, true)
  assert.equal(existsSync(folder), false)
  assert.deepEqual(result.reports.prune_errors, [])
})

test('reports: a live worker group skips each requested report', async () => {
  const { retainReports } = await import(modulePath)
  const env = environment()
  const result = retainReports({ names: ['report.md', 'second.txt'], sourceDir: env.XDG_RUNTIME_DIR, env, groupAlive: true })
  assert.deepEqual(result.retained, [])
  assert.deepEqual(result.skipped.map(x => x.name), ['report.md', 'second.txt'])
  assert.ok(result.skipped.every(x => /worker process group is still running/.test(x.reason)))
})

test('reports: unavailable private temp does not invent a writable report path', () => {
  const prompt = buildRunPrompt({ prompt: 'Review.', sandbox: 'read-only', retainReports: ['report.md'] })
  assert.match(prompt, /private report source is unavailable/)
  assert.doesNotMatch(prompt, /undefined\/report.md/)
})

test('reports: invalid names, duplicates, unsupported modes and excess names fail before launch', async () => {
  const env = environment()
  for (const names of [['../report.md'], ['/tmp/report.md'], ['nested/report.md'], ['.env'], ['report.json'], ['a\n.md'],
    ['report.md', 'report.md'], Array.from({ length: 9 }, (_, i) => `r${i}.md`)]) {
    const result = await runExec({ ...options(env), retainReports: names }, env)
    assert.equal(result.ok, false, JSON.stringify(names))
    assert.match(result.error, /retain-report/)
    assert.equal(result.thread_id, null)
  }
  const result = await runExec({ ...options(env), sandbox: 'danger-full-access' }, env)
  assert.equal(result.ok, false)
  assert.match(result.error, /retain-report/)
})

test('reports: CLI forwards repeated names and explains the flag in help', () => {
  const env = environment()
  const run = spawnSync(process.execPath, [CLI, 'run', '--write', '--cwd', env.XDG_RUNTIME_DIR, '--retain-report', 'report.md',
    '--retain-report', 'second.txt', '--prompt', 'Review.'], { env, encoding: 'utf8', timeout: 10000 })
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.reports.retained.length, 1)
  assert.equal(result.reports.skipped[0].name, 'second.txt')
  const help = spawnSync(process.execPath, [CLI, 'run', '--help'], { env, encoding: 'utf8' })
  assert.match(help.stdout, /--retain-report/)
})

test('reports: prune only old marked run folders without following links or exceeding walk limits', async () => {
  const { pruneReports } = await import(modulePath)
  const env = environment()
  const base = join(env.XDG_STATE_HOME, 'clodeks/reports')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const old = new Date(Date.now() - 8 * 86400_000)
  const create = (id, marked = true) => {
    const path = join(base, id)
    mkdirSync(path, { mode: 0o700 })
    if (marked) writeFileSync(join(path, '.clodeks-report'), 'clodeks retained reports v1\n', { mode: 0o600 })
    writeFileSync(join(path, 'report.md'), 'report')
    utimesSync(path, old, old)
    return path
  }
  const expired = create('run-11111111-1111-4111-8111-111111111111')
  const unmarked = create('run-22222222-2222-4222-8222-222222222222', false)
  const foreign = create('other-folder')
  const fresh = create('run-33333333-3333-4333-8333-333333333333')
  utimesSync(fresh, new Date(), new Date())
  const outside = join(env.XDG_RUNTIME_DIR, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep.txt'), 'keep')
  symlinkSync(outside, join(expired, 'link'))
  utimesSync(expired, old, old)
  assert.deepEqual(pruneReports(env), [])
  assert.equal(existsSync(expired), false)
  for (const path of [unmarked, foreign, fresh]) assert.equal(existsSync(path), true)
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep')
  const crowded = create('run-44444444-4444-4444-8444-444444444444')
  for (let i = 0; i < 10; i++) writeFileSync(join(crowded, `${i}.md`), 'x')
  utimesSync(crowded, old, old)
  const errors = pruneReports(env, { maxEntries: 10 })
  assert.equal(existsSync(crowded), true)
  assert.ok(errors.some(x => /limit/.test(x)))
})

test('reports: state home fallback uses caller HOME and refuses symlinked state roots', async () => {
  const { retainReports } = await import(modulePath)
  const env = environment()
  const sourceDir = join(env.XDG_RUNTIME_DIR, 'source')
  mkdirSync(sourceDir)
  writeFileSync(join(sourceDir, 'report.md'), 'safe report')
  const fallback = { ...env, XDG_STATE_HOME: '', HOME: join(env.XDG_RUNTIME_DIR, 'home') }
  const kept = retainReports({ names: ['report.md'], sourceDir, env: fallback })
  assert.ok(kept.retained[0].path.startsWith(join(fallback.HOME, '.local/state/clodeks/reports')))
  symlinkSync(sourceDir, env.XDG_STATE_HOME)
  const refused = retainReports({ names: ['report.md'], sourceDir, env })
  assert.deepEqual(refused.retained, [])
  assert.match(refused.skipped[0].reason, /state|link/)
  assert.deepEqual(readdirSync(sourceDir), ['report.md'])
})

test('reports: forwarder and result schema preserve retention outcomes', () => {
  const agent = readFileSync(new URL('../plugin/agents/codex-exec.md', import.meta.url), 'utf8')
  assert.match(agent, /RETAIN_REPORTS/)
  assert.match(agent, /--retain-report/)
  assert.match(agent, /reports.*unchanged/)
  const schema = JSON.parse(readFileSync(new URL('../schemas/run-result.json', import.meta.url), 'utf8'))
  assert.ok(schema.properties.reports.properties.retained)
  assert.ok(schema.properties.reports.properties.skipped)
})
