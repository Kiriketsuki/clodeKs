import { snapshotFiles } from './file-changes.mjs'

function byteNumber(value) {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}

// This measures retained regular files, not write traffic or exclusive physical blocks.
export function ownedDiskUsage(folder, options = {}) {
  const snapshot = snapshotFiles([folder], { ...options, includeSizes: true, ignoreGit: false })
  const seen = new Set()
  let logical = 0n
  let allocated = 0n
  let allocationKnown = true
  for (const file of snapshot.sizes.values()) {
    if (seen.has(file.identity)) continue
    seen.add(file.identity)
    logical += file.bytes
    if (file.allocated === null) allocationKnown = false
    else allocated += file.allocated
  }
  const logicalBytes = byteNumber(logical)
  const allocatedBytes = allocationKnown ? byteNumber(allocated) : null
  const errors = [...snapshot.errors,
    ...(logicalBytes === null ? ['Logical byte total exceeds the safe numeric range.'] : []),
    ...(allocatedBytes === null ? ['Allocated byte total is unavailable or exceeds the safe numeric range.'] : []),
  ]
  return { root: folder, measurement: 'before_cleanup', logical_bytes: logicalBytes, allocated_bytes: allocatedBytes,
    files: seen.size, complete: errors.length === 0, errors }
}

// An incomplete baseline cannot prove that an unobserved path is new.
export function workspaceGrowth(before, after) {
  let bytes = 0n
  const grown = []
  for (const [path, file] of after.sizes) {
    const previous = before.sizes.get(path)
    if (!previous && !before.complete && !before.files.has(path)) continue
    const delta = previous ? file.bytes - previous.bytes : file.bytes
    if (delta > 0n) { bytes += delta; grown.push({ path, bytes: delta }) }
  }
  const total = byteNumber(bytes)
  const largest = [...grown].sort((a, b) => a.bytes === b.bytes
    ? (a.path < b.path ? -1 : a.path === b.path ? 0 : 1) : a.bytes > b.bytes ? -1 : 1).slice(0, 5)
  const errors = [...before.errors, ...after.errors,
    ...(total === null ? ['Workspace growth exceeds the safe numeric range.'] : [])]
  return { bytes: total, files: grown.length,
    largest_paths: largest.map(file => ({ path: file.path, bytes: byteNumber(file.bytes) })),
    complete: before.complete && after.complete && errors.length === 0, errors,
    roots: before.roots, excluded_paths: after.excluded_paths, ignored_directories: ['.git'] }
}
