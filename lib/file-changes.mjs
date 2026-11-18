import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

const MAX_ENTRIES = 100_000

// Metadata avoids file-content reads. Child symlinks never expand the named roots.
export function snapshotFiles(roots, { maxEntries = MAX_ENTRIES, excludePaths = [], includeSizes = false, ignoreGit = true } = {}) {
  const files = new Map()
  const sizes = new Map()
  const errors = []
  const canonicalRoots = roots.map(root => {
    try { return realpathSync(root) } catch { return resolve(root) }
  })
  const excluded = excludePaths.map(path => {
    try { return realpathSync(path) } catch { return resolve(path) }
  })
  const pending = [...new Set(canonicalRoots)]
  const visited = new Set()
  let entries = 0
  while (pending.length) {
    const path = pending.pop()
    if (visited.has(path) || excluded.some(base => path === base || path.startsWith(base + sep))) continue
    visited.add(path)
    if (++entries > maxEntries) { errors.push(`File snapshot entry limit reached (${maxEntries}).`); break }
    try {
      const stat = lstatSync(path, { bigint: true })
      if (stat.isDirectory()) {
        if (!ignoreGit || basename(path) !== '.git') pending.push(...readdirSync(path).map(name => join(path, name)))
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        files.set(path, [stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.ino].join(':'))
        if (includeSizes && stat.isFile()) sizes.set(path, { bytes: stat.size,
          allocated: typeof stat.blocks === 'bigint' && stat.blocks >= 0n ? stat.blocks * 512n : null,
          identity: `${stat.dev}:${stat.ino}` })
      }
    } catch (err) {
      errors.push(`${path}: ${err.code ?? 'scan failed'}`)
    }
  }
  return { files, sizes, excluded_paths: excluded, roots: [...new Set(canonicalRoots)], complete: errors.length === 0, errors }
}

export function changedFiles(before, after) {
  return [...new Set([...before.files.keys(), ...after.files.keys()])]
    .filter(path => {
      const was = before.files.has(path)
      const now = after.files.has(path)
      if (was && now) return before.files.get(path) !== after.files.get(path)
      // An incomplete scan cannot prove that an absent entry did not exist.
      return was ? after.complete : before.complete
    }).sort()
}
