import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { ensurePrivateDir, privateRuntimeDir, runtimeDir } from './paths.mjs'

const MAX_RECORD_BYTES = 16384
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HINT = 'Private exec jobs cannot receive shared app-server messages through codex_send. This view reads metadata only. Completed runs leave no history. Use --all to include stale records.'

function processStart(pid, strict = false) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    if (statSync(`/proc/${pid}`).uid !== process.getuid()) return null
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return !['Z', 'X'].includes(fields[0]) && /^\d+$/.test(fields[19] ?? '') ? fields[19] : null
  } catch (err) {
    if (strict && !['ENOENT', 'ESRCH'].includes(err.code)) throw err
    return null
  }
}

function bootId() { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }

function checkDirectory(path) {
  const st = lstatSync(path)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) {
    throw new Error('job metadata directory is not private')
  }
}

function persist(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
}

// Each invocation owns one record, even when several runs share a wrapper process or cwd.
export function createJobRecord({ cwd, onError = () => {} }, env = process.env) {
  const start = processStart(process.pid)
  if (!start) throw new Error('cannot identify the run process')
  const folder = ensurePrivateDir(join(privateRuntimeDir(env), 'jobs'))
  const jobId = randomUUID()
  const path = join(folder, `${jobId}.json`)
  let state = {
    v: 1, job_id: jobId, pid: process.pid, start, boot_id: bootId(),
    codex_pid: null, codex_start: null, cwd, started_at: Date.now(), state: 'starting', thread_id: null,
  }
  persist(path, state)
  const update = patch => {
    state = { ...state, ...patch }
    try { persist(path, state) } catch (err) { onError(err) }
  }
  return {
    folder: path => update({ run_folder: path }),
    running: pid => {
      const start = processStart(pid)
      if (!start) return onError(new Error('cannot identify the Codex process'))
      update({ state: 'running', codex_pid: pid, codex_start: start })
    },
    identified: threadId => update({ thread_id: threadId }),
    finishing: () => update({ state: 'finishing' }),
    finished: () => {
      try { unlinkSync(path) } catch (err) { if (err.code !== 'ENOENT') onError(err) }
    },
  }
}

function validRecord(record, name) {
  const pid = value => Number.isSafeInteger(value) && value > 0
  const start = value => typeof value === 'string' && /^\d+$/.test(value)
  return record?.v === 1 && UUID.test(record.job_id) && name === `${record.job_id}.json` &&
    pid(record.pid) && start(record.start) && typeof record.boot_id === 'string' && UUID.test(record.boot_id) &&
    typeof record.cwd === 'string' && isAbsolute(record.cwd) && record.cwd.length <= 8192 &&
    (record.run_folder === undefined || (typeof record.run_folder === 'string' && isAbsolute(record.run_folder) && record.run_folder.length <= 8192)) &&
    Number.isSafeInteger(record.started_at) && record.started_at > 0 &&
    ['starting', 'running', 'finishing'].includes(record.state) &&
    (record.thread_id === null || (typeof record.thread_id === 'string' && record.thread_id.length > 0 && record.thread_id.length <= 512)) &&
    ((record.codex_pid === null && record.codex_start === null && record.state !== 'running') ||
      (pid(record.codex_pid) && start(record.codex_start)))
}

// A surviving child still owns scratch after its wrapper dies. Listing jobs uses a stricter lifecycle view.
export function liveRunFolders(root, { maxEntries = 10_000, checkBudget = () => {} } = {}) {
  const folders = new Set()
  const folder = join(root, 'jobs')
  let fd
  let dir
  try {
    fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('job metadata directory is not private')
    const pinned = `/proc/self/fd/${fd}`
    dir = opendirSync(pinned)
    const boot = bootId()
    let count = 0
    for (let entry; (entry = dir.readSync());) {
      checkBudget()
      if (++count > maxEntries) throw new Error('Job ownership scan limit reached')
      if (!entry.name.endsWith('.json')) continue
      let record
      try { record = readRecord(join(pinned, entry.name), entry.name) } catch (err) {
        if (err.code === 'ENOENT') continue
        throw err
      }
      if (record.boot_id !== boot) continue
      const wrapper = processStart(record.pid, true) === record.start
      const child = record.codex_pid !== null && processStart(record.codex_pid, true) === record.codex_start
      if (!wrapper && !child) continue
      if (!record.run_folder) throw new Error('Live job has no run folder association')
      folders.add(record.run_folder)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  } finally {
    dir?.closeSync()
    if (fd !== undefined) closeSync(fd)
  }
  return folders
}

function readRecord(path, name) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > MAX_RECORD_BYTES) {
      throw new Error('job record is not a private regular file')
    }
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1)
    const size = readSync(fd, bytes, 0, bytes.length, 0)
    if (size > MAX_RECORD_BYTES) throw new Error('job record is too large')
    let record
    try { record = JSON.parse(bytes.subarray(0, size).toString('utf8')) } catch {
      throw new Error('invalid job record JSON')
    }
    if (!validRecord(record, name)) throw new Error('invalid job record')
    return record
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// This read never creates directories, deletes stale records, or connects to an app-server.
export function listJobs({ all = false } = {}, env = process.env) {
  const jobs = []
  const errors = []
  const folder = join(runtimeDir(env), 'jobs')
  let names
  let boot
  try {
    checkDirectory(runtimeDir(env))
    checkDirectory(folder)
    names = readdirSync(folder).filter(name => name.endsWith('.json')).sort()
    boot = bootId()
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`Cannot read job metadata: ${err.message}`)
    return { jobs, errors, hint: HINT }
  }
  for (const name of names) {
    try {
      const record = readRecord(join(folder, name), name)
      const active = record.boot_id === boot && processStart(record.pid) === record.start &&
        (record.state !== 'running' || processStart(record.codex_pid) === record.codex_start)
      if (!active && !all) continue
      jobs.push({
        job_id: record.job_id, pid: record.pid, codex_pid: record.codex_pid, cwd: record.cwd,
        started_at: record.started_at, elapsed_ms: Math.max(0, Date.now() - record.started_at),
        state: active ? record.state : 'stale', thread_id: record.thread_id,
      })
    } catch (err) {
      // Another run can remove its record between readdir and open.
      if (err.code !== 'ENOENT') errors.push(`Cannot read job record ${name}: ${err.message}`)
    }
  }
  return { jobs: jobs.sort((a, b) => a.started_at - b.started_at || a.job_id.localeCompare(b.job_id)), errors, hint: HINT }
}
