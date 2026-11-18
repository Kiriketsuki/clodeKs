import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { readBackgroundProcesses, readDurableQueue } from '../lib/recycle-service.mjs'
import { testEnv } from './helpers/env.mjs'

test('the process guard allows owned tool hosts and reports other cgroup members', () => {
  const { XDG_RUNTIME_DIR: root } = testEnv()
  const procRoot = join(root, 'proc')
  const cgroupRoot = join(root, 'cgroup')
  const controlGroup = '/clodeks-appserver.service'
  const unit = join(cgroupRoot, controlGroup)
  const nested = join(unit, 'nested')
  const codexHome = join(root, 'codex-home')
  const codex = join(root, 'codex-linux-x64', 'vendor', 'linux-arch', 'bin')
  const cua = '/usr/lib/chatgpt/resources/cua_node/bin'
  mkdirSync(nested, { recursive: true })
  mkdirSync(codexHome)
  writeFileSync(join(unit, 'cgroup.procs'), '10\n11\n12\n20\n22\n23\n24\n25\n26\n')
  writeFileSync(join(nested, 'cgroup.procs'), '21\n')
  for (const [pid, parent, command, exe] of [
    [10, 1, 'launcher', '/usr/bin/node'],
    [11, 10, 'launcher', '/usr/bin/node'],
    [12, 11, 'codex', join(codex, 'codex')],
    [20, 12, 'bash', '/usr/bin/bash'],
    [21, 20, 'watcher', '/usr/bin/python'],
    [22, 12, 'code-mode-host', join(codex, 'codex-code-mode-host')],
    [23, 12, 'node_repl', join(cua, 'node_repl')],
    [24, 23, 'node', join(cua, 'node')],
    [25, 24, 'plugin-host', join(codexHome, 'plugins/cache/test/tool')],
    [26, 20, 'unowned-tool', join(cua, 'node_repl')],
  ]) {
    const folder = join(procRoot, String(pid))
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'cgroup'), `0::${controlGroup}\n`)
    writeFileSync(join(folder, 'stat'), `${pid} (${command}) S ${parent}\n`)
    writeFileSync(join(folder, 'comm'), command + '\n')
    symlinkSync(exe, join(folder, 'exe'))
  }
  const result = readBackgroundProcesses({ mainPid: 10, peerPid: 12, controlGroup, codexHome }, { procRoot, cgroupRoot })
  assert.deepEqual(result, {
    background: [{ pid: 20, command: 'bash' }, { pid: 21, command: 'watcher' }, { pid: 26, command: 'unowned-tool' }],
    allowed: { server_chain: 3, codex_install: 1, cua_node: 2, plugin_cache: 1 },
  })
})

test('durable queue inspection reads only the live database and preserves an older pending item', async () => {
  const env = testEnv()
  const db = join(env.XDG_RUNTIME_DIR, 'queue_1.sqlite')
  const sql = query => {
    const result = spawnSync('python3', ['-I', '-B', '-c',
      'import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.executescript(sys.argv[2])', db, query],
    { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  sql(`CREATE TABLE queued_items (
    id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    queue_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
  )`)
  const fd = openSync(db, 'r')
  try {
    const read = () => readDurableQueue({ peerPid: process.pid }, { env })
    assert.deepEqual(await read(), { pending_count: 0, entries: [] })
    sql(`INSERT INTO queued_items VALUES ('id', 'thread', 'private payload', 0, 1, 10);
         WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 101)
         INSERT INTO queued_items SELECT 'later-' || n, 'thread', 'private payload', n, n + 1, 200 FROM numbers;`)
    const snapshot = await read()
    assert.equal(snapshot.pending_count, 102)
    assert.equal(snapshot.entries.length, 100)
    assert.deepEqual(snapshot.entries[0], { submission_id: 'id', thread_id: 'thread', created_at_ms: 1 })
    assert.equal(snapshot.entries.at(-1).submission_id, 'later-99')
    assert.doesNotMatch(JSON.stringify(snapshot), /private payload/)
    sql('DELETE FROM queued_items; ALTER TABLE queued_items ADD COLUMN unknown_field TEXT')
    await assert.rejects(read(), /cannot verify the app-server durable queue/)
  } finally {
    closeSync(fd)
  }
})
