import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

import { bandDir, offBand, writeBand } from '../lib/band.mjs'
import { testEnv } from './helpers/env.mjs'

for (const code of ['EPERM', 'EBUSY', 'EACCES', 'EIO']) {
  test(`band: rename ${code} keeps the last good file and removes the temporary file`, t => {
    const env = testEnv()
    const target = writeBand(offBand(false, 1), env)
    const next = offBand(true, 2)
    const failure = Object.assign(new Error(`rename failed with ${code}`), { code })
    const rename = t.mock.method(fs, 'renameSync', () => { throw failure })
    syncBuiltinESMExports()

    try {
      if (code === 'EIO') {
        assert.throws(() => writeBand(next, env), error => error === failure)
      } else {
        assert.equal(writeBand(next, env), null)
      }
      assert.deepEqual(fs.readdirSync(bandDir(env)), ['clodeks-off.json'])
      assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).updatedAt, 1)
    } finally {
      rename.mock.restore()
      syncBuiltinESMExports()
    }

    assert.equal(writeBand(next, env), join(bandDir(env), 'clodeks-off.json'))
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).updatedAt, 2)
  })
}
