import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { testEnv } from './helpers/env.mjs'

const CLI = fileURLToPath(new URL('../bin/clodeks.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const agent = readFileSync(new URL('../plugin/agents/codex-exec.md', import.meta.url), 'utf8')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const task = "Review this exact brief.\n$(touch SHOULD_NOT_EXIST) `touch ALSO_NOT_CREATED` $HOME 'quote'\nCLODEKS_TASK_END\nCLODEKS_SCHEMA_END\n\n  trailing spaces  \n\n"

function commandFor(schema, cwd, path) {
  const forms = [...agent.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1])
    .filter(command => command.includes("< 'TASK_FILE'"))
  const command = forms.find(command => command.includes('--schema') === schema)
  assert.ok(command, `agent needs a brief-file form ${schema ? 'with' : 'without'} schema`)
  return command.replace('clodeks run', `${quote(process.execPath)} ${quote(CLI)} run`)
    .replace('TIMEOUT', '20').replace("'CWD'", quote(cwd)).replace("'TASK_FILE'", quote(path))
    .replace('\nSCHEMA\n', '\n{"type":"object","properties":{"answer":{"type":"string"}}}\n')
}

function setup() {
  const env = testEnv({ CLODEKS_CODEX_BIN: FAKE, FAKE_MODE: 'capture-prompt-json' })
  const cwd = join(env.XDG_RUNTIME_DIR, 'worker folder')
  mkdirSync(cwd)
  return { env: { ...env, FAKE_PROMPT_RECORD: join(cwd, 'received.txt') }, cwd }
}

test('brief agent: an explicit task file uses stdin without a model-side read instruction', () => {
  assert.match(agent, /TASK_FILE:.*caller explicitly asks.*brief file/s)
  assert.match(agent, /Do not replace its contents with an instruction to read the file/)
  assert.match(agent, /Do not read TASK_FILE with Read/)
  assert.match(agent, /Keep one Bash call/)
})

for (const schema of [false, true]) {
  test(`brief forwarding: documented ${schema ? 'schema' : 'plain'} form preserves task bytes and shell quoting`, () => {
    const { env, cwd } = setup()
    const path = join(env.XDG_RUNTIME_DIR, "brief ' $(touch BAD_PATH).md")
    writeFileSync(path, task)
    const command = commandFor(schema, cwd, path)
    const result = spawnSync('/bin/bash', ['-c', command], {
      cwd: env.XDG_RUNTIME_DIR, env, encoding: 'utf8', timeout: 30000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const received = readFileSync(env.FAKE_PROMPT_RECORD, 'utf8')
    const boundary = '\n\nCaller task\n\n'
    assert.ok(received.startsWith('clodeKs read-only context'))
    assert.equal(received.slice(received.indexOf(boundary) + boundary.length), task)
    assert.equal(JSON.parse(result.stdout).ok, true)
    if (schema) assert.deepEqual(JSON.parse(result.stdout).result, { answer: 'captured' })
    for (const name of ['SHOULD_NOT_EXIST', 'ALSO_NOT_CREATED', 'BAD_PATH']) {
      assert.equal(existsSync(join(cwd, name)), false)
      assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, name)), false)
    }
  })
}

for (const missing of [false, true]) {
  test(`brief forwarding: ${missing ? 'missing' : 'empty'} files fail before a worker starts`, () => {
    const { env, cwd } = setup()
    const path = join(env.XDG_RUNTIME_DIR, 'brief.md')
    if (!missing) writeFileSync(path, ' \n\t')
    const result = spawnSync('/bin/bash', ['-c', commandFor(false, cwd, path)], {
      cwd: env.XDG_RUNTIME_DIR, env, encoding: 'utf8', timeout: 30000,
    })
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, missing ? /No such file or directory/ : /empty prompt/)
    assert.equal(existsSync(env.FAKE_PROMPT_RECORD), false)
  })
}
