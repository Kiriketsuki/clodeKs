import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants, fstatSync, futimesSync, lstatSync, openSync, opendirSync, readlinkSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { liveRunFolders } from './jobs.mjs'
import { privateRuntimeDir } from './paths.mjs'

const RUN_NAME = /^run-[A-Za-z0-9]{6}$/
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
// Linux O_PATH pins directories even when a worker removed their read permissions.
const PATH_FLAGS = (1 << 21) | constants.O_DIRECTORY | constants.O_NOFOLLOW
const empty = () => ({ removed: [], skipped: [], errors: [], complete: true, throttled: false, skipped_processes: 0 })
const reason = err => err.code ?? err.message
const inside = (path, folder) => path === folder || path.startsWith(`${folder}/`)
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const identity = st => `${st.dev}:${st.ino}`

function privateDirectory(fd) {
  const st = fstatSync(fd)
  if (st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('Orphan scan directory is not private')
  return st
}

function processCwds(procRoot, maxProcesses, checkBudget, view) {
  const paths = []
  const identities = new Set()
  const dir = opendirSync(procRoot)
  let count = 0
  try {
    for (let entry; (entry = dir.readSync());) {
      checkBudget()
      if (++count > maxProcesses) throw new Error('Process ownership scan limit reached')
      if (!/^\d+$/.test(entry.name)) continue
      try {
        const path = join(procRoot, entry.name)
        if (statSync(path).uid !== process.getuid()) continue
        const cwd = readlinkSync(join(path, 'cwd')).replace(/ \(deleted\)$/, '')
        const st = statSync(join(path, 'cwd'))
        paths.push(cwd)
        identities.add(identity(st))
      } catch (err) {
        if (['EACCES', 'EPERM'].includes(err.code)) view.skipped_processes++
        else if (!['ENOENT', 'ESRCH'].includes(err.code)) throw err
      }
    }
  } finally { dir.closeSync() }
  return { paths, identities }
}

// Keep directory descriptors until deletion ends. Worker symlinks never become directory traversal paths.
function planFolder(path, budget, depth = 0, held = []) {
  budget.check()
  if (++budget.entries > budget.maxEntries || depth > 40) throw new Error('Orphan walk limit reached')
  let st = lstatSync(path)
  if (!st.isDirectory() || st.isSymbolicLink()) return { path, st, children: null }
  const fd = openSync(path, PATH_FLAGS)
  held.push(fd)
  if (!same(st, fstatSync(fd))) throw new Error('Orphan directory changed during scan')
  if (st.uid !== process.getuid()) throw new Error('Orphan directory belongs to another user')
  // The #122 repair applies only to real directories. Pin the descriptor before any mode change.
  if ((st.mode & 0o700) !== 0o700) {
    chmodSync(`/proc/self/fd/${fd}`, st.mode | 0o700)
    st = fstatSync(fd)
  }
  const dir = opendirSync(`/proc/self/fd/${fd}`)
  const children = []
  try {
    for (let entry; (entry = dir.readSync());) children.push(planFolder(join(`/proc/self/fd/${fd}`, entry.name), budget, depth + 1, held))
  } finally { dir.closeSync() }
  return { path, st, fd, children }
}

function flatten(node) { return [node, ...(node.children ?? []).flatMap(flatten)] }

function removePlan(node) {
  if (!same(node.st, lstatSync(node.path))) throw new Error('Orphan entry changed before removal')
  if (!node.children) return unlinkSync(node.path)
  for (const child of node.children) removePlan(child)
  // Child removal changes directory timestamps. The pinned identity must still match its name.
  const current = lstatSync(node.path)
  if (current.dev !== node.st.dev || current.ino !== node.st.ino || !current.isDirectory()) throw new Error('Orphan directory changed before removal')
  rmdirSync(node.path)
}

function sweep(root, options) {
  const view = empty()
  const { now = Date.now(), maxEntries = 10_000, maxProcesses = 10_000, procRoot = '/proc', maxMs = 500 } = options
  const end = performance.now() + maxMs
  const check = () => { if (performance.now() > end) throw new Error('Orphan scan time limit reached') }
  let rootFd
  let dir
  try {
    const stamp = fstatSync(3)
    if (stamp.size && now - stamp.mtimeMs < HOUR) return { ...view, throttled: true }
    writeSync(3, '1', 0, 'utf8')
    futimesSync(3, new Date(now), new Date(now))
    rootFd = openSync(root, FLAGS)
    privateDirectory(rootFd)
    const pinned = `/proc/self/fd/${rootFd}`
    const canonicalRoot = readlinkSync(pinned)
    const jobs = liveRunFolders(pinned, { maxEntries, checkBudget: check })
    const owned = new Set()
    for (const path of jobs) {
      check()
      const st = lstatSync(path, { throwIfNoEntry: false })
      if (st) owned.add(identity(st))
    }
    const cwds = processCwds(procRoot, maxProcesses, check, view)
    dir = opendirSync(pinned)
    const budget = { entries: 0, maxEntries, check }
    let candidates = 0
    for (let entry; (entry = dir.readSync());) {
      check()
      if (++budget.entries > maxEntries) throw new Error('Orphan walk limit reached')
      if (!RUN_NAME.test(entry.name)) continue
      if (++candidates > 100) throw new Error('Orphan folder limit reached')
      const path = join(root, entry.name)
      const target = join(pinned, entry.name)
      const st = lstatSync(target)
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) {
        view.skipped.push({ path, reason: 'Run folder is not an owned plain private directory' })
        continue
      }
      if (now - st.mtimeMs <= DAY) {
        view.skipped.push({ path, reason: 'Folder or entry is newer than 24 hours' })
        continue
      }
      if (owned.has(identity(st))) { view.skipped.push({ path, reason: 'Live job owns this folder' }); continue }
      if (cwds.paths.some(cwd => inside(cwd, join(canonicalRoot, entry.name)))) { view.skipped.push({ path, reason: 'Live process cwd owns this folder' }); continue }
      const held = []
      try {
        const plan = planFolder(target, budget, 0, held)
        if (!plan.children || plan.st.dev !== st.dev || plan.st.ino !== st.ino) throw new Error('Orphan root changed during scan')
        const entries = flatten(plan)
        if (entries.some(item => item.children && cwds.identities.has(identity(item.st)))) {
          view.skipped.push({ path, reason: 'Live process cwd owns a directory in this folder' })
          continue
        }
        if (entries.some(item => now - item.st.mtimeMs <= DAY)) {
          view.skipped.push({ path, reason: 'Folder or entry is newer than 24 hours' })
          continue
        }
        if (entries.some(item => !same(item.st, lstatSync(item.path)))) throw new Error('Orphan entry changed after scan')
        check()
        removePlan(plan)
        view.removed.push(path)
      } catch (err) {
        view.complete = false
        view.errors.push(`${path}: ${reason(err)}`)
      } finally { for (const fd of held) closeSync(fd) }
    }
  } catch (err) { view.complete = false; view.errors.push(`Orphan sweep failed: ${reason(err)}`) }
  finally {
    dir?.closeSync()
    if (rootFd !== undefined) closeSync(rootFd)
  }
  return view
}

// flock releases the shared stamp lock even if the bounded sweep process dies.
export function sweepOrphanRuns(env = process.env, options = {}) {
  const view = empty()
  let fd
  try {
    const root = privateRuntimeDir(env)
    fd = openSync(join(root, '.orphan-cleanup.stamp'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o077) || st.size > 1) throw new Error('Orphan sweep stamp is not private')
    if (st.size && (options.now ?? Date.now()) - st.mtimeMs < HOUR) return { ...view, throttled: true }
    const output = execFileSync('flock', ['-F', '-n', '-E', '75', '/proc/self/fd/3', process.execPath,
      fileURLToPath(import.meta.url), '--sweep', root, JSON.stringify(options)],
    { env, stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 1500, maxBuffer: 1024 * 1024 })
    return JSON.parse(output.toString())
  } catch (err) {
    if (err.status === 75) return { ...view, throttled: true }
    return { ...view, complete: false, errors: [`Orphan sweep failed: ${reason(err)}`] }
  } finally { if (fd !== undefined) closeSync(fd) }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--sweep') {
  process.stdout.write(JSON.stringify(sweep(process.argv[3], JSON.parse(process.argv[4]))))
}
