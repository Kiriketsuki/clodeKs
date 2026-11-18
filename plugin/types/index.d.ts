export type CodexThread = {
  id: string
  alias: string
  name: string | null
  status: string
  active_flags: string[]
  queued_count?: number | null
  queued_count_error?: string | null
  loaded: boolean
  cwd: string
  preview: string
  updated_at: number | null
  source: string | null
  backend_source: string | null
  caller_umask?: string | null
  worker_shell_umask?: string | null
  inbox?: string | null
  exposed?: boolean
  client_attachment?: 'unknown'
  idle_age_seconds?: number | null
  idle_age_source?: string | null
  idle_age_error?: string | null
}

export type ClodeksService = { unit: string; enabled: string; active: string }

// The shape of `clodeks status --json`.
export type ClodeksStatus = {
  v: number
  at: number
  services: { appserver: ClodeksService; inboxd: ClodeksService }
  app_server: { socket: string; up: boolean; error: string | null }
  inboxd: { fresh: boolean; pid: number | null }
  codex: { bin: string | null; version: string | null }
  counts: { live: number; active: number; idle?: number; other?: number; idle_queued?: number; idle_queue_unknown?: number; client_attachment?: 'unknown'; exposed: number }
  threads: CodexThread[]
}

export type InboxHeartbeat = {
  v: number
  at: number
  pid: number
  app_server: Pick<ClodeksStatus['app_server'], 'up' | 'error'>
  counts: ClodeksStatus['counts']
  threads?: CodexThread[]
}

declare module 'claude-code' {
  interface PluginState {
    clodeks: {
      status: ClodeksStatus | null
      lastError: string | null
    }
  }
}
