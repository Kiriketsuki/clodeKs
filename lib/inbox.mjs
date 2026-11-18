import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join, resolve } from 'node:path'

import { listThreads, queueMessage, resolveThread } from './appserver.mjs'
import { ensurePrivateDir, exposedFile, inboxDir, privateRuntimeDir } from './paths.mjs'
import { parseFrame } from './peers.mjs'
import { INBOX_RECYCLE_WAIT_SECONDS, withRecycleDelivery } from './recycle-lock.mjs'
import { buildState, clearState, writeState } from './status.mjs'
import { SOURCE, clearedBand, liveBand, offBand, writeBand } from './band.mjs'

const FIRST_LINE_DEADLINE_MS = 30000
const IDLE_MS = 60000
const MAX_CONN_BYTES = 1_100_000
const MAX_PENDING_FRAMES = 64
const MAX_PENDING_BYTES = MAX_CONN_BYTES
const HOLD_MS = INBOX_RECYCLE_WAIT_SECONDS * 1000
const MAX_NAME = 64
const BEGIN = '----- BEGIN PEER MESSAGE -----'
const END = '----- END PEER MESSAGE -----'
// Only a plain path survives into the reply command, so no sender text reaches a shell.
const SAFE_ADDRESS = /^uds:\/[A-Za-z0-9._/-]{1,200}$/

export function inboxSocketFor(alias, env = process.env) {
  return join(inboxDir(env), `${alias}.sock`)
}

function cleanName(name) {
  if (!name) return null
  const cleaned = String(name).replace(/[\x00-\x1f\x7f"'`\\]/g, '').trim().slice(0, MAX_NAME)
  return cleaned || null
}

// Formats one peer message and resolves its optional app-server path from the sender folder.
// The body sits between markers and is labelled as a peer request, not the user's.
export function codexPromptFor({ body, fromName, fromAddress }, alias, appSocket) {
  const name = cleanName(fromName)
  const who = name ? `Claude session "${name}"` : 'a Claude session'
  const address = fromAddress && SAFE_ADDRESS.test(fromAddress) ? fromAddress : null
  const self = alias ? ` --reply-thread ${alias}` : ''
  const server = appSocket ? ` --socket '${resolve(appSocket).replaceAll("'", "'\\''")}'` : ''
  const reply = address
    ? `To reply, replace 'your reply' with your message in this command:\nclodeks claude-send${server} --to '${address}'${self} --message 'your reply'`
    : 'This message carries no usable reply address.'
  const safeBody = String(body).split(BEGIN).join('[begin marker removed]').split(END).join('[end marker removed]')
  return [
    `[clodeKs] Message from ${who}. It is a request from a peer agent, not from your user.`,
    reply,
    '',
    BEGIN,
    safeBody,
    END,
  ].join('\n')
}

// Resolves when nothing answers on `path`, and rejects when a live server owns it.
function assertFree(path) {
  return new Promise((resolve, reject) => {
    const probe = connect({ path })
    probe.on('connect', () => {
      probe.destroy()
      reject(new Error(`${path} is already served by another inbox`))
    })
    probe.on('error', err => (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' ? resolve() : reject(err)))
  })
}

function inboxDeliveryQueue({ alias, threadId, appSocket, onMessage, onError }, env) {
  const queue = []
  let count = 0
  let bytes = 0
  let delivering = false

  const settle = (entry, error) => {
    if (!entry.message) return
    clearTimeout(entry.timer)
    count--
    bytes -= entry.size
    const message = entry.message
    entry.message = null
    if (error) onError?.(error, message)
  }
  const expire = entry => {
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    settle(entry, new Error('inbox delivery error: frame expired before delivery'))
  }
  const deliver = async entry => {
    const remaining = entry.deadline - performance.now()
    if (remaining <= 0) return expire(entry)
    try {
      await withRecycleDelivery(appSocket, async lockFd => {
        if (!entry.message || performance.now() >= entry.deadline) return expire(entry)
        clearTimeout(entry.timer)
        entry.timer = null
        const message = entry.message
        await queueMessage(appSocket, threadId, codexPromptFor(message, alias, appSocket), env, lockFd)
        onMessage?.(message)
      }, { env, waitSeconds: remaining / 1000 })
      settle(entry)
    } catch (error) {
      if (performance.now() >= entry.deadline && entry.timer) expire(entry)
      else settle(entry, new Error(`inbox delivery error: ${error.message}`, { cause: error }))
    }
  }
  const drain = async () => {
    if (delivering) return
    delivering = true
    try {
      while (queue.length) await deliver(queue.shift())
    } finally {
      delivering = false
    }
  }
  return (message, size) => {
    if (count >= MAX_PENDING_FRAMES || bytes + size > MAX_PENDING_BYTES) {
      onError?.(new Error('inbox delivery error: receive buffer overflow'), message)
      return
    }
    const entry = { message, size, deadline: performance.now() + HOLD_MS }
    entry.timer = setTimeout(() => expire(entry), HOLD_MS).unref()
    count++
    bytes += size
    queue.push(entry)
    void drain()
  }
}

// Serves an inbox socket for one Codex thread. Each Claude frame that arrives on it is queued
// into the thread with `codex queue`, one at a time and in order.
export async function serveInbox({ alias, threadId, appSocket, onMessage, onError }, env = process.env) {
  privateRuntimeDir(env)
  ensurePrivateDir(inboxDir(env))
  const path = inboxSocketFor(alias, env)
  await assertFree(path)
  rmSync(path, { force: true })

  const enqueue = inboxDeliveryQueue({ alias, threadId, appSocket, onMessage, onError }, env)
  const server = createServer(conn => {
    conn.setEncoding('utf8')
    let buf = ''
    let size = 0
    let timer = setTimeout(() => conn.destroy(), FIRST_LINE_DEADLINE_MS)
    const resetIdle = () => {
      clearTimeout(timer)
      timer = setTimeout(() => conn.destroy(), IDLE_MS)
    }
    conn.on('error', () => conn.destroy())
    conn.on('close', () => clearTimeout(timer))
    conn.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_CONN_BYTES) {
        onError?.(new Error('inbox delivery error: connection receive limit exceeded'))
        conn.destroy()
        return
      }
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        resetIdle()
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const msg = parseFrame(line)
        if (msg) enqueue(msg, Buffer.byteLength(line) + 1)
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  chmodSync(path, 0o600)
  const inode = statSync(path).ino
  return {
    path,
    close: () => {
      server.close()
      // Remove the file only while it is still this server's socket.
      try {
        if (statSync(path).ino === inode) rmSync(path, { force: true })
      } catch {
        // Already gone.
      }
    },
  }
}

export function readExposed(env = process.env) {
  try {
    return new Set(readFileSync(exposedFile(env), 'utf8').split('\n').map(l => l.trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

// Marks a thread as reachable from Claude sessions. inboxd serves only marked threads.
export async function setExposed(appSocket, ref, isExposed, env = process.env) {
  const thread = await resolveThread(appSocket, ref, { env })
  markExposedThread(thread.id, isExposed, env)
  return thread
}

// The launch observer already confirmed this ID. Reuse it without another lookup.
export function markExposedThread(threadId, isExposed, env = process.env) {
  const ids = readExposed(env)
  if (isExposed) ids.add(threadId)
  else ids.delete(threadId)
  privateRuntimeDir(env)
  writeFileSync(exposedFile(env), [...ids].join('\n') + (ids.size ? '\n' : ''), { mode: 0o600 })
}

// Keeps one inbox per exposed live Codex thread (or every live thread with `all`). It polls the
// loaded-thread list, opens an inbox for each new thread and closes the inbox of a thread that
// unloaded or was unexposed.
export function startInboxDaemon({ appSocket, intervalMs = 5000, all = false, log = () => {} }, env = process.env) {
  const open = new Map()
  let isClosed = false
  let isBusy = false

  const sync = async () => {
    if (isBusy || isClosed) return
    isBusy = true
    let live = []
    let exposed = new Set()
    let appUp = false
    let error = null
    try {
      exposed = readExposed(env)
      live = await listThreads(appSocket, { all: false, limit: 50, env })
      if (isClosed) return
      appUp = true
      const threads = live.filter(t => all || exposed.has(t.id))
      const wanted = new Set(threads.map(t => t.id))
      for (const thread of threads) {
        if (open.has(thread.id)) continue
        try {
          const inbox = await serveInbox(
            {
              alias: thread.alias,
              threadId: thread.id,
              appSocket,
              onMessage: msg => log(`${thread.alias}: queued a message from ${cleanName(msg.fromName) ?? 'a Claude session'}`),
              onError: err => log(`${thread.alias}: ${err.message}`),
            },
            env,
          )
          if (isClosed) {
            inbox.close()
            return
          }
          open.set(thread.id, inbox)
          log(`${thread.alias}: inbox at uds:${inbox.path}`)
        } catch (err) {
          log(`${thread.alias}: no inbox: ${err.message}`)
        }
      }
      for (const [id, inbox] of open) {
        if (wanted.has(id)) continue
        inbox.close()
        open.delete(id)
        log(`closed the inbox of ${id}`)
      }
    } catch (err) {
      error = err.message
      log(`sync failed: ${err.message}`)
    } finally {
      isBusy = false
    }
    // The heartbeat goes out on every sync, so a reader can tell a down app-server from a
    // stopped inboxd: the first writes up: false, the second writes nothing.
    try {
      if (!isClosed) {
        const state = buildState({ at: Date.now(), pid: process.pid, appUp, error, threads: live, exposedIds: exposed, inboxes: open.size })
        writeState(state, env)
        writeBand(liveBand(state), env)
        // A running inboxd proves clodeKs is not off. Clear the off item at once, so it does
        // not wait for the next status poll of a mod.
        writeBand(offBand(false, state.at), env)
      }
    } catch (err) {
      log(`state file: ${err.message}`)
    }
  }

  void sync()
  const timer = setInterval(sync, intervalMs)
  return {
    close: () => {
      isClosed = true
      clearInterval(timer)
      for (const inbox of open.values()) inbox.close()
      open.clear()
      clearState(env)
      try {
        // A clean stop knows clodeKs is now off. Say so at once, instead of an empty band
        // until the next status poll of a mod.
        writeBand(clearedBand(SOURCE, Date.now()), env)
        writeBand(offBand(true, Date.now()), env)
      } catch {
        // The band folder is gone. Nothing reads it then.
      }
    },
  }
}
