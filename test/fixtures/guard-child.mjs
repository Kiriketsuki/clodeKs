// Runs one --git finish with a FIFO planted at a git-dir path. The parent sets a time limit.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { finishGit, prepareGit } from '../../lib/git.mjs'

const [repo, special] = process.argv.slice(2)
const state = await prepareGit(repo, { fetch: false })
writeFileSync(join(repo, 'b.txt'), 'b\n')
execFileSync('git', ['-C', repo, 'add', 'b.txt'])
execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'work'])
const path = join(repo, '.git', special)
mkdirSync(dirname(path), { recursive: true })
try { unlinkSync(path) } catch { /* new path */ }
execFileSync('mkfifo', [path])
console.log(JSON.stringify(await finishGit(repo, state, { push: true, runOk: true })))
