import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runExec } from '../lib/exec.mjs'
import { nativeExecFixture } from './helpers/native-exec.mjs'
import { testEnv } from './helpers/env.mjs'

const execute = promisify(execFile)
const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

// Fixed local Responses events exercise real temporary writes without a model service.
test('native run disk: the writable CLI uses private scratch and measures it before cleanup', { timeout: 45000 }, async t => {
  const env = testEnv()
  const cwd = env.XDG_RUNTIME_DIR
  const script = 'import json,os,tempfile; f=tempfile.NamedTemporaryFile(delete=False); f.write(bytes(8192)); f.close(); print(json.dumps(dict(tempdir=tempfile.gettempdir(),tmpprefix=os.environ.get("TMPPREFIX"),file=f.name)))'
  const fixture = await nativeExecFixture(env, cwd, cwd, cwd, '', `python3 -I -B -c ${quote(script)}`, 30000)
  t.after(() => fixture.close())
  const seed = await runExec({ prompt: 'Seed.', cwd, sandbox: 'workspace-write', timeoutMs: 20000 }, fixture.env)
  assert.equal(seed.ok, true, JSON.stringify(seed))
  const cli = await execute(process.execPath, [CLI, 'run', '--write', '--cwd', cwd, '--resume', seed.thread_id,
    '--timeout', '25', '--prompt', 'Run the private temporary-file check.'], { env: fixture.env, timeout: 30000, maxBuffer: 100000 })
  const result = JSON.parse(cli.stdout)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.commands_run, 1)
  const line = fixture.rawCommandOutput()?.split('\n').find(line => line.startsWith('{"tempdir"'))
  assert.ok(line, fixture.rawCommandOutput())
  const proof = JSON.parse(line)
  assert.match(proof.tempdir, /\/clodeks\/run-[^/]+\/scratch$/)
  assert.equal(dirname(proof.file), proof.tempdir)
  assert.equal(proof.tmpprefix, `${proof.tempdir}/zsh`)
  assert.equal(existsSync(dirname(proof.tempdir)), false)
  assert.ok(result.disk_usage.owned.logical_bytes >= 8192)
  assert.equal(result.disk_usage.owned.complete, true)
  assert.equal(result.disk_usage.workspace_growth.complete, true)
  t.diagnostic(JSON.stringify({ proof, disk_usage: result.disk_usage }))
})
