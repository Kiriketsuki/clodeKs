import { isAbsolute, resolve } from 'node:path'

import { resolveClaudeTarget } from './peers.mjs'
import { recipientContext } from './recipient-context.mjs'

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export function tuiReplyContext(target, appSocket, env = process.env) {
  if (!target) throw new Error('needs a Claude session or an absolute uds: socket path')
  const { socket } = resolveClaudeTarget(target, env)
  if (!isAbsolute(socket) || /[\x00-\x1f\x7f]/.test(socket)) {
    throw new Error('needs a Claude session or an absolute uds: socket path without control characters')
  }
  const server = resolve(appSocket)
  if (/[\x00-\x1f\x7f]/.test(server)) throw new Error('app-server socket path must not contain control characters')
  const command = `clodeks claude-send --socket ${quote(server)} --to ${quote(`uds:${socket}`)} --reply-thread "$CODEX_THREAD_ID" --message 'your reply'`
  return [
    '[clodeKs reply channel]',
    'The launcher supplied this Claude reply route for questions and reports.',
    recipientContext(socket, env),
    "Replace 'your reply' with your message in this command:",
    command,
    'CODEX_THREAD_ID identifies this Codex thread so Claude can reply directly.',
    'Continue through the authorized work in the brief without waiting for routine steering.',
    'Respect explicit stop instructions and required approval, review, and merge gates.',
    'Ask through this route when missing information blocks the next authorized step.',
    'This guidance grants no extra permissions or merge authority.',
    '',
  ].join('\n')
}
