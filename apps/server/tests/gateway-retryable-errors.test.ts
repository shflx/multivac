import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { retryGatewayTransientErrors } from '../src/runtime/executors/gateway-retryable-errors.js';

const failed = (errorMessage: string) => ({ stopReason: 'error', errorMessage });

test('网关临时错误补充为可重试，原判定结果保持不变', () => {
  const session = { _isRetryableError: (message: { errorMessage?: string }) => message.errorMessage === 'Connection error.' };
  retryGatewayTransientErrors(session);

  for (const message of [
    'Error Code upstream_stream_read_error: Upstream response stream was interrupted',
    'Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed',
    'upstream_error: Upstream service temporarily unavailable',
    'gateway_concurrency_limit: Concurrency limit exceeded for user, please retry later',
  ]) assert.equal(session._isRetryableError(failed(message)), true, message);

  assert.equal(session._isRetryableError(failed('Connection error.')), true);
  assert.equal(session._isRetryableError(failed('insufficient_quota')), false);
  assert.equal(session._isRetryableError({ stopReason: 'stop', errorMessage: 'stream was interrupted' }), false);
});

test('会话缺少私有判定方法时不做改动', () => {
  const session = {};
  retryGatewayTransientErrors(session);
  assert.deepEqual(session, {});
});

// 包装目标是 Pi 的私有方法：SDK 升级后名称变化会让补充静默失效，这里固定核对仍存在。
test('当前 Pi 会话仍提供被包装的判定方法', () => {
  assert.equal(typeof AgentSession.prototype._isRetryableError, 'function');
});
