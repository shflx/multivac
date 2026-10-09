import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunsSnapshot } from '@multivac/contracts';
import { RunsStore } from '../src/features/runs/runs-store.js';
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
