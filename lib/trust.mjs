import { connectAppServer } from './appserver.mjs'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Match the remote TUI trust decision, including inherited project-layer decisions.
// https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/config_update.rs#L209
function remoteTrustStatus(response, cwd) {
  if (!isObject(response?.config) || !Array.isArray(response.layers)) throw new Error('invalid trust response')
  const projects = response.config.projects ?? {}
  if (!isObject(projects) || Object.values(projects).some(project => !isObject(project) ||
    (project.trust_level !== undefined && !['trusted', 'untrusted'].includes(project.trust_level)))) {
    throw new Error('invalid trust projects')
  }
  if (response.layers.some(layer => !isObject(layer) || !isObject(layer.name) || typeof layer.name.type !== 'string' ||
    (layer.disabledReason !== undefined && typeof layer.disabledReason !== 'string'))) {
    throw new Error('invalid trust layers')
  }
  const layers = response.layers.filter(layer => layer.name.type === 'project')
  const disabled = layers.findLast(layer => typeof layer.disabledReason === 'string')
  const reason = disabled?.disabledReason
  const entry = path => Object.hasOwn(projects, path) && typeof projects[path].trust_level === 'string'
    ? projects[path] : null
  const exact = entry(cwd)
  const reasonStart = reason?.indexOf(', add ') ?? -1
  const reasonEnd = reason?.lastIndexOf(' as a trusted project in ') ?? -1
  const reasonTarget = reasonStart >= 0 && reasonEnd >= reasonStart + 6
    ? reason.slice(reasonStart + 6, reasonEnd) : null
  const folder = disabled?.name.dotCodexFolder
  const layerTarget = typeof folder === 'string' && /[/\\]\.codex$/.test(folder)
    ? folder.slice(0, -7) : null
  const target = exact ? cwd : (reasonTarget ?? layerTarget ?? cwd)
  const level = entry(target)?.trust_level
  const inheritedUntrusted = !exact && reason !== undefined && Object.entries(projects).some(([path, project]) =>
    project.trust_level === 'untrusted' && reason.startsWith(`${path} is marked as untrusted`))
  if (level || inheritedUntrusted) return 'decided'
  if (!disabled && layers.some(layer => layer.disabledReason === undefined)) return 'decided'
  if (layers.length === 0 && Object.entries(projects).some(([path, project]) =>
    project.trust_level === 'untrusted' && cwd.startsWith(path.endsWith('/') ? path : `${path}/`))) return 'blocked'
  return 'prompt'
}

export async function readFolderTrust(socket, cwd, { timeoutMs = 1500 } = {}) {
  const client = await connectAppServer(socket, { deadlineMs: Date.now() + timeoutMs })
  try {
    const response = await client.request('config/read', { cwd, includeLayers: true })
    return remoteTrustStatus(response, cwd)
  } finally {
    client.close()
  }
}

// Remote TUIs read project trust from the server, so local -c overrides cannot pre-trust them.
// Codex 0.169.0: https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/config_update.rs#L194
export async function trustFolder(socket, cwd) {
  const client = await connectAppServer(socket)
  try {
    await client.request('config/batchWrite', {
      edits: [{
        keyPath: `projects.${JSON.stringify(cwd)}.trust_level`,
        value: 'trusted',
        mergeStrategy: 'replace',
      }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    })
  } finally {
    client.close()
  }
}
