#!/usr/bin/env node

import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

const endpoint = process.argv[4]
if (process.argv[2] !== 'app-server' || !endpoint?.startsWith('unix://')) process.exit(2)

const server = createServer(connection => connection.destroy())
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    writeFileSync(process.env.FIXTURE_STOPPED, signal)
    server.close(() => process.exit(0))
  })
}
server.listen(endpoint.slice('unix://'.length), () => {
  writeFileSync(process.env.FIXTURE_READY, 'ready')
})
setInterval(() => {
  if (existsSync(process.env.FIXTURE_RELEASE)) server.close(() => process.exit(0))
}, 30)
setTimeout(() => process.exit(0), 5000)
