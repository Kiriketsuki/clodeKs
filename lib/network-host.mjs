import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { verifyNamedPermissions } from './permission-check.mjs'

const MAX_HOSTS = 64
const CREDENTIAL_PATHS = ['.ssh', '.gnupg', '.codex/auth.json', '.config/gh', '.config/act-secrets',
  '.netrc', '.npmrc', '.pypirc', '.docker/config.json', '.aws', '.kube', '.git-credentials']
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home', 'localdomain', 'arpa']

export function normalizeNetworkHosts(hosts = []) {
  if (!Array.isArray(hosts) || hosts.length > MAX_HOSTS) {
    throw new Error('--network-host accepts at most 64 DNS host names')
  }
  return [...new Set(hosts.map(host => {
    if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
      throw new Error('--network-host requires an exact public DNS host name')
    }
    const name = host.toLowerCase()
    let parsed
    try { parsed = new URL(`http://${name}`).hostname } catch {
      throw new Error('--network-host requires an exact public DNS host name')
    }
    const labels = name.split('.')
    if (isIP(parsed) || parsed !== name || labels.length < 2 || /^\d+$/.test(labels.at(-1)) ||
      LOCAL_SUFFIXES.some(suffix => name === suffix || name.endsWith(`.${suffix}`)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('--network-host requires an exact public DNS host name')
    }
    return name
  }))]
}

export function validateNetworkHosts(opts, platform = process.platform) {
  const hosts = normalizeNetworkHosts(opts.networkHosts)
  if (!hosts.length) return hosts
  if (platform !== 'linux') throw new Error('--network-host requires Linux')
  if (!['read-only', 'workspace-write'].includes(opts.sandbox)) {
    throw new Error('--network-host requires read-only or workspace-write')
  }
  if (opts.loopbackIsolated) throw new Error('--network-host cannot combine with --loopback-isolated')
  return hosts
}

export function networkHostSettings(opts) {
  const hosts = validateNetworkHosts(opts)
  const profile = opts.networkProfile
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9_]+$/.test(profile)) {
    throw new Error('--network-host requires a unique profile name')
  }
  const roots = [...new Set([opts.outboxDir, ...(opts.gitDirs ?? []), ...(opts.addDirs ?? [])].filter(Boolean))]
  const entries = roots.map(path => `${JSON.stringify(path)}=true`).join(',')
  const domains = hosts.map(host => `${JSON.stringify(host)}="allow"`).join(',')
  const homes = [...new Set([homedir(), opts.homeDir].filter(Boolean))]
  if (homes.some(home => !isAbsolute(home)) || (opts.codexHome && !isAbsolute(opts.codexHome))) {
    throw new Error('--network-host requires absolute home paths')
  }
  const credentialPaths = [...new Set([...homes.flatMap(home => CREDENTIAL_PATHS.map(path => join(home, path))),
    ...(opts.codexHome ? [join(opts.codexHome, 'auth.json')] : [])])]
  const denied = credentialPaths.map(path => `${JSON.stringify(path)}="deny"`)
  const temporary = opts.sandbox === 'read-only' && opts.tempDir ? [`${JSON.stringify(opts.tempDir)}="write"`] : []
  const filesystem = `filesystem={${[...temporary, ...denied].join(',')}}`
  const parent = opts.sandbox === 'read-only' ? ':read-only' : ':workspace'
  const network = 'enabled=true,mode="full",proxy_url="http://127.0.0.1:0",' +
    'enable_socks5=false,enable_socks5_udp=false,allow_upstream_proxy=false,allow_local_binding=false,' +
    `domains={${domains}},unix_sockets={},dangerously_allow_all_unix_sockets=false,dangerously_allow_non_loopback_proxy=false`
  return [
    `default_permissions=${JSON.stringify(profile)}`,
    `permissions.${profile}={extends=${JSON.stringify(parent)},workspace_roots={${entries}},${filesystem},network={${network}}}`,
    'features.network_proxy=true',
    'features.use_legacy_landlock=false',
  ]
}

export async function verifyNetworkHosts(codex, cwd, settings, env) {
  const checked = await verifyNamedPermissions(codex, cwd, settings, env, '--network-host')
  const config = checked.config
  if (!config || typeof config !== 'object' || !Object.hasOwn(config, 'sandbox_workspace_write')) {
    throw new Error('--network-host cannot verify filesystem settings')
  }
  const workspace = config.sandbox_workspace_write
  if (workspace && Object.hasOwn(workspace, 'network_access') && workspace.network_access !== false) {
    throw new Error('--network-host requires restricted network access')
  }
  if (workspace !== null && (!Array.isArray(workspace.writable_roots) || workspace.writable_roots.length ||
    workspace.exclude_tmpdir_env_var !== false || workspace.exclude_slash_tmp !== false)) {
    throw new Error('--network-host requires default workspace filesystem settings')
  }
}
