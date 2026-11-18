import { execFileSync } from 'node:child_process'

export function routingName(value, limit = 256) {
  return typeof value === 'string' && value.trim() && [...value].length <= limit &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value) ? value : null
}

// Read only the original brief. Wrapper reply headings do not name the worker.
export function briefHeading(text) {
  let fence = null
  let previous = ''
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/)
  let frontMatter = /^---[ \t]*$/.test(lines[0] ?? '')
  for (const [index, line] of lines.entries()) {
    if (frontMatter) {
      if (index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line)) frontMatter = false
      continue
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
        line.slice(marker[0].length).trim() === '') fence = null
      previous = ''
      continue
    }
    if (marker && (marker[1][0] !== '`' || !line.slice(marker[0].length).includes('`'))) {
      fence = marker[1]
      previous = ''
      continue
    }
    const atx = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)\s*$/)
    const heading = atx ? atx[1].replace(/(?:^|[ \t]+)#+[ \t]*$/, '')
      : previous.trim() && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) ? previous.trim() : null
    if (heading !== null) {
      if (!routingName(heading, Infinity)) return null
      return [...heading.trim()].slice(0, 120).join('') || null
    }
    previous = line
  }
  return null
}

export function readLaunchWindow(env = process.env, run = execFileSync) {
  if (!env.TMUX || !/^%\d+$/.test(env.TMUX_PANE ?? '')) return null
  try {
    const result = run('tmux', ['display-message', '-p', '-t', env.TMUX_PANE, '#{automatic-rename}\t#{window_name}'], {
      env, encoding: 'utf8', timeout: 1000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const fixedName = result.replace(/\r?\n$/, '').match(/^(?:0|off)\t([\s\S]*)$/)?.[1]
    return routingName(fixedName)
  } catch {
    return null
  }
}
