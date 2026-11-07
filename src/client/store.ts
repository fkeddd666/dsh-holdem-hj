import { useSyncExternalStore } from 'react'
import type { ClientCommand, PlayerView, ServerEvent } from '../types.ts'
import { ApiError, api, getApiBase, newActionId, setApiBase, setSeatTokens } from './api.ts'
import { browserId } from './presence.ts'
import { t } from './i18n.ts'

export type Connection = 'idle' | 'connecting' | 'live' | 'polling' | 'offline'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export interface ClientState {
  booted: boolean
  busy: boolean
  connection: Connection
  view: PlayerView | null
  notice: string | null
  toast: Toast | null
  /** 刚开完房：面板会自动把邀请弹窗打开一次，免得房主不知道怎么叫人。 */
  autoInvite: boolean
}

let state: ClientState = {
  booted: false,
  busy: false,
  connection: 'idle',
  view: null,
  notice: null,
  toast: null,
  autoInvite: false,
}

const listeners = new Set<() => void>()
let socket: WebSocket | null = null
let pollTimer: ReturnType<typeof setInterval> | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined
let toastSeq = 0
let disposed = false

const ROOM_KEY = 'holdem:room'
const SEATS_KEY = 'holdem:seats'

/**
 * 每个标签页按后端 origin 隔离保存座位 token：
 * `{ [base]: { [roomId]: token } }`，base 为 `''` 表示本机。
 * 旧版本的扁平结构 `{ [roomId]: token }` 迁移到本机，不会被发给远端。
 */
type SeatBuckets = Record<string, Record<string, string>>

function readSeats(): SeatBuckets {
  try {
    const raw = sessionStorage.getItem(SEATS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: SeatBuckets = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        out[''] ??= {}
        out[''][key] = value
      } else if (value && typeof value === 'object') {
        const bucket: Record<string, string> = {}
        for (const [roomId, token] of Object.entries(value as Record<string, unknown>)) {
          if (typeof token === 'string' && token !== '') bucket[roomId] = token
        }
        out[key] = bucket
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 只把“当前后端”的 token 同步到请求头，绝不把其他 origin 的 token 发出去。 */
function syncSeatTokens(): void {
  setSeatTokens(Object.values(readSeats()[getApiBase()] ?? {}))
}

function rememberSeat(roomId: string, token: string): void {
  const seats = readSeats()
  const base = getApiBase()
  const bucket = seats[base] ?? (seats[base] = {})
  bucket[roomId] = token
  const ids = Object.keys(bucket)
  for (const stale of ids.slice(0, Math.max(0, ids.length - 5))) delete bucket[stale]
  try {
    sessionStorage.setItem(SEATS_KEY, JSON.stringify(seats))
  } catch {
    // 隐私模式忽略
  }
  syncSeatTokens()
}

/** 每个标签页记住自己在哪个房间，刷新后不会跑到同一浏览器里最新开的那个房间。 */
function rememberRoom(roomId: string | null): void {
  try {
    if (roomId) sessionStorage.setItem(ROOM_KEY, roomId)
    else sessionStorage.removeItem(ROOM_KEY)
  } catch {
    // 隐私模式下忽略
  }
}

function rememberedRoom(): string | null {
  try {
    return sessionStorage.getItem(ROOM_KEY)
  } catch {
    return null
  }
}

function set(patch: Partial<ClientState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useClientState(): ClientState {
  return useSyncExternalStore(subscribe, getState, getState)
}

export function getState(): ClientState {
  return state
}

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  toastSeq += 1
  set({ toast: { id: toastSeq, text, kind } })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    set({ toast: null })
  }, kind === 'error' ? 4200 : 2600)
}

/** 邀请弹窗已经自动弹过一次了。 */
export function consumeAutoInvite(): void {
  if (state.autoInvite) set({ autoInvite: false })
}

export function clearToast(): void {
  if (toastTimer) clearTimeout(toastTimer)
  set({ toast: null })
}

// ------------------------------------------------------------------ 通道

const BASE_KEY = 'holdem:api-base'

/**
 * 实时通道地址。
 *
 * 故意不带子协议：Cloudflare Worker 的 Durable Object 没法在 101 响应里回
 * `Sec-WebSocket-Protocol`，浏览器只要请求了子协议，握手就会以 1006 失败，
 * 于是玩家明明能操作（HTTP 正常）却一直显示「离线」。服务端两种都收。
 */
function wsUrl(ticket: string): string {
  const base = getApiBase()
  const url = base === '' ? new URL(location.href) : new URL(base)
  const protocol = url.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${url.host}/holdem/ws?ticket=${encodeURIComponent(ticket)}`
}

/** 切换后端（本机 / Cloudflare Worker），下一轮刷新也能回到同一处。 */
export function useBackend(base: string): void {
  setApiBase(base)
  try {
    if (base === '') sessionStorage.removeItem(BASE_KEY)
    else sessionStorage.setItem(BASE_KEY, base)
  } catch {
    // 忽略
  }
  syncSeatTokens()
}

export function restoreBackend(): void {
  try {
    const saved = sessionStorage.getItem(BASE_KEY)
    if (saved) setApiBase(saved)
  } catch {
    // 忽略
  }
  syncSeatTokens()
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

function startPolling(roomId: string): void {
  if (pollTimer || disposed) return
  pollTimer = setInterval(() => {
    void refresh(roomId).catch(() => undefined)
  }, 1000)
}

function scheduleReconnect(roomId: string): void {
  if (reconnectTimer || disposed) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    void reissueTicket(roomId)
  }, 3000)
}

async function reissueTicket(roomId: string): Promise<void> {
  if (disposed) return
  try {
    const { wsTicket } = await api.wsTicket(roomId)
    connectChannel(roomId, wsTicket)
  } catch {
    scheduleReconnect(roomId)
  }
}

function closeChannel(): void {
  stopPolling()
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  if (socket) {
    socket.onclose = null
    socket.close()
  }
  socket = null
}

function connectChannel(roomId: string, ticket: string): void {
  closeChannel()
  if (disposed) return
  set({ connection: 'connecting' })
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl(ticket))
  } catch {
    set({ connection: 'polling' })
    startPolling(roomId)
    scheduleReconnect(roomId)
    return
  }
  socket = ws
  ws.onopen = () => {
    set({ connection: 'live' })
    stopPolling()
  }
  ws.onmessage = (event) => {
    try {
      handleEvent(JSON.parse(String(event.data)) as ServerEvent)
    } catch {
      // ignore malformed frames
    }
  }
  ws.onclose = () => {
    if (socket === ws) socket = null
    if (disposed) return
    set({ connection: 'polling' })
    const room = state.view?.room.roomId
    if (room) {
      startPolling(room)
      scheduleReconnect(room)
    }
  }
  ws.onerror = () => {
    ws.close()
  }
}

function handleEvent(event: ServerEvent): void {
  if (event.type === 'snapshot') {
    if (!state.view || state.view.room.roomId === event.view.room.roomId) set({ view: event.view })
    return
  }
  if (event.type === 'settled') {
    toast(t('toast.settlement'))
    const room = state.view?.room.roomId
    if (room) void refresh(room)
    return
  }
  if (event.type === 'kicked') {
    closeChannel()
    useBackend('')
    set({ view: null, notice: t('error.kicked'), connection: 'idle' })
    return
  }
  if (event.type === 'left') {
    closeChannel()
    useBackend('')
    set({ view: null, notice: event.reason, connection: 'idle' })
    return
  }
  if (event.type === 'reject') {
    toast(event.reason, 'error')
  }
}

async function refresh(roomId: string): Promise<void> {
  if (!roomId) return
  try {
    const response = await api.state(roomId)
    set({ view: response.view })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      await recoverSession(roomId)
    } else {
      throw error
    }
  }
}

/**
 * 状态接口说「不在这个房间」时，先确认浏览器现在到底在哪个房间：
 * 同一个浏览器可能有多个标签页各自在别的房间，cookie 还在就别把用户踢回大厅。
 */
async function recoverSession(roomId: string): Promise<void> {
  let session: Awaited<ReturnType<typeof api.session>> | null = null
  try {
    session = await api.session()
  } catch {
    session = null
  }
  if (session?.inRoom && session.view) {
    const next = session.view.room.roomId
    rememberRoom(next)
    set({ view: session.view, notice: null })
    if (next !== roomId) toast(t('toast.switched', { code: session.view.room.roomCode }))
    try {
      const { wsTicket } = await api.wsTicket(next)
      connectChannel(next, wsTicket)
    } catch {
      set({ connection: 'polling' })
      startPolling(next)
      scheduleReconnect(next)
    }
    return
  }
  rememberRoom(null)
  closeChannel()
  useBackend('')
  const noCookie = session !== null && !session.inRoom && (session.seatCookies ?? 1) === 0
  set({ view: null, connection: 'idle', notice: noCookie ? t('error.noSeatCookie') : t('error.roomGone') })
}

// ------------------------------------------------------------------ 生命周期

export async function bootstrap(): Promise<void> {
  // 插件热重载会先 dispose 再重新挂载：此时状态已清空，直接重来一次
  if (disposed) disposed = false
  else if (state.booted) return
  try {
    syncSeatTokens()
    const session = await api.session(rememberedRoom() ?? undefined)
    if (session.inRoom && session.view) {
      rememberRoom(session.view.room.roomId)
      set({ view: session.view })
      try {
        const { wsTicket } = await api.wsTicket(session.view.room.roomId)
        connectChannel(session.view.room.roomId, wsTicket)
      } catch {
        set({ connection: 'polling' })
        startPolling(session.view.room.roomId)
      }
    } else {
      // 没在房间里就别继续指着远端：大厅的授权面板、入座都要回到本机
      useBackend('')
    }
  } catch {
    // 没有会话时保持大厅
  } finally {
    set({ booted: true })
  }
}

export function dispose(): void {
  disposed = true
  closeChannel()
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = undefined
  listeners.clear()
  socket = null
  state = { booted: false, busy: false, connection: 'idle', view: null, notice: null, toast: null, autoInvite: false }
}

export async function createRoom(
  input: { title?: string | undefined; blindLevel: string; displayName: string },
  base = '',
): Promise<void> {
  set({ busy: true })
  if (base !== '') useBackend(base)
  try {
    const created = await api.createRoom({ ...input, browserId: browserId() })
    rememberRoom(created.view.room.roomId)
    rememberSeat(created.view.room.roomId, created.sessionToken)
    set({ view: created.view, busy: false, notice: null, autoInvite: true })
    toast(t('toast.created', { code: created.roomCode }))
    connectChannel(created.view.room.roomId, created.wsTicket)
  } catch (error) {
    set({ busy: false })
    if (base !== '') useBackend('')
    toast(errorText(error), 'error')
    throw error
  }
}

export async function joinRoom(input: {
  roomCode: string
  invite?: string | undefined
  displayName: string
  role: 'sit' | 'watch'
}, base = ''): Promise<void> {
  set({ busy: true })
  if (base !== '') useBackend(base)
  try {
    const joined = await api.join({ ...input, browserId: browserId() })
    rememberRoom(joined.view.room.roomId)
    rememberSeat(joined.view.room.roomId, joined.sessionToken)
    set({ view: joined.view, busy: false, notice: null })
    toast(t('toast.joined', { code: joined.view.room.roomCode }))
    connectChannel(joined.view.room.roomId, joined.wsTicket)
  } catch (error) {
    set({ busy: false })
    if (base !== '') useBackend('')
    toast(errorText(error), 'error')
    throw error
  }
}

export async function leaveRoom(): Promise<void> {
  try {
    await api.leave(state.view?.room.roomId)
  } catch {
    // 房间可能已解散
  }
  rememberRoom(null)
  closeChannel()
  useBackend('')
  set({ view: null, connection: 'idle', notice: null })
  toast(t('toast.left'))
}

export async function runCommand(command: ClientCommand): Promise<void> {
  const view = state.view
  if (!view) return
  set({ busy: true })
  try {
    const response = await api.action(view.room.roomId, {
      actionId: newActionId(),
      baseSeq: view.room.seq,
      command,
    })
    set({ view: response.view, busy: false })
    if (response.duplicate) toast(t('toast.duplicate'))
  } catch (error) {
    set({ busy: false })
    if (error instanceof ApiError) {
      if (error.code === 'stale' && error.view) {
        set({ view: error.view })
        toast(t('error.stale'))
        return
      }
      if (error.code === 'not-your-turn') {
        toast(t('error.notYourTurn'), 'error')
      } else {
        toast(error.message || t('error.generic'), 'error')
      }
      const roomId = state.view?.room.roomId
      if (roomId) void refresh(roomId).catch(() => undefined)
      return
    }
    toast(errorText(error), 'error')
  }
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message || t('error.generic')
  if (error instanceof Error) return error.message
  return t('error.generic')
}

// 放在所有常量初始化之后：BASE_KEY/SEATS_KEY 在模块后段才声明，
// 以前在文件顶部调用会命中 TDZ 并被 try/catch 吞掉，导致刷新后恢复不了后端。
restoreBackend()
