import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensurePrivateDir, privateRuntimeDir, runtimeDir } from './paths.mjs'
import { routingName } from './tui-identity.mjs'
import { sameMaskProcess } from './umask-cache.mjs'
import { callerUmask, unknownWorkerUmask } from './umask.mjs'

const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function launcherIdentity() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return { launcher_start: start, launcher_boot_id: boot }
  } catch {
    return { launcher_start: null, launcher_boot_id: null }
  }
}

function liveLauncher(record) {
  if (record.exited_at !== null || !sameMaskProcess({ pid: record.launcher_pid, start: record.launcher_start })) return false
  try {
    return typeof record.launcher_boot_id === 'string' && !!record.launcher_boot_id &&
      record.launcher_boot_id === readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return false
  }
}

export function createLaunchRecord({ launchId, cwd, briefPath, onError, workerMask = unknownWorkerUmask(), gate, expose = false, tmuxWindowName = null }, env = process.env) {
  if (!LAUNCH_ID.test(launchId ?? '')) {
    throw new Error('invalid launch ID')
  }
  const folder = ensurePrivateDir(join(privateRuntimeDir(env), 'launches'))
  const path = join(folder, `${launchId}.json`)
  if (existsSync(path)) throw new Error(`launch record already exists: ${path}`)
  const created = Date.now()
  let state = {
    v: 1, launch_id: launchId, cwd, brief_path: briefPath, launcher_pid: process.pid, ...launcherIdentity(),
    created_at: created, updated_at: created, exited_at: null,
    tmux_window_name: routingName(tmuxWindowName),
    status: 'observing', alias: null, thread_id: null, error: null,
    caller_umask: callerUmask(), ...workerMask, ...(gate ? { gate } : {}),
    ...(expose ? { exposure: { status: 'pending', error: null } } : {}),
  }
  const persist = value => {
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  }
  persist(state)
  const update = patch => {
    state = { ...state, ...patch, updated_at: Date.now() }
    try {
      persist(state)
    } catch (err) {
      onError(err)
    }
  }
  return {
    path,
    identified: (alias, threadId) => update({ status: 'identified', alias, thread_id: threadId, error: null }),
    naming: (name, error = null) => update({ naming: { name, status: error ? 'failed' : 'named', error } }),
    unavailable: message => update({ status: 'unavailable', error: message }),
    exposure: (status, error = null) => update({ exposure: { status, error } }),
    finished: () => update({
      ...(state.exposure?.status === 'pending' ? { exposure: {
        status: 'unavailable', error: 'TUI exited before inbox exposure',
      } } : {}),
      exited_at: Date.now(),
      ...(state.status === 'observing' ? { status: 'closed', error: 'TUI exited before alias identification' } : {}),
    }),
  }
}

function privateLaunchFolder(env) {
  const root = runtimeDir(env)
  const folder = join(root, 'launches')
  for (const directory of [root, folder]) {
    const st = lstatSync(directory)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) {
      throw new Error('Cannot verify the private launch record directory.')
    }
  }
  return folder
}

function readLaunchRecord(folder, launchId) {
  let fd
  try {
    fd = openSync(join(folder, `${launchId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.size > 16384) return null
    const bytes = Buffer.alloc(16385)
    const size = readSync(fd, bytes, 0, bytes.length, 0)
    if (size > 16384) return null
    const record = JSON.parse(bytes.subarray(0, size).toString('utf8'))
    return record?.v === 1 && record.launch_id === launchId && record.status === 'identified' ? record : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// A launch record proves creation provenance after the launcher exits. It does not prove current ownership.
export function readThreadLaunch(thread, env = process.env) {
  const match = typeof thread.preview === 'string' && thread.preview.match(
    /^\[clodeks launch ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\](?:\s|$)/,
  )
  if (!match) return null
  try {
    const record = readLaunchRecord(privateLaunchFolder(env), match[1])
    if (!record || record.thread_id !== thread.id || record.cwd !== thread.cwd) return null
    const mask = typeof record.caller_umask === 'string' && /^0[0-7]{3}$/.test(record.caller_umask)
      ? record.caller_umask : null
    const windowName = routingName(record.tmux_window_name)
    return { source: 'clodeks-tui', caller_umask: mask,
      tmux_window_name: windowName && liveLauncher(record) ? windowName : null }
  } catch {
    return null
  }
}

export function hasLiveThreadLauncher(threadId, env = process.env) {
  try {
    const folder = privateLaunchFolder(env)
    return readdirSync(folder).some(name => {
      if (!name.endsWith('.json')) return false
      const launchId = name.slice(0, -5)
      if (!LAUNCH_ID.test(launchId)) return false
      const record = readLaunchRecord(folder, launchId)
      return record?.thread_id === threadId && liveLauncher(record)
    })
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

export function readCallerUmask(thread, env = process.env) {
  return readThreadLaunch(thread, env)?.caller_umask ?? null
}
