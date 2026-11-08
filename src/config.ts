import z from '@deepseek-ai/schemastery'
import {
  BLIND_LEVELS,
  DEFAULT_LAN_PORT,
  DEFAULT_MAX_SPECTATORS,
  MAX_ROOMS,
  MAX_SEATS,
  ROUTE_PREFIX,
  SPECTATORS_LIMIT,
  type BlindLevelId,
  blindsFor,
  buyInFor,
} from './invariant.ts'

export interface PluginConfig {
  enabled?: boolean
  defaultBlindLevel?: string
  /** 每个行动时限，秒。 */
  turnTimeoutSec?: number
  /** 一手结束后自动开下一手的等待，秒。 */
  autoAdvanceSec?: number
  allowSpectators?: boolean
  /** 每个房间的观战席位上限；0 等于关闭观战。 */
  maxSpectators?: number
  chatEnabled?: boolean
  maxRooms?: number
  /** 房主失联多久后自动解散并结算，分钟。 */
  hostIdleDissolveMin?: number
  /** 局域网代理端口；固定端口便于防火墙放行。 */
  lanPort?: number
  routePrefix?: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  defaultBlindLevel: z.string().default('25/50'),
  turnTimeoutSec: z.number().default(30).min(15).max(90),
  autoAdvanceSec: z.number().default(6).min(2).max(30),
  allowSpectators: z.boolean().default(true),
  maxSpectators: z.number().default(DEFAULT_MAX_SPECTATORS).min(0).max(SPECTATORS_LIMIT),
  chatEnabled: z.boolean().default(true),
  maxRooms: z.number().default(MAX_ROOMS).min(1).max(64),
  hostIdleDissolveMin: z.number().default(10).min(1).max(120),
  lanPort: z.number().default(DEFAULT_LAN_PORT).min(1024).max(65535),
  routePrefix: z.string().default(ROUTE_PREFIX),
})

export interface ResolvedConfig {
  enabled: boolean
  blindLevel: BlindLevelId
  sb: number
  bb: number
  buyIn: number
  turnTimeoutMs: number
  autoAdvanceMs: number
  allowSpectators: boolean
  /** 观战席位上限；0 表示这桌不接观战。 */
  maxSpectators: number
  chatEnabled: boolean
  maxRooms: number
  hostIdleDissolveMs: number
  lanPort: number
  routePrefix: string
}

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (trimmed === '') return ROUTE_PREFIX
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+$/, '') || ROUTE_PREFIX
}

export function resolveConfig(config: PluginConfig): ResolvedConfig {
  const blindId = (config.defaultBlindLevel ?? '25/50') as BlindLevelId
  const known = BLIND_LEVELS.some((level) => level.id === blindId)
  const blinds = blindsFor(known ? blindId : '25/50')
  const turnTimeoutSec = clamp(config.turnTimeoutSec ?? 30, 15, 90)
  const autoAdvanceSec = clamp(config.autoAdvanceSec ?? 6, 2, 30)
  return {
    enabled: config.enabled !== false,
    blindLevel: blinds.id,
    sb: blinds.sb,
    bb: blinds.bb,
    buyIn: buyInFor(blinds.bb),
    turnTimeoutMs: turnTimeoutSec * 1000,
    autoAdvanceMs: autoAdvanceSec * 1000,
    allowSpectators: config.allowSpectators !== false,
    maxSpectators: clamp(Math.trunc(config.maxSpectators ?? DEFAULT_MAX_SPECTATORS), 0, SPECTATORS_LIMIT),
    chatEnabled: config.chatEnabled !== false,
    maxRooms: clamp(Math.trunc(config.maxRooms ?? MAX_ROOMS), 1, 64),
    hostIdleDissolveMs: clamp(config.hostIdleDissolveMin ?? 10, 1, 120) * 60_000,
    lanPort: clamp(Math.trunc(config.lanPort ?? DEFAULT_LAN_PORT), 1024, 65535),
    routePrefix: normalizePrefix(config.routePrefix ?? ROUTE_PREFIX),
  }
}

export const MAX_TABLE_SEATS = MAX_SEATS

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
