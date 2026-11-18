import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync,
  rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ensurePrivateDir } from './paths.mjs'

const MAX_BYTES = 1024 * 1024
const MAX_REPORTS = 8
const MAX_AGE_MS = 7 * 86400_000
const MARKER = '.clodeks-report'
const MARKER_TEXT = 'clodeks retained reports v1\n'
const RUN_NAME = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

export function validateRetainReports({ retainReports = [], sandbox }) {
  if (!Array.isArray(retainReports) || retainReports.length > MAX_REPORTS) throw new Error('--retain-report permits at most eight names')
  if (retainReports.length && !['workspace-write', 'read-only'].includes(sandbox)) {
    throw new Error('--retain-report needs workspace-write or read-only permissions')
  }
  if (new Set(retainReports).size !== retainReports.length) throw new Error('--retain-report names must be unique')
  for (const name of retainReports) {
    if (typeof name !== 'string' || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(md|txt)$/.test(name)) {
      throw new Error('--retain-report needs a plain .md or .txt basename of at most 128 characters')
    }
  }
  return [...retainReports]
}

// Check ancestors too. A symlinked state parent must not redirect retained data or pruning.
function plainAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const st = lstatSync(current, { throwIfNoEntry: false })
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new Error('Report state path contains a link or non-directory')
    if (dirname(current) === current) break
  }
}

function reportBase(env, create = false) {
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state')
  if (!isAbsolute(state)) throw new Error('Report state home must be absolute')
  const app = join(state, 'clodeks')
  const base = join(app, 'reports')
  plainAncestors(base)
  if (!create && !lstatSync(base, { throwIfNoEntry: false })) return null
  if (create) mkdirSync(state, { recursive: true, mode: 0o700 })
  ensurePrivateDir(app)
  return ensurePrivateDir(base)
}

function readBounded(path, remaining) {
  // O_NONBLOCK avoids blocking on a FIFO before fstat rejects it.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('Report source is not a regular file')
    if (st.nlink !== 1) throw new Error('Report source has multiple links')
    if (st.size > remaining) throw new Error('Report exceeds the one MiB total limit')
    const buffer = Buffer.alloc(remaining + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length > remaining) throw new Error('Report exceeds the one MiB total limit')
    const after = fstatSync(fd)
    if (after.nlink !== 1 || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) {
      throw new Error('Report source changed during retention')
    }
    return buffer.subarray(0, length)
  } finally { closeSync(fd) }
}

function sourceRoot(path, expected) {
  if (!path) throw new Error('Report source folder is unavailable')
  const st = lstatSync(path)
  if (!st.isDirectory() || st.isSymbolicLink() || (expected && !sameFile(st, expected))) {
    throw new Error('Report source folder changed or is a link')
  }
  return st
}

function readReport(sourceDir, expectedSource, name, remaining) {
  const root = sourceRoot(sourceDir, expectedSource)
  const fd = openSync(sourceDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (!sameFile(root, fstatSync(fd))) throw new Error('Report source folder changed before its descriptor opened')
    const descriptor = `/proc/self/fd/${fd}`
    try { realpathSync(descriptor) } catch {
      throw new Error('Report source directory descriptor is unavailable through /proc/self/fd')
    }
    // The proc descriptor pins the directory. A later rename cannot redirect this basename.
    const data = readBounded(join(descriptor, name), remaining)
    sourceRoot(sourceDir, root)
    return data
  } finally { closeSync(fd) }
}

function createReportFolder(env) {
  const candidate = join(reportBase(env, true), `run-${randomUUID()}`)
  mkdirSync(candidate, { mode: 0o700 })
  try {
    writeFileSync(join(candidate, MARKER), MARKER_TEXT, { mode: 0o600, flag: 'wx' })
    return candidate
  } catch (err) {
    // A failed write can leave a partial marker. Only this new private folder needs cleanup.
    try { unlinkSync(join(candidate, MARKER)) } catch { /* No marker or cleanup refused. */ }
    try { rmdirSync(candidate) } catch { /* Keep the marker failure as the reported cause. */ }
    throw new Error(`Report folder marker write failed (${err.code ?? 'unknown error'})`)
  }
}

function safeReason(error) {
  if (error.code === 'ENOENT') return 'Report source is missing'
  if (error.code === 'ELOOP') return 'Report source is a link'
  if (error.code) return `Report retention failed (${error.code})`
  return error.message
}

export function retainReports({ names, sourceDir, expectedSource, env = process.env, groupAlive = false }) {
  const retained = []
  const skipped = []
  let bytes = 0
  let folder
  let folderError
  for (const name of names) {
    try {
      if (folderError) throw folderError
      if (groupAlive) throw new Error('Report skipped because the worker process group is still running')
      const data = readReport(sourceDir, expectedSource, name, MAX_BYTES - bytes)
      if (!folder) {
        try { folder = createReportFolder(env) }
        catch (err) { folderError = err; throw err }
      }
      const path = join(folder, name)
      writeFileSync(path, data, { mode: 0o600, flag: 'wx' })
      retained.push({ name, path, bytes: data.length })
      bytes += data.length
    } catch (err) { skipped.push({ name, reason: safeReason(err) }) }
  }
  return { retained, skipped }
}

// First collect a bounded no-follow plan. An over-limit folder stays intact for manual cleanup.
function deletionPlan(path, budget, depth = 0) {
  if (++budget.entries > budget.maxEntries || depth > 40) throw new Error('Report pruning walk limit reached')
  const st = lstatSync(path)
  if (!st.isDirectory() || st.isSymbolicLink()) return [{ path, directory: false }]
  const plan = []
  const dir = opendirSync(path)
  try {
    for (let entry; (entry = dir.readSync());) plan.push(...deletionPlan(join(path, entry.name), budget, depth + 1))
  } finally { dir.closeSync() }
  return [...plan, { path, directory: true }]
}

function markedFolder(path, now) {
  const st = lstatSync(path)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || now - st.mtimeMs <= MAX_AGE_MS) return false
  return readBounded(join(path, MARKER), 100).toString() === MARKER_TEXT
}

export function pruneReports(env = process.env, { now = Date.now(), maxEntries = 10_000 } = {}) {
  const errors = []
  let dir
  try {
    const base = reportBase(env)
    if (!base) return errors
    dir = opendirSync(base)
    const budget = { entries: 0, maxEntries }
    for (let entry; (entry = dir.readSync());) {
      if (++budget.entries > maxEntries) { errors.push('Report pruning walk limit reached'); break }
      if (!RUN_NAME.test(entry.name)) continue
      const path = join(base, entry.name)
      try {
        if (!markedFolder(path, now)) continue
        const plan = deletionPlan(path, budget)
        for (const item of plan) {
          if (item.directory) rmdirSync(item.path)
          else unlinkSync(item.path)
        }
      } catch (err) {
        if (err.code !== 'ENOENT') errors.push(safeReason(err))
      }
    }
  } catch (err) { errors.push(safeReason(err)) }
  finally { dir?.closeSync() }
  return [...new Set(errors)]
}
