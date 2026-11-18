import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { LIVE_TTL_MS, OFF_SOURCE, SOURCE, bandDir, liveBand, offBand, writeBand } from '../lib/band.mjs'
import { startInboxDaemon } from '../lib/inbox.mjs'
import { buildState } from '../lib/status.mjs'
import { testEnv } from './helpers/env.mjs'

const RESERVED = new Set('aeghlnoprswx'.split(''))
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const ID = /^[a-z0-9-]{1,32}$/
const TONES = new Set(['calm', 'info', 'accent', 'warn', 'alert'])

// The rules of chrysaki band protocol version 1, as its README states them.
function assertValidBand(file) {
  assert.equal(file.v, 1)
  assert.match(file.source, NAME)
  assert.equal(typeof file.updatedAt, 'number')
  assert.ok(file.ttlMs > 0 && file.ttlMs <= 600000)
  assert.ok(file.items.length <= 4)
  const ids = new Set()
  for (const item of file.items) {
    assert.match(item.id, ID)
    assert.ok(!ids.has(item.id))
    ids.add(item.id)
    assert.ok(item.text.length >= 1 && [...item.text].length <= 32 && !item.text.includes('\n'), item.text)
    assert.ok([...(item.icon ?? '')].length <= 2)
    assert.ok(TONES.has(item.tone))
    assert.match(item.command, /^[a-z0-9:_-]{1,64}$/)
    assert.ok(item.args.length <= 200)
    assert.ok((item.hint ?? '').length <= 200)
    assert.match(item.hotkey, /^[a-z]$/)
    assert.ok(!RESERVED.has(item.hotkey), `hotkey ${item.hotkey} is reserved`)
  }
}

const state = (up, live, active, error = null) =>
  buildState({ at: 1000, pid: 1, appUp: up, error, threads: Array.from({ length: live }, (_, i) => ({ id: `t${i}`, status: i < active ? 'active' : 'idle' })), exposedIds: new Set(['t0']), inboxes: 1 })

test('band: up is calm with the live count, info with a working count', () => {
  const idle = liveBand(state(true, 2, 0))
  assertValidBand(idle)
  assert.equal(idle.source, SOURCE)
  assert.equal(idle.ttlMs, LIVE_TTL_MS)
  assert.deepEqual([idle.items[0].tone, idle.items[0].icon, idle.items[0].text], ['calm', '◆', 'codex 0 working, 2 idle'])
  const busy = liveBand(state(true, 3, 2))
  assertValidBand(busy)
  assert.deepEqual([busy.items[0].tone, busy.items[0].text], ['info', 'codex 2 working, 1 idle'])
  assert.deepEqual([busy.items[0].command, busy.items[0].args], ['codex', 'panel'])
})

test('band: a down app-server is an alert, with the error kept short', () => {
  const down = liveBand(state(false, 0, 0, 'x'.repeat(500)))
  assertValidBand(down)
  assert.deepEqual([down.items[0].tone, down.items[0].text], ['alert', 'codex down'])
})

test('band: off is a warn item, and on clears the off source', () => {
  const off = offBand(true, 5)
  assertValidBand(off)
  assert.equal(off.source, OFF_SOURCE)
  assert.deepEqual([off.items[0].tone, off.items[0].text], ['warn', 'codex off'])
  const on = offBand(false, 5)
  assertValidBand(on)
  assert.equal(on.items.length, 0)
})

test('band: writeBand replaces the file whole and refuses a bad source name', () => {
  const env = testEnv()
  const path = writeBand(offBand(true, 7), env)
  assert.equal(path, join(bandDir(env), 'clodeks-off.json'))
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).items[0].text, 'codex off')
  assert.throws(() => writeBand({ ...offBand(true, 7), source: '../evil' }, env), /invalid band source/)
})

test('band: inboxd publishes the down item, and on a clean stop swaps it for the off item', async () => {
  const env = testEnv()
  const daemon = startInboxDaemon({ appSocket: join(env.XDG_RUNTIME_DIR, 'none.sock'), intervalMs: 100 }, env)
  const file = join(bandDir(env), 'clodeks.json')
  let band = null
  for (let i = 0; i < 40 && band === null; i++) {
    await new Promise(r => setTimeout(r, 50))
    try {
      band = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      band = null
    }
  }
  assert.ok(band, 'inboxd wrote no band file')
  assertValidBand(band)
  assert.equal(band.items[0].tone, 'alert')
  const off = JSON.parse(readFileSync(join(bandDir(env), 'clodeks-off.json'), 'utf8'))
  assert.equal(off.items.length, 0)
  daemon.close()
  const cleared = JSON.parse(readFileSync(file, 'utf8'))
  assertValidBand(cleared)
  assert.equal(cleared.items.length, 0)
  const offAfterStop = JSON.parse(readFileSync(join(bandDir(env), 'clodeks-off.json'), 'utf8'))
  assert.equal(offAfterStop.items[0].text, 'codex off')
})

test('band: clodeks status --band writes off without a heartbeat and clears it with one', async () => {
  const { execFileSync } = await import('node:child_process')
  const { privateRuntimeDir } = await import('../lib/paths.mjs')
  const { writeState } = await import('../lib/status.mjs')
  const bin = new URL('../bin/clodeks.mjs', import.meta.url).pathname
  const env = testEnv({ CLODEKS_CODEX_BIN: new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname })
  const offFile = join(bandDir(env), 'clodeks-off.json')
  execFileSync(process.execPath, [bin, 'status', '--band'], { env, stdio: 'ignore' })
  assert.equal(JSON.parse(readFileSync(offFile, 'utf8')).items[0].text, 'codex off')
  privateRuntimeDir(env)
  writeState(buildState({ at: Date.now(), pid: 1, appUp: true, error: null, threads: [], exposedIds: new Set(), inboxes: 0 }), env)
  execFileSync(process.execPath, [bin, 'status', '--band'], { env, stdio: 'ignore' })
  assert.equal(JSON.parse(readFileSync(offFile, 'utf8')).items.length, 0)
})

test('band: status --band-only publishes the off item without collecting status', async () => {
  const { execFileSync } = await import('node:child_process')
  const { statusCacheFile } = await import('../lib/status.mjs')
  const bin = new URL('../bin/clodeks.mjs', import.meta.url).pathname
  const env = testEnv()
  const out = execFileSync(process.execPath, [bin, 'status', '--band-only'], { env, encoding: 'utf8' })
  assert.equal(out, '')
  const off = JSON.parse(readFileSync(join(bandDir(env), 'clodeks-off.json'), 'utf8'))
  assert.equal(off.items[0].text, 'codex off')
  assert.equal(existsSync(statusCacheFile(env)), false)
})

test('band: the folder follows CHRYSAKI_BAND_DIR, then XDG_RUNTIME_DIR, TMPDIR, TEMP, TMP, then /tmp', () => {
  const base = { CHRYSAKI_BAND_DIR: '', XDG_RUNTIME_DIR: '', TMPDIR: '', TEMP: '', TMP: '' }
  assert.equal(bandDir({ ...base, CHRYSAKI_BAND_DIR: '/x/band', XDG_RUNTIME_DIR: '/run/user/1' }), '/x/band')
  assert.equal(bandDir({ ...base, XDG_RUNTIME_DIR: '/run/user/1', TMPDIR: '/t' }), '/run/user/1/chrysaki-band')
  assert.equal(bandDir({ ...base, TMPDIR: '/t', TEMP: '/e' }), '/t/chrysaki-band')
  assert.equal(bandDir({ ...base, TEMP: '/e', TMP: '/m' }), '/e/chrysaki-band')
  assert.equal(bandDir({ ...base, TMP: '/m' }), '/m/chrysaki-band')
  assert.equal(bandDir(base), '/tmp/chrysaki-band')
})

test('band: a failed rename leaves no temporary file, and an error other than EPERM, EBUSY or EACCES still throws', async () => {
  const { mkdirSync, readdirSync } = await import('node:fs')
  const dir = testEnv().XDG_RUNTIME_DIR
  // A directory at the target makes rename fail with EISDIR on Linux, which must still throw.
  mkdirSync(join(dir, 'clodeks-off.json'))
  assert.throws(() => writeBand(offBand(true, 1), { ...process.env, CHRYSAKI_BAND_DIR: dir }), /EISDIR|ENOTEMPTY|EEXIST/)
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), [])
})
