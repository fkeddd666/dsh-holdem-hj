/** 错误码 → HTTP 状态码：本机路由与 Worker 共用，避免两套实现漂移。 */
export function statusOf(code: string): number {
  if (code === 'auth') return 403
  if (code === 'room-not-found' || code === 'expired') return 404
  if (code === 'rate-limited') return 429
  if (
    code === 'room-full'
    || code === 'phase'
    || code === 'stale'
    || code === 'already-in-room'
    || code === 'duplicate-nonce'
  ) return 409
  return 400
}
