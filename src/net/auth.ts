import type { IncomingMessage } from 'node:http'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 局域网代理加的内部标记：客户端传入的同名头会被代理先删除。 */
export const PROXY_HEADER = 'x-holdem-proxy'
export const PROXY_HEADER_VALUE = '1'

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function hostnameOf(hostHeader: string | undefined): string {
  const value = (hostHeader ?? '').trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end >= 0 ? value.slice(0, end + 1) : value
  }
  return value.split(':')[0] ?? ''
}

/**
 * 是否来自本机。
 *
 * 必须同时满足：Host 是回环地址、TCP 对端也是回环地址、且请求不是经局域网代理转发。
 * 只看 Host 会被 `Host: 127.0.0.1` 伪造；只看 remoteAddress 会把经代理的局域网请求
 * 误判成本机（代理到上游的连接来自 127.0.0.1）。
 */
export function isLoopbackHost(
  hostHeader: string | undefined,
  remoteAddress: string | undefined,
  proxied = false,
): boolean {
  if (proxied) return false
  const host = hostnameOf(hostHeader)
  const remote = (remoteAddress ?? '').replace(/^::ffff:/, '')
  return LOOPBACK_HOSTS.has(host) && LOOPBACK_REMOTES.has(remote)
}

export function isProxiedRequest(req: IncomingMessage): boolean {
  return header(req, PROXY_HEADER) === PROXY_HEADER_VALUE
}

export function isLocalRequest(req: IncomingMessage): boolean {
  return isLoopbackHost(header(req, 'host'), req.socket.remoteAddress, isProxiedRequest(req))
}

/** 私有网段（局域网直连）也放行：同 Wi-Fi 的朋友用 http://192.168.x.x:端口 进来。 */
export function isPrivateOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname
    return host.startsWith('10.')
      || host.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  } catch {
    return false
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

export function requestOrigin(req: IncomingMessage): string | null {
  const origin = header(req, 'origin')
  if (origin) {
    try {
      return new URL(origin).origin
    } catch {
      return null
    }
  }
  const referer = header(req, 'referer')
  if (referer) {
    try {
      return new URL(referer).origin
    } catch {
      return null
    }
  }
  return null
}

export function originAllowed(origin: string | null, browser: boolean): boolean {
  if (!origin) return !browser
  return isLoopbackOrigin(origin) || isPrivateOrigin(origin)
}

export function isBrowserRequest(req: IncomingMessage): boolean {
  return Boolean(header(req, 'origin') || header(req, 'sec-fetch-site'))
}

export function assertOrigin(req: IncomingMessage): void {
  if (header(req, 'sec-fetch-site') === 'cross-site') {
    throw Object.assign(new Error('cross-site forbidden'), { status: 403, code: 'auth' })
  }
  if (!originAllowed(requestOrigin(req), isBrowserRequest(req))) {
    throw Object.assign(new Error('origin not allowed'), { status: 403, code: 'auth' })
  }
}

/** 变更请求必须带 JSON 与自定义请求头（跨源页面设不了后者）。 */
export function assertMutatingHeaders(req: IncomingMessage): void {
  if (header(req, 'x-requested-with') === '@zhuweiyou/dsh-holdem') return
  const contentType = header(req, 'content-type') ?? ''
  if (contentType.includes('application/json') && header(req, 'x-requested-with')) return
  throw Object.assign(new Error('missing csrf header'), { status: 403, code: 'auth' })
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = header(req, 'cookie') ?? ''
  const out: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) {
      try {
        out[key] = decodeURIComponent(value)
      } catch {
        out[key] = value
      }
    }
  }
  return out
}

export function cookieHeader(
  name: string,
  value: string,
  options: { secure: boolean; sameSite: 'Lax' | 'Strict'; maxAge?: number; path: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    'HttpOnly',
    `SameSite=${options.sameSite}`,
    `Max-Age=${options.maxAge ?? 86400}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}
