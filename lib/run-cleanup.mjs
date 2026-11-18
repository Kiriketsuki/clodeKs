import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function restoreOwnerAccess(folder) {
  const stat = lstatSync(folder, { throwIfNoEntry: false })
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return
  // Removal needs directory access. Leave files and symlink targets unchanged.
  chmodSync(folder, stat.mode | 0o700)
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreOwnerAccess(join(folder, entry.name))
  }
}

export function cleanupRunFolder(folder) {
  try {
    rmSync(folder, { recursive: true, force: true })
    return null
  } catch {
    // A worker can leave directories without owner write permission.
  }
  try {
    restoreOwnerAccess(folder)
    rmSync(folder, { recursive: true, force: true })
    return null
  } catch (err) {
    return `Run folder cleanup failed (${err?.code ?? 'unknown error'}). Temporary files may remain at ${folder}.`
  }
}
