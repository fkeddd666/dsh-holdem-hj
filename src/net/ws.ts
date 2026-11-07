import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebServer } from '@deepseek-ai/cordis'
import { DISCONNECT_AFTER_MS, HEARTBEAT_MS, MAX_FRAME_BYTES, SUBPROTOCOL } from '../invariant.ts'
import type { RoomManager } from '../room/RoomManager.ts'
import type { PlayerId, RoomId, ServerEvent } from '../types.ts'
import { assertOrigin } from './auth.ts'
import { encodeJson } from './json.ts'

interface SocketState {
  playerId: PlayerId
  roomId: RoomId
  lastSeen: number
}

/** 诊断日志默认关闭；开启后也只记录来源/结果，不记录 ticket 或查询串。 */
const DEBUG = process.env.HOLDEM_DEBUG === '1'

function traceWs(line: Record<string, unknown>): void {
  if (!DEBUG) return
  try {
    const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'holdem')
    const record = JSON.stringify({ at: new Date().toISOString(), ws: true, ...line }) + '\n'
    void mkdir(dir, { recursive: true })
      .then(() => appendFile(join(dir, 'debug.jsonl'), record, 'utf8'))
      .catch(() => undefined)
  } catch {
    // ignore
  }
}

export function registerHoldemSocket(server: WebServer, manager: RoomManager): () => void {
  const wss = new WebSocketServer({
    noServer: true,
    // 客户端现在不请求子协议（Worker 那边没法回 Sec-WebSocket-Protocol）；
    // 老客户端请求了就照给，没请求/不认识就回空串＝不设这个头，但别掐握手。
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : ''),
  })
  const sockets = new Map<WebSocket, SocketState>()

  const off = manager.onEvent((playerId, event) => {
    for (const [socket, state] of sockets) {
      if (state.playerId === playerId && socket.readyState === WebSocket.OPEN) send(socket, event)
    }
  })

  const heartbeat = setInterval(() => {
    const now = Date.now()
    const limit = DISCONNECT_AFTER_MS
    for (const [socket, state] of sockets) {
      if (now - state.lastSeen > limit) {
        socket.terminate()
        continue
      }
      if (socket.readyState === WebSocket.OPEN) socket.ping()
    }
  }, HEARTBEAT_MS)
  if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref()

  const disposeRoute = server.registerUpgrade({
    path: `${manager.getConfig().routePrefix}/ws`,
    handler: (req, socket, head) => {
      try {
        assertOrigin(req as IncomingMessage)
      } catch (error) {
        traceWs({ outcome: 'reject-origin', origin: req.headers.origin ?? null, host: req.headers.host ?? null, message: String(error) })
        reject(socket, '403 Forbidden')
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const ticket = url.searchParams.get('ticket') ?? ''
      const consumed = manager.consumeTicket(ticket)
      if (!consumed) {
        traceWs({ outcome: 'reject-ticket', origin: req.headers.origin ?? null, host: req.headers.host ?? null, hasTicket: ticket !== '' })
        reject(socket, '401 Unauthorized')
        return
      }
      traceWs({ outcome: 'open', origin: req.headers.origin ?? null, host: req.headers.host ?? null })
      wss.handleUpgrade(req as IncomingMessage, socket as Duplex, head, (ws) => {
        const state: SocketState = { playerId: consumed.playerId, roomId: consumed.roomId, lastSeen: Date.now() }
        sockets.set(ws, state)
        manager.counters.wsConnected += 1
        manager.markConnected(state.playerId, state.roomId, true)
        try {
          send(ws, { type: 'snapshot', seq: 0, view: manager.view(state.roomId, state.playerId) })
        } catch {
          ws.close()
          return
        }
        ws.on('pong', () => {
          state.lastSeen = Date.now()
          manager.markConnected(state.playerId, state.roomId, true)
        })
        ws.on('message', (data) => {
          state.lastSeen = Date.now()
          if (Buffer.byteLength(data.toString()) > MAX_FRAME_BYTES) {
            ws.close()
            return
          }
          let parsed: { type?: string } | null = null
          try {
            parsed = JSON.parse(data.toString()) as { type?: string }
          } catch {
            return
          }
          if (parsed?.type === 'ping') send(ws, { type: 'pong', ts: Date.now() })
        })
        ws.on('close', () => {
          sockets.delete(ws)
          manager.counters.wsConnected = Math.max(0, manager.counters.wsConnected - 1)
          const stillOpen = [...sockets.values()].some(
            (entry) => entry.playerId === state.playerId && entry.roomId === state.roomId,
          )
          if (!stillOpen) manager.markConnected(state.playerId, state.roomId, false)
        })
        ws.on('error', () => {
          ws.terminate()
        })
      })
    },
  })

  return () => {
    clearInterval(heartbeat)
    off()
    disposeRoute()
    for (const socket of sockets.keys()) socket.terminate()
    wss.close()
  }
}

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(encodeJson(event))
  } catch {
    ws.terminate()
  }
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
