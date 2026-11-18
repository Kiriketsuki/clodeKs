import { createHash } from 'node:crypto'
import { createServer } from 'node:net'

import { decodeFrames } from '../../lib/ws.mjs'

function responseFrame(message) {
  const data = Buffer.from(JSON.stringify(message))
  const header = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.alloc(4)
  if (data.length >= 126) {
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  }
  return Buffer.concat([header, data])
}

export async function fakeAppServer(socketPath, handle, { onResponse } = {}) {
  const connections = new Set()
  const requests = []
  const responses = []
  const server = createServer(conn => {
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    conn.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let upgraded = false
    conn.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const key = buffer.toString('utf8', 0, end).match(/Sec-WebSocket-Key:\s*(.+)/i)[1].trim()
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        conn.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
        buffer = buffer.subarray(end + 4)
        upgraded = true
      }
      const { frames, rest } = decodeFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        if (frame.opcode === 0x8) { conn.end(); continue }
        if (frame.opcode !== 0x1) continue
        const request = JSON.parse(frame.payload.toString())
        if (request.id === undefined) continue
        const send = message => { if (!conn.destroyed) conn.write(responseFrame({ jsonrpc: '2.0', ...message })) }
        if (request.method === undefined) {
          responses.push(request)
          onResponse?.(request, send)
          continue
        }
        requests.push(request)
        Promise.resolve().then(() => handle(request, send)).then(result => {
          if (!conn.destroyed) conn.write(responseFrame({ jsonrpc: '2.0', id: request.id, result: result ?? {} }))
        }).catch(err => {
          if (!conn.destroyed) conn.write(responseFrame({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: err.message } }))
        })
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    requests, responses,
    connectionCount: () => connections.size,
    notify: (method, params) => {
      for (const conn of connections) conn.write(responseFrame({ jsonrpc: '2.0', method, params }))
    },
    close: () => {
      for (const conn of connections) conn.destroy()
      return new Promise(resolve => server.close(resolve))
    },
  }
}
