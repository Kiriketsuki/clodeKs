import { stripVTControlCharacters } from 'node:util'

const MAX_ERROR_CHARS = 500
const MAX_RAW_CHARS = 8192
const ERROR_READ_BUDGET_MS = 1500

function safeMessage(value) {
  if (typeof value !== 'string') return null
  const text = stripVTControlCharacters(value.slice(0, MAX_RAW_CHARS))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!text) return null
  return text.length > MAX_ERROR_CHARS || value.length > MAX_RAW_CHARS
    ? text.slice(0, MAX_ERROR_CHARS - 3) + '...' : text
}

// Error text is untrusted worker data. Read no items and retain only a bounded message.
export async function readLastTurnError(client, threadId, { deadlineMs = Infinity } = {}) {
  try {
    const page = await client.request('thread/turns/list', {
      threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    }, { deadlineMs: Math.min(deadlineMs, Date.now() + ERROR_READ_BUDGET_MS) })
    const turn = Array.isArray(page?.data) && page.data.length === 1 ? page.data[0] : null
    if (typeof turn?.id !== 'string' || !turn.id) return null
    return safeMessage(turn.error?.message)
  } catch {
    return null
  }
}

export function lastTurnErrorText(message) {
  const safe = safeMessage(message)
  return safe ? `Last turn error (untrusted): ${JSON.stringify(safe)}` : 'Last turn error unavailable.'
}
