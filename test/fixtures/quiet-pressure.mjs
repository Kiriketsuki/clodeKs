import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const readFileSync = fs.readFileSync

// Fake launches use a fixed PSI reading and an unavailable swap-in counter.
fs.readFileSync = (path, ...options) => {
  if (path === '/proc/pressure/memory') return 'some avg10=0.00\nfull avg10=0.00\n'
  if (path === '/proc/vmstat') return ''
  return readFileSync(path, ...options)
}
syncBuiltinESMExports()
