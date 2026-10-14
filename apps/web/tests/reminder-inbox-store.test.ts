import assert from 'node:assert/strict';
import test from 'node:test';
import type { InboxItem } from '@multivac/contracts';
import { TaskRequestsStore } from '../src/features/tasks/task-requests-provider.js';

const notification: InboxItem = { id: 'notification:r1:1', kind: 'notification', revision: 1, status: 'pending', title: '开会',
  createdAt: '2026-10-14T07:00:05Z', updatedAt: '2026-10-14T07:00:05Z', blocksWork: false,
  taskId: null, sessionId: 'global-coordinator', artifactVersionId: null, human: null, authorization: null,
  notification: { id: 'notification:r1:1', reminderId: 'r1', reminderRevision: 1, revision: 1, text: '开会', scheduledAt: '2026-10-14T07:00:00Z',
    timeZone: 'Asia/Shanghai', localTime: '2026-10-14T15:00:00', sourceSessionId: 'global-coordinator', createdAt: '2026-10-14T07:00:05Z', acknowledgedAt: null },
  state: { revision: 0, seen: false, draft: '' } };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const page = (item: InboxItem) => ({ items: [item], total: 1, pendingCount: item.status === 'pending' ? 1 : 0,
  unseenCount: item.status === 'pending' && !item.state.seen ? 1 : 0, nextOffset: null });

test('查询不自动查看，查看与确认计数分别变化；新窗口读取相同事实', async t => {
  let current = notification;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const input = JSON.parse(String(init.body));
      if (url.endsWith('/state')) { assert.equal(input.seen, true); current = { ...current, state: { ...current.state, revision: 1, seen: true } }; return response({ state: current.state }); }
      assert.equal(input.decision, 'acknowledge');
      current = { ...current, revision: 2, status: 'answered', notification: { ...current.notification!, revision: 2, acknowledgedAt: '2026-10-14T07:01:00Z' } };
      return response({ item: current });
    }
    return response(page(current));
  });
  const first = new TaskRequestsStore(); const second = new TaskRequestsStore();
  await first.refreshInbox(); assert.equal(first.snapshot().unseenCount, 1);
  await first.seen(notification.id);
  assert.equal(first.snapshot().pendingCount, 1); assert.equal(first.snapshot().unseenCount, 0);
  await second.refreshInbox(); assert.equal(second.snapshot().items[0]!.state.seen, true);
  await first.decideItem(current, 'acknowledge');
  assert.equal(first.snapshot().pendingCount, 0);
  await second.refreshInbox(); assert.equal(second.snapshot().pendingCount, 0);
  second.applyInbox(notification); assert.equal(second.snapshot().items[0]!.status, 'answered');
});

test('确认响应丢失后读事实，重复点击只发送一次且不会复活已确认通知', async t => {
  let current = notification;
  let sent = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent++;
      current = { ...notification, revision: 2, status: 'answered', notification: { ...notification.notification!, revision: 2, acknowledgedAt: '2026-10-14T07:01:00Z' } };
      await gate; throw new Error('响应丢失');
    }
    return response(page(current));
  });
  const store = new TaskRequestsStore(); store.applyInbox(notification);
  const first = store.decideItem(notification, 'acknowledge');
  await store.decideItem(notification, 'acknowledge'); release(); await first;
  assert.equal(sent, 1); assert.equal(store.snapshot().pendingCount, 0);
  assert.equal(store.snapshot().items[0]!.status, 'answered');
});
