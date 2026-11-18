import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listThreads } from './appserver.mjs'
import { threadCounts } from './thread-activity.mjs'
import { readExposed } from './inbox.mjs'
import { defaultAppSocket, privateRuntimeDir, resolveCodex, runtimeDir } from './paths.mjs'

export const UNITS = { appserver: 'clodeks-appserver.service', inboxd: 'clodeks-inboxd.service' }
// inboxd writes the state file every 5 s. A file older than this means inboxd is not running.
export const STATE_FRESH_MS = 20000
export const STATE_VERSION = 1

// The heartbeat that inboxd writes and the chrysaki statusline reads.
export function stateFile(env = process.env) {
  return join(runtimeDir(env), 'state.json')
}

// Builds the heartbeat from one inboxd sync. Pure.
export function buildState({ at, pid, appUp, error, threads, exposedIds, inboxes }) {
  return {
    v: STATE_VERSION,
    at,
    pid,
    app_server: { up: appUp, error: error ?? null },
    counts: {
      ...threadCounts(threads),
      exposed: threads.filter(t => exposedIds.has(t.id)).length,
      inboxes,
    },
    threads: threads.map(thread => ({ ...thread, exposed: exposedIds.has(thread.id) })),
  }
}

// Writes the heartbeat atomically, so a reader never sees half a file.
export function writeState(state, env = process.env) {
  privateRuntimeDir(env)
  const file = stateFile(env)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function clearState(env = process.env) {
  rmSync(stateFile(env), { force: true })
}

// Reads the heartbeat. Null when it is missing, unreadable or stale. Pure apart from the read.
export function readState(env = process.env, now = Date.now()) {
  try {
    const state = JSON.parse(readFileSync(stateFile(env), 'utf8'))
    if (state?.v !== STATE_VERSION || typeof state.at !== 'number' || state.at > now || now - state.at > STATE_FRESH_MS) return null
    return state
  } catch {
    return null
  }
}

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 5000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '').trim() }))
  })
}

async function serviceState(unit) {
  const [enabled, active] = await Promise.all([
    run('systemctl', ['--user', 'is-enabled', unit]),
    run('systemctl', ['--user', 'is-active', unit]),
  ])
  return { unit, enabled: enabled.out || 'unknown', active: active.out || 'unknown' }
}

// A full status read runs systemctl and Codex. Share one result across concurrent CLI readers.
export const STATUS_CACHE_MS = 8000

export function statusCacheFile(env = process.env) {
  return join(runtimeDir(env), 'status.json')
}

function readStatusCache(env, now, ttlMs) {
  try {
    const st = JSON.parse(readFileSync(statusCacheFile(env), 'utf8'))
    if (st?.v !== STATE_VERSION || typeof st.at !== 'number') return null
    const age = now - st.at
    return age >= 0 && age < ttlMs ? st : null
  } catch {
    return null
  }
}

function writeStatusCache(st, env) {
  privateRuntimeDir(env)
  const file = statusCacheFile(env)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(st) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// Returns a status that is at most `ttlMs` old, and shares it between processes through a
// file in the runtime dir. The inboxd heartbeat is cheap, so a cache hit reads it again. The
// band logic in `clodeks status --band` then never acts on a stale heartbeat. It never throws.
export async function sharedStatus(env = process.env, { now = Date.now(), ttlMs = STATUS_CACHE_MS, collect = collectStatus } = {}) {
  const cached = readStatusCache(env, now, ttlMs)
  if (cached) {
    const heartbeat = readState(env, now)
    return { ...cached, inboxd: { fresh: heartbeat !== null, pid: heartbeat?.pid ?? null } }
  }
  const st = await collect(env)
  try {
    writeStatusCache(st, env)
  } catch {
    // The next poll reads the status again. The cache only saves work.
  }
  return st
}

// Everything the status panel shows, from one process. It never throws.
export async function collectStatus(env = process.env) {
  const socket = defaultAppSocket(env)
  const [appserver, inboxd] = await Promise.all([serviceState(UNITS.appserver), serviceState(UNITS.inboxd)])
  let codex = { bin: null, version: null }
  try {
    const bin = resolveCodex(env)
    const ver = await run(bin, ['--version'])
    codex = { bin, version: ver.ok ? ver.out.replace(/^codex-cli\s*/, '') : null }
  } catch {
    // codex is missing. The panel says so.
  }
  let threads = []
  let appUp = false
  let error = null
  if (existsSync(socket)) {
    try {
      threads = await listThreads(socket, { all: false, limit: 50, env })
      appUp = true
    } catch (err) {
      error = err.message
    }
  } else {
    error = 'no app-server socket'
  }
  const exposed = readExposed(env)
  const heartbeat = readState(env)
  return {
    v: STATE_VERSION,
    at: Date.now(),
    services: { appserver, inboxd },
    app_server: { socket, up: appUp, error },
    inboxd: { fresh: heartbeat !== null, pid: heartbeat?.pid ?? null },
    codex,
    counts: {
      ...threadCounts(threads),
      exposed: threads.filter(t => exposed.has(t.id)).length,
    },
    threads: threads.map(t => ({ ...t, exposed: exposed.has(t.id) })),
  }
}
