import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after } from 'node:test'

// A short private path keeps test sockets below the Unix socket path limit.
const root = mkdtempSync('/tmp/cktest-')
const pressureFixture = `--import=${new URL('../fixtures/quiet-pressure.mjs', import.meta.url)}`
after(() => rmSync(root, { recursive: true, force: true }))

export function testEnv(overrides = {}, parent = process.env) {
  const clean = Object.fromEntries(Object.entries(parent).filter(([key]) =>
    !key.startsWith('CLODEKS_') && !key.startsWith('CLAUDE_CODE_MESSAGING_') && key !== 'CHRYSAKI_BAND_DIR' && key !== 'NODE_TEST_CONTEXT',
  ))
  const nodeOptions = clean.NODE_OPTIONS ?? ''
  return {
    ...clean,
    NODE_OPTIONS: nodeOptions.includes(pressureFixture) ? nodeOptions : [nodeOptions, pressureFixture].filter(Boolean).join(' '),
    XDG_RUNTIME_DIR: mkdtempSync(join(root, 'env-')),
    XDG_STATE_HOME: join(root, 'state'),
    ...overrides,
  }
}
