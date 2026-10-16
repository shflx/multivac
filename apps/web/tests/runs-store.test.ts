import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunsSnapshot } from '@multivac/contracts';
import { RunsStore } from '../src/features/runs/runs-store.js';
import { STATUS_QUERY_TIMEOUT_MS } from '../src/features/runs/status-query.js';
import { setImmediate } from 'node:timers/promises';
const snapshot = (version: number): RunsSnapshot => ({ version, observedAt: '', items: [], highlights: [], total: 0, nextOffset: null, counts: { running: 0, queued: 0, anomalies: 0, waiting: 0 } });
test('迟到读取与旧版本不能覆盖重连后事实', async () => {
  const pending: ((value: RunsSnapshot) => void)[] = [];
  const store = new RunsStore(() => new Promise((resolve) => pending.push(resolve)));
  const first = store.refresh();
  const reconnect = store.refresh();
  pending[1]!(snapshot(3)); await reconnect;
  pending[0]!(snapshot(1)); await first;
  assert.equal(store.snapshot().data?.version, 3);
  const old = store.refresh(); pending[2]!(snapshot(2)); await old;
  assert.equal(store.snapshot().data?.version, 3);
  assert.equal(store.snapshot().loading, false);
});


test('活跃列表缩短后回到有效页，避免总数有执行但当前页为空', async () => {
  const offsets: number[] = [];
  const store = new RunsStore(async offset => { offsets.push(offset); return { ...snapshot(1), total: 3 }; });
  await store.refresh(100);
  assert.deepEqual(offsets, [100, 0]); assert.equal(store.snapshot().offset, 0); assert.equal(store.snapshot().loading, false);
});

test('旧空快照之后请求永久挂起：超时释放 loading，重试成功前保留错误', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let signal: AbortSignal | undefined;
  let resolveOld!: (data: RunsSnapshot) => void;
  let resolveRetry!: (data: RunsSnapshot) => void;
  const store = new RunsStore((_offset, nextSignal) => {
    if (++reads === 1) return Promise.resolve(snapshot(1));
    if (reads === 2) {
      signal = nextSignal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return new Promise(resolve => { resolveRetry = resolve; });
  });
  await store.refresh();
  const hung = store.refresh();
  t.mock.timers.tick(STATUS_QUERY_TIMEOUT_MS);
  await hung;
  assert.equal(signal?.aborted, true);
  assert.equal(store.snapshot().loading, false);
  assert.equal(store.snapshot().data?.version, 1);
  assert.match(store.snapshot().error, /超时/);

  const retry = store.refresh();
  assert.equal(store.snapshot().loading, true);
  assert.match(store.snapshot().error, /超时/);
  resolveRetry({ ...snapshot(2), counts: { ...snapshot(2).counts, running: 1 } });
  await retry;
  assert.equal(store.snapshot().data?.counts.running, 1);
  assert.equal(store.snapshot().error, '');
  resolveOld(snapshot(1));
  await Promise.resolve();
  assert.equal(store.snapshot().data?.version, 2);
});

test('响应头已返回但正文未结束，也会超时且不会应用迟到正文', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  let closeBody!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(snapshot(1))));
    closeBody = () => controller.close();
  } });
  const response = new Response(body);
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return Promise.resolve(response);
  });
  const store = new RunsStore();
  try {
    const hung = store.refresh();
    await setImmediate();
    assert.equal(response.body?.locked, true);
    t.mock.timers.tick(STATUS_QUERY_TIMEOUT_MS);
    await hung;
    assert.equal(signal?.aborted, true);
    assert.equal(store.snapshot().loading, false);
    assert.match(store.snapshot().error, /超时/);
    assert.equal(store.snapshot().data, null);
  } finally {
    closeBody();
  }
  await setImmediate();
  assert.equal(store.snapshot().data, null);
});
