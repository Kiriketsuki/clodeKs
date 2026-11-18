const STDIN_IDLE_TIMEOUT_MS = 5000

// Read through EOF. A pipe can deliver its first bytes after the child starts.
export async function readStdin(input = process.stdin, { timeoutMs = STDIN_IDLE_TIMEOUT_MS } = {}) {
  if (input.isTTY) return ''
  const chunks = []
  const timeout = Object.assign(new Error(
    `standard input idle timeout after ${timeoutMs} ms. Pass the message as an argument or close standard input.`,
  ), { code: 'STDIN_TIMEOUT' })
  const timer = setTimeout(() => input.destroy(timeout), timeoutMs)
  try {
    for await (const chunk of input) {
      timer.refresh()
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch (err) {
    if (err === timeout) throw err
    throw new Error(`cannot read standard input: ${err.code ?? 'read failed'}`, { cause: err })
  } finally {
    clearTimeout(timer)
  }
}
