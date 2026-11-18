import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function inside(root, target) {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function existing(path) {
  try {
    return lstatSync(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function inspect(dir, roots) {
  let parent = dir
  let suffix = []
  while (!existing(parent)) {
    suffix = [basename(parent), ...suffix]
    const next = dirname(parent)
    if (next === parent) throw new Error(`--add-dir: no existing parent: ${dir}`)
    parent = next
  }
  if (!statSync(parent).isDirectory()) throw new Error(`--add-dir: not a folder: ${dir}`)
  const target = resolve(realpathSync(parent), ...suffix)
  if (suffix.length && !roots.some(root => inside(root, target))) {
    throw new Error(`--add-dir: create missing folders only inside cwd or the temporary directory: ${dir}`)
  }
  return { missing: suffix.length > 0, target }
}

// Validate every path before mkdir. Canonical parents prevent static symlink escapes.
export function prepareAddDirs(dirs, { cwd, sandbox }) {
  if (!dirs.length) return []
  if (sandbox === 'read-only') throw new Error('--add-dir needs a writable sandbox. Add --write.')
  if (!statSync(cwd).isDirectory()) throw new Error(`cwd is not a folder: ${cwd}`)
  let scratch = null
  try {
    if (statSync(tmpdir()).isDirectory()) scratch = realpathSync(tmpdir())
  } catch {
    // An unavailable temporary root does not prevent creation inside cwd.
  }
  const roots = [realpathSync(cwd), scratch].filter(Boolean)
  const unique = [...new Set(dirs)]
  const plans = unique.map(dir => ({ dir, ...inspect(dir, roots) }))
  for (const plan of plans) {
    const current = inspect(plan.dir, roots)
    if (current.target !== plan.target) throw new Error(`--add-dir: folder changed during validation: ${plan.dir}`)
    if (current.missing) mkdirSync(plan.dir, { recursive: true })
  }
  return unique
}
