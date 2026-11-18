import { verifyNamedPermissions } from './permission-check.mjs'
import { temporaryFilesystem } from './readonly-temp.mjs'

export function validateIsolatedLoopback(sandbox, platform = process.platform) {
  if (platform !== 'linux') throw new Error('--loopback-isolated requires Linux')
  if (!['read-only', 'workspace-write'].includes(sandbox)) {
    throw new Error('--loopback-isolated requires read-only or workspace-write')
  }
}

export function isolatedLoopbackSettings(opts, profile = 'clodeks_loopback_isolated') {
  validateIsolatedLoopback(opts.sandbox)
  const roots = [...new Set([opts.outboxDir, ...(opts.gitDirs ?? []), ...(opts.addDirs ?? [])].filter(Boolean))]
  const entries = roots.map(path => `${JSON.stringify(path)}=true`).join(',')
  const parent = opts.sandbox === 'read-only' ? ':read-only' : ':workspace'
  // The proxy bridges only its own endpoints into the private network namespace.
  // Empty domains deny proxy egress. Managed requirements need a separate check.
  const network = 'enabled=true,mode="full",proxy_url="http://127.0.0.1:0",socks_url="http://127.0.0.1:0",' +
    'enable_socks5=true,enable_socks5_udp=false,allow_upstream_proxy=false,allow_local_binding=true,' +
    'domains={},unix_sockets={},dangerously_allow_all_unix_sockets=false,dangerously_allow_non_loopback_proxy=false'
  return [
    `default_permissions=${JSON.stringify(profile)}`,
    `permissions.${profile}={extends=${JSON.stringify(parent)},workspace_roots={${entries}}${temporaryFilesystem(opts)},network={${network}}}`,
    'features.network_proxy=true',
    'features.use_legacy_landlock=false',
  ]
}

export async function verifyIsolatedLoopback(codex, cwd, settings, env = process.env) {
  const checked = await verifyNamedPermissions(codex, cwd, settings, env, '--loopback-isolated')
  const config = checked.config
  if (!config || typeof config !== 'object' || !Object.hasOwn(config, 'sandbox_workspace_write')) {
    throw new Error('--loopback-isolated cannot verify filesystem settings')
  }
  const workspace = config.sandbox_workspace_write
  if (workspace !== null && (!Array.isArray(workspace.writable_roots) || workspace.writable_roots.length ||
    workspace.exclude_tmpdir_env_var !== false || workspace.exclude_slash_tmp !== false)) {
    throw new Error('--loopback-isolated requires default workspace filesystem settings')
  }
}
