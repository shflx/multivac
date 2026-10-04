import assert from 'node:assert/strict';
import test from 'node:test';
import type { HumanRequest } from '@multivac/contracts';
import { TaskRequestsStore } from '../src/features/tasks/task-requests-provider.js';
import type { InboxItem } from '@multivac/contracts';

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

test('Inbox 旧快照不复活终态，后台读取不覆盖编辑，失败保留草稿', async (t) => {
  const item: InboxItem = { id: 'i', kind: 'clarification', revision: 1, status: 'pending', title: '问题', createdAt: '', updatedAt: '', blocksWork: true, taskId: 'task', sessionId: null, artifactVersionId: null, human: request('i'), authorization: null, state: { revision: 0, draft: '', seen: false } };
  const store = new TaskRequestsStore(); store.applyInbox(item);
  t.mock.method(globalThis, 'fetch', async () => response({ error: { code: 'INTERNAL_ERROR', message: '网络不可用' } }, 503));
  store.draft('i', '正在编辑');
  store.applyInbox({ ...item, state: { revision: 1, seen: true, draft: '其他窗口' } });
  assert.equal(store.snapshot().drafts.i, '正在编辑');
  await store.saveDraft('i');
  assert.equal(store.snapshot().drafts.i, '正在编辑');
  assert.equal(store.snapshot().errors.i, '网络不可用');
  store.applyInbox({ ...item, revision: 2, status: 'answered', human: { ...request('i'), revision: 2, status: 'answered' } });
  store.applyInbox(item);
  assert.equal(store.snapshot().items[0]?.status, 'answered');
  assert.equal(store.snapshot().items[0]?.state.seen, true);
});

test('响应丢失先对账，重试复用原命令 ID，重复点击只发送一次', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ids: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { ids.push(JSON.parse(String(init.body)).commandId); await gate; throw new Error('响应丢失'); }
    return response({ requests: [request('i')], total: 1, nextOffset: null });
  });
  const store = new TaskRequestsStore(); store.apply(request('i')); store.draft('i', '答复');
  const first = store.decide(request('i'), 'answer');
  await store.decide(request('i'), 'answer');
  release(); await first;
  await store.decide(request('i'), 'answer');
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(store.snapshot().drafts.i, '答复');
});
