const BROWSER_KEY = 'dsh-holdem.browser'
const NAME_KEY = 'dsh-holdem.name'
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/

let cached = ''

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** browserId 只用于“同一浏览器已在本房间”去重，不参与授权；优先 CSPRNG。 */
function randomBrowserId(): string {
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID()
  if (cryptoObject?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObject.getRandomValues(bytes)
    let out = 'b'
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
    return out
  }
  return `b${Date.now().toString(36)}`
}

/** 同一浏览器（同源）稳定 id，用于「这个浏览器已经在这个房间里」判定。 */
export function browserId(): string {
  if (cached) return cached
  const store = storage()
  if (!store) return ''
  try {
    const existing = store.getItem(BROWSER_KEY)
    if (existing && ID_RE.test(existing)) {
      cached = existing
      return cached
    }
    const next = randomBrowserId()
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 64)
    if (!ID_RE.test(next)) return ''
    store.setItem(BROWSER_KEY, next)
    cached = next
    return cached
  } catch {
    return ''
  }
}

export function rememberedName(): string {
  try {
    return storage()?.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function rememberName(name: string): void {
  try {
    storage()?.setItem(NAME_KEY, name)
  } catch {
    // ignore
  }
}

export interface DeepLink {
  code: string
  invite: string
  role: 'sit' | 'watch'
}

/** 读取 `/?dsh-panel=holdem&code=...&invite=...&role=...`（也兼容 hash 内的查询串）。 */
export function parseDeepLink(): DeepLink | null {
  if (typeof location === 'undefined') return null
  const search = new URLSearchParams(location.search)
  const hash = location.hash.includes('?') ? new URLSearchParams(location.hash.slice(location.hash.indexOf('?') + 1)) : null
  const code = search.get('code') ?? hash?.get('code') ?? ''
  const panel = search.get('dsh-panel') ?? hash?.get('dsh-panel') ?? ''
  if (!code || (panel !== 'holdem' && !search.has('code'))) return null
  return {
    code: code.replace(/\D/g, '').slice(0, 6),
    invite: search.get('invite') ?? hash?.get('invite') ?? '',
    role: (search.get('role') ?? hash?.get('role')) === 'watch' ? 'watch' : 'sit',
  }
}

export function clearDeepLink(): void {
  try {
    const url = new URL(location.href)
    for (const key of ['code', 'invite', 'role', 'dsh-panel']) url.searchParams.delete(key)
    const query = url.searchParams.toString()
    history.replaceState(null, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash.includes('dsh-panel') ? '#/' : url.hash}`)
  } catch {
    // ignore
  }
}
