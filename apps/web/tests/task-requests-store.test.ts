import assert from 'node:assert/strict';
import test from 'node:test';
import type { HumanRequest } from '@multivac/contracts';
import { TaskRequestsStore } from '../src/features/tasks/task-requests-provider.js';

const request = (id: string, status: HumanRequest['status'] = 'pending'): HumanRequest => ({ requestId: id, taskId: 'task', runId: null, sessionId: null, kind: 'clarification', revision: 1, status, question: '采用哪份资料？', artifactVersionId: null, authorizationRequestId: null, decision: null, answer: '', reason: '', createdAt: '', updatedAt: '' });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('请求超过百条仍读取到旧待处理请求，失败保留草稿和已知事实并允许重试', async (t) => {
  const offsets: number[] = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (fail) return response({ error: { code: 'INTERNAL_ERROR', message: '人工请求读取失败' } }, 503);
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
    offsets.push(offset);
    return response({ requests: offset === 0 ? Array.from({ length: 100 }, (_, i) => request(`recent-${i}`, 'answered')) : [request('old')], total: 101, nextOffset: offset === 0 ? 100 : null });
  });
  const store = new TaskRequestsStore();
  await store.refresh();
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(store.snapshot().requests.length, 101);
  assert.equal(store.snapshot().requests.find((item) => item.requestId === 'old')?.status, 'pending');
  store.draft('old', '采用真实来源 A');
  store.apply({ ...request('old'), revision: 2, status: 'answered', decision: 'answer', answer: '采用真实来源 A' });
  fail = true;
  await assert.rejects(store.refresh());
  assert.equal(store.snapshot().error, '人工请求读取失败');
  assert.equal(store.snapshot().drafts.old, '采用真实来源 A');
  fail = false;
  await store.refresh();
  assert.equal(store.snapshot().error, '');
  assert.equal(store.snapshot().requests.find((item) => item.requestId === 'old')?.status, 'answered');
});
