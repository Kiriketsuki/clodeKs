import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'

const MAX_BYTES = 64 * 1024
const COMMAND_BYTES = 8 * 1024

function bounded(text, limit, tail = false) {
  const bytes = Buffer.from(text)
  if (bytes.length <= limit) return { text, truncated: false }
  let start = tail ? bytes.length - limit : 0
  let end = tail ? bytes.length : limit
  if (tail) while (start < end && (bytes[start] & 0xc0) === 0x80) start++
  else while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return { text: bytes.subarray(start, end).toString('utf8'), truncated: true }
}

export function readStoppedOutputFile(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile()) return { text: '', truncated: false }
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    const count = readSync(fd, bytes, 0, bytes.length, 0)
    const result = bounded(new StringDecoder('utf8').write(bytes.subarray(0, count)), MAX_BYTES)
    return { ...result, truncated: result.truncated || st.size > MAX_BYTES || count > MAX_BYTES }
  } catch { return { text: '', truncated: false } }
  finally { if (fd !== undefined) closeSync(fd) }
}

// Reserve space for the command tail before messages consume the shared byte budget.
export function stoppedOutput(folded, outText, outTruncated = false) {
  const rawCommand = typeof folded.lastCommandOutput === 'string' ? folded.lastCommandOutput : ''
  const sanitized = stripVTControlCharacters(rawCommand).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, control =>
    control === '\n' || control === '\t' ? control : '')
  const command = bounded(sanitized, COMMAND_BYTES, true)
  let remaining = MAX_BYTES - Buffer.byteLength(command.text)
  const items = []
  for (const [source, value, truncated] of [
    ['output_file', outText, outTruncated],
    ['agent_message_update', folded.messageUpdate, false],
    ['agent_message', folded.lastMessage, false],
  ]) {
    if (typeof value !== 'string' || (!value.trim() && !truncated)) continue
    const item = bounded(value.trim(), remaining)
    items.push({ source, ...item, truncated: item.truncated || truncated })
    remaining -= Buffer.byteLength(item.text)
  }
  if (sanitized) items.push({ source: 'command_output', ...command })
  return { items, bytes: items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
    truncated: items.some(item => item.truncated) }
}
