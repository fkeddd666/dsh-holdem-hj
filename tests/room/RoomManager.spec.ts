import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.ts'
import { PRESENCE_TTL_MS } from '../../src/invariant.ts'
import { RoomManager, StaleCommandError } from '../../src/room/RoomManager.ts'
import { noopStore } from '../../src/persist/store.ts'
import type { ClientCommand, PlayerId, PlayerView, RoomId } from '../../src/types.ts'

class FakeClock {
  t = 1_700_000_000_000
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

function setup(options: { turnTimeoutSec?: number; autoAdvanceSec?: number; maxSpectators?: number } = {}) {
  const clock = new FakeClock()
  const manager = new RoomManager({
    config: resolveConfig({
      defaultBlindLevel: '25/50',
      turnTimeoutSec: options.turnTimeoutSec ?? 30,
      autoAdvanceSec: options.autoAdvanceSec ?? 2,
      maxSpectators: options.maxSpectators,
      hostIdleDissolveMin: 10,
    }),
    origin: () => 'http://127.0.0.1:49923',
    now: clock.now,
    store: noopStore,
  })
  return { manager, clock }
}

function send(manager: RoomManager, view: PlayerView, command: ClientCommand, actionId?: string) {
  return manager.command(view.room.roomId, view.you.playerId, command, view.room.seq, actionId)
}

describe('房间与入座', () => {
  it('6 人坐满后第 7 人自动观战', () => {
    const { manager } = setup()
    const host = manager.createRoom({ title: '测试桌', displayName: '房主' })
    expect(host.view.room.seats[0]!.displayName).toBe('房主')

    for (let i = 1; i < 6; i += 1) {
      manager.join({ roomCode: host.roomCode, role: 'sit', displayName: `玩家${i}`, local: true })
    }
    const preview = manager.peek({ roomCode: host.roomCode, local: true })
    expect(preview.seated).toBe(6)
    expect(preview.canSit).toBe(false)

    const spectator = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '旁观', local: true })
    expect(spectator.seat).toBeNull()
    expect(spectator.view.you.spectator).toBe(true)
    expect(spectator.view.spectators.map((entry) => entry.displayName)).toContain('旁观')
  })

  it('观战席位受 maxSpectators 限制，0 等于不接观战', () => {
    const { manager } = setup({ maxSpectators: 2 })
    const host = manager.createRoom({ title: '测试桌', displayName: '房主' })
    for (let i = 1; i < 6; i += 1) {
      manager.join({ roomCode: host.roomCode, role: 'sit', displayName: `玩家${i}`, local: true })
    }
    manager.join({ roomCode: host.roomCode, role: 'watch', displayName: '观众1', local: true })
    manager.join({ roomCode: host.roomCode, role: 'watch', displayName: '观众2', local: true })
    expect(manager.peek({ roomCode: host.roomCode, local: true }).spectators).toBe(2)
    expect(() =>
      manager.join({ roomCode: host.roomCode, role: 'watch', displayName: '观众3', local: true }),
    ).toThrow(/观战席已满/)

    const closed = setup({ maxSpectators: 0 }).manager
    const closedHost = closed.createRoom({ title: '满员桌', displayName: '房主' })
    for (let i = 1; i < 6; i += 1) {
      closed.join({ roomCode: closedHost.roomCode, role: 'sit', displayName: `玩家${i}`, local: true })
    }
    expect(closed.peek({ roomCode: closedHost.roomCode, local: true }).settings.maxSpectators).toBe(0)
    expect(() =>
      closed.join({ roomCode: closedHost.roomCode, role: 'watch', displayName: '观众', local: true }),
    ).toThrow(/不允许观战/)
  })

  it('同一 cookie 重连复用同一玩家', () => {
    const { manager } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const rejoined = manager.join({
      roomCode: host.roomCode,
      role: 'sit',
      displayName: '房主',
      local: true,
      cookies: [host.sessionToken],
    })
    expect(rejoined.playerId).toBe(host.hostPlayerId)
    expect(rejoined.seat).toBe(0)
  })

  it('解散后能看结算，离开后可以再开新房', () => {
    const { manager } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '客人', local: true })
    manager.command(host.roomId, host.hostPlayerId, { type: 'hostDissolve' })

    // 结算阶段会话还在
    expect(manager.sessionByToken(host.sessionToken)).toBeTruthy()
    expect(manager.view(host.roomId, host.hostPlayerId).settlement).toBeTruthy()

    // 点「返回大厅」：座位与会话清掉
    manager.leave(host.hostPlayerId)
    expect(manager.sessionByToken(host.sessionToken)).toBeUndefined()

    // 还能再开一桌
    const next = manager.createRoom({ displayName: '房主' })
    expect(next.roomCode).not.toBe(host.roomCode)
    expect(next.sessionToken).toBeTruthy()
  })

  it('房主可以踢人，被踢者收到事件', () => {
    const { manager } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const guest = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '小张', local: true })
    const events: string[] = []
    manager.onEvent((playerId, event) => {
      if (playerId === guest.playerId) events.push(event.type)
    })
    send(manager, manager.view(host.roomId, host.hostPlayerId), { type: 'hostKick', playerId: guest.playerId })
    expect(events).toContain('kicked')
    expect(manager.view(host.roomId, host.hostPlayerId).room.seats[1]!.playerId).toBeNull()
  })
})

describe('开局与行动', () => {
  it('两人准备后可开局，且不泄露对手底牌', () => {
    const { manager } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const guest = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '客人', local: true })

    send(manager, manager.view(host.roomId, host.hostPlayerId), { type: 'start' })
    const hostView = manager.view(host.roomId, host.hostPlayerId)
    const guestView = manager.view(host.roomId, guest.playerId)

    expect(hostView.room.phase).toBe('hand')
    expect(hostView.you.holeCards).toHaveLength(2)
    expect(guestView.you.holeCards).toHaveLength(2)
    expect(hostView.you.holeCards).not.toEqual(guestView.you.holeCards)

    const hostCards = new Set(hostView.you.holeCards)
    const guestSeat = hostView.room.seats.find((seat) => seat.playerId === guest.playerId)!
    expect(guestSeat.holeCount).toBe(2)

    const serialized = JSON.stringify(guestView)
    for (const card of hostCards) expect(serialized.includes(`"${card}"`)).toBe(false)
  })

  it('完整打完一手后进入 handOver 并自动开下一手', () => {
    const { manager, clock } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const guest = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '客人', local: true })
    send(manager, manager.view(host.roomId, host.hostPlayerId), { type: 'start' })

    drive(manager, host.roomId, [host.hostPlayerId, guest.playerId])
    const view = manager.view(host.roomId, host.hostPlayerId)
    expect(view.room.phase).toBe('handOver')
    expect(view.lastHand).not.toBeNull()
    expect(view.lastHand!.deltas.reduce((sum, delta) => sum + delta.net, 0)).toBe(0)

    clock.advance(3000)
    manager.tick()
    const next = manager.view(host.roomId, host.hostPlayerId)
    expect(next.room.phase).toBe('hand')
    expect(next.room.handNo).toBe(2)
  })

  it('超时自动行动并推进', () => {
    const { manager, clock } = setup({ turnTimeoutSec: 15 })
    const host = manager.createRoom({ displayName: '房主' })
    manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '客人', local: true })
    send(manager, manager.view(host.roomId, host.hostPlayerId), { type: 'start' })

    const before = manager.view(host.roomId, host.hostPlayerId)
    clock.advance(15_001)
    manager.tick()
    const after = manager.view(host.roomId, host.hostPlayerId)
    expect(after.room.seq).toBeGreaterThan(before.room.seq)
    expect(after.hand !== null && before.hand !== null).toBe(true)
  })

  it('过期 baseSeq 被拒绝，重复 actionId 幂等', () => {
    const { manager } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const guest = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '客人', local: true })
    send(manager, manager.view(host.roomId, host.hostPlayerId), { type: 'start' })

    const actor = [host.hostPlayerId, guest.playerId]
      .map((id) => manager.view(host.roomId, id))
      .find((view) => view.you.canAct)!
    expect(actor).toBeDefined()

    const command: ClientCommand = {
      type: 'action',
      action: actor.you.legal!.canCheck ? { type: 'check' } : { type: 'call' },
    }
    expect(() => manager.command(host.roomId, actor.you.playerId, command, actor.room.seq * 7))
      .toThrow(StaleCommandError)

    const first = manager.command(host.roomId, actor.you.playerId, command, actor.room.seq, 'act-1')
    const again = manager.command(host.roomId, actor.you.playerId, command, first.seq, 'act-1')
    expect(again.duplicate).toBe(true)
    expect(again.seq).toBe(first.seq)
  })

  it('房主解散后所有人都拿到结算与排名', () => {
    const { manager } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const guest = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '客人', local: true })
    send(manager, manager.view(host.roomId, host.hostPlayerId), { type: 'start' })
    drive(manager, host.roomId, [host.hostPlayerId, guest.playerId])

    let settled = 0
    manager.onEvent((_playerId, event) => {
      if (event.type === 'settled') settled += 1
    })
    send(manager, manager.view(host.roomId, host.hostPlayerId), { type: 'hostDissolve' })
    const view = manager.view(host.roomId, guest.playerId)
    expect(view.room.phase).toBe('closed')
    expect(view.settlement).not.toBeNull()
    expect(view.settlement!.players).toHaveLength(2)
    expect(view.settlement!.players[0]!.rank).toBe(1)
    expect(view.settlement!.players.reduce((sum, player) => sum + player.netChips, 0)).toBe(0)
    expect(settled).toBeGreaterThan(0)
  })
})

describe('在线状态', () => {
  /** 用房主的视角读某个座位的在线标记（读房主视图不会刷新别人的心跳）。 */
  function connectedOf(manager: RoomManager, host: { roomId: RoomId; hostPlayerId: PlayerId }, playerId: PlayerId): boolean {
    const seat = manager.view(host.roomId, host.hostPlayerId).room.seats.find((entry) => entry.playerId === playerId)
    return seat?.connected === true
  }

  it('实时通道断掉的瞬间不算离线，超过心跳窗口才算', () => {
    const { manager, clock } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const guest = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '客人', local: true })

    manager.markConnected(guest.playerId, guest.roomId, true)
    expect(connectedOf(manager, host, guest.playerId)).toBe(true)

    manager.markConnected(guest.playerId, guest.roomId, false)
    clock.advance(PRESENCE_TTL_MS / 2)
    manager.tick()
    expect(connectedOf(manager, host, guest.playerId)).toBe(true)

    clock.advance(PRESENCE_TTL_MS)
    manager.tick()
    expect(connectedOf(manager, host, guest.playerId)).toBe(false)
  })

  it('没有实时通道时，HTTP 轮询同样算在线', () => {
    const { manager, clock } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    const guest = manager.join({ roomCode: host.roomCode, role: 'sit', displayName: '轮询玩家', local: true })
    // 新玩家还没连上实时通道，先按「刚到」算在线
    manager.markConnected(guest.playerId, guest.roomId, false)
    manager.tick()
    expect(connectedOf(manager, host, guest.playerId)).toBe(true)

    // 每秒轮询一次：一直在线
    for (let i = 0; i < 10; i += 1) {
      clock.advance(1000)
      manager.view(guest.roomId, guest.playerId)
      manager.tick()
    }
    expect(connectedOf(manager, host, guest.playerId)).toBe(true)

    // 关掉标签页，没人再来取状态：窗口过后标成离线
    clock.advance(PRESENCE_TTL_MS + 1)
    manager.tick()
    expect(connectedOf(manager, host, guest.playerId)).toBe(false)

    // 回来继续轮询又能恢复在线
    manager.view(guest.roomId, guest.playerId)
    expect(connectedOf(manager, host, guest.playerId)).toBe(true)
  })

  it('单玩家命令限流：10 秒内第 31 条命令被拒绝', () => {
    const { manager } = setup()
    const host = manager.createRoom({ displayName: '房主' })
    for (let i = 0; i < 30; i += 1) {
      manager.command(host.roomId, host.hostPlayerId, { type: 'ready', ready: i % 2 === 0 })
    }
    expect(() => manager.command(host.roomId, host.hostPlayerId, { type: 'ready', ready: true }))
      .toThrow(/太频繁/)
  })
})

/** 反复用合法动作推进，直到这一手结束。 */
function drive(manager: RoomManager, roomId: RoomId, playerIds: readonly PlayerId[]): void {
  for (let step = 0; step < 300; step += 1) {
    const views = playerIds.map((id) => manager.view(roomId, id))
    if (views[0]!.room.phase !== 'hand') return
    const actor = views.find((view) => view.you.canAct)
    if (!actor) return
    const legal = actor.you.legal!
    const command: ClientCommand = {
      type: 'action',
      action: legal.canCheck ? { type: 'check' } : { type: 'call' },
    }
    manager.command(roomId, actor.you.playerId, command, actor.room.seq)
  }
  throw new Error('hand did not finish')
}
