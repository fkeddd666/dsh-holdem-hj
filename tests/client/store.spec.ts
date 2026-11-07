import { afterEach, describe, expect, it, vi } from 'vitest'
import { getApiBase, setApiBase } from '../../src/client/api.ts'
import { bootstrap, dispose, getState } from '../../src/client/store.ts'

function stubSession(inRoom: boolean): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    calls.push(String(input))
    return new Response(JSON.stringify(inRoom ? { inRoom: false } : { inRoom: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

afterEach(() => {
  dispose()
  setApiBase('')
  vi.unstubAllGlobals()
})

describe('客户端 store 生命周期', () => {
  it('dispose 之后重新挂载会重新拉会话（插件热重载不会卡在旧状态）', async () => {
    const calls = stubSession(false)
    await bootstrap()
    expect(getState().booted).toBe(true)
    expect(calls.length).toBe(1)

    dispose()
    expect(getState().booted).toBe(false)
    expect(getState().view).toBe(null)

    await bootstrap()
    expect(getState().booted).toBe(true)
    expect(calls.length).toBe(2)
  })

  it('没在房间里时把后端指回本机（创建过 Cloudflare 房间再回来）', async () => {
    stubSession(false)
    setApiBase('https://dsh-holdem.example.workers.dev')

    await bootstrap()

    expect(getState().view).toBe(null)
    expect(getApiBase()).toBe('')
  })

  it('只把当前后端的座位 token 放进请求头', async () => {
    const store = new Map<string, string>()
    store.set('holdem:seats', JSON.stringify({
      '': { localRoom: 'local-token' },
      'https://evil.example': { evilRoom: 'evil-token' },
    }))
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => store.clear(),
      key: () => null,
      get length() { return store.size },
    } as Storage)

    const headers: Record<string, string>[] = []
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      headers.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ inRoom: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    setApiBase('')
    await bootstrap()
    expect(headers[0]?.['x-holdem-seat']).toBe('local-token')

    dispose()
    setApiBase('https://evil.example')
    await bootstrap()
    const remote = headers.at(-1)
    expect(remote?.['x-holdem-seat']).toBe('evil-token')
    expect(remote?.['x-holdem-seat']).not.toContain('local-token')
  })
})
