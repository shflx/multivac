import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { assistantErrorMessage, assistantExecutionError, AssistantExecutionErrorSchema, ASSISTANT_ERROR_MESSAGE_MAX_LENGTH } from '../src/assistant-error.js';

test('错误说明保留 HTTP、认证和网络原因，隐藏凭据并在脱敏后截断', () => {
  const original = 'HTTP 401: invalid API key sk-abcdefghijk\nAuthorization: Bearer opaque-credential\npassword="private-password" apiKey=private-key token=private-token\nhttps://user:private-pass@provider.example/v1?key=private-query#private-hash\n    at request (/private/file.ts:1)';
  const result = assistantErrorMessage(original)!;
  assert.match(result, /HTTP 401: invalid API key/);
  assert.match(result, /https:\/\/provider.example\/v1/);
  for (const secret of ['sk-abcdefghijk', 'opaque-credential', 'private-password', 'private-key', 'private-token', 'private-pass', 'private-query', 'private-hash', '/private/file.ts']) assert.equal(result.includes(secret), false, secret);
  for (const reason of ['ECONNREFUSED: 模型服务连接被拒绝', 'ETIMEDOUT: 请求超时', 'HTTP 429: 请求限额已用完', '工具执行租约核对失败']) assert.equal(assistantErrorMessage(reason), reason);
  const bounded = assistantExecutionError('MODEL_REQUEST_FAILED', '中'.repeat(4096))!;
  assert.equal(bounded.message.length, ASSISTANT_ERROR_MESSAGE_MAX_LENGTH);
  assert.equal(Check(AssistantExecutionErrorSchema, bounded), true);
});

test('只提取字符串或 Error.message，不序列化任意对象；空细节保留为未提供', () => {
  assert.equal(assistantErrorMessage(undefined), undefined);
  assert.equal(assistantErrorMessage(' \n '), undefined);
  assert.equal(assistantErrorMessage({ message: '秘密', headers: { Authorization: '秘密' } }), undefined);
  assert.equal(assistantErrorMessage(new Error('网络连接断开')), '网络连接断开');
  assert.equal(assistantExecutionError('secret-token', '执行中断')?.code, 'RUNTIME_OPERATION_FAILED');
});
