#!/usr/bin/env node
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handlePermissionProbe } from '../helpers/permission-probe.mjs'
if (await handlePermissionProbe()) process.exit(0)
const args = process.argv.slice(2)
const prompt = readFileSync(0, 'utf8')
const scratch = prompt.match(/^Scratch folder: (.+)$/m)?.[1]
const temporary = process.env.TMPDIR
mkdirSync(join(temporary, '.git'), { recursive: true })
mkdirSync(join(temporary, 'nested'), { recursive: true })
writeFileSync(join(temporary, 'temp.bin'), Buffer.alloc(60))
writeFileSync(join(temporary, 'nested', 'cache.bin'), Buffer.alloc(40))
writeFileSync(join(temporary, '.git', 'metadata'), Buffer.alloc(5))
if (process.env.FAKE_DISK_OUTSIDE) symlinkSync(process.env.FAKE_DISK_OUTSIDE, join(temporary, 'outside-link'))
if (!process.env.FAKE_DISK_READ_ONLY) {
  mkdirSync('.tmp/stage', { recursive: true })
  mkdirSync('.git', { recursive: true })
  writeFileSync('.tmp/stage/package.tar', Buffer.alloc(200))
  writeFileSync('.git/ignored', Buffer.alloc(1000))
  writeFileSync('grown.bin', Buffer.alloc(50))
  writeFileSync('shrunk.bin', Buffer.alloc(3))
  if (process.env.FAKE_DISK_EXTRA) writeFileSync(join(process.env.FAKE_DISK_EXTRA, 'report.bin'), Buffer.alloc(50))
}
const text = JSON.stringify({ temporary, temp: process.env.TEMP, tmp: process.env.TMP, tmpprefix: process.env.TMPPREFIX,
  scratch: scratch ? JSON.parse(scratch) : null })
writeFileSync(args[args.indexOf('-o') + 1], text)
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }))
if (process.env.FAKE_DISK_HANG) setInterval(() => {}, 1000)
else if (process.env.FAKE_DISK_FAIL) process.exitCode = 1
else console.log(JSON.stringify({ type: 'turn.completed', usage: {} }))
