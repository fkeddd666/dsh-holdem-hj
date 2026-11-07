/**
 * Cloudflare Worker + Durable Object 版牌桌服务。
 *
 * 目的：把「房主进程即服务端」换成「Cloudflare 上的一个房间服务器」，
 * 别人用浏览器打开 Worker 的地址就能玩，不依赖你本机开着 dsh。
 *
 * - 规则引擎与房间状态机直接复用 src/engine + src/room/RoomManager（纯逻辑，无 node 依赖）
 * - 所有房间放在一个 Durable Object 里（6 人桌的小场景足够），WS 连接也由它持有
 * - HTTP 接口与本地插件保持一致，网页牌桌（/play）可以直接复用
 */
import { resolveConfig } from '../src/config.ts'
import { MAX_BODY_BYTES, PACKAGE_NAME } from '../src/invariant.ts'
import { noopStore } from '../src/persist/noop.ts'
import { RoomManager, type Session } from '../src/room/RoomManager.ts'
import { createNonce, htmlSecurityHeaders, jsonSecurityHeaders } from '../src/net/html.ts'
import { joinPageHtml } from '../src/net/join-page.ts'
import { playPageHtml } from '../src/net/play-page.ts'
import { statusOf } from '../src/net/status.ts'
import type { ClientCommand, PlayerView, RoomId } from '../src/types.ts'

const PREFIX = '/holdem'
const SEAT_HEADER = 'x-holdem-seat'

export interface Env {
  ROOMS: DurableObjectNamespace
  /** 房间上限等可选覆盖 */
  MAX_ROOMS?: string
  /** 观战席位上限的可选覆盖 */
  MAX_SPECTATORS?: string
  /** 额外允许的跨源 origin，逗号分隔（默认只允许回环与私有网段）。 */
  ALLOWED_ORIGINS?: string
}

const CORS_HEADERS = {
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-requested-with,x-holdem-seat',
  'access-control-max-age': '600',
}

function isPrivateHostname(hostname: string): boolean {
  return hostname.startsWith('10.')
    || hostname.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
}

function isAllowedOrigin(origin: string, self: string, extra: string[]): boolean {
  if (origin === self || extra.includes(origin)) return true
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]') {
      return true
    }
    return isPrivateHostname(url.hostname)
  } catch {
    return false
  }
}

function configuredOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
}

/** 只对白名单 origin 回写 ACAO；不再无条件反射任意 Origin。 */
function allowedOrigin(request: Request, extra: string[]): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  return isAllowedOrigin(origin, new URL(request.url).origin, extra) ? origin : null
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers)
  if (origin) headers.set('access-control-allow-origin', origin)
  headers.set('vary', 'Origin')
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value)
  return new Response(response.body, { status: response.status, headers })
}

/** 变更请求必须带自定义头 + JSON：跨源页面无法在不触发预检的情况下伪造。 */
function assertMutating(request: Request): void {
  if (request.method !== 'POST') return
  if (request.headers.get('x-requested-with') !== PACKAGE_NAME) {
    throw Object.assign(new Error('missing csrf header'), { code: 'auth', status: 403 })
  }
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    throw Object.assign(new Error('invalid content type'), { code: 'auth', status: 403 })
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('payload too large'), { code: 'illegal', status: 413 })
  }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    throw Object.assign(new Error('payload too large'), { code: 'illegal', status: 413 })
  }
  if (text === '') return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('invalid json'), { code: 'illegal', status: 400 })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(PREFIX)) {
      return new Response('@zhuweiyou/dsh-holdem worker: try /holdem/play?code=…', { status: 404 })
    }
    const extra = configuredOrigins(env)
    const corsOrigin = allowedOrigin(request, extra)
    // WebSocket 升级不走 CORS，但同样校验 Origin（ticket 之外再加一层）。
    if (request.headers.get('upgrade') === 'websocket') {
      if (request.headers.get('origin') && !corsOrigin) return new Response('forbidden', { status: 403 })
      return env.ROOMS.get(env.ROOMS.idFromName('rooms')).fetch(request)
    }
    if (request.method === 'OPTIONS') {
      if (!corsOrigin) return new Response(null, { status: 403 })
      return withCors(new Response(null, { status: 204 }), corsOrigin)
    }
    const id = env.ROOMS.idFromName('rooms')
    const response = await env.ROOMS.get(id).fetch(request)
    return withCors(response, corsOrigin)
  },
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...jsonSecurityHeaders(),
      ...headers,
    },
  })
}

function html(body: string, nonce: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...htmlSecurityHeaders(nonce),
    },
  })
}

function tokensOf(request: Request): string[] {
  const header = request.headers.get(SEAT_HEADER) ?? ''
  const fromHeader = header.split(',').map((value) => value.trim()).filter(Boolean)
  const cookie = request.headers.get('cookie') ?? ''
  const fromCookies = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('hdm_seat'))
    .map((part) => part.slice(part.indexOf('=') + 1))
    .filter(Boolean)
  return [...new Set([...fromHeader, ...fromCookies])]
}

function sessionOf(manager: RoomManager, request: Request, roomId?: string): Session | undefined {
  const sessions = manager.sessionsForTokens(tokensOf(request))
  return roomId ? sessions.find((session) => session.roomId === roomId) : sessions[0]
}

export class RoomsDurableObject {
  private readonly manager: RoomManager
  private readonly sockets = new Map<string, WebSocket>()
  /** 每 IP 的请求时间戳，用于建房/加入/动作限流。 */
  private readonly rate = new Map<string, number[]>()
  private origin = 'https://holdem-worker.local'

  constructor(_state: DurableObjectState, env: Env) {
    const overrides: Record<string, unknown> = {}
    if (env.MAX_ROOMS) overrides.maxRooms = Number(env.MAX_ROOMS)
    if (env.MAX_SPECTATORS) overrides.maxSpectators = Number(env.MAX_SPECTATORS)
    const config = resolveConfig(overrides as never)
    this.manager = new RoomManager({
      config,
      origin: () => this.origin,
      store: noopStore,
      now: Date.now,
      lanIp: () => '',
      log: (message) => console.log('[holdem]', message),
    })
    this.manager.onEvent((playerId, event) => {
      const socket = this.sockets.get(playerId)
      if (!socket) return
      try {
        socket.send(JSON.stringify(event))
      } catch {
        this.sockets.delete(playerId)
      }
    })
    this.timer = setInterval(() => {
      try {
        this.manager.tick()
        this.pruneRate()
      } catch (error) {
        console.error('[holdem] tick failed', error)
      }
    }, 500)
  }

  private timer: ReturnType<typeof setInterval>

  private clientKey(request: Request): string {
    return request.headers.get('cf-connecting-ip')
      ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? 'unknown'
  }

  private allowRate(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now()
    const hits = (this.rate.get(key) ?? []).filter((at) => now - at < windowMs)
    if (hits.length >= limit) {
      this.rate.set(key, hits)
      return false
    }
    hits.push(now)
    this.rate.set(key, hits)
    return true
  }

  private pruneRate(): void {
    const now = Date.now()
    for (const [key, hits] of this.rate) {
      const kept = hits.filter((at) => now - at < 10 * 60_000)
      if (kept.length === 0) this.rate.delete(key)
      else this.rate.set(key, kept)
    }
  }

  async fetch(request: Request): Promise<Response> {
    void this.timer
    const url = new URL(request.url)
    // 房间的对外地址就是 Worker 自己：邀请链接按它算
    if (this.origin !== url.origin) this.origin = url.origin
    try {
      assertMutating(request)
      return await this.route(request, url)
    } catch (error) {
      const coded = error as { code?: string; status?: number; message?: string; view?: PlayerView }
      const code = coded.code ?? 'illegal'
      const payload: Record<string, unknown> = { error: code, message: coded.message ?? 'error' }
      if (code === 'stale' && coded.view) payload.view = coded.view
      return json(payload, coded.status ?? statusOf(code))
    }
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(PREFIX, '') || '/'

    if (request.method === 'GET' && (path === '/' || path === '/join')) {
      const nonce = createNonce()
      return html(joinPageHtml({
        prefix: PREFIX,
        nonce,
        code: String(url.searchParams.get('code') ?? ''),
        invite: String(url.searchParams.get('invite') ?? ''),
        role: url.searchParams.get('role') === 'watch' ? 'watch' : 'auto',
      }), nonce)
    }
    if (request.method === 'GET' && path === '/play') {
      const nonce = createNonce()
      return html(playPageHtml({
        prefix: PREFIX,
        nonce,
        code: String(url.searchParams.get('code') ?? ''),
        invite: String(url.searchParams.get('invite') ?? ''),
        role: url.searchParams.get('role') === 'watch' ? 'watch' : url.searchParams.get('role') === 'sit' ? 'sit' : 'auto',
        name: String(url.searchParams.get('name') ?? ''),
      }), nonce)
    }
    if (request.method === 'GET' && path === '/api/ready') {
      return json({ ok: true, plugin: '@zhuweiyou/dsh-holdem', turnTimeoutMs: this.manager.getConfig().turnTimeoutMs, worker: true })
    }
    if (request.method === 'GET' && path === '/api/session') {
      const session = sessionOf(this.manager, request, url.searchParams.get('roomId') ?? undefined)
      if (!session) return json({ inRoom: false })
      return json({ inRoom: true, roomId: session.roomId, view: this.manager.view(session.roomId, session.playerId) })
    }
    if (request.method === 'GET' && path === '/api/preview') {
      return json(this.manager.peek({
        roomCode: String(url.searchParams.get('code') ?? ''),
        invite: String(url.searchParams.get('invite') ?? ''),
        role: url.searchParams.get('role') === 'watch' ? 'watch' : 'sit',
        local: false,
        cookies: tokensOf(request),
      }))
    }
    if (request.method === 'POST' && path === '/api/rooms') {
      if (!this.allowRate(`rooms:${this.clientKey(request)}`, 3, 10 * 60_000)) {
        throw Object.assign(new Error('建房太频繁'), { code: 'rate-limited', status: 429 })
      }
      const body = (await readJsonBody(request)) as { title?: string; blindLevel?: string; displayName?: string; browserId?: string }
      const created = this.manager.createRoom(body)
      return json({
        roomId: created.roomId,
        roomCode: created.roomCode,
        hostPlayerId: created.hostPlayerId,
        joinUrl: created.joinUrl,
        wsTicket: created.wsTicket,
        sessionToken: created.sessionToken,
        view: created.view,
      })
    }
    if (request.method === 'POST' && path === '/api/join') {
      if (!this.allowRate(`join:${this.clientKey(request)}`, 20, 60_000)) {
        throw Object.assign(new Error('加入太频繁'), { code: 'rate-limited', status: 429 })
      }
      const body = (await readJsonBody(request)) as { roomCode?: string; invite?: string; displayName?: string; role?: 'sit' | 'watch'; browserId?: string }
      const joined = this.manager.join({
        roomCode: String(body.roomCode ?? ''),
        invite: String(body.invite ?? ''),
        role: body.role === 'watch' ? 'watch' : 'sit',
        displayName: String(body.displayName ?? ''),
        local: false,
        browserId: body.browserId,
        cookies: tokensOf(request),
      })
      return json({
        playerId: joined.playerId,
        roomId: joined.roomId,
        seat: joined.seat,
        wsTicket: joined.wsTicket,
        sessionToken: joined.sessionToken,
        view: joined.view,
      })
    }
    if (request.method === 'POST' && path === '/api/leave') {
      const body = (await readJsonBody(request)) as { roomId?: string }
      const session = sessionOf(this.manager, request, body.roomId) ?? sessionOf(this.manager, request)
      if (session) this.manager.leave(session.playerId)
      return json({ ok: true })
    }
    if (request.method === 'POST' && path === '/api/ws-ticket') {
      if (!this.allowRate(`ticket:${this.clientKey(request)}`, 30, 60_000)) {
        throw Object.assign(new Error('操作太频繁'), { code: 'rate-limited', status: 429 })
      }
      const body = (await readJsonBody(request)) as { roomId?: string }
      const session = sessionOf(this.manager, request, body.roomId) ?? sessionOf(this.manager, request)
      if (!session) throw Object.assign(new Error('还没进房间'), { code: 'auth', status: 403 })
      return json({ wsTicket: this.manager.issueTicket(session.playerId, session.roomId) })
    }

    const roomMatch = /^\/api\/rooms\/([^/]+)(?:\/(state|action|history))?$/.exec(path)
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1] ?? '') as RoomId
      const action = roomMatch[2]
      const session = sessionOf(this.manager, request, roomId)
      if (!session) throw Object.assign(new Error('不在这个房间里'), { code: 'auth', status: 403 })
      if (request.method === 'GET' && (!action || action === 'state')) {
        const view = this.manager.view(roomId, session.playerId)
        return json({ seq: view.room.seq, view })
      }
      if (request.method === 'GET' && action === 'history') {
        return json({ summary: this.manager.exportSummary(roomId, session.playerId) })
      }
      if (request.method === 'POST' && action === 'action') {
        if (!this.allowRate(`action:${this.clientKey(request)}`, 120, 60_000)) {
          throw Object.assign(new Error('操作太频繁'), { code: 'rate-limited', status: 429 })
        }
        const body = (await readJsonBody(request)) as { actionId?: string; baseSeq?: number; command?: ClientCommand }
        if (!body.command) throw Object.assign(new Error('缺少 command'), { code: 'illegal', status: 400 })
        const result = this.manager.command(
          roomId,
          session.playerId,
          body.command,
          Number.isFinite(body.baseSeq) ? Number(body.baseSeq) : undefined,
          typeof body.actionId === 'string' ? body.actionId : undefined,
        )
        return json({ seq: result.seq, view: result.view, duplicate: result.duplicate === true })
      }
    }

    if (path === '/ws' && request.headers.get('upgrade') === 'websocket') {
      return this.acceptSocket(url)
    }

    return json({ error: 'expired', message: 'not found' }, 404)
  }

  private acceptSocket(url: URL): Response {
    const ticket = url.searchParams.get('ticket') ?? ''
    const consumed = this.manager.consumeTicket(ticket)
    if (!consumed) return new Response('unauthorized', { status: 401 })
    const pair = new WebSocketPair()
    const server = pair[1]
    server.accept()
    this.sockets.set(consumed.playerId, server)
    this.manager.markConnected(consumed.playerId, consumed.roomId, true)
    try {
      server.send(JSON.stringify({ type: 'snapshot', seq: 0, view: this.manager.view(consumed.roomId, consumed.playerId) }))
    } catch {
      server.close()
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    server.addEventListener('close', () => {
      if (this.sockets.get(consumed.playerId) === server) this.sockets.delete(consumed.playerId)
      this.manager.markConnected(consumed.playerId, consumed.roomId, false)
    })
    server.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as { type?: string }
        if (parsed?.type === 'ping') server.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      } catch {
        // 忽略
      }
    })
    return new Response(null, { status: 101, webSocket: pair[0] })
  }
}
