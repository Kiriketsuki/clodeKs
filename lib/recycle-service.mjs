import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { UNITS } from './status.mjs'
import { probeAppServerPeer, socketIdentity } from './umask.mjs'
import { sameMaskProcess } from './umask-cache.mjs'

const exec = promisify(execFile)
const CUA_NODE_ROOT = '/usr/lib/chatgpt/resources/cua_node'
const SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'])
const MAX_CGROUPS = 64
const MAX_GROUP_PROCESSES = 256
const RESTART_SETTLE_MS = 15_000
const QUEUE_REPORT_LIMIT = 100
const QUEUE_READER = fileURLToPath(new URL('./recycle-queue.py', import.meta.url))
const SYSTEMD_PROPS = ['ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'InvocationID', 'Job']

async function serviceProperties(env) {
  const { stdout } = await exec('systemctl', ['--user', 'show',
    ...SYSTEMD_PROPS.map(key => '--property=' + key), UNITS.appserver],
  { env, timeout: 3000, maxBuffer: 4096 })
  return Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=', 2)))
}

const unifiedGroup = pid => readFileSync(`/proc/${pid}/cgroup`, 'utf8').match(/^0::(.+)$/m)?.[1]

export async function readManagedService(socket, env) {
  const identity = socketIdentity(socket)
  if (!identity) throw new Error('managed app-server socket is unavailable')
  const [properties, peerResult] = await Promise.all([
    serviceProperties(env), probeAppServerPeer(socket, 1500),
  ])
  const { ActiveState, SubState, MainPID, ControlGroup, InvocationID } = properties
  const peer = JSON.parse(peerResult)
  if (ActiveState !== 'active' || SubState !== 'running' || !/^[1-9]\d*$/.test(MainPID) ||
      !/^\/[\w./:@-]+$/.test(ControlGroup) || ControlGroup.split('/').some(part => part === '.' || part === '..') ||
      !/^[a-f0-9]{32}$/.test(InvocationID) ||
      !peer || !Number.isSafeInteger(peer.pid) || peer.pid <= 0 || peer.stable !== true ||
      typeof peer.start !== 'string' || !/^\d+$/.test(peer.start)) {
    throw new Error('cannot verify the managed app-server service and socket owner')
  }
  if (unifiedGroup(peer.pid) !== ControlGroup || unifiedGroup(MainPID) !== ControlGroup ||
      !sameMaskProcess(peer) || socketIdentity(socket) !== identity) {
    throw new Error('app-server socket does not belong to the managed service')
  }
  return {
    generation: `${InvocationID}:${peer.pid}:${peer.start}:${identity}`,
    peerPid: peer.pid, mainPid: Number(MainPID), controlGroup: ControlGroup,
  }
}

function processParent(folder) {
  const stat = readFileSync(join(folder, 'stat'), 'utf8')
  const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1])
  if (!Number.isSafeInteger(parent) || parent < 0) throw new Error('service process parent is unavailable')
  return parent
}

function serverProcessChain({ mainPid, peerPid, controlGroup }, procRoot) {
  // The listener can run under a launcher between the unit's MainPID and Codex.
  const managed = new Set()
  let pid = peerPid
  while (Number.isSafeInteger(pid) && pid > 0 && !managed.has(pid) && managed.size < 16) {
    const folder = join(procRoot, String(pid))
    if (readFileSync(join(folder, 'cgroup'), 'utf8').match(/^0::(.+)$/m)?.[1] !== controlGroup) break
    managed.add(pid)
    if (pid === mainPid) return managed
    pid = processParent(folder)
  }
  throw new Error('cannot verify the app-server process chain')
}

function serviceProcessIds(folder) {
  const folders = [folder]
  const ids = new Set()
  for (let index = 0; index < folders.length; index++) {
    const root = folders[index]
    const contents = readFileSync(join(root, 'cgroup.procs'), 'utf8').trim()
    for (const text of contents ? contents.split(/\s+/) : []) {
      const pid = Number(text)
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(pid)) throw new Error('invalid service cgroup process ID')
      ids.add(pid)
      if (ids.size > MAX_GROUP_PROCESSES) throw new Error('service cgroup has too many processes to verify')
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) folders.push(join(root, entry.name))
      if (folders.length > MAX_CGROUPS) throw new Error('service cgroup tree exceeds the scan limit')
    }
  }
  return [...ids].sort((a, b) => a - b)
}

function codexInstallRoot(executable) {
  const vendorPackage = executable.match(/^(.*\/codex(?:-[\w.-]+)?)\/vendor\/[^/]+\/bin\/codex$/)?.[1]
  if (vendorPackage) return vendorPackage
  const dir = dirname(executable)
  const release = dirname(dir)
  if (basename(dir) === 'bin' && (basename(release).startsWith('codex-') ||
      dirname(release).endsWith('/app-server-daemon/releases'))) return release
  // A flat install can share a binary directory with unrelated programs.
  return null
}

function helperClass(executable, roots) {
  if (!isAbsolute(executable) || executable.endsWith(' (deleted)') || SHELLS.has(basename(executable))) return null
  return Object.keys(roots).find(key => roots[key] && executable.startsWith(roots[key] + sep)) ?? null
}

function describeProcess(procRoot, pid, roots) {
  const folder = join(procRoot, String(pid))
  try {
    const command = readFileSync(join(folder, 'comm'), 'utf8').trim().replace(/[\x00-\x1f\x7f]/g, '?')
    const parent = processParent(folder)
    let executable
    try { executable = readlinkSync(join(folder, 'exe')) } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    }
    return { pid, command, parent, type: executable ? helperClass(executable, roots) : null }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    // Process churn requires another idle observation.
    return { pid, command: 'exited during scan' }
  }
}

export function readBackgroundProcesses(service, { procRoot = '/proc', cgroupRoot = '/sys/fs/cgroup' } = {}) {
  const { controlGroup, codexHome, peerPid } = service
  const known = serverProcessChain(service, procRoot)
  const ids = serviceProcessIds(join(cgroupRoot, controlGroup))
  if ([...known].some(pid => !ids.includes(pid))) throw new Error('service cgroup changed during the scan')
  const roots = {
    codex_install: codexInstallRoot(readlinkSync(join(procRoot, String(peerPid), 'exe'))),
    cua_node: CUA_NODE_ROOT,
    plugin_cache: codexHome ? join(realpathSync(codexHome), 'plugins', 'cache') : null,
  }
  const allowed = { server_chain: known.size, codex_install: 0, cua_node: 0, plugin_cache: 0 }
  const extra = ids.filter(pid => !known.has(pid)).map(pid => describeProcess(procRoot, pid, roots))
  let changed
  do {
    changed = false
    for (const process of extra) {
      if (process.type && known.has(process.parent) && !known.has(process.pid)) {
        known.add(process.pid)
        allowed[process.type]++
        changed = true
      }
    }
  } while (changed)
  const background = extra.filter(process => !known.has(process.pid)).map(({ pid, command }) => ({ pid, command }))
  return { allowed, background }
}

export async function readDurableQueue(service, { env }) {
  const { stdout } = await exec('python3', ['-I', '-B', QUEUE_READER, String(service.peerPid), String(QUEUE_REPORT_LIMIT)], {
    env, timeout: 1800, maxBuffer: 32768,
  })
  const result = JSON.parse(stdout)
  const { pending_count: count, entries } = result ?? {}
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 128
  if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(entries) ||
      entries.length !== Math.min(count, QUEUE_REPORT_LIMIT) || entries.some(entry =>
        !validId(entry?.submission_id) || !validId(entry.thread_id) ||
        !Number.isSafeInteger(entry.created_at_ms) || entry.created_at_ms < 0)) {
    throw new Error('cannot verify the app-server durable queue')
  }
  return result
}

async function waitForSettledService(env) {
  const deadline = Date.now() + RESTART_SETTLE_MS
  while (Date.now() < deadline) {
    try {
      const { ActiveState, SubState, Job } = await serviceProperties(env)
      if (Job === '' && (ActiveState === 'failed' || (ActiveState === 'active' && SubState === 'running'))) {
        return ActiveState
      }
    } catch {
      // The service manager can return incomplete state while the job changes.
    }
    await sleep(250)
  }
  return null
}

export async function restartManagedAppServer(env) {
  try {
    await exec('systemctl', ['--user', 'restart', UNITS.appserver], { env, timeout: 110_000, maxBuffer: 8192 })
  } catch (error) {
    if (!error.killed) throw error
    const settled = await waitForSettledService(env)
    if (settled === 'active') return
    throw new Error(settled === 'failed'
      ? 'the restart timed out and systemd reports the app-server failed'
      : 'the restart timed out and systemd did not settle before the deadline',
    { cause: error })
  }
}
