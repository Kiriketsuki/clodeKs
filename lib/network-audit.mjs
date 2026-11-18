const MAX_LINE = 8192
const MAX_RECORDS = 1000
const TRACE_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z[ \t]+INFO[ \t]+codex_otel\.network_proxy: /

function field(line, name) {
  const escaped = name.replaceAll('.', '\\.')
  const token = line.match(new RegExp(`(?:^|\\s)${escaped}=("(?:[^"\\\\]|\\\\.)*"|[^\\s]+)`))?.[1]
  if (token === undefined) return undefined
  try { return token.startsWith('"') ? JSON.parse(token) : token } catch { return undefined }
}

function admission(line) {
  if (!TRACE_PREFIX.test(line) ||
    field(line, 'event.name') !== 'codex.network_proxy.policy_decision') return null
  const host = field(line, 'server.address')
  const port = Number(field(line, 'server.port'))
  const decision = field(line, 'network.policy.decision')
  const reason = field(line, 'network.policy.reason')
  const time = field(line, 'event.timestamp')
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9.:[\]-]+$/.test(host) ||
    !Number.isInteger(port) || port < 0 || port > 65535 ||
    !['allow', 'deny', 'ask'].includes(decision) || typeof reason !== 'string' || !/^[a-z_]{1,128}$/.test(reason) ||
    typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(time) || !Number.isFinite(Date.parse(time))) return null
  return { host, port, decision, reason, time }
}

// Tracing has no delivery acknowledgement. This collector cannot establish completeness.
export function createNetworkAudit(onDiagnostic = () => {}) {
  let pending = ''
  let dropping = false
  let records = []
  let truncated = false
  const consume = line => {
    if (!line.includes('codex_otel.network_proxy:')) { onDiagnostic(line + '\n'); return }
    const record = admission(line)
    if (!record) return
    if (records.length >= MAX_RECORDS) { truncated = true; return }
    records = [...records, record]
  }
  return {
    get truncated() { return truncated },
    write(chunk) {
      const parts = String(chunk).split('\n')
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]
        if (!dropping) {
          if (pending.length + part.length > MAX_LINE) { pending = ''; dropping = true; truncated = true }
          else pending += part
        }
        if (index < parts.length - 1) {
          if (!dropping) consume(pending)
          pending = ''
          dropping = false
        }
      }
    },
    finish() {
      if (!dropping && pending) consume(pending)
      pending = ''
      return records.length ? [...records] : null
    },
  }
}
