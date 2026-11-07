import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WebServer } from '@deepseek-ai/cordis'
import { resolveConfig } from '../../src/config.ts'
import { RoomManager } from '../../src/room/RoomManager.ts'
import { registerHoldemHttp } from '../../src/net/routes.ts'
import { startLanProxy, type LanProxy } from '../../src/net/lan-proxy.ts'
import { isLoopbackHost, isPrivateOrigin } from '../../src/net/auth.ts'
import { noopStore } from '../../src/persist/store.ts'

const prefix = '/holdem'
let target: Server
let targetPort = 0
let proxy: LanProxy | null = null
let manager: RoomManager

beforeAll(async () => {
  manager = new RoomManager({
    config: resolveConfig({ defaultBlindLevel: '25/50' }),
    origin: () => `http://127.0.0.1:${targetPort}`,
    now: Date.now,
    store: noopStore,
    lanIp: () => '192.168.0.103',
  })
  const routes: { path: string; handler: (req: unknown, res: unknown) => unknown }[] = []
  const fake: WebServer = {
    host: '127.0.0.1',
    port: 0,
    getOrigin: () => `http://127.0.0.1:${targetPort}`,
    register(route) {
      routes.push(route as never)
      return () => undefined
    },
    registerUpgrade() {
      return () => undefined
    },
    registerFallback() {
      return () => undefined
    },
  } as unknown as WebServer
  registerHoldemHttp(fake, manager)
  target = createServer((req, res) => {
    const route = routes.find((entry) => (req.url ?? '').startsWith(entry.path))
    if (!route) {
      res.statusCode = 404
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()))
  const address = target.address()
  targetPort = typeof address === 'object' && address ? address.port : 0

  proxy = await startLanProxy({ targetPort, prefix })
  if (proxy) manager.setLanPort(proxy.port)
})

afterAll(async () => {
  proxy?.dispose()
  await new Promise<void>((resolve) => target.close(() => resolve()))
})

describe('局域网小代理', () => {
  it('代理起来后能把插件路由转发出去，其它路径一律 404', async () => {
    expect(proxy).not.toBeNull()
    const base = `http://127.0.0.1:${proxy!.port}`

    const ready = await fetch(`${base}${prefix}/api/ready`)
    expect(ready.status).toBe(200)
    expect(((await ready.json()) as { plugin: string }).plugin).toBe('@zhuweiyou/dsh-holdem')

    const play = await fetch(`${base}${prefix}/play?code=123456&invite=x&role=auto`)
    expect(play.status).toBe(200)
    expect(await play.text()).toContain('进入牌桌')

    const outside = await fetch(`${base}/nothing-here`)
    expect(outside.status).toBe(404)
  })

  it('房间视图带局域网链接，且从「私有网段 origin」能入座', async () => {
    const created = manager.createRoom({ displayName: '房主' })
    const lanUrl = manager.view(created.roomId, created.hostPlayerId).room.lanUrl
    expect(lanUrl.startsWith('http://')).toBe(true)
    expect(lanUrl).toContain(`:${proxy!.port}${prefix}/play`)
    expect(lanUrl).toContain(`code=${created.roomCode}`)

    // 模拟局域网朋友：Origin 是 192.168.x.x，并且走代理端口
    const invite = new URL(lanUrl).searchParams.get('invite') ?? ''
    const joined = await fetch(`http://127.0.0.1:${proxy!.port}${prefix}/api/join`, {
      method: 'POST',
      headers: {
        origin: `http://192.168.0.103:${proxy!.port}`,
        'content-type': 'application/json',
        'x-requested-with': '@zhuweiyou/dsh-holdem',
      },
      body: JSON.stringify({ roomCode: created.roomCode, invite, displayName: '局域网小伙伴', role: 'sit' }),
    })
    expect(joined.status).toBe(200)
    const body = (await joined.json()) as { seat: number | null; sessionToken: string }
    expect(body.seat).toBe(1)
    expect(body.sessionToken.length).toBeGreaterThan(10)
  })

  it('局域网来源不算本机：建房 / 部署 Cloudflare 这类操作会被挡住', () => {
    // Host 和 TCP 对端都必须是回环；代理连接来自 127.0.0.1，所以额外标记 proxied。
    expect(isLoopbackHost('192.168.0.103:64670', '192.168.0.103')).toBe(false)
    expect(isLoopbackHost('127.0.0.1:64670', '127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.1:64670', '127.0.0.1', true)).toBe(false)
    // 私有网段允许当作合法 Origin（朋友能加入房间），但不等于本机权限
    expect(isPrivateOrigin('http://192.168.0.103:64670')).toBe(true)
    expect(isPrivateOrigin('http://example.com')).toBe(false)
  })

  it('经代理的局域网请求不能建房，也不能无邀请入座', async () => {
    const base = `http://127.0.0.1:${proxy!.port}`
    const headers = {
      origin: `http://192.168.0.103:${proxy!.port}`,
      'content-type': 'application/json',
      'x-requested-with': '@zhuweiyou/dsh-holdem',
    }
    const create = await fetch(`${base}${prefix}/api/rooms`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ displayName: 'LAN attacker' }),
    })
    expect(create.status).toBe(403)

    const host = manager.createRoom({ displayName: '房主' })
    const join = await fetch(`${base}${prefix}/api/join`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ roomCode: host.roomCode, displayName: '无邀请' }),
    })
    expect(join.status).not.toBe(200)
    expect([403, 404]).toContain(join.status)
  })
})
