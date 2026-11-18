import assert from 'node:assert/strict'
import { test } from 'node:test'

const identity = () => import('../lib/tui-identity.mjs')

test('brief identity: use the first real heading and ignore fenced examples', async () => {
  const { briefHeading } = await identity()
  assert.equal(briefHeading('Intro\n```md\n# Example\n```\n## Worker 123 ###\n# Later'), 'Worker 123')
  assert.equal(briefHeading('Title\n=====\nBody'), 'Title')
  assert.equal(briefHeading('No heading here'), null)
  assert.equal(briefHeading('#   '), null)
  assert.equal(briefHeading('# ###'), null)
  assert.equal(briefHeading('# Bad\u001bheading'), null)
  assert.equal(briefHeading('# ' + 'a'.repeat(140)), 'a'.repeat(120))
})

test('brief identity: read the actual window through its exact pane', async () => {
  const { readLaunchWindow } = await identity()
  let call
  const name = readLaunchWindow({ TMUX: '/tmp/mux,1,0', TMUX_PANE: '%42' }, (...args) => {
    call = args
    return '0\tcx-worker-123\n'
  })
  assert.equal(name, 'cx-worker-123')
  assert.equal(call[0], 'tmux')
  assert.deepEqual(call[1], ['display-message', '-p', '-t', '%42', '#{automatic-rename}\t#{window_name}'])
  assert.equal(call[2].timeout, 1000)
})

test('brief identity: missing or invalid tmux context stays unknown', async () => {
  const { readLaunchWindow } = await identity()
  for (const env of [{}, { TMUX: 'mux' }, { TMUX: 'mux', TMUX_PANE: 'wrong' }]) {
    assert.equal(readLaunchWindow(env, () => { throw new Error('must not run') }), null)
  }
  const env = { TMUX: 'mux', TMUX_PANE: '%1' }
  assert.equal(readLaunchWindow(env, () => { throw new Error('tmux unavailable') }), null)
  for (const name of ['\n', 'bad\nname\n', 'bad\u001bname\n', 'a'.repeat(257)]) {
    assert.equal(readLaunchWindow(env, () => '0\t' + name), null)
  }
})


test('brief identity: refuse invisible and bidi name characters at every entry point', async () => {
  const { routingName, briefHeading, readLaunchWindow } = await identity()
  const forbidden = [0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
  for (const code of forbidden) {
    const name = `worker${String.fromCodePoint(code)}123`
    assert.equal(routingName(name), null, `U+${code.toString(16)}`)
    assert.equal(briefHeading('# ' + name), null)
    assert.equal(readLaunchWindow({ TMUX: 'mux', TMUX_PANE: '%1' }, () => '0\t' + name + '\n'), null)
  }
})

test('brief identity: skip initial YAML front matter and a leading BOM', async () => {
  const { briefHeading } = await identity()
  for (const bom of ['', '\ufeff']) {
    assert.equal(briefHeading(bom + '---\ntitle: x\n---\n# Actual worker'), 'Actual worker')
    assert.equal(briefHeading(bom + '---\n# YAML comment\ntitle: x\n...\n## Actual worker'), 'Actual worker')
    assert.equal(briefHeading(bom + '# Actual worker'), 'Actual worker')
    assert.equal(briefHeading(bom + '---\ntitle: x\n---\nPlain body'), null)
    assert.equal(briefHeading(bom + '---\ntitle: x\n# Unclosed YAML'), null)
  }
})

test('brief identity: reject automatic tmux window names without another process call', async () => {
  const { readLaunchWindow } = await identity()
  const env = { TMUX: 'mux', TMUX_PANE: '%1' }
  for (const result of ['1\tnode\n', 'on\tzsh\n', '\tcx-worker\n', 'unknown\tcx-worker\n']) {
    let calls = 0
    assert.equal(readLaunchWindow(env, () => { calls++; return result }), null)
    assert.equal(calls, 1)
  }
  assert.equal(readLaunchWindow(env, () => 'off\tcx-worker\n'), 'cx-worker')
})

test('brief identity: backticks in a fence info string do not hide the next heading', async () => {
  const { briefHeading } = await identity()
  assert.equal(briefHeading('```a`b\n# Actual worker'), 'Actual worker')
  assert.equal(briefHeading('``` inline ```\n# Actual worker'), 'Actual worker')
  assert.equal(briefHeading('~~~a`b\n# Hidden worker\n~~~\n# Actual worker'), 'Actual worker')
  assert.equal(briefHeading('```text\n# Hidden worker\n```\n# Actual worker'), 'Actual worker')
})
