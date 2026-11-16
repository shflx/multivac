/**
 * 中转网关的临时错误补充为可重试。
 *
 * Pi 只按 pi-ai 内置关键词判定可重试错误，sub2api 等中转在流中途断开时报出的
 * “upstream_stream_read_error: Upstream response stream was interrupted” 等文本不在其中，
 * 本轮会直接失败。Pi 没有提供扩展判定的配置，这里包装会话实例的判定方法：
 * 原判定之外，再把下列网关临时错误交给 Pi 既有的自动重试，重试预算与退避仍由 Pi 负责。
 */

/** 网关上游断流、HTTP/2 流失败、临时不可用与并发限流；都是可在稍后恢复的瞬时故障。 */
const GATEWAY_TRANSIENT_ERROR_PATTERN = /upstream_stream_read_error|upstream_http2_stream_error|stream was interrupted|temporarily unavailable|concurrency.?limit/i;

interface RetryableAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
}

export function isGatewayTransientError(message: RetryableAssistantMessage): boolean {
  return message.stopReason === 'error' && !!message.errorMessage && GATEWAY_TRANSIENT_ERROR_PATTERN.test(message.errorMessage);
}

/** 包装 Pi 会话的私有判定 `_isRetryableError`；SDK 变更后缺少该方法时保持原行为。 */
export function retryGatewayTransientErrors(session: object): void {
  const target = session as { _isRetryableError?: (message: RetryableAssistantMessage) => boolean };
  const original = target._isRetryableError;
  if (typeof original !== 'function') return;
  target._isRetryableError = message => original.call(session, message) || isGatewayTransientError(message);
}
