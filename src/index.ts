import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type PluginConfig } from './config.ts'
import { PACKAGE_NAME } from './invariant.ts'
import { registerHoldemHttp } from './net/routes.ts'
import { registerHoldemSocket } from './net/ws.ts'
import { CloudflareDeployer } from './net/cloudflare.ts'
import { startLanProxy, type LanProxy } from './net/lan-proxy.ts'
import { firstLanIPv4 } from './net/network.ts'
import { createFileStore } from './persist/store.ts'
import { RoomManager } from './room/RoomManager.ts'

export const name = PACKAGE_NAME
export const inject = ['webServer']
export { Config }

export function apply(ctx: Context, config: PluginConfig): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const manager = new RoomManager({
    config: resolved,
    origin: () => {
      try {
        return ctx.webServer.getOrigin()
      } catch {
        return `http://127.0.0.1:${ctx.webServer.port}`
      }
    },
    store: createFileStore(),
    lanIp: firstLanIPv4,
    log: (message) => ctx.logger?.warn?.(`holdem: ${message}`),
  })

  const cloudflare = new CloudflareDeployer()

  ctx.effect(() => {
    let lanProxy: LanProxy | null = null
    void startLanProxy({
      targetPort: ctx.webServer.port,
      prefix: resolved.routePrefix,
      port: resolved.lanPort,
      log: (message) => ctx.logger?.info?.(message),
    }).then((started) => {
      lanProxy = started
      if (started) manager.setLanPort(started.port)
    }).catch((error: unknown) => {
      ctx.logger?.warn?.(`holdem: 局域网代理启动失败：${error instanceof Error ? error.message : String(error)}`)
    })

    const stopTick = manager.start()
    const disposeHttp = registerHoldemHttp(ctx.webServer, manager, cloudflare)
    const disposeWs = registerHoldemSocket(ctx.webServer, manager)
    return () => {
      stopTick()
      disposeHttp()
      disposeWs()
      lanProxy?.dispose()
      cloudflare.dispose()
      void manager.dispose()
    }
  }, 'holdem: room routes')

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt?.section({
      name: 'plugin:@zhuweiyou/dsh-holdem',
      order: 200,
      text: [
        '本机已安装 @zhuweiyou/dsh-holdem（德州扑克）。',
        '开房与打牌都在侧栏的「德州扑克」面板里；牌桌可以跑在本机（局域网分享），也可以跑在 Cloudflare Worker 上（公网分享）。',
        '结算是本地娱乐筹码，不是 DeepSeek 余额；加入只需要房主发来的邀请链接。',
      ].join(''),
    })
  })
}
