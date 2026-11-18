import { listClaudeSessions } from './peers.mjs'

export function recipientContext(socket, env = process.env) {
  const matches = listClaudeSessions(env).filter(session => session.socket === socket)
  const name = matches.length === 1 ? matches[0].name : null
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(name)) {
    return 'Reply recipient session: unknown. The registry has no usable name for this socket. Do not invent a session name.'
  }
  return `Reply recipient session: ${JSON.stringify(name)}\nUse that session name in the To header. The socket remains the delivery route.`
}
