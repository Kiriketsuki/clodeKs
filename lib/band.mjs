import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { idleQueueHint } from './thread-activity.mjs'

// clodeKs as a contributor to the chrysaki band protocol, version 1
// (chrysaki-claude protocol/chrysaki-band/README.md). The chrysaki statusline lists
// $XDG_RUNTIME_DIR/chrysaki-band every 3 s and draws each fresh file's items in its header.
//
// Two sources keep the writers apart:
//   clodeks      inboxd writes it on every sync: up or down. It expires on its own if inboxd dies.
//   clodeks-off  The status fallback writes this item while no inboxd heartbeat is fresh.

export const BAND_VERSION = 1
export const SOURCE = 'clodeks'
export const OFF_SOURCE = 'clodeks-off'
// inboxd writes every 5 s. Three missed syncs and more leave the band.
export const LIVE_TTL_MS = 30000
// The mod calls the fallback every 60 s while the heartbeat is stale.
export const OFF_TTL_MS = 120000
// The statusline reserves a e g h l n o p r s w x.
const HOTKEY = 'c'
const PRESS = { command: 'codex', args: 'panel', hotkey: HOTKEY }
const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

// The folder rule of the protocol, the same on Linux, macOS and Windows. It does not use
// os.tmpdir(), which skips XDG_RUNTIME_DIR and falls back differently on Windows.
export function bandDir(env = process.env) {
  return env.CHRYSAKI_BAND_DIR || join(env.XDG_RUNTIME_DIR || env.TMPDIR || env.TEMP || env.TMP || '/tmp', 'chrysaki-band')
}

// On Windows a rename fails while a reader holds the target. The next sync writes again,
// and the statusline keeps the last good items until the TTL runs out.
const RETRY_LATER = new Set(['EPERM', 'EBUSY', 'EACCES'])

// The `clodeks` source for one heartbeat state (see status.mjs buildState). Pure.
export function liveBand(state, now = state.at) {
  const { active, idle, other, exposed } = state.counts
  const item = state.app_server.up
    ? {
        id: 'status',
        icon: '◆',
        text: `codex ${active} working, ${idle ?? '?'} idle`,
        tone: active > 0 ? 'info' : 'calm',
        hint: `clodeKs: app-server up, ${active} working, ${idle ?? 'unknown'} idle, ${other ?? 'unknown'} other, ${exposed} exposed. ${idleQueueHint(state.counts)}. Client attachment is unknown.`,
        ...PRESS,
      }
    : {
        id: 'status',
        icon: '✕',
        text: 'codex down',
        tone: 'alert',
        hint: `clodeKs: inboxd runs, but the Codex app-server does not answer${state.app_server.error ? `: ${String(state.app_server.error).slice(0, 120)}` : ''}`,
        ...PRESS,
      }
  return { v: BAND_VERSION, source: SOURCE, updatedAt: now, ttlMs: LIVE_TTL_MS, items: [item] }
}

// The `clodeks-off` source. `isOff` is true while no inboxd heartbeat is fresh. Pure.
export function offBand(isOff, now) {
  const items = isOff
    ? [{ id: 'off', icon: '○', text: 'codex off', tone: 'warn', hint: 'clodeKs: no inboxd heartbeat. Start the services from the clodeKs panel.', ...PRESS }]
    : []
  return { v: BAND_VERSION, source: OFF_SOURCE, updatedAt: now, ttlMs: OFF_TTL_MS, items }
}

// An empty list clears the source at once, for example when inboxd stops cleanly.
export function clearedBand(source, now) {
  return { v: BAND_VERSION, source, updatedAt: now, ttlMs: LIVE_TTL_MS, items: [] }
}

// Writes a band file atomically: a temporary file, then a rename. Resolves the target path,
// or null when a reader held the target and the write waits for the next sync.
export function writeBand(file, env = process.env) {
  if (!SOURCE_NAME.test(file.source)) throw new Error(`invalid band source "${file.source}"`)
  const dir = bandDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, `${file.source}.json`)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file) + '\n', { mode: 0o600 })
  try {
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    if (RETRY_LATER.has(err.code)) return null
    throw err
  }
  return target
}
