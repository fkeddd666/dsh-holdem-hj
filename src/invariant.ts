/** 全局常量：协议、上限、时间与筹码档位。 */

export const PACKAGE_NAME = '@zhuweiyou/dsh-holdem'
export const CLIENT_ID = '@zhuweiyou/dsh-holdem'
export const PANEL_KEY = 'holdem'
export const SUBPROTOCOL = 'holdem.v1'
export const ROUTE_PREFIX = '/holdem'
/** 局域网代理默认端口：固定端口便于在 Windows 防火墙里只放行一次。 */
export const DEFAULT_LAN_PORT = 45567

export const MAX_SEATS = 6
/** 观战席位默认值；实际值由设置项 maxSpectators 决定。 */
export const DEFAULT_MAX_SPECTATORS = 16
/** 设置项 maxSpectators 能配到的最大值。 */
export const SPECTATORS_LIMIT = 64
export const MAX_ROOMS = 8
export const MAX_TITLE = 24
export const MAX_DISPLAY_NAME = 16
export const MAX_CHAT = 80
export const MAX_CHAT_LINES = 80
export const MAX_HISTORY_HANDS = 50
export const MAX_CACHED_ACTIONS = 64
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_FRAME_BYTES = 64 * 1024

export const TICK_MS = 250
export const WS_TICKET_TTL_MS = 60_000
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const HEARTBEAT_MS = 15_000
export const DISCONNECT_AFTER_MS = 45_000
/** 没有实时通道时，HTTP 请求也算「人在」：这么久没动静才标成离线。 */
export const PRESENCE_TTL_MS = 20_000
export const LOBBY_KICK_IDLE_MS = 10 * 60 * 1000
export const CHAT_COOLDOWN_MS = 1200
export const ACTION_RATE_WINDOW_MS = 10_000
export const ACTION_RATE_MAX = 30

export const BUY_IN_BB = 100
export const ALL_IN_RUNOUT_MS = 1200
export const HAND_OVER_MIN_MS = 2500

export const BLIND_LEVELS = [
  { id: '10/20', sb: 10, bb: 20 },
  { id: '25/50', sb: 25, bb: 50 },
  { id: '100/200', sb: 100, bb: 200 },
] as const

export type BlindLevelId = (typeof BLIND_LEVELS)[number]['id']

export function blindsFor(id: string): { id: BlindLevelId; sb: number; bb: number } {
  const found = BLIND_LEVELS.find((level) => level.id === id)
  const level = found ?? BLIND_LEVELS[1]!
  return { id: level.id, sb: level.sb, bb: level.bb }
}

export function buyInFor(bb: number): number {
  return bb * BUY_IN_BB
}
