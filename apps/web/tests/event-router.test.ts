import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantPublicEvent } from '@multivac/contracts';
import { GlobalEventRouter, type EventRangePage } from '../src/features/events/event-router.js';

/** 一条正文增量：cursor 与会话即可区分，正文写成 `会话@游标` 便于核对顺序。 */
function delta(sessionId: string, cursor: number): AssistantPublicEvent {
  return {
    cursor: String(cursor),
    assistantSessionId: sessionId,
    commandId: null,
    occurredAt: '2026-01-01T00:00:00.000Z',
    type: 'assistant.message.delta',
    data: { piSessionId: 'pi', messageId: 'm', delta: `${sessionId}@${cursor}` },
  } as AssistantPublicEvent;
}

interface RangeCall {
  sessionId: string;
  after: number;
  until: number;
  resolve(page: EventRangePage): void;
  reject(error: unknown): void;
}

const EXPIRED = new Error('EVENT_CURSOR_EXPIRED');

/** 测试夹具：补漏读取由测试逐页应答，记录起流游标、交付顺序与过期通知。 */
function harness() {
  const ranges: RangeCall[] = [];
  const starts: number[] = [];
  const router = new GlobalEventRouter({
    readRange: (sessionId, after, until) => new Promise((resolve, reject) => {
      ranges.push({ sessionId, after, until, resolve, reject });
    }),
    isCursorExpired: (error) => error === EXPIRED,
    onStart: (cursor) => starts.push(cursor),
    retryDelayMs: () => 0,
  });
  const open = (sessionId: string) => {
    const delivered: number[] = [];
    let expired = 0;
    const feed = router.open(sessionId, {
      deliver: (event) => delivered.push(Number(event.cursor)),
      expired: () => { expired += 1; },
    });
    return { feed, delivered, expiredCount: () => expired };
  };
  /** 全局流送来一串事件（按 cursor 升序）。 */
  const stream = (...events: AssistantPublicEvent[]) => {
    for (const event of events) router.dispatch(event);
  };
  return { router, ranges, starts, open, stream };
}

/** 等在途的 Promise 回调执行完。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('快照前、快照中、快照后三种时序：丢弃快照已包含的，按序交付之后的，不漏不重', async () => {
  const { router, ranges, starts, open, stream } = harness();
  // 另一个会话的快照先到位，全局流以 10 起流。
  const other = open('other');
  other.feed.ready(10);
  assert.deepEqual(starts, [10]);
  assert.equal(router.cursor, 10);

  // 会话 A 在游标 10 时开始读取快照：之后的事件先缓存。
  const a = open('a');
  // 快照前：11、12 在 A 的快照读取时已写入，快照会包含它们。
  stream(delta('a', 11), delta('other', 12), delta('a', 13));
  // 快照中：14、15 在 A 的快照游标之后到达。
  stream(delta('a', 14), delta('other', 15), delta('a', 16));
  assert.deepEqual(a.delivered, []);

  // 快照游标 13：11、13 已在快照里，14 之后的按序交付。
  a.feed.ready(13);
  await settle();
  assert.equal(ranges.length, 0, '快照游标不早于缓存起点时不需要补漏');
  assert.deepEqual(a.delivered, [14, 16]);

  // 快照后：直接交付；重复的旧事件按全局游标丢弃。
  stream(delta('a', 17), delta('a', 16), delta('other', 18), delta('a', 19));
  assert.deepEqual(a.delivered, [14, 16, 17, 19]);
  assert.deepEqual(other.delivered, [12, 15, 18]);
  assert.equal(router.cursor, 19);
  assert.deepEqual(starts, [10], '已在流上时快照不改变起点');
});

test('快照游标早于缓存起点时按 (快照游标, 起点] 补漏后再交付缓存，补漏期间新到的事件排在其后', async () => {
  const { ranges, starts, open, stream } = harness();
  // A 在全局流连接之前开始读取快照；B 的快照先到位，全局流以 20 起流。
  const a = open('a');
  const b = open('b');
  b.feed.ready(20);
  assert.deepEqual(starts, [20]);
  stream(delta('a', 21), delta('b', 22));

  // A 的快照游标是 15：16–20 之间的事件只能补漏。
  a.feed.ready(15);
  assert.equal(ranges.length, 1);
  assert.deepEqual({ sessionId: ranges[0]!.sessionId, after: ranges[0]!.after, until: ranges[0]!.until },
    { sessionId: 'a', after: 15, until: 20 });

  // 补漏期间新事件到达：继续缓存，不能插到补漏结果之前。
  stream(delta('a', 23));
  assert.deepEqual(a.delivered, []);

  ranges[0]!.resolve({ events: [delta('a', 16), delta('a', 19)], hasMore: false });
  await settle();
  assert.deepEqual(a.delivered, [16, 19, 21, 23]);

  stream(delta('a', 24));
  assert.deepEqual(a.delivered, [16, 19, 21, 23, 24]);
  assert.deepEqual(b.delivered, [22]);
});

test('补漏按 hasMore 分页续读，失败时稍后重试同一页', async () => {
  const { ranges, open, stream } = harness();
  const a = open('a');
  const b = open('b');
  b.feed.ready(100);
  stream(delta('a', 101));
  a.feed.ready(10);

  ranges[0]!.resolve({ events: [delta('a', 11), delta('a', 40)], hasMore: true });
  await settle();
  assert.deepEqual({ after: ranges[1]!.after, until: ranges[1]!.until }, { after: 40, until: 100 });
  assert.deepEqual(a.delivered, [11, 40]);

  // 第二页读取失败（网络中断）：重试同一页，期间到达的事件继续缓存。
  ranges[1]!.reject(new Error('network'));
  stream(delta('a', 102));
  await settle();
  await settle();
  assert.deepEqual({ after: ranges[2]!.after, until: ranges[2]!.until }, { after: 40, until: 100 });

  ranges[2]!.resolve({ events: [delta('a', 70), delta('a', 100)], hasMore: false });
  await settle();
  assert.deepEqual(a.delivered, [11, 40, 70, 100, 101, 102]);
});

test('补漏读取游标过期时通知会话重读快照，之后以新快照重新衔接', async () => {
  const { ranges, open, stream } = harness();
  const a = open('a');
  const b = open('b');
  b.feed.ready(50);
  a.feed.ready(5);
  stream(delta('a', 51));
  ranges[0]!.reject(EXPIRED);
  await settle();
  assert.equal(a.expiredCount(), 1);
  assert.deepEqual(a.delivered, []);

  // 重读期间的事件仍然缓存；新快照游标 51 已包含 51。
  stream(delta('a', 52));
  a.feed.ready(51);
  await settle();
  assert.equal(ranges.length, 1);
  assert.deepEqual(a.delivered, [52]);
});

test('全局游标过期：已衔接的会话重读快照，仍在读取快照的不重复通知；第一个新快照成为新起点', async () => {
  const { router, ranges, starts, open, stream } = harness();
  const a = open('a');
  const b = open('b');
  a.feed.ready(10);
  b.feed.ready(10);
  stream(delta('a', 11), delta('b', 12));
  const c = open('c');
  stream(delta('c', 13));

  router.expire();
  assert.equal(router.cursor, null);
  assert.equal(a.expiredCount(), 1);
  assert.equal(b.expiredCount(), 1);
  assert.equal(c.expiredCount(), 0, 'C 的首次快照还在读取，读完照常衔接');
  // 过期后流已停止，迟到的事件不再分发。
  stream(delta('a', 14));

  // A 的快照先到位（游标 30），全局流从 30 重新起流；B、C 的快照更早，按 (快照游标, 30] 补漏。
  a.feed.ready(30);
  assert.deepEqual(starts, [10, 30]);
  stream(delta('b', 31), delta('c', 32));
  b.feed.ready(25);
  c.feed.ready(30);
  await settle();
  assert.deepEqual(ranges.map(({ sessionId, after, until }) => ({ sessionId, after, until })),
    [{ sessionId: 'b', after: 25, until: 30 }]);
  ranges[0]!.resolve({ events: [delta('b', 28)], hasMore: false });
  await settle();

  assert.deepEqual(a.delivered, [11]);
  assert.deepEqual(b.delivered, [12, 28, 31]);
  assert.deepEqual(c.delivered, [32]);
});

test('过期时在途的补漏结果作废，关闭的会话不再缓存与交付', async () => {
  const { router, ranges, open, stream } = harness();
  const a = open('a');
  const b = open('b');
  b.feed.ready(20);
  a.feed.ready(10);
  router.expire();
  // 过期前发出的补漏读取迟到：不交付。
  ranges[0]!.resolve({ events: [delta('a', 15)], hasMore: false });
  await settle();
  assert.deepEqual(a.delivered, []);

  b.feed.ready(40);
  a.feed.ready(40);
  stream(delta('a', 41));
  await settle();
  assert.deepEqual(a.delivered, [41]);

  a.feed.close();
  stream(delta('a', 42), delta('b', 43));
  assert.deepEqual(a.delivered, [41]);
  assert.deepEqual(b.delivered, [43]);
  // 同一会话重新打开（例如再次放进栏位）是新的接入，从打开时的全局游标之后缓存。
  const reopened = open('a');
  stream(delta('a', 44));
  reopened.feed.ready(43);
  await settle();
  assert.deepEqual(reopened.delivered, [44]);
});
