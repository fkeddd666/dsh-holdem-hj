import {
  request as httpRequest,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import net from 'node:net'
import { PROXY_HEADER, PROXY_HEADER_VALUE } from './auth.ts'

/**
 * 标记请求来自局域网代理，并删掉客户端自己传入的同名头。
 *
 * 上游只看 remoteAddress 的话，代理连接永远来自 127.0.0.1，会把局域网用户误判成本机。
 */
function proxiedHeaders(req: IncomingMessage): IncomingHttpHeaders {
  const headers = { ...req.headers }
  delete headers[PROXY_HEADER]
  headers[PROXY_HEADER] = PROXY_HEADER_VALUE
  return headers
}

/**
 * DSH 的 Web 服务只监听 127.0.0.1，同 Wi-Fi 的朋友连不上。
 * 这里起一个只转发 `/holdem/*`（HTTP + WS）的小代理，绑到 0.0.0.0，
 * 用它的端口生成「局域网邀请链接」。
 */
export interface LanProxy {
  port: number
  dispose(): void
}

export interface LanProxyOptions {
  targetPort: number
  prefix: string
  /** 期望端口；被占用就交给系统分配。 */
  port?: number
  log?: (message: string) => void
}

export function startLanProxy(options: LanProxyOptions): Promise<LanProxy | null> {
  const prefix = options.prefix
  const target = { host: '127.0.0.1', port: options.targetPort }
  const log = options.log

  const forward = (req: IncomingMessage, res: ServerResponse): void => {
    const upstream = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: proxiedHeaders(req),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('upstream unavailable')
    })
    req.pipe(upstream)
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    forward(req, res)
  })

  // WebSocket：把 upgrade 也原样转到本地端口
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      socket.destroy()
      return
    }
    const upstream = net.connect(target.port, target.host, () => {
      const lines = [`GET ${req.url} HTTP/1.1`]
      const headers = proxiedHeaders(req)
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else if (value !== undefined) lines.push(`${key}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  return new Promise((resolve) => {
    const fallback = (): void => {
      // 指定端口被占用时让系统挑一个
      if (options.port !== undefined) {
        const retry = createRetry()
        retry()
        return
      }
      resolve(null)
    }
    const createRetry = () => () => {
      server.removeAllListeners('error')
      server.once('error', () => resolve(null))
      server.listen(0, '0.0.0.0', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        if (port <= 0) {
          resolve(null)
          return
        }
        log?.(`局域网分享已开启：http://0.0.0.0:${port}${prefix}`)
        resolve({ port, dispose: () => server.close() })
      })
    }
    server.once('error', fallback)
    server.listen(options.port ?? 0, '0.0.0.0', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      if (port <= 0) {
        resolve(null)
        return
      }
      log?.(`局域网分享已开启：端口 ${port}${prefix}`)
      resolve({ port, dispose: () => server.close() })
    })
  })
}
