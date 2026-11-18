#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { handlePermissionProbe } from '../helpers/permission-probe.mjs'

if (await handlePermissionProbe()) process.exit(0)

const prompt = readFileSync(0, 'utf8')
const match = prompt.match(/^Scratch folder: (.+)$/m)
const scratch = match ? JSON.parse(match[1]) : null
const args = process.argv.slice(2)
const setting = args.find(arg => arg.startsWith('sandbox_workspace_write.writable_roots='))
const roots = setting ? JSON.parse(setting.slice(setting.indexOf('=') + 1)) : []
let wrote = false
let mode = null
if (scratch) {
  mode = statSync(scratch).mode & 0o777
  if (roots.includes(scratch)) {
    writeFileSync(join(scratch, 'commit-message.txt'), 'temporary commit message')
    wrote = true
  }
}
if (process.env.FAKE_SIGNAL_RELEASE) process.on('SIGTERM', () => {})
if (scratch && process.env.FAKE_BLOCKED_SCRATCH) {
  const blocked = join(scratch, 'blocked')
  mkdirSync(blocked)
  writeFileSync(join(blocked, 'note.txt'), 'private note')
  chmodSync(blocked, 0o500)
}
if (scratch && process.env.FAKE_EXTERNAL_DIR) symlinkSync(process.env.FAKE_EXTERNAL_DIR, join(scratch, 'outside'))
if (scratch && process.env.FAKE_BLOCK_PARENT) chmodSync(dirname(dirname(scratch)), 0o500)
if (process.env.FAKE_CLEANUP_RECORD) writeFileSync(process.env.FAKE_CLEANUP_RECORD, scratch)
for (const event of [
  { type: 'thread.started', thread_id: 'scratch-fixture-thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ scratch, roots, args, prompt, mode, wrote }) } },
  { type: 'turn.completed', usage: {} },
]) process.stdout.write(JSON.stringify(event) + '\n')

if (process.env.FAKE_SIGNAL_RELEASE) setInterval(() => {
  if (existsSync(process.env.FAKE_SIGNAL_RELEASE)) {
    writeFileSync(`${process.env.FAKE_SIGNAL_RELEASE}.stopped`, 'stopped')
    process.exit(0)
  }
}, 20)
