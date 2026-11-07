import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/cordis'
import { type ClientCommand } from '../types.ts'
import { asRoomId } from '../types.ts'
import type { RoomManager } from '../room/RoomManager.ts'
import {
  assertMutatingHeaders,
  assertOrigin,
  cookieHeader,
  header,
  isLocalRequest,
  isLoopbackOrigin,
  isPrivateOrigin,
  parseCookies,
} from './auth.ts'
import { createNonce, htmlSecurityHeaders, jsonSecurityHeaders } from './html.ts'
import { encodeJson, readJson } from './json.ts'
import { joinPageHtml } from './join-page.ts'
import { playPageHtml } from './play-page.ts'
import { statusOf } from './status.ts'

/** 诊断日志默认关闭：开启后也只记录路径，不记录含邀请 token 的查询串。 */
const DEBUG = process.env.HOLDEM_DEBUG === '1'

/** 每个房间一个座位 cookie：同一个浏览器可以同时待在不同房间的多个标签页里。 */
const SEAT_COOKIE_PREFIX = 'hdm_seat'
/** 客户端同时用请求头带 token：不依赖 cookie 是否被浏览器/宿主保留。 */
const SEAT_HEADER = 'x-holdem-seat'

function seatCookieName(roomId: string): string {
  return `${SEAT_COOKIE_PREFIX}_${roomId}`
}

function seatTokens(req: IncomingMessage, cookies: Record<string, string>): string[] {
  const fromHeader = (header(req, SEAT_HEADER) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  const fromCookies = Object.entries(cookies)
    .filter(([name]) => name.startsWith(SEAT_COOKIE_PREFIX))
    .map(([, value]) => value)
    .filter((value) => value !== '')
  return [...new Set([...fromHeader, ...fromCookies])]
}

function sessionOf(manager: RoomManager, tokens: string[], roomId?: string) {
  const sessions = manager.sessionsForTokens(tokens)
  if (roomId) return sessions.find((session) => session.roomId === roomId)
  return sessions[0]
}

/**
 * 诊断日志（HOLDEM_DEBUG=1 时才写）。
 *
 * 只记录 path，不记录 query：`/play?invite=<token>` 的 invite 是入座凭证，
 * 落盘会变成凭据泄露。写入改为异步，避免阻塞请求。
 */
function trace(req: IncomingMessage, res: ServerResponse): void {
  if (!DEBUG) return
  const started = Date.now()
  res.on('finish', () => {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        ms: Date.now() - started,
        method: req.method,
        path: (req.url ?? '/').split('?')[0],
        status: res.statusCode,
        origin: req.headers.origin ?? null,
        host: req.headers.host ?? null,
        fetchSite: req.headers['sec-fetch-site'] ?? null,
        cookieNames: Object.keys(parseCookies(req)),
      })
      const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'holdem')
      void mkdir(dir, { recursive: true })
        .then(() => appendFile(join(dir, 'debug.jsonl'), line + '\n', 'utf8'))
        .catch(() => undefined)
    } catch {
      // 诊断日志失败不影响主流程
    }
  })
}

export interface CloudflareLike {
  getStatus(): unknown
  startLogin(): unknown
  startDeploy(): unknown
  cancelLogin(): unknown
  logout(): unknown
}

/** role=auto 是默认：有空位就入座，满员自动转观战。 */
function playRole(value: string | null): 'auto' | 'sit' | 'watch' {
  return value === 'watch' ? 'watch' : value === 'sit' ? 'sit' : 'auto'
}

export function registerHoldemHttp(
  server: WebServer,
  manager: RoomManager,
  cloudflare?: CloudflareLike,
): () => void {
  const prefix = manager.getConfig().routePrefix
  return server.register({
    kind: 'prefix',
    path: prefix,
    handler: (req, res) => {
      trace(req, res)
      // 面板可以从本机或局域网另一个 origin 调过来（例如加入云端/别人机器的房间）
      const origin = header(req, 'origin')
      const allow = origin !== undefined && (isLoopbackOrigin(origin) || isPrivateOrigin(origin))
      if (allow) {
        res.setHeader('access-control-allow-origin', origin)
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
        res.setHeader('access-control-allow-headers', 'content-type,x-requested-with,x-holdem-seat')
        res.setHeader('access-control-max-age', '600')
        res.setHeader('vary', 'Origin')
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(allow ? 204 : 403)
        res.end()
        return
      }
      void handle(req, res, manager, prefix, cloudflare)
    },
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RoomManager,
  prefix: string,
  cloudflare?: CloudflareLike,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const cookies = parseCookies(req)

    if (req.method === 'GET' && path === `${prefix}/play`) {
      const nonce = createNonce()
      html(res, playPageHtml({
        prefix,
        nonce,
        code: String(url.searchParams.get('code') ?? ''),
        invite: String(url.searchParams.get('invite') ?? ''),
        role: playRole(url.searchParams.get('role')),
        name: String(url.searchParams.get('name') ?? ''),
      }), nonce)
      return
    }

    if (req.method === 'GET' && (path === prefix || path === `${prefix}/` || path === `${prefix}/join`)) {
      const role = playRole(url.searchParams.get('role'))
      const nonce = createNonce()
      html(res, joinPageHtml({
        prefix,
        nonce,
        code: String(url.searchParams.get('code') ?? ''),
        invite: String(url.searchParams.get('invite') ?? ''),
        role,
      }), nonce)
      return
    }

    if (req.method === 'GET' && path === `${prefix}/api/ready`) {
      json(res, 200, {
        ok: true,
        plugin: '@zhuweiyou/dsh-holdem',
        turnTimeoutMs: manager.getConfig().turnTimeoutMs,
      })
      return
    }

    if (req.method === 'GET' && path === `${prefix}/api/health`) {
      if (!isLocalRequest(req)) throw auth('仅本机可查看健康状态')
      json(res, 200, manager.health())
      return
    }

    if (path === `${prefix}/api/cloudflare`) {
      if (!cloudflare) {
        json(res, 200, { authorized: false, account: '', workerUrl: '', pending: false, deploying: false, authorizeUrl: '', error: 'not-supported', log: '' })
        return
      }
      if (req.method === 'POST') {
        assertOrigin(req)
        assertMutatingHeaders(req)
        if (!isLocalRequest(req)) throw auth('只能在本机操作 Cloudflare 授权')
        const action = url.searchParams.get('action') ?? ''
        if (action === 'login') json(res, 200, cloudflare.startLogin())
        else if (action === 'deploy') json(res, 200, cloudflare.startDeploy())
        else if (action === 'cancel') json(res, 200, cloudflare.cancelLogin())
        else if (action === 'logout') json(res, 200, cloudflare.logout())
        else json(res, 400, { error: 'illegal', message: '未知操作' })
        return
      }
      if (!isLocalRequest(req)) throw auth('只能在本机查看 Cloudflare 状态')
      json(res, 200, cloudflare.getStatus())
      return
    }

    if (req.method === 'GET' && path === `${prefix}/api/session`) {
      const wanted = url.searchParams.get('roomId') ?? ''
      const tokens = seatTokens(req, cookies)
      const session = (wanted ? sessionOf(manager, tokens, wanted) : undefined) ?? sessionOf(manager, tokens)
      const seatCookieCount = tokens.length
      if (!session) {
        json(res, 200, { inRoom: false, seatCookies: seatCookieCount })
        return
      }
      try {
        json(res, 200, { inRoom: true, roomId: session.roomId, view: manager.view(session.roomId, session.playerId) })
      } catch {
        json(res, 200, { inRoom: false, seatCookies: seatCookieCount })
      }
      return
    }

    if (req.method === 'POST' && path === `${prefix}/api/rooms`) {
      assertOrigin(req)
      assertMutatingHeaders(req)
      const local = isLocalRequest(req)
      if (!local) throw auth('只能在运行 Harness 的本机开房')
      const body = await readJson<{ title?: string; blindLevel?: string; displayName?: string; browserId?: string }>(req)
      const created = manager.createRoom({
        title: body.title,
        blindLevel: body.blindLevel,
        displayName: body.displayName,
        browserId: body.browserId,
      })
      json(res, 200, {
        roomId: created.roomId,
        roomCode: created.roomCode,
        hostPlayerId: created.hostPlayerId,
        joinUrl: created.joinUrl,
        wsTicket: created.wsTicket,
        sessionToken: created.sessionToken,
        view: created.view,
      }, [seatCookie(manager, created.sessionToken, created.roomId)])
      return
    }

    if (req.method === 'GET' && path === `${prefix}/api/preview`) {
      const preview = manager.peek({
        roomCode: String(url.searchParams.get('code') ?? ''),
        invite: String(url.searchParams.get('invite') ?? ''),
        role: url.searchParams.get('role') === 'watch' ? 'watch' : 'sit',
        local: isLocalRequest(req),
        browserId: url.searchParams.get('browser') ?? undefined,
        cookies: seatTokens(req, cookies),
      })
      json(res, 200, preview)
      return
    }

    if (req.method === 'POST' && path === `${prefix}/api/join`) {
      assertOrigin(req)
      assertMutatingHeaders(req)
      const body = await readJson<{
        roomCode?: string
        invite?: string
        displayName?: string
        role?: 'sit' | 'watch'
        browserId?: string
      }>(req)
      const joined = manager.join({
        roomCode: String(body.roomCode ?? ''),
        invite: String(body.invite ?? ''),
        role: body.role === 'watch' ? 'watch' : 'sit',
        displayName: String(body.displayName ?? ''),
        local: isLocalRequest(req),
        browserId: body.browserId,
        cookies: seatTokens(req, cookies),
      })
      json(res, 200, {
        playerId: joined.playerId,
        roomId: joined.roomId,
        seat: joined.seat,
        wsTicket: joined.wsTicket,
        sessionToken: joined.sessionToken,
        view: joined.view,
      }, [seatCookie(manager, joined.sessionToken, joined.roomId)])
      return
    }

    if (req.method === 'POST' && path === `${prefix}/api/leave`) {
      assertOrigin(req)
      assertMutatingHeaders(req)
      const body = await readJson<{ roomId?: string }>(req).catch(() => ({}) as { roomId?: string })
      const tokens = seatTokens(req, cookies)
      const session = sessionOf(manager, tokens, body.roomId) ?? sessionOf(manager, tokens)
      if (session) {
        manager.leave(session.playerId)
        json(res, 200, { ok: true }, [clearSeatCookie(manager, session.roomId)])
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === `${prefix}/api/ws-ticket`) {
      assertOrigin(req)
      assertMutatingHeaders(req)
      const body = await readJson<{ roomId?: string }>(req).catch(() => ({}) as { roomId?: string })
      const tokens = seatTokens(req, cookies)
      const session = sessionOf(manager, tokens, body.roomId) ?? sessionOf(manager, tokens)
      if (!session) throw auth('还没进房间')
      json(res, 200, { wsTicket: manager.issueTicket(session.playerId, session.roomId) })
      return
    }

    const roomMatch = /^\/api\/rooms\/([^/]+)(?:\/(state|action|history))?$/.exec(path.slice(prefix.length))
    if (roomMatch) {
      const action = roomMatch[2]
      const roomId = asRoomId(decodeURIComponent(roomMatch[1] ?? ''))
      const session = sessionOf(manager, seatTokens(req, cookies), roomId)
      if (!session) throw auth('不在这个房间里')
      if (req.method === 'GET' && (!action || action === 'state')) {
        const view = manager.view(roomId, session.playerId)
        json(res, 200, { seq: view.room.seq, view })
        return
      }
      if (req.method === 'GET' && action === 'history') {
        json(res, 200, { summary: manager.exportSummary(roomId, session.playerId) })
        return
      }
      if (req.method === 'POST' && action === 'action') {
        assertOrigin(req)
        assertMutatingHeaders(req)
        const body = await readJson<{
          actionId?: string
          baseSeq?: number
          command?: ClientCommand
        }>(req)
        if (!body.command || typeof body.command !== 'object') throw Object.assign(new Error('缺少 command'), { status: 400, code: 'illegal' })
        const result = manager.command(
          roomId,
          session.playerId,
          body.command,
          Number.isFinite(body.baseSeq) ? Number(body.baseSeq) : undefined,
          typeof body.actionId === 'string' ? body.actionId : undefined,
        )
        json(res, 200, { seq: result.seq, view: result.view, duplicate: result.duplicate === true })
        return
      }
      send(res, 404, encodeJson({ error: 'expired', message: 'not found' }), jsonHeaders())
      return
    }

    send(res, 404, encodeJson({ error: 'expired', message: 'not found' }), jsonHeaders())
  } catch (error) {
    writeError(res, error)
  }
}

function seatCookie(manager: RoomManager, token: string, roomId: string): string {
  return cookieHeader(seatCookieName(roomId), token, {
    secure: false,
    sameSite: 'Lax',
    maxAge: 86400,
    path: manager.getConfig().routePrefix,
  })
}

function clearSeatCookie(manager: RoomManager, roomId: string): string {
  return cookieHeader(seatCookieName(roomId), '', {
    secure: false,
    sameSite: 'Lax',
    maxAge: 0,
    path: manager.getConfig().routePrefix,
  })
}

function auth(message: string): Error {
  return Object.assign(new Error(message), { status: 403, code: 'auth' })
}

function json(res: ServerResponse, status: number, body: unknown, cookies?: string[]): void {
  const headers: Record<string, string | string[]> = jsonHeaders()
  if (cookies && cookies.length > 0) headers['set-cookie'] = cookies
  send(res, status, encodeJson(body), headers)
}

function html(res: ServerResponse, body: string, nonce: string): void {
  send(res, 200, body, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...htmlSecurityHeaders(nonce),
  })
}

function jsonHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...jsonSecurityHeaders(),
  }
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]>): void {
  if (res.headersSent) return
  res.writeHead(status, headers)
  res.end(body)
}

function writeError(res: ServerResponse, error: unknown): void {
  const coded = error as { code?: string; status?: number; view?: unknown }
  const code = coded.code ?? 'illegal'
  const status = coded.status ?? statusOf(code)
  const payload: Record<string, unknown> = {
    error: code,
    message: error instanceof Error ? error.message : 'error',
  }
  if (code === 'stale' && coded.view) payload.view = coded.view
  send(res, status, encodeJson(payload), jsonHeaders())
}
