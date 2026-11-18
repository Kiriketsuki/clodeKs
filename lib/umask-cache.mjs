import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ensurePrivateDir, privateRuntimeDir, runtimeDir } from './paths.mjs'

function cachePath(socketPath, env) {
  const key = createHash('sha256').update(resolve(socketPath)).digest('hex')
  return join(runtimeDir(env), 'mask-cache', `${key}.json`)
}

function privateDirectory(path) {
  const st = lstatSync(path)
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && !(st.mode & 0o077)
}

// A cached PID can exit or belong to a new process before the next poll.
export function sameMaskProcess({ pid, start }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof start !== 'string' || !/^\d+$/.test(start)) return false
  try {
    if (statSync(`/proc/${pid}`).uid !== process.getuid()) return false
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return !['Z', 'X'].includes(fields[0]) && fields[19] === start
  } catch {
    return false
  }
}

export function readMaskCache(socketPath, identity, env) {
  let fd
  try {
    if (!privateDirectory(runtimeDir(env)) || !privateDirectory(join(runtimeDir(env), 'mask-cache'))) return null
    fd = openSync(cachePath(socketPath, env), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 4096) return null
    const record = JSON.parse(readFileSync(fd, 'utf8'))
    if (record?.v !== 1 || record.socket_identity !== identity ||
      typeof record.mask !== 'string' || !/^0[0-7]{3}$/.test(record.mask) || !sameMaskProcess(record)) return null
    return { mask: record.mask, pid: record.pid, start: record.start, stable: true }
  } catch {
    // Missing, malformed, or unsafe cache files require a new observation.
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function writeMaskCache(socketPath, identity, observation, env) {
  try {
    ensurePrivateDir(join(privateRuntimeDir(env), 'mask-cache'))
    const path = cachePath(socketPath, env)
    const temporary = `${path}.${randomUUID()}.tmp`
    const record = { v: 1, socket_identity: identity, mask: observation.mask, pid: observation.pid, start: observation.start }
    writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch {
    // Cache failures do not discard a valid observation or stop a caller.
  }
}
