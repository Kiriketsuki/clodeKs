import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readMaskCache, sameMaskProcess, writeMaskCache } from './umask-cache.mjs'

const helper = fileURLToPath(new URL('./umask-peer.py', import.meta.url))

export function unknownWorkerUmask() {
  return { worker_shell_umask: null, worker_shell_umask_source: null }
}

export function socketIdentity(socketPath) {
  try {
    const st = statSync(socketPath, { bigint: true })
    return st.isSocket() ? `${st.dev}:${st.ino}:${st.ctimeNs}` : null
  } catch {
    return null
  }
}

export function probeAppServerPeer(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-B', helper, target], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs, killSignal: 'SIGKILL',
    })
    let output = ''
    child.stdout.on('data', data => {
      output += data
      if (output.length > 4096) child.kill('SIGKILL')
    })
    child.once('error', reject)
    child.once('close', code => code === 0 && output.length <= 4096
      ? resolve(output) : reject(new Error('app-server mask probe failed')))
  })
}

// Python exposes Linux socket peer credentials. A missing helper leaves the mask unknown.
// The probe does not send protocol messages or change a process mask.
export async function appServerUmask(socketPath, {
  probe = probeAppServerPeer, timeoutMs = 1500, expectedIdentity = socketIdentity(socketPath), env = process.env,
} = {}) {
  if (timeoutMs <= 0 || !expectedIdentity || socketIdentity(socketPath) !== expectedIdentity) return unknownWorkerUmask()
  const cached = readMaskCache(socketPath, expectedIdentity, env)
  if (cached && socketIdentity(socketPath) === expectedIdentity) {
    return { worker_shell_umask: cached.mask, worker_shell_umask_source: 'app-server' }
  }
  try {
    const result = JSON.parse(await probe(socketPath, timeoutMs))
    if (socketIdentity(socketPath) !== expectedIdentity || !result ||
      Object.keys(result).sort().join(',') !== 'mask,pid,stable,start' ||
      !Number.isSafeInteger(result.pid) || result.pid <= 0 || result.stable !== true ||
      typeof result.start !== 'string' || !/^\d+$/.test(result.start) ||
      typeof result.mask !== 'string' || !/^0[0-7]{3}$/.test(result.mask) || !sameMaskProcess(result)) return unknownWorkerUmask()
    writeMaskCache(socketPath, expectedIdentity, result, env)
    return { worker_shell_umask: result.mask, worker_shell_umask_source: 'app-server' }
  } catch {
    // Unsupported systems, inaccessible processes, and failed probes stay unknown.
    return unknownWorkerUmask()
  }
}

// Node's process.umask() getter changes the mask briefly. Read Linux process status instead.
// https://github.com/nodejs/node/blob/v24.14.1/doc/api/process.md#processumask
export function callerUmask(statusPath = '/proc/self/status') {
  try {
    return readFileSync(statusPath, 'utf8').match(/^Umask:[ \t]*(0[0-7]{3})[ \t]*$/m)?.[1] ?? null
  } catch {
    return null
  }
}
