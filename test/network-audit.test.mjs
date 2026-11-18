import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNetworkAudit } from '../lib/network-audit.mjs'

const event = (host = 'pypi.org') => `2026-11-17T08:30:37Z INFO codex_otel.network_proxy: event.name="codex.network_proxy.policy_decision" event.timestamp=2026-11-17T08:30:37.228Z network.policy.decision="allow" network.policy.reason="allow" server.address="${host}" server.port=443 private.secret="must not appear"\n`

test('network audit: split stderr retains only admission fields and never claims completeness', () => {
  const audit = createNetworkAudit()
  const line = event()
  audit.write(line.slice(0, 32))
  audit.write(line.slice(32))
  assert.deepEqual(audit.finish(), [{ host: 'pypi.org', port: 443, decision: 'allow', reason: 'allow', time: '2026-11-17T08:30:37.228Z' }])
})

test('network audit: missing or malformed events remain unavailable', () => {
  for (const text of ['ordinary stderr\n', event().replace('server.port=443', 'server.port=bad'),
    event().replace('event.timestamp=2026-11-17T08:30:37.228Z', 'event.timestamp=bad'),
    event('https://secret/path')]) {
    const audit = createNetworkAudit()
    audit.write(text)
    assert.equal(audit.finish(), null)
  }
})

test('network audit: oversized lines and record limits bound memory without losing later valid events', () => {
  const audit = createNetworkAudit()
  audit.write('x'.repeat(100000))
  audit.write('\n' + event())
  for (let index = 0; index < 1100; index++) audit.write(event())
  assert.equal(audit.finish().length, 1000)
})

test('network audit: an unterminated final line remains best effort evidence', () => {
  const audit = createNetworkAudit()
  audit.write(event().trimEnd())
  assert.equal(audit.finish()[0].host, 'pypi.org')
})

test('network audit: raw audit metadata never enters ordinary failure diagnostics', () => {
  let diagnostic = ''
  const audit = createNetworkAudit(line => { diagnostic += line })
  audit.write(event() + 'ordinary error\n')
  audit.finish()
  assert.equal(diagnostic, 'ordinary error\n')
})

test('network audit review: embedded or wrong-level tracing text is not an admission', () => {
  for (const line of ['worker said: ' + event(), event().replace(' INFO ', ' WARN '), event().replace(/^\S+/, 'not-a-time')]) {
    const audit = createNetworkAudit()
    audit.write(line)
    assert.equal(audit.finish(), null)
  }
})

test('network audit review: truncation reports only discarded lines or admission records', () => {
  const audit = createNetworkAudit()
  assert.equal(audit.truncated, false)
  for (let index = 0; index < 1000; index++) audit.write(event())
  assert.equal(audit.truncated, false)
  audit.write(event())
  assert.equal(audit.truncated, true)
  const oversized = createNetworkAudit()
  oversized.write('x'.repeat(8193))
  assert.equal(oversized.truncated, true)
})
