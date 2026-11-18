import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildExecArgs, runExec } from '../lib/exec.mjs'
import { nativeExecFixture } from './helpers/native-exec.mjs'
import { testEnv } from './helpers/env.mjs'

// Run explicitly with the installed sandbox. This check contacts no model service.
test('native read-only temp: tempfile and heredocs work while every other write stays blocked', () => {
  const env = testEnv()
  const cwd = join(env.XDG_RUNTIME_DIR, 'repository')
  const tempDir = join(env.XDG_RUNTIME_DIR, 'private-temp')
  const sibling = join(env.XDG_RUNTIME_DIR, 'sibling')
  for (const path of [cwd, tempDir, sibling]) mkdirSync(path, { mode: 0o700 })
  const script = join(env.XDG_RUNTIME_DIR, 'probe.py')
  writeFileSync(script, `import json, os, socket, tempfile
paths = [os.environ['PROBE_REPO'], os.environ['PROBE_SIBLING'], '/tmp', '/var/tmp', os.path.dirname(os.environ['TMPDIR'])]
writes = {}
for path in paths:
    try:
        with open(os.path.join(path, 'clodeks-denied-write'), 'x') as stream: stream.write('unexpected')
        writes[path] = True
    except OSError: writes[path] = False
with tempfile.TemporaryFile() as stream:
    stream.write(b'private')
    stream.seek(0)
    proof = stream.read().decode()
try:
    with socket.socket() as listener: listener.bind(('127.0.0.1', 0))
    local_bind = True
except OSError: local_bind = False
print(json.dumps({'tempdir': tempfile.gettempdir(), 'proof': proof, 'writes': writes, 'local_bind': local_bind}))
`)
  for (const loopbackIsolated of [false, true]) {
    const args = buildExecArgs({ sandbox: 'read-only', cwd, tempDir, loopbackIsolated,
      permissionProfile: 'temp_native', loopbackProfile: 'temp_native' })
    const settings = args.flatMap((arg, index) => arg === '-c' ? ['-c', args[index + 1]] : [])
    const selection = settings.find(arg => arg.startsWith('default_permissions='))
    const selected = ['-P', selection ? JSON.parse(selection.slice(selection.indexOf('=') + 1)) : ':read-only']
    const result = spawnSync('codex', ['sandbox', ...selected, ...settings, '--include-managed-config', '-C', cwd,
      '--', 'zsh', '-f', '-c', 'python3 -B "$PROBE_SCRIPT" <<\'CLODEKS_TEMP_PROBE\'\nheredoc proof\nCLODEKS_TEMP_PROBE'], {
      cwd, env: { ...env, TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir, TMPPREFIX: join(tempDir, 'zsh'),
        PROBE_REPO: cwd, PROBE_SIBLING: sibling, PROBE_SCRIPT: script }, encoding: 'utf8', timeout: 15000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const seen = JSON.parse(result.stdout)
    assert.equal(seen.tempdir, tempDir)
    assert.equal(seen.proof, 'private')
    assert.equal(seen.local_bind, loopbackIsolated)
    assert.ok(Object.values(seen.writes).every(wrote => wrote === false), JSON.stringify(seen))
    for (const path of [cwd, sibling]) assert.equal(existsSync(join(path, 'clodeks-denied-write')), false)
  }
})

test('native read-only temp: exec resume replaces prior workspace writes and exports usable shell temp paths', { timeout: 45000 }, async t => {
  const env = testEnv()
  const cwd = join(env.XDG_RUNTIME_DIR, 'repository')
  mkdirSync(cwd)
  const command = `python3 -B -c 'import json, os, tempfile
with tempfile.TemporaryFile() as f:
 f.write(b"private")
try:
 open("denied.txt", "w").close()
 writable = True
except OSError:
 writable = False
print(json.dumps({"tmpdir": tempfile.gettempdir(), "tmpprefix": os.environ.get("TMPPREFIX"), "writable": writable}))' <<'TEMP_PROBE'
heredoc proof
TEMP_PROBE`
  const fixture = await nativeExecFixture(env, cwd, cwd, cwd, '', command)
  t.after(() => fixture.close())
  const seed = await runExec({ cwd, prompt: 'Seed the fixture session.', sandbox: 'workspace-write', timeoutMs: 15000 }, fixture.env)
  assert.equal(seed.ok, true, JSON.stringify(seed))
  const resumed = await runExec({ cwd, prompt: 'Run the local temp probe.', sandbox: 'read-only',
    resume: seed.thread_id, timeoutMs: 20000 }, fixture.env)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.commands_run, 1)
  const output = fixture.rawCommandOutput()
  assert.equal(typeof output, 'string')
  const line = output.split('\n').find(line => line.startsWith('{"tmpdir"'))
  assert.ok(line, output)
  const seen = JSON.parse(line)
  assert.equal(seen.writable, false)
  assert.equal(seen.tmpprefix, join(seen.tmpdir, 'zsh'))
  assert.equal(existsSync(seen.tmpdir), false)
  assert.equal(existsSync(join(cwd, 'denied.txt')), false)
  assert.equal(fixture.requestCount(), 3)
})
