#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
if (process.argv[2] === 'exec' && process.env.FAKE_NETWORK_LOG_RECORD) {
  writeFileSync(process.env.FAKE_NETWORK_LOG_RECORD, process.env.RUST_LOG ?? '')
}
if (process.argv[2] === 'exec' && process.env.FAKE_NETWORK_AUDIT && process.env.RUST_LOG?.includes('codex_otel.network_proxy=info')) {
  process.stderr.write(process.env.FAKE_NETWORK_AUDIT)
}
if (process.argv[2] === 'exec' && process.env.FAKE_NETWORK_RUN_MODE) {
  readFileSync(0)
  if (process.env.FAKE_NETWORK_RUN_MODE === 'fail') process.exit(1)
  setInterval(() => {}, 1000)
} else await import('./loopback-codex.mjs')
