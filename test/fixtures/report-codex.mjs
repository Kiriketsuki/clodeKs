#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handlePermissionProbe } from '../helpers/permission-probe.mjs'

if (await handlePermissionProbe()) process.exit(0)
const prompt = readFileSync(0, 'utf8')
const source = JSON.parse(prompt.match(/^(?:Scratch|Temporary) folder: (.+)$/m)[1])
const path = join(source, 'report.md')
const kind = process.env.FAKE_REPORT_KIND
const external = join(source, '../outside.txt')
if (kind === 'symlink' || kind === 'hardlink') {
  writeFileSync(external, 'synthetic private content')
  if (kind === 'symlink') symlinkSync(external, path)
  else linkSync(external, path)
} else if (kind === 'directory') mkdirSync(path)
else if (kind === 'fifo') execFileSync('mkfifo', [path])
else if (kind === 'oversized') writeFileSync(path, Buffer.alloc(1048577))
else if (kind === 'total') {
  writeFileSync(path, Buffer.alloc(700000, 65))
  writeFileSync(join(source, 'second.txt'), Buffer.alloc(700000, 66))
} else if (kind !== 'missing') writeFileSync(path, 'review result\n')
if (kind === 'root-symlink') {
  renameSync(source, `${source}-original`)
  symlinkSync(`${source}-original`, source)
}
for (const event of [
  { type: 'thread.started', thread_id: 'report-fixture' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ source, prompt }) } },
  process.env.FAKE_REPORT_FAIL ? { type: 'turn.failed', error: { message: 'fixture failure' } } : { type: 'turn.completed', usage: {} },
]) process.stdout.write(JSON.stringify(event) + '\n')
if (process.env.FAKE_REPORT_HANG) setInterval(() => {}, 1000)
