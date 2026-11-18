import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

// A sandboxed --git worker can write the git dirs. This guard finds state it left behind that a
// later host git command would act on. It fails closed: an error while it looks counts as unsafe.
// Git state that starts a command or redirects a write. A repo that already has one before the
// run is not flagged, only a new one is.
const OPERATION_NAMES = ['rebase-merge', 'rebase-apply', 'sequencer', 'MERGE_HEAD', 'CHERRY_PICK_HEAD',
  'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'AUTO_MERGE', 'MERGE_AUTOSTASH']
const POINTER_FILES = ['commondir', 'gitdir', 'HEAD', 'objects/info/alternates', 'objects/info/http-alternates']
// Fetch and gc rewrite remote-tracking refs, packed-refs and the commit graph, so those stay out.
const REF_PREFIXES = ['refs/heads/', 'refs/tags/', 'refs/replace/', 'refs/notes/', 'refs/stash']

// Hashes a regular file. It looks at the type first, so a FIFO, socket or device is never opened.
// A read of a FIFO would block the run forever.
export function fileHash(path, odd) {
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : `error:${err.code}`
  }
  if (st.isSymbolicLink()) return 'symlink'
  if (st.isDirectory()) return 'dir'
  if (!st.isFile()) {
    odd?.push(path)
    return 'special'
  }
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (err) {
    return `error:${err.code}`
  }
}

const DEFAULT_LIMITS = { maxEntries: 500_000, maxDepth: 40 }

// Walks a git dir without following links. Records each symlink and its target. A file that is
// not a regular file, a link or a folder is recorded as special. Going past a cap is unsafe.
function walk(dir, ctx, depth) {
  if (ctx.stop) return
  if (depth > ctx.limits.maxDepth) {
    ctx.errors.push(dir)
    ctx.stop = true
    return
  }
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    ctx.errors.push(dir)
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (++ctx.count > ctx.limits.maxEntries) {
      ctx.errors.push(dir)
      ctx.stop = true
      return
    }
    if (entry.isSymbolicLink()) {
      try {
        ctx.links[path] = readlinkSync(path)
      } catch {
        ctx.errors.push(path)
      }
    } else if (entry.isDirectory()) walk(path, ctx, depth + 1)
    else if (!entry.isFile()) ctx.special.push(path)
  }
}

function listDir(path) {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

// Reads only files. It runs no git command and opens no special file.
export function snapshotGitFiles(gitDirs, limits = {}) {
  const ctx = { links: {}, errors: [], special: [], count: 0, stop: false, limits: { ...DEFAULT_LIMITS, ...limits } }
  const snap = { links: ctx.links, errors: ctx.errors, special: ctx.special, pointers: {}, operations: [] }
  for (const dir of gitDirs) {
    try {
      if (lstatSync(dir).isSymbolicLink()) snap.links[dir] = readlinkSync(dir)
    } catch {
      snap.errors.push(dir)
      continue
    }
    walk(dir, ctx, 0)
    for (const name of POINTER_FILES) snap.pointers[join(dir, name)] = fileHash(join(dir, name), snap.special)
    const info = join(dir, 'info')
    for (const entry of listDir(info)) snap.pointers[join(info, entry)] = fileHash(join(info, entry), snap.special)
    snap.pointers[`${info}/`] = listDir(info).join('\n')
    // Sibling worktrees keep their own HEAD and pointer files in the common dir.
    const trees = join(dir, 'worktrees')
    for (const tree of listDir(trees)) {
      for (const name of ['HEAD', 'gitdir', 'commondir']) {
        snap.pointers[join(trees, tree, name)] = fileHash(join(trees, tree, name), snap.special)
      }
    }
    for (const name of OPERATION_NAMES) {
      try {
        lstatSync(join(dir, name))
        snap.operations.push(join(dir, name))
      } catch {
        // Absent is the normal case.
      }
    }
  }
  snap.special = [...new Set(snap.special)]
  return snap
}

// What makes a repo unsafe to start from. Pre-existing alternates and info files stay allowed.
export function baselineFindings(files, { gitDir, commonDir }) {
  const found = []
  for (const path of files.errors) found.push({ class: 'inspect_error', path })
  for (const path of files.special) found.push({ class: 'special_file', path })
  for (const path of Object.keys(files.links)) found.push({ class: 'symlink', path })
  for (const path of files.operations) found.push({ class: 'operation_state', path })
  const pointer = join(gitDir, 'commondir')
  if (files.pointers[pointer] && files.pointers[pointer] !== 'missing') {
    try {
      const target = readFileSync(pointer, 'utf8').trim()
      if (realpathSync(resolve(gitDir, target)) !== realpathSync(commonDir)) found.push({ class: 'control_changed', path: pointer })
    } catch {
      found.push({ class: 'control_changed', path: pointer })
    }
  }
  return found
}

export function inspectGitFiles(before, after) {
  const found = []
  for (const path of new Set([...before.errors, ...after.errors])) found.push({ class: 'inspect_error', path })
  for (const path of after.special) found.push({ class: 'special_file', path })
  for (const [path, target] of Object.entries(after.links)) {
    if (before.links[path] !== target) found.push({ class: 'symlink', path })
  }
  for (const path of after.operations) {
    if (!before.operations.includes(path)) found.push({ class: 'operation_state', path })
  }
  const keys = new Set([...Object.keys(before.pointers), ...Object.keys(after.pointers)])
  for (const path of [...keys].sort()) {
    const isNewTree = path.includes('/worktrees/') && !(path in before.pointers)
    if (!isNewTree && before.pointers[path] !== after.pointers[path]) found.push({ class: 'control_changed', path })
  }
  return found
}

// `run(args)` runs git in the repo with the safe flags. It returns { code, out, err }.
export async function snapshotGitState(top, run) {
  const state = { gitlinks: {}, modules: top ? fileHash(join(top, '.gitmodules')) : 'missing', refs: {}, error: null }
  const links = await run(['ls-files', '-s', '--full-name', '--', ':/'])
  if (links.code !== 0) state.error = 'ls-files'
  for (const line of links.out.split('\n')) {
    const m = /^160000 (\w+) \d\t(.*)$/.exec(line)
    if (m) state.gitlinks[m[2]] = m[1]
  }
  const refs = await run(['for-each-ref', '--format=%(refname) %(objectname)'])
  if (refs.code !== 0) state.error = 'for-each-ref'
  for (const line of refs.out.split('\n')) {
    const [name, oid] = line.split(' ')
    if (name && REF_PREFIXES.some(p => name.startsWith(p))) state.refs[name] = oid
  }
  return state
}

export function inspectGitState(before, after, { branch, gitDir }) {
  const found = []
  if (after.error) found.push({ class: 'inspect_error', path: gitDir })
  for (const [path, oid] of Object.entries(after.gitlinks)) {
    if (before.gitlinks[path] !== oid) found.push({ class: 'gitlink', path })
  }
  if (before.modules !== after.modules) found.push({ class: 'gitlink', path: '.gitmodules' })
  const own = branch ? `refs/heads/${branch}` : null
  for (const [name, oid] of Object.entries(before.refs)) {
    if (name !== own && after.refs[name] !== oid) found.push({ class: 'refs_moved', path: name })
  }
  for (const name of Object.keys(after.refs)) {
    if (name.startsWith('refs/replace/') && !(name in before.refs)) found.push({ class: 'refs_moved', path: name })
  }
  return found
}
