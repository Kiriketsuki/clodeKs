import { connectAppServer, isHiddenThreadHelper, threadAlias } from './appserver.mjs'

const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim()
const emptyStartupRollout = error => typeof error?.message === 'string' &&
  error.message.startsWith('thread/read:') && /(?:^|: )rollout at [^\r\n]+ is empty$/.test(error.message)

// Never start or resume a thread here. Name only a uniquely confirmed brief thread.
export async function observeBriefLaunch(socket, {
  cwd, brief, launchId, onAlias, onWarning, name = null, onName, timeoutMs = 15000, nameTimeoutMs = 1500, pollMs = 250, settleMs = 500,
}) {
  const marker = `[clodeks launch ${launchId}]`
  if (!/^[0-9a-f-]{36}$/.test(launchId ?? '') || !brief.startsWith(`${marker}\n`)) {
    throw new Error('brief launch observation requires a unique launch marker')
  }
  const startedAt = Math.floor(Date.now() / 1000)
  const client = await connectAppServer(socket)
  let closed = false
  let busy = false
  let candidates = new Map()
  let stableId = null
  let stableSince = 0
  let lastStartupReadError = null
  let poll
  let deadline
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(poll)
    clearTimeout(deadline)
    client.close()
  }
  const warn = message => {
    if (closed) return
    close()
    onWarning(message)
  }
  let baseline
  try {
    const loaded = await client.request('thread/loaded/list', {})
    if (!Array.isArray(loaded.data)) throw new Error('invalid loaded thread list')
    baseline = new Set(loaded.data)
  } catch (err) {
    close()
    throw err
  }
  const expected = normalize(brief)
  const matches = thread => {
    const preview = normalize(thread.preview)
    return preview.startsWith(`${marker} `) &&
      (expected.length < 120 ? preview === expected : preview.slice(0, 120) === expected.slice(0, 120))
  }
  const eligible = thread => thread?.cwd === cwd && thread.ephemeral === false &&
    typeof thread.id === 'string' && thread.createdAt >= startedAt - 1 &&
    thread.threadSource === 'user' && !isHiddenThreadHelper(thread) && !baseline.has(thread.id)

  const refresh = async () => {
    if (closed || busy || candidates.size === 0) return
    busy = true
    try {
      for (const [id, candidate] of candidates) {
        if (normalize(candidate.preview) && !matches(candidate)) continue
        const { thread } = await client.request('thread/read', { threadId: id })
        if (closed) return
        if (thread?.id !== id) throw new Error('thread read returned a different ID')
        candidates = new Map([...candidates, [id, thread]])
      }
      lastStartupReadError = null
      const found = [...candidates.values()].filter(t => eligible(t) && matches(t))
      if (found.length > 1) return warn('brief thread alias is ambiguous. Use clodeks threads --json to select it.')
      const id = found[0]?.id ?? null
      if (id !== stableId) {
        stableId = id
        stableSince = Date.now()
      }
      const unresolved = [...candidates.values()].some(t => eligible(t) && !normalize(t.preview))
      if (id && !unresolved && Date.now() - stableSince >= settleMs) {
        onAlias(threadAlias(found[0]), id)
        if (closed) return
        if (name) {
          // The alias is already proven. A slow metadata write must not erase that route.
          clearTimeout(deadline)
          deadline = setTimeout(() => {
            if (closed) return
            onName?.(name, 'thread/name/set timed out')
            close()
          }, nameTimeoutMs)
          let error = null
          try {
            await client.request('thread/name/set', { threadId: id, name })
          } catch (err) {
            error = err.message
          }
          if (closed) return
          onName?.(name, error)
        }
        close()
      }
    } catch (err) {
      if (closed) return
      if (emptyStartupRollout(err)) {
        // A fresh notification can precede rollout content. Never bind from an older successful snapshot.
        stableId = null
        stableSince = 0
        lastStartupReadError = err.message
        return
      }
      warn(`brief thread alias is unavailable: ${err.message}`)
    } finally {
      busy = false
    }
  }
  client.onNotification(message => {
    const thread = message.params?.thread
    if (closed || message.method !== 'thread/started' || !eligible(thread)) return
    candidates = new Map([...candidates, [thread.id, thread]])
    void refresh()
  })
  poll = setInterval(() => { void refresh() }, pollMs)
  deadline = setTimeout(() => {
    const detail = lastStartupReadError ? ` Last startup read error: ${lastStartupReadError}.` : ''
    warn(`brief thread alias was not identified before the launch timeout.${detail} Use clodeks threads --json.`)
  }, timeoutMs)
  return { close }
}
