import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('test command: serial concurrency reaches Node before test file paths', () => {
  const env = testEnv()
  const capture = join(env.XDG_RUNTIME_DIR, 'node')
  writeFileSync(capture, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 })
  const command = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: ROOT, env: { ...env, PATH: `${env.XDG_RUNTIME_DIR}:${env.PATH}` }, encoding: 'utf8', timeout: 5000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const args = JSON.parse(result.stdout)
  const option = args.indexOf('--test-concurrency=1')
  const firstFile = args.findIndex(arg => arg.endsWith('.test.mjs'))
  assert.ok(firstFile >= 0, 'the configured test command must discover test files')
  assert.ok(option >= 0 && option < firstFile, 'serial concurrency must precede test files so Node applies it')
})
