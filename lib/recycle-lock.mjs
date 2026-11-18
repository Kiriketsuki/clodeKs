import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, readlinkSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { ensurePrivateDir, privateRuntimeDir } from './paths.mjs'

const LOCK_BUSY = 75
const DELIVERY_WAIT_SECONDS = 15
export const INBOX_RECYCLE_WAIT_SECONDS = 170
let warnedUnavailable = false

function canonicalSocket(path) {
  let socket = resolve(path)
  for (let hops = 0; hops < 16; hops++) {
    try {
      socket = join(realpathSync(dirname(socket)), basename(socket))
    } catch (error) {
      if (error.code === 'ENOENT') return socket
      throw error
    }
    try {
      socket = resolve(dirname(socket), readlinkSync(socket))
    } catch (error) {
      if (error.code === 'EINVAL' || error.code === 'ENOENT') return socket
      throw error
    }
  }
  throw new Error('cannot resolve app-server socket for the recycle lock')
}

function isSocketOrMissing(path) {
  try { return statSync(path).isSocket() } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

function privateSocketFolder(path) {
  if (!isSocketOrMissing(path)) return null
  const folder = dirname(path)
  try {
    const st = lstatSync(folder)
    if (st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077)) return folder
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return null
}

function lockFile(socket, mode, env) {
  socket = canonicalSocket(socket)
  const folder = privateSocketFolder(socket)
  if (!folder && mode !== 'shared') throw new Error('recycle needs a socket in a private directory')
  const key = createHash('sha256').update(socket).digest('hex')
  const root = folder ? ensurePrivateDir(join(folder, '.recycle')) : privateRuntimeDir(env)
  return join(root, `recycle-${key}.lock`)
}

function lock(fd, mode, waitSeconds, env) {
  const wait = waitSeconds ? ['-w', String(waitSeconds)] : ['-n']
  return new Promise((resolve, reject) => {
    const child = spawn('flock', [mode === 'shared' ? '-s' : '-x', ...wait, '-E', String(LOCK_BUSY), '3'], {
      env, stdio: ['ignore', 'ignore', 'ignore', fd],
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 || code === LOCK_BUSY) resolve(code === 0)
      else reject(new Error(`flock failed for the recycle lock (${code ?? signal})`))
    })
  })
}

function openPrivateLock(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o077)) {
      throw new Error('recycle lock file is not private')
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function fileActivity(fd) {
  const st = fstatSync(fd, { bigint: true })
  return `${st.dev}:${st.ino}:${st.mtimeNs}`
}

export async function acquireRecycleLock(socket, { mode, waitSeconds = 0, env = process.env }) {
  if (!['shared', 'exclusive', 'poll'].includes(mode)) throw new Error('invalid recycle lock mode')
  const path = lockFile(socket, mode, env)
  const fd = openPrivateLock(mode === 'poll' ? path + '.poll' : path)
  let owned = false
  try {
    if (!await lock(fd, mode, waitSeconds, env)) return null
    const noteActivity = () => { if (mode === 'shared') writeSync(fd, '1', 0) }
    noteActivity()
    owned = true
    let closed = false
    return {
      fd,
      statePath: `${path}.json`,
      activity: () => {
        if (mode !== 'poll') return fileActivity(fd)
        const deliveryFd = openPrivateLock(path)
        try { return fileActivity(deliveryFd) } finally { closeSync(deliveryFd) }
      },
      close: () => {
        if (closed) return
        closed = true
        try { noteActivity() } finally { closeSync(fd) }
      },
    }
  } finally {
    if (!owned) closeSync(fd)
  }
}

function warnUnavailable(error, warn) {
  if (warnedUnavailable) return
  warnedUnavailable = true
  warn(`clodeks: recycle lock is unavailable. Delivery continues without the lock. ${error.message}`)
}

export async function withRecycleDelivery(socket, callback, {
  env = process.env, waitSeconds = DELIVERY_WAIT_SECONDS, warn = text => process.stderr.write(text + '\n'),
} = {}) {
  if (process.platform !== 'linux') return callback()
  let lease
  try {
    if (isSocketOrMissing(socket)) lease = await acquireRecycleLock(socket, { env, mode: 'shared', waitSeconds })
  } catch (error) {
    warnUnavailable(error, warn)
    return callback()
  }
  if (lease === undefined) return callback()
  if (!lease) throw new Error('app-server recycle is in progress. Try again after it finishes.')
  try {
    return await callback(lease.fd)
  } finally {
    try { lease.close() } catch (error) { warnUnavailable(error, warn) }
  }
}
