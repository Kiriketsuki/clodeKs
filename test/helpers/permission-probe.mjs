import { createInterface } from 'node:readline'

// Fixture binaries answer configuration probes before they emulate a worker turn.
export async function handlePermissionProbe(args = process.argv.slice(2)) {
  if (args[0] === '--version') {
    console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.169.0'}`)
    return true
  }
  if (args[0] !== 'app-server') return false
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    let result
    if (request.method === 'initialize') result = {}
    else if (request.method === 'configRequirements/read') {
      result = process.env.FAKE_REQUIREMENTS_RESPONSE ? JSON.parse(process.env.FAKE_REQUIREMENTS_RESPONSE) : { requirements: null }
    } else if (request.method === 'config/read') result = { config: { sandbox_workspace_write: null } }
    else continue
    console.log(JSON.stringify({ id: request.id, result }))
  }
  return true
}
