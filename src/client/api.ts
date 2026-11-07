import type { ClientCommand, PlayerView, RoomPreview, SessionSummary } from '../types.ts'

export const PREFIX = '/holdem'
const HEADERS = {
  'content-type': 'application/json',
  'x-requested-with': '@zhuweiyou/dsh-holdem',
}

/** 后端基址：'' = 当前 DSH 进程；也可以指到 Cloudflare Worker 上。 */
let apiBase = ''

export function setApiBase(base: string): void {
  const trimmed = base.trim().replace(/\/+$/, '')
  apiBase = trimmed === '' ? '' : trimmed
}

export function getApiBase(): string {
  return apiBase
}

/** 座位 token 走请求头，不依赖浏览器是否保留 cookie。 */
let seatTokens: string[] = []

export function setSeatTokens(tokens: string[]): void {
  seatTokens = [...new Set(tokens.filter((token) => token !== ''))]
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly view: PlayerView | undefined

  constructor(code: string, message: string, status: number, view?: PlayerView) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.view = view
  }
}

async function request<T>(path: string, init: RequestInit = {}, base: string = apiBase): Promise<T> {
  const response = await fetch(`${base}${PREFIX}${path}`, {
    credentials: base === '' ? 'same-origin' : 'omit',
    ...init,
    headers: {
      ...HEADERS,
      ...(seatTokens.length > 0 ? { 'x-holdem-seat': seatTokens.join(',') } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  const text = await response.text()
  let body = {} as T & { error?: string; message?: string; view?: PlayerView }
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string; message?: string; view?: PlayerView }
    } catch {
      if (response.ok) throw new ApiError('invalid-json', '服务器返回了非 JSON 响应', response.status)
    }
  }
  if (!response.ok) {
    throw new ApiError(body.error ?? `http-${response.status}`, body.message ?? response.statusText, response.status, body.view)
  }
  return body
}

/**
 * 本机特权请求：Cloudflare 授权/部署跑在 dsh 进程里，只认回环地址。
 * 当前会话可能指向 Worker（创建过公网房间后 apiBase 不是 ''），所以这里强制打到本机。
 */
function localRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init, '')
}

export interface CreateRoomResponse {
  roomId: string
  roomCode: string
  hostPlayerId: string
  joinUrl: string
  wsTicket: string
  sessionToken: string
  view: PlayerView
}

export interface JoinResponse {
  playerId: string
  roomId: string
  seat: number | null
  wsTicket: string
  sessionToken: string
  view: PlayerView
}

export interface CloudflareStatus {
  authorized: boolean
  account: string
  workerUrl: string
  pending: boolean
  deploying: boolean
  authorizeUrl: string
  error: string
  log: string
}

export interface SessionResponse {
  inRoom: boolean
  roomId?: string
  view?: PlayerView
  /** 浏览器实际带上来几个座位凭证（0 说明 cookie 没存/被拦）。 */
  seatCookies?: number
}

export interface StateResponse {
  seq: number
  view: PlayerView
}

export const api = {
  createRoom(input: { title?: string | undefined; blindLevel?: string | undefined; displayName?: string | undefined; browserId?: string | undefined }) {
    return request<CreateRoomResponse>('/api/rooms', { method: 'POST', body: JSON.stringify(input) })
  },
  preview(input: { code: string; invite?: string | undefined; role?: 'sit' | 'watch' | undefined; browserId?: string | undefined }) {
    const query = new URLSearchParams({ code: input.code })
    if (input.invite) query.set('invite', input.invite)
    if (input.role) query.set('role', input.role)
    if (input.browserId) query.set('browser', input.browserId)
    return request<RoomPreview>(`/api/preview?${query.toString()}`)
  },
  join(input: { roomCode: string; invite?: string | undefined; displayName: string; role: 'sit' | 'watch'; browserId?: string | undefined }) {
    return request<JoinResponse>('/api/join', { method: 'POST', body: JSON.stringify(input) })
  },
  session(roomId?: string) {
    const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : ''
    return request<SessionResponse>(`/api/session${query}`)
  },
  state(roomId: string) {
    return request<StateResponse>(`/api/rooms/${encodeURIComponent(roomId)}/state`)
  },
  action(roomId: string, input: { actionId: string; baseSeq: number; command: ClientCommand }) {
    return request<{ seq: number; view: PlayerView; duplicate: boolean }>(
      `/api/rooms/${encodeURIComponent(roomId)}/action`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  },
  leave(roomId?: string) {
    return request<{ ok: boolean }>('/api/leave', {
      method: 'POST',
      body: JSON.stringify(roomId ? { roomId } : {}),
      keepalive: true,
    })
  },
  wsTicket(roomId?: string) {
    return request<{ wsTicket: string }>('/api/ws-ticket', {
      method: 'POST',
      body: JSON.stringify(roomId ? { roomId } : {}),
    })
  },
  history(roomId: string) {
    return request<{ summary: SessionSummary | null }>(`/api/rooms/${encodeURIComponent(roomId)}/history`)
  },
  cloudflare() {
    return localRequest<CloudflareStatus>('/api/cloudflare')
  },
  cloudflareAction(action: 'login' | 'deploy' | 'cancel' | 'logout') {
    return localRequest<CloudflareStatus>(`/api/cloudflare?action=${action}`, { method: 'POST', body: '{}' })
  },
}

let actionSeq = 0

export function newActionId(): string {
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID()
  if (cryptoObject?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObject.getRandomValues(bytes)
    let out = ''
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
    return `a${out}`
  }
  // 极老环境：actionId 只用于幂等去重，不参与安全决策，用时间 + 进程内序号即可。
  actionSeq += 1
  return `a${Date.now().toString(36)}${actionSeq.toString(36)}`
}
