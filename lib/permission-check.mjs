import { execFile, spawn } from 'node:child_process'
import { promisify, stripVTControlCharacters } from 'node:util'

const execute = promisify(execFile)
const TESTED_VERSION = '0.169.0'
const CHECK_TIMEOUT_MS = 5000
const CONFIG_BUDGET_MS = 8000
const STDERR_TAIL_CHARS = 4096
const STDERR_MESSAGE_CHARS = 200
const SPAWN_CODES = new Set(['EACCES', 'ENOENT', 'EAGAIN', 'ENOMEM', 'ENOTDIR', 'EMFILE', 'ENFILE', 'ENOEXEC', 'E2BIG', 'ETXTBSY'])

// Stderr can contain arbitrary credentials. Retain only fixed diagnostic phrases.
function safeStderrTail(raw) {
  const clean = stripVTControlCharacters(raw)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').toLowerCase()
  const diagnostics = clean.match(/\b(?:resource temporarily unavailable|permission denied|no such file or directory|too many open files|cannot allocate memory|out of memory|connection refused|connection reset|broken pipe|address already in use|operation not permitted|timed out|os error (?:[1-9]\d{0,2})(?!\d))\b/g)
  return raw ? [...new Set(diagnostics ?? [])].join(', ').slice(-STDERR_MESSAGE_CHARS) || '[redacted]' : 'unavailable'
}

function probeError(label, failure, stderr) {
  const error = new Error(`${label} cannot verify managed requirements: ${failure.reason}. Sanitized stderr tail: ${safeStderrTail(stderr)}`)
  error.retryable = failure.retryable === true
  return error
}

// Use a private server. The shared server can have a different cwd and configuration.
function readPermissionConfig(codex, cwd, settings, env, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(codex, ['app-server', ...settings.flatMap(value => ['-c', value]),
      '-c', 'features.hooks=false'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let response
    let config
    let failure
    let settled = false
    let inputFailed = false
    const finish = currentFailure => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (currentFailure) {
        child.kill('SIGKILL')
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        reject(probeError(label, currentFailure, stderr))
      } else resolve({ requirements: response.requirements, config })
    }
    const fail = (reason, retryable = false) => {
      failure ??= { reason, retryable }
      child.stdin.destroy()
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      fail('timeout', true)
      finish(failure)
    }, timeoutMs)
    const send = value => child.stdin.write(JSON.stringify(value) + '\n')
    child.stdin.on('error', () => { inputFailed = true })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-STDERR_TAIL_CHARS) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', data => {
      if (failure || settled) return
      buffer += data
      if (buffer.length > 1_000_000) { fail('protocol error: oversized response'); return }
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message
        try { message = JSON.parse(line) } catch { fail('protocol error: invalid JSON'); return }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { fail('protocol error: invalid response'); return }
        if (message.id === 1) {
          if (message.error) { fail('RPC error in initialize'); return }
          send({ jsonrpc: '2.0', method: 'initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'configRequirements/read', params: {} })
        } else if (message.id === 2) {
          if (message.error) { fail('RPC error in configRequirements/read'); return }
          response = message.result
          if (response?.requirements === null) {
            send({ jsonrpc: '2.0', id: 3, method: 'config/read', params: { cwd, includeLayers: false } })
          } else child.stdin.end()
        } else if (message.id === 3) {
          if (message.error) { fail('RPC error in config/read'); return }
          config = message.result?.config
          child.stdin.end()
        }
      }
    })
    child.once('error', error => {
      fail(`spawn error ${SPAWN_CODES.has(error.code) ? error.code : 'unknown'}`)
      finish(failure)
    })
    child.once('close', (code, signal) => {
      if (!failure && code !== 0) {
        failure = signal ? { reason: `signal ${signal}` } : { reason: `exit code ${code}`, retryable: true }
      }
      if (!failure && inputFailed) failure = { reason: 'protocol error on input' }
      if (!failure && (!response || !Object.hasOwn(response, 'requirements'))) {
        failure = { reason: 'protocol error: missing requirements response' }
      }
      finish(failure)
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      clientInfo: { name: 'clodeks-loopback-check', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    } })
  })
}

async function readPermissionConfigWithRetry(codex, cwd, settings, env, label) {
  const deadline = performance.now() + CONFIG_BUDGET_MS
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw probeError(label, { reason: 'timeout' }, '')
    try {
      return await readPermissionConfig(codex, cwd, settings, env, label, Math.min(CHECK_TIMEOUT_MS, remaining))
    } catch (error) {
      if (!error.retryable || attempt === 1 || performance.now() >= deadline) throw error
    }
  }
}

export async function verifyNamedPermissions(codex, cwd, settings, env, label) {
  let version
  try {
    const result = await execute(codex, ['--version'], { cwd, env, timeout: CHECK_TIMEOUT_MS,
      killSignal: 'SIGKILL', maxBuffer: 4096 })
    version = result.stdout.trim()
  } catch {
    throw new Error(`${label} requires tested Codex ${TESTED_VERSION}`)
  }
  if (version !== `codex-cli ${TESTED_VERSION}`) {
    throw new Error(`${label} requires tested Codex ${TESTED_VERSION}`)
  }
  const checked = await readPermissionConfigWithRetry(codex, cwd, settings, env, label)
  if (checked.requirements !== null) {
    throw new Error(`${label} cannot verify isolation with managed requirements`)
  }
  return checked
}
