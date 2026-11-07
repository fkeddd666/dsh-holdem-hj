import { MAX_CHAT, MAX_DISPLAY_NAME, MAX_TITLE } from '../invariant.ts'

/** 纯 JS 的 SHA-256：Node 和 Cloudflare Workers 都能同步调用。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const bitLength = bytes.length * 8
  const withPadding = new Uint8Array((((bytes.length + 9) >> 6) + 1) << 6)
  withPadding.set(bytes)
  withPadding[bytes.length] = 0x80
  const view = new DataView(withPadding.buffer)
  view.setUint32(withPadding.length - 4, bitLength >>> 0, false)
  view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000), false)

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4, false)
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3)
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10)
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
      const ch = (e! & f!) ^ (~e! & g!)
      const temp1 = (h! + s1 + ch + K[index]! + w[index]!) >>> 0
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d! + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    hash[0] = (hash[0]! + a!) >>> 0
    hash[1] = (hash[1]! + b!) >>> 0
    hash[2] = (hash[2]! + c!) >>> 0
    hash[3] = (hash[3]! + d!) >>> 0
    hash[4] = (hash[4]! + e!) >>> 0
    hash[5] = (hash[5]! + f!) >>> 0
    hash[6] = (hash[6]! + g!) >>> 0
    hash[7] = (hash[7]! + h!) >>> 0
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('')
}

interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}

function webcrypto(): RandomSource {
  return (globalThis as unknown as { crypto: RandomSource }).crypto
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  webcrypto().getRandomValues(bytes)
  return bytes
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** [0, maxExclusive) 的无偏随机整数（拒绝采样，Node 与 Workers 通用）。 */
export function randomBelow(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error('maxExclusive must be positive')
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
  const buffer = new Uint32Array(1)
  for (;;) {
    webcrypto().getRandomValues(buffer)
    const value = buffer[0]!
    if (value < limit) return value % maxExclusive
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${toBase64Url(randomBytes(9))}`
}

/** 6 位房号，CSPRNG 且无取模偏置。 */
export function newRoomCode(): string {
  return String(randomBelow(1_000_000)).padStart(6, '0')
}

export function newToken(): string {
  return toBase64Url(randomBytes(24))
}

export function newSecret(): string {
  return toBase64Url(randomBytes(16))
}

export function hashInvite(secret: string, kind: 'sit' | 'watch', token: string): string {
  return sha256Hex(`${secret}|${kind}|${token}`)
}

export function hashEquals(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) return false
  let diff = 0
  for (let index = 0; index < expectedHex.length; index += 1) {
    diff |= expectedHex.charCodeAt(index) ^ actualHex.charCodeAt(index)
  }
  return diff === 0
}

export function sanitizeDisplayName(value: unknown): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text.slice(0, MAX_DISPLAY_NAME) || '玩家'
}

export function sanitizeChat(value: unknown): string | null {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return null
  return text.slice(0, MAX_CHAT)
}

export function sanitizeTitle(value: unknown): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text.slice(0, MAX_TITLE) || '好友牌桌'
}
