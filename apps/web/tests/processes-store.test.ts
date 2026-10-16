import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProcessList } from '@multivac/contracts';
import { ProcessesStore } from '../src/features/runs/processes-store.js';
import { STATUS_QUERY_TIMEOUT_MS } from '../src/features/runs/status-query.js';

const empty = (): ProcessList => ({ processes: [], total: 0, nextOffset: null });

test('进程读取挂起会超时；补读成功前保留错误，迟到结果不能覆盖新快照', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let signal: AbortSignal | undefined;
  let resolveOld!: (data: ProcessList) => void;
  let resolveRetry!: (data: ProcessList) => void;
  const store = new ProcessesStore((_offset, nextSignal) => {
    if (++reads === 1) return Promise.resolve(empty());
    if (reads === 2) {
      signal = nextSignal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return new Promise(resolve => { resolveRetry = resolve; });
  });
  await store.refresh();
  const previous = store.snapshot().data;
  const hung = store.refresh();
  t.mock.timers.tick(STATUS_QUERY_TIMEOUT_MS);
  await hung;
  assert.equal(signal?.aborted, true);
  assert.equal(store.snapshot().loading, false);
  assert.match(store.snapshot().error, /超时/);
  assert.equal(store.snapshot().data, previous);

  const retry = store.refresh();
  assert.match(store.snapshot().error, /超时/);
  const fresh = empty();
  resolveRetry(fresh);
  await retry;
  assert.equal(store.snapshot().error, '');
  assert.equal(store.snapshot().data, fresh);
  resolveOld({ ...empty(), total: 99 });
  await Promise.resolve();
  assert.equal(store.snapshot().data, fresh);
});
