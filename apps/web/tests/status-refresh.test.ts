import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { ProcessList, RunsSnapshot } from '@multivac/contracts';
import { RunsStore } from '../src/features/runs/runs-store.js';
import { ProcessesStore } from '../src/features/runs/processes-store.js';
import { scheduleStatusRefresh } from '../src/features/runs/status-refresh.js';
import { STATUS_QUERY_TIMEOUT_MS } from '../src/features/runs/status-query.js';

const runs = (version: number): RunsSnapshot => ({ version, observedAt: '', items: [], highlights: [], total: version, nextOffset: null,
  counts: { running: 0, queued: 0, anomalies: 0, waiting: 0 } });
const processes = (total: number): ProcessList => ({ processes: [], total, nextOffset: null });

for (const source of ['runs', 'processes'] as const) {
  test(`${source} 合并突发刷新、保留超时，拒绝迟到快照`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const reads: { signal: AbortSignal; finish: (version: number) => void }[] = [];
    function read<T>(signal: AbortSignal, snapshot: (version: number) => T): Promise<T> {
      return new Promise(resolve => reads.push({ signal, finish: version => resolve(snapshot(version)) }));
    }
    const store = source === 'runs' ? new RunsStore((_offset, signal) => read(signal, runs)) : new ProcessesStore((_offset, signal) => read(signal, processes));
    const scheduler = scheduleStatusRefresh(store);
    try {
      scheduler.queue();
      for (let i = 0; i < 30; i++) scheduler.queue();
      assert.equal(reads.length, 1);
      assert.equal(reads[0]!.signal.aborted, false);
      reads[0]!.finish(1);
      await setImmediate();
      assert.equal(reads.length, 1);
      t.mock.timers.tick(250);
      assert.equal(reads.length, 2);
      // 持续普通事件不能延长第二次读取的原期限。
      for (let i = 0; i < 9; i++) { t.mock.timers.tick(1000); scheduler.queue(); }
      t.mock.timers.tick(STATUS_QUERY_TIMEOUT_MS - 9001);
      assert.equal(reads.length, 2);
      assert.equal(reads[1]!.signal.aborted, false);
      t.mock.timers.tick(1);
      await setImmediate();
      assert.equal(reads[1]!.signal.aborted, true);
      assert.equal(reads.length, 3);
      assert.match(store.snapshot().error, /超时/);
      reads[2]!.finish(3);
      reads[1]!.finish(2);
      await setImmediate();
      assert.equal(reads.length, 3);
      assert.equal(store.snapshot().data?.total, 3);
      assert.equal(store.snapshot().error, '');

      scheduler.queue();
      t.mock.timers.tick(250);
      scheduler.foreground();
      scheduler.foreground();
      scheduler.foreground();
      assert.equal(reads.length, 5);
      assert.equal(reads[3]!.signal.aborted, true);
      reads[4]!.finish(5);
      reads[3]!.finish(4);
      await setImmediate();
      assert.equal(store.snapshot().data?.total, 5);
    } finally { scheduler.dispose(); }
  });
}
