#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { handlePermissionProbe } from '../helpers/permission-probe.mjs'

if (await handlePermissionProbe()) process.exit(0)

const args = process.argv.slice(2)
const prompt = readFileSync(0, 'utf8')
const tmpdir = process.env.TMPDIR
if (process.env.FAKE_TEMP_RECORD) writeFileSync(process.env.FAKE_TEMP_RECORD, tmpdir)
let mode = null
let wrote = false
try {
  mode = statSync(tmpdir).mode & 0o777
  writeFileSync(join(tmpdir, 'temp-proof'), 'private')
  wrote = true
} catch {}
const text = JSON.stringify({ args, prompt, tmpdir, temp: process.env.TEMP, tmp: process.env.TMP,
  tmpprefix: process.env.TMPPREFIX, mode, wrote,
  privateTempExists: existsSync(join(dirname(args[args.indexOf('-o') + 1]), 'tmp')) })
if (process.env.FAKE_TEMP_HANG) setInterval(() => {}, 1000)
else if (process.env.FAKE_TEMP_FAIL) process.exitCode = 1
else {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }))
}
