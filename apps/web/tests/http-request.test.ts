import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { WINDOW_ID_HEADER } from '@multivac/contracts';
import { requestJson, type JsonRequestErrors } from '../src/data/http.js';

const errors: JsonRequestErrors = {
  unreadable: (status) => new Error(`unreadable:${status}`),
  failed: (body, status) => new Error(`failed:${status}:${JSON.stringify(body)}`),
  invalid: (status) => new Error(`invalid:${status}`),
};
const Schema = Type.Object({ id: Type.String() }, { additionalProperties: false });

function respond(body: string, status = 200): void {
  globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

test('请求函数按 schema 校验响应，协议失败交由各功能映射', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  respond('{"id":"a"}');
  const value = await requestJson('/api/sample', Schema, undefined, errors);
  assert.equal(value.id, 'a');

  respond('{"id":1}');
  await assert.rejects(requestJson('/api/sample', Schema, undefined, errors), /invalid:200/);
  respond('不是 JSON');
  await assert.rejects(requestJson('/api/sample', Schema, undefined, errors), /unreadable:200/);
  respond('{"error":{"code":"NOT_FOUND"}}', 404);
  await assert.rejects(requestJson('/api/sample', Schema, undefined, errors), /failed:404/);
});

test('写请求带上本窗口 id，读请求不添加', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen: (string | null)[] = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get(WINDOW_ID_HEADER));
    return new Response('{"id":"a"}', { status: 200 });
  };
  await requestJson('/api/sample', Schema, undefined, errors);
  await requestJson('/api/sample', Schema, { method: 'POST' }, errors);
  assert.equal(seen[0], null);
  assert.ok(seen[1]);
});
