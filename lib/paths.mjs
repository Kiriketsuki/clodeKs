import { accessSync, constants, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

// The runtime dir holds sockets. Unix socket paths must stay short (SUN_LEN is 108 bytes),
// so this uses XDG_RUNTIME_DIR and not a deep cache path.
export function runtimeDir(env = process.env) {
  const base = env.XDG_RUNTIME_DIR || `/tmp/clodeks-${userInfo().uid}`
  return join(base, 'clodeks')
}

// Creates `dir` if needed and refuses one that another user could control. Under /tmp another
// local user can create the directory first, so an existing directory is checked, not trusted.
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`)
  if (st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`)
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 700 ${dir}`)
  return dir
}

export function privateRuntimeDir(env = process.env) {
  const dir = runtimeDir(env)
  if (!env.XDG_RUNTIME_DIR) ensurePrivateDir(join(dir, '..'))
  return ensurePrivateDir(dir)
}

export function defaultAppSocket(env = process.env) {
  return env.CLODEKS_APP_SOCKET || join(runtimeDir(env), 'app.sock')
}

export function inboxDir(env = process.env) {
  return join(runtimeDir(env), 'inbox')
}

// Thread ids that `clodeks expose` opened to Claude sessions. inboxd serves only these.
export function exposedFile(env = process.env) {
  return join(runtimeDir(env), 'exposed')
}

// Returns the first executable named `name` on PATH, or undefined.
export function which(name, env = process.env) {
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not on this PATH entry. Try the next one.
    }
  }
  return undefined
}

// CLODEKS_CODEX_BIN wins. Otherwise the first `codex` on PATH. Shell aliases do not apply here,
// so the user alias that adds --yolo never reaches a subagent run.
export function resolveCodex(env = process.env) {
  const bin = env.CLODEKS_CODEX_BIN || which('codex', env)
  if (!bin) throw new Error('codex not found. Set CLODEKS_CODEX_BIN or put codex on PATH.')
  return bin
}

// Account wrappers use separate .claude-* folders. Search their registries without
// reading account settings or process environments.
export function claudeConfigDirs(env = process.env) {
  const homePath = env.HOME || homedir()
  const standard = join(homePath, '.claude')
  let accounts = []
  try {
    accounts = readdirSync(homePath).filter(name => name.startsWith('.claude-')).sort()
      .map(name => join(homePath, name)).filter(dir => {
        try { return statSync(join(dir, 'sessions')).isDirectory() } catch { return false }
      })
  } catch {
    // Explicit folders still work when the home directory cannot be listed.
  }
  return [...new Set([
    env.CLAUDE_CONFIG_DIR || standard, standard, ...accounts,
    ...(env.CLODEKS_EXTRA_CLAUDE_DIRS || '').split(delimiter).filter(Boolean),
  ])]
}
