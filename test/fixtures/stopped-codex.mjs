#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { handlePermissionProbe } from '../helpers/permission-probe.mjs'

if (await handlePermissionProbe()) process.exit(0)
readFileSync(0, 'utf8')
const out = value => process.stdout.write(JSON.stringify(value) + '\n')
out({ type: 'thread.started', thread_id: 'stopped-thread' })
out({ type: 'item.completed', item: { type: 'agent_message', text: 'saved progress' } })
out({ type: 'item.updated', item: { type: 'agent_message', text: 'current progress' } })
out({ type: 'item.updated', item: { type: 'command_execution', aggregated_output: '\u001b[32mcommand tail\u001b[0m' } })
const output = process.argv[process.argv.indexOf('-o') + 1]
writeFileSync(output, '')
if (process.env.FAKE_READY) writeFileSync(process.env.FAKE_READY, 'ready')
setInterval(() => {}, 1000)
