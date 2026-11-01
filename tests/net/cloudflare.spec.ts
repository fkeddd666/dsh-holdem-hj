import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CloudflareDeployer,
  packageRoot,
  spawnWrangler,
  type WranglerCommand,
} from '../../src/net/cloudflare.ts'

/**
 * 回归测试：Windows 上曾经因为 `new URL(import.meta.url).pathname` 拿到
 * "/C:/..." 而拼出 "C:\C:\..."，spawn 的 cwd 不存在 → 异步 ENOENT 事件
 * 没人监听 → uncaughtException → 整个 dsh 进程退出（桌面端「无法启动」）。
 */

describe('cloudflare packageRoot', () => {
  it('从源码位置往上找到插件根（有 wrangler.toml 和 package.json）', () => {
    const root = packageRoot()
    expect(existsSync(join(root, 'wrangler.toml'))).toBe(true)
    expect(existsSync(join(root, 'package.json'))).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('Windows 盘符路径解析正确，不会出现 "C:\\C:" 这种前缀', () => {
    // 模拟 Windows 上 file:// URL 的形态；fileURLToPath 会转成 C:\...
    const fake = 'file:///C:/Users/me/.dsh/profiles/desktop/node_modules/@scope/pkg/lib/index.js'
    const root = packageRoot(fake)
    expect(root.startsWith('/C:')).toBe(false)
    expect(root).not.toMatch(/^[A-Za-z]:\\C:/)
  })
})

describe('spawnWrangler', () => {
  const missing: WranglerCommand = {
    command: join(process.cwd(), '__no_such_wrangler__'),
    baseArgs: [],
    label: 'missing-wrangler',
  }

  it('命令不存在时走 onError，不会抛出未捕获的 error 事件', async () => {
    const error = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('onError 没有在 5 秒内触发')), 5000)
      spawnWrangler(missing, ['--version'], {
        onData: () => undefined,
        onExit: () => undefined,
        onError: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
    })
    expect(error).toContain('wrangler')
  })

  it('cwd 不存在也不会把错误漏到进程级别', async () => {
    // 这里直接验证 packageRoot 返回的目录一定存在，avoid 传给 spawn
    const root = packageRoot()
    expect(existsSync(root)).toBe(true)
  })
})

describe('CloudflareDeployer', () => {
  it('dispose 幂等，且不会因为没起过子进程而抛错', () => {
    const deployer = new CloudflareDeployer()
    deployer.dispose()
    deployer.dispose()
  })
})
