import assert from 'node:assert/strict';
import test from 'node:test';
import { newCommandId } from '../src/data/command-id.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
test('正常环境生成UUID命令身份', () => { assert.match(newCommandId(), uuid); });
test('没有randomUUID的HTTP环境仍生成不同的有效命令身份', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const ids = Array.from({ length: 100 }, () => newCommandId());
    for (const id of ids) assert.match(id, uuid);
    assert.equal(new Set(ids).size, 100);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
});
