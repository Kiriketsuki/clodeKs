import { resolve } from 'node:path'

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const unavailable = message => ({ command_candidates: [], commands_truncated: null, command_details_error: message })

export function approvalResumeCommand(socket, threadId) {
  return `clodeks tui --socket ${quote(resolve(socket))} -- resume ${quote(threadId)}`
}

// History can redact text and cannot link an item to an approval request.
// These readers never attach a client or replay a request.
export async function readApprovalCommandCandidates(client, threadId, deadlineMs) {
  try {
    const turns = await client.request('thread/turns/list', {
      threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    }, { deadlineMs })
    if (!Array.isArray(turns?.data) || turns.data.length !== 1) {
      return unavailable('Current command history is unavailable.')
    }
    const turn = turns.data[0]
    if (typeof turn?.id !== 'string' || !turn.id || turn.status !== 'inProgress') {
      return unavailable('Current in-progress turn history is unavailable.')
    }
    const page = await client.request('thread/items/list', {
      threadId, turnId: turn.id, limit: 100, sortDirection: 'desc',
    }, { deadlineMs })
    if (!Array.isArray(page?.data) || page.data.length > 100 ||
        (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) {
      return unavailable('Current command history is unavailable. Invalid item page.')
    }
    const candidates = []
    for (const entry of page.data) {
      const item = entry?.item
      if (entry?.turnId !== turn.id || typeof item?.type !== 'string') {
        return unavailable('Current command history is unavailable. Invalid turn item.')
      }
      if (item.type !== 'commandExecution' || item.status !== 'inProgress') continue
      if (typeof item.id !== 'string' || !item.id || typeof item.command !== 'string' || !item.command || typeof item.cwd !== 'string') {
        return unavailable('Current command history is unavailable. Invalid command item.')
      }
      candidates.push({ item_id: item.id, turn_id: turn.id, command: item.command, cwd: item.cwd, approval_confirmed: false })
    }
    return {
      command_candidates: candidates,
      commands_truncated: page.nextCursor != null,
      command_details_error: candidates.length ? null : 'Command text is unavailable in this history page.',
    }
  } catch (err) {
    return unavailable(`Command history is unavailable: ${err.message}`)
  }
}
