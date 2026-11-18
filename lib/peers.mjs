import { randomUUID } from 'node:crypto'
import { appendFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

import { claudeConfigDirs } from './paths.mjs'

// Claude Code cross-session messaging, as far as clodeks uses it.
//
// Documented (code.claude.com/docs/en/cross-session-messaging): each session binds an inbox
// Unix socket, exports CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN to its
// children, and accepts an optional {"type":"auth","token":...} first line on Linux.
//
// Internal (read from the 2.1.295 bundle, can change with any update): the registry file
// <configDir>/sessions/<pid>.json, the NDJSON frame and the envelope below.
// clodeks reads the registry and never writes it, so it never claims to be a Claude session.

const ENVELOPE_TAG = 'cross-session-message'
const MAX_LINE_CHARS = 1_000_000

function procStart(pid) {
  try {
    // The command name can contain ") ", so split after the last one.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

function isAlive(record) {
  try {
    process.kill(record.pid, 0)
  } catch {
    return false
  }
  // A recycled pid has a different start time.
  const start = procStart(record.pid)
  return start === undefined || record.procStart === undefined || String(record.procStart) === start
}

// Lists live Claude Code sessions on this machine that have an inbox socket.
export function listClaudeSessions(env = process.env, configDirs = claudeConfigDirs(env)) {
  const sessions = []
  const seenRegistries = new Set()
  const seenSockets = new Set()
  for (const configDir of configDirs) {
    const dir = join(configDir, 'sessions')
    let files
    try {
      const canonical = realpathSync(dir)
      if (seenRegistries.has(canonical)) continue
      seenRegistries.add(canonical)
      files = readdirSync(dir).filter(f => /^\d+\.json$/.test(f))
    } catch {
      continue
    }
    for (const file of files) {
      let record
      try {
        record = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      } catch {
        continue
      }
      if (!record.messagingSocketPath || seenSockets.has(record.messagingSocketPath) || !isAlive(record)) continue
      seenSockets.add(record.messagingSocketPath)
      sessions.push({
        name: record.name ?? null,
        session_id: record.sessionId,
        pid: record.pid,
        cwd: record.cwd,
        kind: record.kind,
        status: record.status ?? null,
        socket: record.messagingSocketPath,
        config_dir: configDir,
        is_self: record.messagingSocketPath === env.CLAUDE_CODE_MESSAGING_SOCKET,
      })
    }
  }
  return sessions
}

// Resolves a target to an inbox socket path: "self", "uds:/path", a session name,
// a session id, or a pid.
export function resolveClaudeTarget(target, env = process.env) {
  if (target === 'self' || target === 'parent') {
    if (!env.CLAUDE_CODE_MESSAGING_SOCKET) {
      throw new Error('No parent Claude session: CLAUDE_CODE_MESSAGING_SOCKET is not set.')
    }
    return { socket: env.CLAUDE_CODE_MESSAGING_SOCKET, isOwnParent: true }
  }
  if (target.startsWith('uds:')) return { socket: target.slice(4), isOwnParent: target.slice(4) === env.CLAUDE_CODE_MESSAGING_SOCKET }
  const configDirs = claudeConfigDirs(env)
  const sessions = listClaudeSessions(env, configDirs)
  const matches = sessions.filter(s => s.name === target || s.session_id === target || String(s.pid) === target)
  if (matches.length === 1) return { socket: matches[0].socket, isOwnParent: matches[0].is_self }
  if (matches.length > 1) {
    const routes = matches.map(s => `session ${s.session_id ?? 'unknown'}, pid ${s.pid}, uds:${s.socket}`).join('\n')
    throw new Error(`"${target}" matches ${matches.length} Claude sessions. Use a listed session ID, PID, or socket.\n${routes}`)
  }
  throw new Error(
    `No live Claude session matches "${target}". ` +
    `Searched registries: ${configDirs.map(dir => join(dir, 'sessions')).join(', ')}. ` +
    'Set CLODEKS_EXTRA_CLAUDE_DIRS for other config folders. Run: clodeks peers --json --diagnostics',
  )
}

// Attribute values lose quotes, angle brackets and control characters, so a sender cannot
// add an attribute or a line to the envelope.
function attr(value) {
  return String(value).replace(/["<>\x00-\x1f\x7f]/g, '')
}

// A body cannot close the envelope early. Text after a forged closing tag would read as if it
// stood outside the peer message.
export function escapeBody(body) {
  return String(body).replace(new RegExp(`</(${ENVELOPE_TAG})`, 'gi'), '&lt;/$1')
}

// Builds the envelope and frame that Claude Code itself sends. Pure.
// clodeks never sets from-mode. A bypass-mode receiver therefore holds a message from an
// unrelated process for approval, which is the safe default.
export function buildFrame({ body, fromName, fromAddress }) {
  const attrs = []
  if (fromAddress) attrs.push(`from="${attr(fromAddress)}"`)
  if (fromName) attrs.push(`from-name="${attr(fromName)}"`)
  const content = `<${ENVELOPE_TAG}${attrs.length ? ' ' + attrs.join(' ') : ''}>\n${escapeBody(body)}\n</${ENVELOPE_TAG}>`
  const frame = {
    msgV: 1,
    msg_id: randomUUID(),
    type: 'user',
    message: { role: 'user', content },
    priority: 'next',
  }
  if (fromAddress) frame.from = fromAddress
  return frame
}

// Parses one inbound frame into { body, fromName, fromAddress }, or null. Pure.
export function parseFrame(line) {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return null
  }
  if (frame?.type !== 'user') return null
  const content = typeof frame.message?.content === 'string'
    ? frame.message.content
    : Array.isArray(frame.message?.content)
      ? frame.message.content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      : ''
  const match = content.match(new RegExp(`^<${ENVELOPE_TAG}([^>]*)>\\n?([\\s\\S]*?)\\n?</${ENVELOPE_TAG}>\\s*$`))
  const attrs = {}
  if (match) for (const [, k, v] of match[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[k] = v
  return {
    body: match ? match[2] : content,
    fromName: attrs['from-name'] ?? null,
    fromAddress: attrs.from ?? (typeof frame.from === 'string' ? frame.from : null),
    msgId: typeof frame.msg_id === 'string' ? frame.msg_id : null,
  }
}

// Posts one message to a Claude inbox socket.
export function sendToClaude({ socket, body, fromName, fromAddress, isOwnParent }, env = process.env) {
  const frame = buildFrame({ body, fromName, fromAddress })
  const line = JSON.stringify(frame)
  if (line.length > MAX_LINE_CHARS) {
    return Promise.reject(new Error(`Message is ${line.length} characters. The limit is ${MAX_LINE_CHARS}.`))
  }
  return new Promise((resolve, reject) => {
    const sock = connect({ path: socket })
    sock.on('error', reject)
    sock.on('connect', () => {
      // The auth line proves an own-child sender where process evidence is missing.
      if (isOwnParent && env.CLAUDE_CODE_MESSAGING_TOKEN) {
        sock.write(JSON.stringify({ type: 'auth', token: env.CLAUDE_CODE_MESSAGING_TOKEN }) + '\n')
      }
      sock.end(line + '\n', () => resolve({ msg_id: frame.msg_id, socket }))
    })
  })
}

// Inside a `clodeks run --relay` subagent the sandbox blocks sockets. A message to the parent
// session goes to the outbox file, and the clodeks run outside the sandbox forwards it.
export function appendToOutbox(file, { body, fromName }) {
  const line = JSON.stringify({ body, fromName: fromName ?? null }) + '\n'
  if (line.length > MAX_LINE_CHARS) throw new Error(`Message is ${line.length} characters. The limit is ${MAX_LINE_CHARS}.`)
  appendFileSync(file, line)
  return { relayed: true, outbox: file }
}
