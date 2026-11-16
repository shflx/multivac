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

test('未编辑时的保存不会锁住后续输入，编辑期间远端更新仍按原版本检测冲突', async (t) => {
  const item: InboxItem = { id: 'conflict', kind: 'clarification', revision: 1, status: 'pending', title: '问题', createdAt: '', updatedAt: '', blocksWork: true, taskId: 'task', sessionId: null, artifactVersionId: null, human: request('conflict'), authorization: null, state: { revision: 0, draft: '', seen: false } };
  const store = new TaskRequestsStore(); store.applyInbox(item);
  await store.saveDraft(item.id);
  let sentRevision = -1;
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { sentRevision = JSON.parse(String(init.body)).revision; return response({ error: { code: 'TASK_CONFLICT', message: '另一窗口修改了草稿' } }, 409); }
    return response({ items: [{ ...item, state: { revision: 2, draft: '其他窗口', seen: true } }], total: 1, pendingCount: 1, unseenCount: 0, nextOffset: null });
  });
  store.draft(item.id, '本窗口输入');
  store.applyInbox({ ...item, state: { revision: 2, draft: '其他窗口', seen: true } });
  await store.saveDraft(item.id);
  assert.equal(sentRevision, 0);
  assert.equal(store.snapshot().drafts.conflict, '本窗口输入');
  assert.match(store.snapshot().errors.conflict!, /另一窗口/);
});

const inboxItem = (id: string): InboxItem => ({ id, kind: 'clarification', revision: 1, status: 'pending', title: '问题', createdAt: '', updatedAt: '', blocksWork: true, taskId: 'task', sessionId: null, artifactVersionId: null, human: request(id), authorization: null, state: { revision: 0, draft: '', seen: false } });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const remote of [false, true]) test(`${remote ? '远程' : '本机'}成功回执不等待百条历史的后续分页，旧快照和刷新失败不撤回结果`, async (t) => {
  const item = inboxItem('receipt');
  const answered = { ...request(item.id), revision: 2, status: 'answered' as const, decision: 'answer' as const, answer: '已保存' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let laterPage = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return response(remote ? { item: { ...item, revision: 2, status: 'answered', human: answered } } : { request: answered });
    if (url.includes('offset=100')) { laterPage = true; await gate; return response({ error: { code: 'INTERNAL_ERROR', message: '历史读取失败' } }, 503); }
    return response({ items: [item, ...Array.from({ length: 99 }, (_, i) => inboxItem(`history-${i}`))], total: 101, pendingCount: 101, unseenCount: 101, nextOffset: 100 });
  });
  const store = new TaskRequestsStore(remote); store.applyInbox(item);
  let finished = false;
  const decision = store.decideItem(item, 'answer').then(() => { finished = true; });
  await turn();
  assert.equal(laterPage, true);
  assert.equal(finished, true);
  assert.equal(store.snapshot().pending.has(item.id), false);
  assert.equal(store.snapshot().items.find(value => value.id === item.id)?.human?.answer, '已保存');
  assert.equal(store.snapshot().items.find(value => value.id === item.id)?.status, 'answered');
  store.applyInbox(item);
  assert.equal(store.snapshot().items.find(value => value.id === item.id)?.status, 'answered');
  release(); await decision; await turn();
  assert.equal(store.snapshot().inboxError, '历史读取失败');
  assert.equal(store.snapshot().items.find(value => value.id === item.id)?.status, 'answered');
});

for (const remote of [false, true]) test(`${remote ? '远程' : '本机'}决定失败和响应丢失保留输入，历史挂起仍可沿用命令身份重试`, async (t) => {
  const item = inboxItem('unknown');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ids: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      ids.push(JSON.parse(String(init.body)).commandId);
      if (ids.length === 1) throw new Error('响应丢失');
      return response({ error: { code: 'TASK_CONFLICT', message: '请核对决定' } }, 409);
    }
    await gate;
    return response(_url.includes('/api/inbox') ? { items: [item], total: 1, pendingCount: 1, unseenCount: 1, nextOffset: null } : { requests: [item.human], total: 1, nextOffset: null });
  });
  const store = new TaskRequestsStore(remote); store.applyInbox(item); store.draft(item.id, '保留输入');
  let finished = false;
  const first = store.decideItem(item, 'answer').then(() => { finished = true; });
  await store.decideItem(item, 'answer');
  await turn();
  assert.equal(finished, true);
  assert.equal(ids.length, 1);
  assert.equal(store.snapshot().items[0]?.status, 'pending');
  assert.equal(store.snapshot().drafts[item.id], '保留输入');
  await store.decideItem(item, 'answer');
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(store.snapshot().items[0]?.status, 'pending');
  release(); await first;
  // 结束草稿自动保存定时器；保留模拟中的输入和错误事实。
  await store.saveDraft(item.id);
});

for (const remote of [false, true]) test(`${remote ? '远程轮询' : '事件和决定'}共享刷新，百条分页期间多次通知合并补读并取得完整计数`, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const offsets: number[] = [];
  let active = 0, maxActive = 0, round = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    active++; maxActive = Math.max(active, maxActive);
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
    offsets.push(offset);
    if (offset === 0) round++;
    if (round === 1 && offset === 100) await gate;
    active--;
    return response({ items: offset === 0 ? Array.from({ length: 100 }, (_, i) => inboxItem(`page-${i}`)) : [inboxItem(round === 1 ? 'old' : 'latest')], total: 101, pendingCount: round === 1 ? 101 : 102, unseenCount: round === 1 ? 101 : 7, nextOffset: offset === 0 ? 100 : null });
  });
  const store = new TaskRequestsStore(remote);
  const initial = store.refreshInbox();
  await turn();
  for (let i = 0; i < 20; i++) assert.equal(store.refreshInbox(), initial);
  assert.deepEqual(offsets, [0, 100]);
  release(); await initial;
  assert.deepEqual(offsets, [0, 100, 0, 100]);
  assert.equal(maxActive, 1);
  assert.equal(store.snapshot().items.some(item => item.id === 'latest'), true);
  assert.equal(store.snapshot().pendingCount, 102);
  assert.equal(store.snapshot().unseenCount, 7);
  assert.equal(store.snapshot().loaded, true);
});

test('分页失败不提交半份事实，可重试且保留本窗口草稿和刷新期间的变化', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fail = true, read = 0;
  const item = inboxItem('draft');
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return response({ error: { code: 'TASK_CONFLICT', message: '草稿冲突' } }, 409);
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
    read++;
    if (offset === 100 && fail) { await gate; throw new Error('分页失败'); }
    return response({ items: offset === 0 ? [{ ...item, state: { revision: 3, draft: '远端草稿', seen: true } }] : [inboxItem('latest')], total: 101, pendingCount: 101, unseenCount: 9, nextOffset: offset === 0 ? 100 : null });
  });
  const store = new TaskRequestsStore(); store.applyInbox(item); store.draft(item.id, '本窗口草稿');
  const first = store.refreshInbox(); await turn(); release(); await assert.rejects(first, /分页失败/);
  assert.equal(store.snapshot().items.length, 1);
  assert.equal(store.snapshot().loaded, false);
  assert.equal(store.snapshot().drafts[item.id], '本窗口草稿');
  fail = false; await store.refreshInbox();
  assert.equal(read, 4);
  assert.equal(store.snapshot().inboxError, '');
  assert.equal(store.snapshot().drafts[item.id], '本窗口草稿');
  assert.equal(store.snapshot().pendingCount, 101);
  await store.saveDraft(item.id);
});

test('失败分页期间收到的补读要求仍会执行，重连可继续核对后续变化', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) { await gate; throw new Error('断线'); }
    return response({ items: [inboxItem(`latest-${calls}`)], total: 1, pendingCount: 1, unseenCount: 0, nextOffset: null });
  });
  const store = new TaskRequestsStore();
  const initial = store.refreshInbox();
  assert.equal(store.refreshInbox(), initial);
  release(); await initial;
  assert.equal(calls, 2);
  assert.equal(store.snapshot().inboxError, '');
  await store.refreshInbox();
  assert.equal(calls, 3);
  assert.equal(store.snapshot().items.some(item => item.id === 'latest-3'), true);
});
