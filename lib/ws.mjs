import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'

// A minimal WebSocket client over a Unix socket. `codex app-server --listen unix://PATH`
// speaks JSON-RPC in WebSocket text frames after an HTTP Upgrade, not raw JSONL.

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

// Encodes one masked client frame. RFC 6455 requires a client to mask every frame.
export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const mask = randomBytes(4)
  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  const masked = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

// Reads complete frames from the front of `buf`. Returns the frames and the unread rest. Pure.
export function decodeFrames(buf) {
  const frames = []
  let offset = 0
  while (buf.length - offset >= 2) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    let len = b1 & 0x7f
    let pos = offset + 2
    if (len === 126) {
      if (buf.length - pos < 2) break
      len = buf.readUInt16BE(pos)
      pos += 2
    } else if (len === 127) {
      if (buf.length - pos < 8) break
      len = Number(buf.readBigUInt64BE(pos))
      pos += 8
    }
    const isMasked = (b1 & 0x80) !== 0
    let mask
    if (isMasked) {
      if (buf.length - pos < 4) break
      mask = buf.subarray(pos, pos + 4)
      pos += 4
    }
    if (buf.length - pos < len) break
    let payload = Buffer.from(buf.subarray(pos, pos + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload })
    offset = pos + len
  }
  return { frames, rest: buf.subarray(offset) }
}

// Opens a WebSocket on a Unix socket. Destroy closes the transport without a handshake.
export function openWebSocket(socketPath, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect({ path: socketPath })
    const key = randomBytes(16).toString('base64')
    let handshake = Buffer.alloc(0)
    let buf = Buffer.alloc(0)
    let isOpen = false
    let isClosed = false
    let fragments = []
    const textHandlers = []
    const closeHandlers = []
    // Text that arrives before the caller attaches a handler waits here.
    const early = []
    const emitText = text => {
      if (textHandlers.length === 0) early.push(text)
      else for (const fn of textHandlers) fn(text)
    }
    const emitClose = err => {
      if (isClosed) return
      isClosed = true
      for (const fn of closeHandlers) fn(err)
    }

    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`WebSocket handshake timed out on ${socketPath}`))
    }, timeoutMs)

    sock.on('error', err => {
      clearTimeout(timer)
      if (!isOpen) reject(err)
      else emitClose(err)
    })
    sock.on('close', () => {
      clearTimeout(timer)
      if (isOpen) emitClose()
      else reject(new Error(`app-server closed the connection on ${socketPath} before the upgrade`))
    })

    sock.on('connect', () => {
      sock.write(
        'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })

    const pump = () => {
      const { frames, rest } = decodeFrames(buf)
      buf = Buffer.from(rest)
      for (const frame of frames) {
        if (frame.opcode === OP_PING) sock.write(encodeFrame(OP_PONG, frame.payload))
        else if (frame.opcode === OP_CLOSE) sock.end(encodeFrame(OP_CLOSE, Buffer.alloc(0)))
        else if (frame.opcode === OP_TEXT || frame.opcode === OP_CONT) {
          fragments.push(frame.payload)
          if (frame.fin) {
            const text = Buffer.concat(fragments).toString('utf8')
            fragments = []
            emitText(text)
          }
        }
      }
    }

    sock.on('data', chunk => {
      if (isOpen) {
        buf = Buffer.concat([buf, chunk])
        pump()
        return
      }
      handshake = Buffer.concat([handshake, chunk])
      const end = handshake.indexOf('\r\n\r\n')
      if (end === -1) return
      const status = handshake.subarray(0, handshake.indexOf('\r\n')).toString()
      if (!/^HTTP\/1\.1 101/.test(status)) {
        clearTimeout(timer)
        sock.destroy()
        reject(new Error(`WebSocket upgrade refused: ${status}`))
        return
      }
      clearTimeout(timer)
      isOpen = true
      buf = Buffer.from(handshake.subarray(end + 4))
      resolve({
        send: text => sock.write(encodeFrame(OP_TEXT, text)),
        close: () => {
          sock.write(encodeFrame(OP_CLOSE, Buffer.alloc(0)))
          sock.end()
        },
        destroy: () => sock.destroy(),
        onText: fn => {
          textHandlers.push(fn)
          for (const text of early.splice(0)) fn(text)
        },
        onClose: fn => closeHandlers.push(fn),
      })
      pump()
    })
  })
}
