/** HTML/JS 转义与安全响应头：Node 与 Cloudflare Workers 共用（不依赖 node: 模块）。 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

/**
 * 把值序列化成可以安全放进内联 <script> 的 JS 字面量。
 *
 * JSON.stringify 不会转义 `<`/`>`/`&`/U+2028/U+2029，直接插入会让
 * `</script>` 提前闭合脚本；这里统一转成 \uXXXX。
 */
export function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<': return '\\u003c'
      case '>': return '\\u003e'
      case '&': return '\\u0026'
      case '\u2028': return '\\u2028'
      case '\u2029': return '\\u2029'
      default: return char
    }
  })
}

interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}

function webcrypto(): RandomSource {
  return (globalThis as unknown as { crypto: RandomSource }).crypto
}

/** 16 字节 CSPRNG nonce，用于内联脚本的 CSP。 */
export function createNonce(): string {
  const bytes = new Uint8Array(16)
  webcrypto().getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function htmlSecurityHeaders(nonce: string): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  }
}

export function jsonSecurityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
}
