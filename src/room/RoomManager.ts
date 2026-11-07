import type { ResolvedConfig } from '../config.ts'
import type {
  ChatLine,
  ClientCommand,
  HandResultView,
  LeaderboardEntry,
  PlayerId,
  PlayerView,
  RoomId,
  RoomPhase,
  RoomPreview,
  RoomSettingsView,
  RoomView,
  SeatView,
  ServerEvent,
  SessionSummary,
  TableAction,
} from '../types.ts'
import { CommandError, asPlayerId, asRoomId, asSessionId, nowIso } from '../types.ts'
import {
  ACTION_RATE_MAX,
  ACTION_RATE_WINDOW_MS,
  MAX_CACHED_ACTIONS,
  MAX_CHAT_LINES,
  MAX_HISTORY_HANDS,
  MAX_SEATS,
  WS_TICKET_TTL_MS,
  CHAT_COOLDOWN_MS,
  HAND_OVER_MIN_MS,
  PRESENCE_TTL_MS,
  TICK_MS,
  SESSION_TTL_MS,
  blindsFor,
  buyInFor,
} from '../invariant.ts'
import { act, createHand, foldSeat, forceTimeout, handView, legalForSeat, tick as tickHand, type HandState } from '../engine/hand.ts'
import { HandError } from '../engine/hand.ts'
import type { HoldemStore } from '../persist/noop.ts'
import { noopStore } from '../persist/noop.ts'
import {
  hashEquals,
  hashInvite,
  newId,
  newRoomCode,
  newSecret,
  newToken,
  sanitizeChat,
  sanitizeDisplayName,
  sanitizeTitle,
} from './ids.ts'

export interface Session {
  token: string
  playerId: PlayerId
  roomId: RoomId
  kind: 'seat' | 'watch' | 'host'
  createdAt: number
  expiresAt: number
}

interface LivePlayer {
  playerId: PlayerId
  displayName: string
  seat: number | null
  ready: boolean
  connected: boolean
  /** 当前有一条打开的实时通道（HTTP 轮询不算）。 */
  socketOpen: boolean
  /** 最近一次被观察到「人在」的时间：实时通道或 HTTP 请求都算。 */
  lastSeenAt: number
  sittingOut: boolean
  autoFold: boolean
  timeoutStreak: number
  browserId: string
  joinedAt: number
  leaving: boolean
}

interface Stats {
  displayName: string
  seat: number | null
  handsPlayed: number
  handsWon: number
  netChips: number
  biggestWin: number
  showdownsWon: number
  showdownsPlayed: number
}

interface LiveRoom {
  roomId: RoomId
  roomCode: string
  title: string
  hostPlayerId: PlayerId
  phase: RoomPhase
  settings: RoomSettingsView
  players: Map<PlayerId, LivePlayer>
  stats: Map<PlayerId, Stats>
  hand: HandState | null
  handNo: number
  lastHand: HandResultView | null
  lastButton: number | null
  history: HandResultView[]
  chat: ChatLine[]
  seq: number
  createdAt: number
  inviteExpiresAt: number
  secret: string
  sitToken: string
  watchToken: string
  sitHash: string
  watchHash: string
  handOverAt: number | null
  summary: SessionSummary | null
  closedAt: number | null
  hostLastSeen: number
  lastChatAt: Map<PlayerId, number>
  browsers: Map<string, PlayerId>
  actionCache: Map<string, number>
}

export interface RoomManagerOptions {
  config: ResolvedConfig
  origin: () => string
  now?: () => number
  store?: HoldemStore
  log?: (message: string) => void
  /** 局域网 IPv4（Node 下用 os.networkInterfaces，Worker 下为空）。 */
  lanIp?: () => string
}

export interface CreateRoomInput {
  title?: string | undefined
  blindLevel?: string | undefined
  displayName?: string | undefined
  browserId?: string | undefined
}

export interface PeekInput {
  roomCode: string
  invite?: string | undefined
  role?: 'sit' | 'watch'
  local: boolean
  browserId?: string | undefined
  /** 浏览器带来的所有座位 token（每个房间一个），按新到旧排列。 */
  cookies?: string[] | undefined
}

export interface JoinInput extends PeekInput {
  displayName: string
  role: 'sit' | 'watch'
}

export interface CreateRoomResult {
  roomId: RoomId
  roomCode: string
  hostPlayerId: PlayerId
  joinUrl: string
  wsTicket: string
  sessionToken: string
  view: PlayerView
}

export interface JoinResult {
  playerId: PlayerId
  roomId: RoomId
  seat: number | null
  wsTicket: string
  sessionToken: string
  view: PlayerView
}

interface Ticket {
  playerId: PlayerId
  roomId: RoomId
  expiresAt: number
}

export class StaleCommandError extends CommandError {
  readonly view: PlayerView
  constructor(reason: string, view: PlayerView) {
    super('stale', reason)
    this.view = view
  }
}

const CLOSED_RETENTION_MS = 10 * 60 * 1000

export class RoomManager {
  readonly counters = { roomsCreated: 0, roomsClosed: 0, handsPlayed: 0, wsConnected: 0, commands: 0 }

  private config: ResolvedConfig
  private readonly origin: () => string
  private readonly now: () => number
  private readonly store: HoldemStore
  private readonly log: (message: string) => void
  /** 每玩家命令令牌桶：防止 ready/hostKick 等无冷却命令被刷。 */
  private readonly actionRate = new Map<PlayerId, { count: number; resetAt: number }>()

  private readonly rooms = new Map<string, LiveRoom>()
  private readonly roomsByCode = new Map<string, LiveRoom>()
  private readonly sessions = new Map<string, Session>()
  private readonly tickets = new Map<string, Ticket>()
  private readonly listeners = new Set<(playerId: PlayerId, event: ServerEvent) => void>()

  constructor(options: RoomManagerOptions) {
    this.config = options.config
    this.origin = options.origin
    this.now = options.now ?? (() => Date.now())
    this.store = options.store ?? noopStore
    this.log = options.log ?? (() => undefined)
    this.lanIp = options.lanIp ?? (() => '')
  }

  getConfig(): ResolvedConfig {
    return this.config
  }

  /** 局域网小代理的端口（0 表示没起来）。 */
  private lanPort = 0
  private readonly lanIp: () => string

  setLanPort(port: number): void {
    this.lanPort = port > 0 ? port : 0
  }

  replaceConfig(config: ResolvedConfig): void {
    this.config = config
  }

  start(): () => void {
    // 定时器回调里的异常会变成 uncaughtException，直接带走整个 dsh 进程；
    // 这里兜底记录，单个房间的异常不应该影响其他房间。
    const timer = setInterval(() => {
      try {
        this.tick()
      } catch (error) {
        this.log(`tick failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, TICK_MS)
    // Node 下别让定时器拖住进程；Workers 里 setInterval 返回数字，没有 unref
    const handle = timer as unknown as { unref?: () => void }
    if (typeof handle === 'object' && typeof handle.unref === 'function') handle.unref()
    return () => clearInterval(timer)
  }

  async dispose(): Promise<void> {
    this.rooms.clear()
    this.roomsByCode.clear()
    this.sessions.clear()
    this.tickets.clear()
    this.listeners.clear()
    this.actionRate.clear()
  }

  onEvent(listener: (playerId: PlayerId, event: ServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---------------------------------------------------------------- 房间/会话

  createRoom(input: CreateRoomInput): CreateRoomResult {
    const now = this.now()
    const openRooms = [...this.rooms.values()].filter((room) => room.phase !== 'closed').length
    if (openRooms >= this.config.maxRooms) throw new CommandError('room-full', '房间数量已达上限')

    const blinds = blindsFor(input.blindLevel ?? this.config.blindLevel)
    const code = this.uniqueCode()
    const secret = newSecret()
    const sitToken = newToken()
    const watchToken = newToken()
    const roomId = asRoomId(newId('room'))
    const room: LiveRoom = {
      roomId,
      roomCode: code,
      title: sanitizeTitle(input.title),
      hostPlayerId: asPlayerId(''),
      phase: 'lobby',
      settings: {
        blindLevel: blinds.id,
        sb: blinds.sb,
        bb: blinds.bb,
        buyIn: buyInFor(blinds.bb),
        turnTimeoutMs: this.config.turnTimeoutMs,
        autoAdvanceMs: this.config.autoAdvanceMs,
        allowSpectators: this.config.allowSpectators,
        maxSpectators: this.config.maxSpectators,
        chatEnabled: this.config.chatEnabled,
      },
      players: new Map(),
      stats: new Map(),
      hand: null,
      handNo: 0,
      lastHand: null,
      lastButton: null,
      history: [],
      chat: [],
      seq: 0,
      createdAt: now,
      inviteExpiresAt: now + 24 * 60 * 60 * 1000,
      secret,
      sitToken,
      watchToken,
      sitHash: hashInvite(secret, 'sit', sitToken),
      watchHash: hashInvite(secret, 'watch', watchToken),
      handOverAt: null,
      summary: null,
      closedAt: null,
      hostLastSeen: now,
      lastChatAt: new Map(),
      browsers: new Map(),
      actionCache: new Map(),
    }

    const host = this.addPlayer(room, sanitizeDisplayName(input.displayName), 0, input.browserId ?? '')
    host.ready = true
    room.hostPlayerId = host.playerId
    this.rooms.set(roomId, room)
    this.roomsByCode.set(code, room)
    this.counters.roomsCreated += 1

    const session = this.newSession(room, host.playerId, 'host')
    const joinUrl = this.joinUrlFor(room, sitToken)
    return {
      roomId,
      roomCode: code,
      hostPlayerId: host.playerId,
      joinUrl,
      wsTicket: this.issueTicket(host.playerId, roomId),
      sessionToken: session.token,
      view: this.project(room, host.playerId),
    }
  }

  peek(input: PeekInput): RoomPreview {
    const room = this.roomByCode(input.roomCode)
    const inviteOk = this.checkInvite(room, input, input.role ?? 'sit', input.local)
    if (!inviteOk.allowed) throw new CommandError('expired', '邀请已失效，请向房主要一个新链接')

    const seated = [...room.players.values()].filter((player) => player.seat !== null)
    const seats = Array.from({ length: MAX_SEATS }, (_, seat) => {
      const occupant = seated.find((player) => player.seat === seat)
      return {
        seat,
        displayName: occupant?.displayName ?? null,
        ready: occupant?.ready ?? false,
        host: occupant?.playerId === room.hostPlayerId,
        connected: occupant?.connected ?? false,
      }
    })
    const existing = this.existingPlayer(room, input)
    return {
      roomCode: room.roomCode,
      title: room.title,
      hostDisplayName: room.players.get(room.hostPlayerId)?.displayName ?? '房主',
      phase: room.phase,
      settings: room.settings,
      seated: seated.length,
      spectators: [...room.players.values()].filter((player) => player.seat === null).length,
      seats,
      canSit: room.phase === 'lobby' && seated.length < MAX_SEATS,
      alreadyInRoom: existing !== null,
      inviteExpiresAt: new Date(room.inviteExpiresAt).toISOString(),
    }
  }

  join(input: JoinInput): JoinResult {
    const room = this.roomByCode(input.roomCode)
    const wanted = input.role === 'watch' ? 'watch' : 'sit'
    const invite = this.checkInvite(room, input, wanted, input.local)
    if (!invite.allowed) throw new CommandError('expired', '邀请已失效，请向房主要一个新链接')

    const cookieSession = this.sessionFromCookies(input.cookies, room.roomId)
    if (cookieSession) {
      const player = room.players.get(cookieSession.playerId)
      if (player && !player.leaving) {
        player.browserId = input.browserId ?? player.browserId
        this.touch(room, player)
        return {
          playerId: player.playerId,
          roomId: room.roomId,
          seat: player.seat,
          wsTicket: this.issueTicket(player.playerId, room.roomId),
          sessionToken: cookieSession.token,
          view: this.project(room, player.playerId),
        }
      }
    }

    const existing = this.existingPlayer(room, input)
    if (existing) throw new CommandError('already-in-room', '这个浏览器已经在这个房间里了')

    const seatedCount = [...room.players.values()].filter((player) => player.seat !== null).length
    const canSit = wanted === 'sit' && invite.sit && room.phase === 'lobby' && seatedCount < MAX_SEATS
    if (!canSit) {
      if (!room.settings.allowSpectators || room.settings.maxSpectators <= 0) {
        throw new CommandError('room-full', '房间已满且不允许观战')
      }
      const spectators = [...room.players.values()].filter((player) => player.seat === null)
      if (spectators.length >= room.settings.maxSpectators) throw new CommandError('room-full', '观战席已满')
      if (wanted === 'sit' && invite.sit === false) throw new CommandError('auth', '没有入座权限')
    }

    const seat = canSit ? this.firstFreeSeat(room) : null
    const player = this.addPlayer(room, sanitizeDisplayName(input.displayName), seat, input.browserId ?? '')
    player.ready = seat !== null
    const session = this.newSession(room, player.playerId, seat === null ? 'watch' : 'seat')
    if (seat === null && room.phase === 'hand') {
      this.pushChat(room, null, `${player.displayName} 进入观战`)
    }
    this.publish(room)
    return {
      playerId: player.playerId,
      roomId: room.roomId,
      seat: player.seat,
      wsTicket: this.issueTicket(player.playerId, room.roomId),
      sessionToken: session.token,
      view: this.project(room, player.playerId),
    }
  }

  leave(playerId: PlayerId): void {
    const room = this.roomOf(playerId)
    if (!room) return
    if (room.phase === 'closed') {
      // 结算页点「返回大厅」：把座位与会话清掉，别让旧房间一直挂着
      this.removePlayer(room, playerId)
      this.dropSessionsOf(room, playerId)
      return
    }
    const isHost = room.hostPlayerId === playerId
    const player = room.players.get(playerId)

    // 手牌进行中：不管是谁（包括房主）都先把这手打完，只弃掉自己的牌
    if (player && room.phase === 'hand' && room.hand && !room.hand.completed && player.seat !== null) {
      foldSeat(room.hand, player.seat, this.now())
      player.leaving = true
      player.connected = false
      this.dropSessionsOf(room, playerId)
      if (room.hand.completed) this.finalizeHand(room, this.now())
      else this.publish(room)
      return
    }

    if (isHost) {
      // 大厅/两手之间离开：没有手牌要保，直接结算
      this.dissolve(room, 'host-dissolved')
      return
    }
    if (!player) return
    this.removePlayer(room, playerId)
    this.publish(room)
  }

  sessionByToken(token: string | undefined): Session | undefined {
    if (!token) return undefined
    const session = this.sessions.get(token)
    if (!session) return undefined
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token)
      return undefined
    }
    return session
  }

  /** 把浏览器带来的若干 token 解析成会话，新的在前。 */
  sessionsForTokens(tokens: readonly string[]): Session[] {
    const out: Session[] = []
    for (const token of tokens) {
      const session = this.sessionByToken(token)
      if (session && !out.some((entry) => entry.token === session.token)) out.push(session)
    }
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  private sessionFromCookies(tokens: readonly string[] | undefined, roomId: RoomId): Session | undefined {
    if (!tokens || tokens.length === 0) return undefined
    for (const token of tokens) {
      const session = this.sessionByToken(token)
      if (session && session.roomId === roomId) return session
    }
    return undefined
  }

  view(roomId: RoomId, playerId: PlayerId): PlayerView {
    const room = this.roomOf(playerId)
    if (!room || room.roomId !== roomId) throw new CommandError('auth', '不在这个房间里')
    // 能取到状态就说明人在：轮询（实时通道断掉时的退路）不该显示成离线
    const player = room.players.get(playerId)
    if (player) this.touch(room, player)
    return this.project(room, playerId)
  }

  // ---------------------------------------------------------------- 命令

  command(
    roomId: RoomId,
    playerId: PlayerId,
    command: ClientCommand,
    baseSeq?: number,
    actionId?: string,
  ): { seq: number; view: PlayerView; duplicate?: boolean } {
    const room = this.roomOf(playerId)
    if (!room || room.roomId !== roomId) throw new CommandError('auth', '不在这个房间里')
    const player = room.players.get(playerId)
    if (!player || player.leaving) throw new CommandError('auth', '不在这个房间里')
    this.touch(room, player)

    if (command.type === 'ping') {
      return { seq: room.seq, view: this.project(room, playerId) }
    }
    if (!this.allowAction(playerId)) throw new CommandError('rate-limited', '操作太频繁，请稍后再试')
    if (room.phase === 'closed') throw new CommandError('phase', '房间已解散')
    if (baseSeq !== undefined && baseSeq !== room.seq) {
      throw new StaleCommandError('状态已更新，请重试', this.project(room, playerId))
    }
    const cacheKey = actionId ? `${playerId}:${actionId}` : ''
    if (cacheKey && room.actionCache.has(cacheKey)) {
      return { seq: room.seq, view: this.project(room, playerId), duplicate: true }
    }
    this.counters.commands += 1

    switch (command.type) {
      case 'sit': {
        if (room.phase !== 'lobby') throw new CommandError('phase', '对局进行中，暂时不能入座')
        if (player.seat !== null) throw new CommandError('illegal', '你已经在座位上了')
        const requested = command.seat
        const seat = requested !== undefined && Number.isInteger(requested) && requested >= 0 && requested < MAX_SEATS
          ? (this.seatTaken(room, requested) ? -1 : requested)
          : this.firstFreeSeat(room)
        if (seat < 0) throw new CommandError('room-full', '没有空座')
        player.seat = seat
        player.ready = true
        player.sittingOut = false
        player.autoFold = false
        player.timeoutStreak = 0
        if (command.displayName) player.displayName = sanitizeDisplayName(command.displayName)
        this.publish(room)
        break
      }
      case 'stand': {
        if (player.seat === null) throw new CommandError('illegal', '你本来就在观战')
        if (room.phase === 'hand' && room.hand && !room.hand.completed) foldSeat(room.hand, player.seat, this.now())
        player.seat = null
        player.ready = false
        if (room.hand?.completed) this.finalizeHand(room, this.now())
        else this.publish(room)
        break
      }
      case 'ready': {
        if (player.seat === null) throw new CommandError('not-seated', '先入座再准备')
        // 幂等：状态没变化就不广播，避免刷 ready 造成 O(N²) 广播放大。
        // 但 sittingOut/autoFold 需要靠 ready=true 复位，这种情况不能提前返回。
        if (player.ready === command.ready && (command.ready === false || (!player.sittingOut && !player.autoFold))) {
          return { seq: room.seq, view: this.project(room, playerId) }
        }
        player.ready = command.ready
        if (command.ready) {
          player.sittingOut = false
          player.autoFold = false
          player.timeoutStreak = 0
        }
        this.publish(room)
        break
      }
      case 'start': {
        this.requireHost(room, playerId)
        if (room.phase !== 'lobby') throw new CommandError('phase', '当前阶段不能开局')
        this.startHand(room, this.now())
        break
      }
      case 'action': {
        if (room.phase !== 'hand' || !room.hand || room.hand.completed) throw new CommandError('phase', '现在不能行动')
        if (player.seat === null) throw new CommandError('not-seated', '你在观战')
        player.timeoutStreak = 0
        player.autoFold = false
        player.sittingOut = false
        this.applyTableAction(room, player.seat, command.action)
        break
      }
      case 'chat': {
        if (!room.settings.chatEnabled) throw new CommandError('illegal', '本桌已关闭聊天')
        const text = sanitizeChat(command.text)
        if (!text) throw new CommandError('illegal', '消息为空')
        const last = room.lastChatAt.get(playerId) ?? 0
        const now = this.now()
        if (now - last < CHAT_COOLDOWN_MS) throw new CommandError('rate-limited', '发得太快了')
        room.lastChatAt.set(playerId, now)
        this.pushChat(room, player, text)
        this.publish(room)
        break
      }
      case 'hostPause': {
        this.requireHost(room, playerId)
        if (room.phase === 'hand') throw new CommandError('phase', '一手牌进行中不能暂停')
        room.phase = 'lobby'
        room.hand = null
        room.handOverAt = null
        for (const seated of room.players.values()) if (seated.seat !== null) seated.ready = false
        this.publish(room)
        break
      }
      case 'hostKick': {
        this.requireHost(room, playerId)
        const target = command.playerId
        if (target === room.hostPlayerId) throw new CommandError('illegal', '不能踢房主')
        const targetPlayer = room.players.get(target)
        if (!targetPlayer) throw new CommandError('illegal', '玩家不在房间里')
        // 座位上的牌友只有在大厅能踢；观战者随时可以清走
        if (targetPlayer.seat !== null && room.phase !== 'lobby') {
          throw new CommandError('phase', '对局中不能踢座位上的人')
        }
        this.removePlayer(room, target)
        this.dropSessionsOf(room, target)
        this.sendTo(target, { type: 'kicked', seq: room.seq, reason: '你被房主请出了房间' })
        this.publish(room)
        break
      }
      case 'hostDissolve': {
        this.requireHost(room, playerId)
        this.dissolve(room, 'host-dissolved')
        break
      }
      default:
        throw new CommandError('illegal', '未知命令')
    }

    if (cacheKey) {
      room.actionCache.set(cacheKey, room.seq)
      while (room.actionCache.size > MAX_CACHED_ACTIONS) {
        const oldest = room.actionCache.keys().next().value
        if (oldest === undefined) break
        room.actionCache.delete(oldest)
      }
    }
    return { seq: room.seq, view: this.project(room, playerId) }
  }

  /** 结算导出：房主与在场玩家都能取到本次会话汇总。 */
  exportSummary(roomId: RoomId, playerId: PlayerId): SessionSummary | null {
    const room = this.roomOf(playerId)
    if (!room || room.roomId !== roomId) throw new CommandError('auth', '不在这个房间里')
    return room.summary
  }

  // ---------------------------------------------------------------- WS 票据

  issueTicket(playerId: PlayerId, roomId: RoomId): string {
    const ticket = newToken()
    this.tickets.set(ticket, { playerId, roomId, expiresAt: this.now() + WS_TICKET_TTL_MS })
    return ticket
  }

  consumeTicket(ticket: string): { playerId: PlayerId; roomId: RoomId } | null {
    const entry = this.tickets.get(ticket)
    if (!entry) return null
    this.tickets.delete(ticket)
    if (entry.expiresAt <= this.now()) return null
    return { playerId: entry.playerId, roomId: entry.roomId }
  }

  /**
   * 实时通道打开/关闭。
   *
   * 关掉 socket 不等于立刻离线：后台轮询（HTTP）还活着的话人还在。真正判离线交给
   * `tick` 按 `PRESENCE_TTL_MS` 扫一遍，两边都没有动静才标成离线。
   */
  markConnected(playerId: PlayerId, roomId: RoomId, connected: boolean): void {
    const room = this.rooms.get(roomId)
    const player = room?.players.get(playerId)
    if (!room || !player) return
    player.socketOpen = connected
    if (connected) player.lastSeenAt = this.now()
    this.refreshPresence(room, player)
  }

  /** HTTP 请求也算心跳：轮询模式下不能把自己和别人都显示成离线。 */
  private touch(room: LiveRoom, player: LivePlayer): void {
    if (player.leaving) return
    player.lastSeenAt = this.now()
    if (room.hostPlayerId === player.playerId) room.hostLastSeen = player.lastSeenAt
    this.refreshPresence(room, player)
  }

  /** 有实时通道，或者最近有 HTTP 动静，就算在线。 */
  private refreshPresence(room: LiveRoom, player: LivePlayer): void {
    const online = !player.leaving && (player.socketOpen || this.now() - player.lastSeenAt < PRESENCE_TTL_MS)
    if (player.connected === online) return
    player.connected = online
    this.publish(room)
  }

  health(): Record<string, unknown> {
    return {
      rooms: this.rooms.size,
      open: [...this.rooms.values()].filter((room) => room.phase !== 'closed').length,
      sessions: this.sessions.size,
      ...this.counters,
    }
  }

  // ---------------------------------------------------------------- 内部：阶段

  private startHand(room: LiveRoom, now: number): void {
    const eligible = [...room.players.values()].filter(
      (player) => player.seat !== null && player.ready && !player.sittingOut && !player.autoFold && !player.leaving,
    )
    const seated = [...room.players.values()].filter((player) => player.seat !== null && !player.leaving)
    const notReady = seated.filter(
      (player) => player.playerId !== room.hostPlayerId && !player.ready && !player.sittingOut && !player.autoFold,
    )
    if (notReady.length > 0) throw new CommandError('phase', `还有 ${notReady.length} 人没准备`)
    if (eligible.length < 2) throw new CommandError('phase', '至少需要 2 人准备才能开局')

    const seats = eligible.map((player) => ({
      seat: player.seat as number,
      playerId: player.playerId,
      displayName: player.displayName,
    }))
    const button = this.nextButton(room, seats.map((entry) => entry.seat))
    room.hand = createHand({
      handNo: room.handNo + 1,
      button,
      seats,
      sb: room.settings.sb,
      bb: room.settings.bb,
      buyIn: room.settings.buyIn,
      turnTimeoutMs: room.settings.turnTimeoutMs,
      now,
    })
    room.handNo += 1
    room.phase = 'hand'
    room.handOverAt = null
    this.counters.handsPlayed += 1
    this.publish(room)
  }

  private applyTableAction(room: LiveRoom, seat: number, action: TableAction): void {
    const hand = room.hand
    if (!hand) throw new CommandError('phase', '没有进行中的手牌')
    try {
      act(hand, seat, action, this.now())
    } catch (error) {
      if (error instanceof HandError) throw new CommandError(error.code === 'not-your-turn' ? 'not-your-turn' : error.code, error.message)
      throw error
    }
    if (hand.completed) this.finalizeHand(room, this.now())
    else this.publish(room)
  }

  private finalizeHand(room: LiveRoom, now: number): void {
    const hand = room.hand
    const result = hand?.result
    if (!hand || !result) return

    for (const delta of result.deltas) {
      const stats = this.ensureStats(room, delta.playerId, delta.displayName, delta.seat)
      stats.handsPlayed += 1
      stats.netChips += delta.net
      stats.biggestWin = Math.max(stats.biggestWin, delta.net)
      stats.displayName = delta.displayName
      stats.seat = delta.seat
      if (result.winners.includes(delta.seat)) stats.handsWon += 1
      if (!result.foldedWin && result.shownHands.some((shown) => shown.seat === delta.seat)) {
        stats.showdownsPlayed += 1
        if (result.winners.includes(delta.seat)) stats.showdownsWon += 1
      }
    }

    room.lastHand = result
    room.lastButton = hand.button
    room.history.push(result)
    if (room.history.length > MAX_HISTORY_HANDS) room.history.splice(0, room.history.length - MAX_HISTORY_HANDS)
    room.phase = 'handOver'
    room.handOverAt = now + Math.max(room.settings.autoAdvanceMs, HAND_OVER_MIN_MS)

    for (const player of [...room.players.values()]) {
      if (player.leaving) this.removePlayer(room, player.playerId)
    }

    this.store.appendHand({
      ...result,
      roomCode: room.roomCode,
      title: room.title,
      recordedAt: nowIso(),
    })
    this.publish(room)
  }

  private advance(room: LiveRoom, now: number): void {
    const host = room.players.get(room.hostPlayerId)
    if (!host || host.leaving) {
      // 房主走了：这手照常算完，但不再开新局
      this.dissolve(room, 'host-dissolved')
      return
    }
    const eligible = [...room.players.values()].filter(
      (player) => player.seat !== null && !player.sittingOut && !player.autoFold && !player.leaving,
    )
    if (eligible.length >= 2) {
      try {
        this.startHand(room, now)
        return
      } catch {
        // 落到大厅
      }
    }
    room.phase = 'lobby'
    room.hand = null
    room.handOverAt = null
    for (const player of room.players.values()) if (player.seat !== null) player.ready = false
    this.publish(room)
  }

  private dissolve(room: LiveRoom, reason: 'host-dissolved' | 'host-idle'): void {
    if (room.phase === 'closed' || room.phase === 'settling') return
    room.hand = null
    room.handOverAt = null
    room.closedAt = this.now()
    const summary = this.buildSummary(room, reason)
    room.summary = summary
    room.phase = 'closed'
    this.counters.roomsClosed += 1
    this.store.appendSession(summary)
    this.publish(room)
    for (const player of room.players.values()) {
      this.sendTo(player.playerId, { type: 'settled', seq: room.seq, summary })
    }
  }

  private buildSummary(room: LiveRoom, reason: 'host-dissolved' | 'host-idle'): SessionSummary {
    const entries = [...room.stats.entries()]
      .map(([playerId, stats]) => ({ playerId, ...stats }))
      .filter((entry) => entry.handsPlayed > 0)
    entries.sort((a, b) => (b.netChips - a.netChips) || (b.handsWon - a.handsWon) || (a.displayName.localeCompare(b.displayName)))
    const endedAt = this.now()
    return {
      sessionId: asSessionId(`sess_${room.roomCode}_${room.createdAt}`),
      roomCode: room.roomCode,
      title: room.title,
      startedAt: new Date(room.createdAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - room.createdAt,
      handsPlayed: room.handNo,
      players: entries.map((entry, index) => ({
        rank: index + 1,
        playerId: entry.playerId,
        displayName: entry.displayName,
        handsPlayed: entry.handsPlayed,
        handsWon: entry.handsWon,
        netChips: entry.netChips,
        biggestWin: entry.biggestWin,
        showdownsWon: entry.showdownsWon,
        showdownsPlayed: entry.showdownsPlayed,
      })),
      history: [...room.history],
      reason,
    }
  }

  // ---------------------------------------------------------------- 内部：tick

  tick(): void {
    const now = this.now()
    for (const room of [...this.rooms.values()]) {
      if (room.phase === 'closed') {
        if (room.closedAt !== null && now - room.closedAt > CLOSED_RETENTION_MS) this.dropRoom(room)
        continue
      }
      if (room.hostPlayerId && now - room.hostLastSeen > this.config.hostIdleDissolveMs) {
        this.dissolve(room, 'host-idle')
        continue
      }
      if (room.phase === 'hand' && room.hand) {
        this.tickHand(room, now)
      }
      if (room.phase === 'handOver' && room.handOverAt !== null && now >= room.handOverAt) {
        this.advance(room, now)
      }
      for (const player of [...room.players.values()]) {
        if (player.leaving && room.phase !== 'hand') this.removePlayer(room, player.playerId)
        else this.refreshPresence(room, player)
      }
    }
    this.cleanupSessions(now)
  }

  private tickHand(room: LiveRoom, now: number): void {
    const hand = room.hand
    if (!hand || hand.completed) return
    if (hand.runoutDueAt !== null) {
      if (tickHand(hand, now)) {
        if (hand.completed) this.finalizeHand(room, now)
        else this.publish(room)
      }
      return
    }
    if (hand.deadlineAt === null || now < hand.deadlineAt) return

    const seat = hand.toActSeat
    if (seat !== null) {
      const player = [...room.players.values()].find((entry) => entry.seat === seat)
      if (player) {
        player.timeoutStreak += 1
        if (player.timeoutStreak >= 3) {
          player.autoFold = true
          player.sittingOut = true
        }
      }
    }
    const outcome = forceTimeout(hand, now)
    if (!outcome) return
    if (hand.completed) this.finalizeHand(room, now)
    else this.publish(room)
  }

  /** 本机地址兜底（拿不到局域网 IP 时用）。 */
  private joinUrlFor(room: LiveRoom, token: string): string {
    return `${this.origin()}${this.config.routePrefix}/play?code=${room.roomCode}&invite=${encodeURIComponent(token)}&role=auto`
  }

  /** 同一局域网可直连的邀请链接；需要局域网代理在跑、而且拿得到网卡地址。 */
  private lanJoinUrl(room: LiveRoom): string {
    if (this.lanPort <= 0) return ''
    const ip = this.lanIp()
    if (!ip) return ''
    return `http://${ip}:${this.lanPort}${this.config.routePrefix}/play?code=${room.roomCode}&invite=${encodeURIComponent(room.sitToken)}&role=auto`
  }

  // ---------------------------------------------------------------- 内部：视图

  private project(room: LiveRoom, playerId: PlayerId): PlayerView {
    const you = room.players.get(playerId)
    if (!you) throw new CommandError('auth', '不在这个房间里')
    const hand = room.hand
    const seats: SeatView[] = []
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      const handPlayer = hand?.players.find((entry) => entry.seat === seat)
      const live = [...room.players.values()].find((entry) => entry.seat === seat)
      if (!handPlayer && !live) {
        seats.push({
          seat,
          playerId: null,
          displayName: null,
          ready: false,
          connected: false,
          sittingOut: false,
          autoFold: false,
          host: false,
          stack: 0,
          committed: 0,
          handNet: 0,
          folded: false,
          allIn: false,
          lastAction: null,
          holeCount: 0,
        })
        continue
      }
      const holder = handPlayer?.playerId ?? live!.playerId
      const delta = room.lastHand?.deltas.find((entry) => entry.seat === seat)
      seats.push({
        seat,
        playerId: holder,
        displayName: handPlayer?.displayName ?? live!.displayName,
        ready: live?.ready ?? false,
        connected: live?.connected ?? handPlayer !== undefined,
        sittingOut: live?.sittingOut ?? false,
        autoFold: live?.autoFold ?? false,
        host: holder === room.hostPlayerId,
        stack: handPlayer ? handPlayer.stack : room.settings.buyIn,
        committed: handPlayer ? handPlayer.streetCommitted : 0,
        handNet: delta?.net ?? 0,
        folded: handPlayer?.folded ?? false,
        allIn: handPlayer?.allIn ?? false,
        lastAction: handPlayer?.lastAction ?? null,
        holeCount: handPlayer ? handPlayer.hole.length : 0,
      })
    }

    const stats = room.stats.get(playerId)
    const ownHandPlayer = hand?.players.find((entry) => entry.playerId === playerId)
    const legal = hand && !hand.completed && you.seat !== null ? legalForSeat(hand, you.seat) : null

    const roomView: RoomView = {
      roomId: room.roomId,
      roomCode: room.roomCode,
      title: room.title,
      hostPlayerId: room.hostPlayerId,
      hostDisplayName: room.players.get(room.hostPlayerId)?.displayName ?? '房主',
      phase: room.phase,
      settings: room.settings,
      seats,
      handNo: room.handNo,
      createdAt: new Date(room.createdAt).toISOString(),
      nextHandAt: room.handOverAt === null ? null : new Date(room.handOverAt).toISOString(),
      seq: room.seq,
      joinUrl: this.lanJoinUrl(room) || this.joinUrlFor(room, room.sitToken),
      lanUrl: this.lanJoinUrl(room),
    }

    const leaderboard: LeaderboardEntry[] = [...room.stats.entries()]
      .map(([entryId, entry]) => ({
        playerId: entryId,
        displayName: entry.displayName,
        seat: room.players.get(entryId)?.seat ?? entry.seat,
        handsPlayed: entry.handsPlayed,
        handsWon: entry.handsWon,
        netChips: entry.netChips,
        biggestWin: entry.biggestWin,
        showdownsWon: entry.showdownsWon,
        showdownsPlayed: entry.showdownsPlayed,
      }))
      .sort((a, b) => (b.netChips - a.netChips) || (b.handsWon - a.handsWon))

    return {
      room: roomView,
      you: {
        playerId,
        displayName: you.displayName,
        seat: you.seat,
        spectator: you.seat === null,
        ready: you.ready,
        sittingOut: you.sittingOut,
        holeCards: ownHandPlayer ? [...ownHandPlayer.hole] : [],
        legal,
        canAct: legal !== null,
        netChips: stats?.netChips ?? 0,
        handsPlayed: stats?.handsPlayed ?? 0,
      },
      hand: hand ? handView(hand) : null,
      lastHand: room.lastHand,
      leaderboard,
      settlement: room.summary,
      chat: room.chat.slice(-40),
      spectators: [...room.players.values()]
        .filter((player) => player.seat === null)
        .map((player) => ({ playerId: player.playerId, displayName: player.displayName })),
      serverNow: nowIso(),
    }
  }

  // ---------------------------------------------------------------- 内部：玩家

  private addPlayer(room: LiveRoom, displayName: string, seat: number | null, browserId: string): LivePlayer {
    const player: LivePlayer = {
      playerId: asPlayerId(newId('p')),
      displayName,
      seat,
      ready: false,
      connected: true,
      socketOpen: false,
      lastSeenAt: this.now(),
      sittingOut: false,
      autoFold: false,
      timeoutStreak: 0,
      browserId,
      joinedAt: this.now(),
      leaving: false,
    }
    room.players.set(player.playerId, player)
    if (browserId) room.browsers.set(browserId, player.playerId)
    this.ensureStats(room, player.playerId, displayName, seat)
    return player
  }

  private removePlayer(room: LiveRoom, playerId: PlayerId): void {
    const player = room.players.get(playerId)
    if (!player) return
    room.players.delete(playerId)
    if (player.browserId && room.browsers.get(player.browserId) === playerId) room.browsers.delete(player.browserId)
    this.dropSessionsOf(room, playerId)
  }

  private ensureStats(room: LiveRoom, playerId: PlayerId, displayName: string, seat: number | null): Stats {
    let stats = room.stats.get(playerId)
    if (!stats) {
      stats = {
        displayName,
        seat,
        handsPlayed: 0,
        handsWon: 0,
        netChips: 0,
        biggestWin: 0,
        showdownsWon: 0,
        showdownsPlayed: 0,
      }
      room.stats.set(playerId, stats)
    }
    return stats
  }

  private pushChat(room: LiveRoom, player: LivePlayer | null, text: string): void {
    room.chat.push({
      playerId: player?.playerId ?? asPlayerId('system'),
      displayName: player?.displayName ?? '桌子',
      text,
      ts: nowIso(),
    })
    if (room.chat.length > MAX_CHAT_LINES) room.chat.splice(0, room.chat.length - MAX_CHAT_LINES)
  }

  private newSession(room: LiveRoom, playerId: PlayerId, kind: Session['kind']): Session {
    const session: Session = {
      token: newToken(),
      playerId,
      roomId: room.roomId,
      kind,
      createdAt: this.now(),
      expiresAt: this.now() + SESSION_TTL_MS,
    }
    this.sessions.set(session.token, session)
    return session
  }

  private dropSessionsOf(room: LiveRoom, playerId: PlayerId): void {
    for (const [token, session] of this.sessions) {
      if (session.playerId === playerId && session.roomId === room.roomId) this.sessions.delete(token)
    }
  }

  private cleanupSessions(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token)
    }
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(ticket)
    }
    for (const [playerId, entry] of this.actionRate) {
      if (entry.resetAt <= now) this.actionRate.delete(playerId)
    }
  }

  /** 每玩家 10 秒最多 30 条命令；chat 另有 1.2 秒冷却。 */
  private allowAction(playerId: PlayerId): boolean {
    const now = this.now()
    const entry = this.actionRate.get(playerId)
    if (!entry || now >= entry.resetAt) {
      this.actionRate.set(playerId, { count: 1, resetAt: now + ACTION_RATE_WINDOW_MS })
      return true
    }
    if (entry.count >= ACTION_RATE_MAX) return false
    entry.count += 1
    return true
  }

  private existingPlayer(room: LiveRoom, input: PeekInput): LivePlayer | null {
    const session = this.sessionFromCookies(input.cookies, room.roomId)
    if (session) {
      const player = room.players.get(session.playerId)
      if (player && !player.leaving) return player
    }
    if (input.browserId) {
      const playerId = room.browsers.get(input.browserId)
      if (playerId) {
        const player = room.players.get(playerId)
        if (player && !player.leaving) return player
      }
    }
    return null
  }

  private checkInvite(
    room: LiveRoom,
    input: PeekInput,
    role: 'sit' | 'watch',
    local: boolean,
  ): { allowed: boolean; sit: boolean } {
    if (local) return { allowed: true, sit: true }
    const token = input.invite ?? ''
    if (!token) return { allowed: false, sit: false }
    const sit = hashEquals(room.sitHash, hashInvite(room.secret, 'sit', token))
    const watch = hashEquals(room.watchHash, hashInvite(room.secret, 'watch', token))
    if (role === 'sit') return { allowed: sit || watch, sit }
    return { allowed: watch || sit, sit }
  }

  private requireHost(room: LiveRoom, playerId: PlayerId): void {
    if (room.hostPlayerId !== playerId) throw new CommandError('host-only', '只有房主能这么做')
  }

  private roomByCode(code: string): LiveRoom {
    const room = this.roomsByCode.get(String(code ?? '').trim())
    if (!room) throw new CommandError('room-not-found', '房号不存在或房间已关闭')
    if (room.phase === 'closed') throw new CommandError('expired', '房间已解散')
    return room
  }

  private roomOf(playerId: PlayerId): LiveRoom | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.has(playerId)) return room
    }
    return undefined
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = newRoomCode()
      if (!this.roomsByCode.has(code)) return code
    }
    throw new CommandError('room-full', '暂时没有可用房号，请稍后再试')
  }

  private firstFreeSeat(room: LiveRoom): number {
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      if (!this.seatTaken(room, seat)) return seat
    }
    return -1
  }

  private seatTaken(room: LiveRoom, seat: number): boolean {
    return [...room.players.values()].some((player) => player.seat === seat && !player.leaving)
  }

  private nextButton(room: LiveRoom, seats: number[]): number {
    const ordered = [...seats].sort((a, b) => a - b)
    const previous = room.lastButton
    if (previous === null) return ordered[0]!
    for (const seat of ordered) if (seat > previous) return seat
    return ordered[0]!
  }

  private sendTo(playerId: PlayerId, event: ServerEvent): void {
    for (const listener of this.listeners) listener(playerId, event)
  }

  private publish(room: LiveRoom, extra?: (seq: number) => ServerEvent): void {
    room.seq += 1
    for (const player of room.players.values()) {
      const event: ServerEvent = { type: 'snapshot', seq: room.seq, view: this.project(room, player.playerId) }
      this.sendTo(player.playerId, event)
    }
    if (extra) {
      const event = extra(room.seq)
      for (const player of room.players.values()) this.sendTo(player.playerId, event)
    }
  }

  private dropRoom(room: LiveRoom): void {
    this.rooms.delete(room.roomId)
    this.roomsByCode.delete(room.roomCode)
  }
}
