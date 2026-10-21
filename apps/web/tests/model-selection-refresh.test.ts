import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelSelectionRefresh } from '../src/features/assistant/model-selection-refresh.js';

function harness(read: () => Promise<void> = async () => {}) {
  let now = 0, counter = 0, reads = 0, pending = false, visible = true;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const scheduler = new ModelSelectionRefresh({
    read: async () => { reads++; await read(); }, pending: () => pending, visible: () => visible,
    clock: { setTimeout: (callback, delay) => { timers.set(++counter, { at: now + delay, callback }); return counter; }, clearTimeout: id => { timers.delete(id); } },
  });
  return { scheduler, flush, reads: () => reads, timers,
    pending: (value: boolean) => { pending = value; scheduler.schedule(); },
    visible: (value: boolean) => { visible = value; scheduler.schedule(); },
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = end;
    },
  };
}

test('空闲60秒仅初读和两次30秒兜底；隐藏停止普通轮询，恢复可立即读取', async () => {
  const h = harness(); h.scheduler.start(); await h.flush();
  await h.advance(60_000); assert.equal(h.reads(), 3);
  h.visible(false); await h.advance(60_000); assert.equal(h.reads(), 3);
  h.visible(true); await h.scheduler.request(); assert.equal(h.reads(), 4);
  h.scheduler.stop(); assert.equal(h.timers.size, 0);
});

test('本会话/全局/重连事件刷新，其他会话不刷新；未知命令隐藏时也只读短周期', async () => {
  const h = harness(); h.scheduler.start(); await h.flush();
  h.scheduler.event({ type: 'model-selection.changed', seq: 1, sessionId: 'other' }, 'mine'); await h.flush();
  assert.equal(h.reads(), 1);
  for (const sessionId of ['mine', null]) {
    h.scheduler.event({ type: 'model-selection.changed', seq: 2, sessionId }, 'mine'); await h.flush();
  }
  h.scheduler.event({ type: 'workbench.connected', seq: 3, windowId: 'B' }, 'mine'); await h.flush();
  assert.equal(h.reads(), 4);
  h.visible(false); h.pending(true); await h.advance(4_500); assert.equal(h.reads(), 7);
  h.pending(false); await h.advance(30_000); assert.equal(h.reads(), 7);
  h.scheduler.stop();
});

test('在途事件合并一次立即补读，补读期间变化延时承接，无持续空闲请求，停止后不补读', async () => {
  let release!: () => void;
  const h = harness(() => new Promise<void>(resolve => { release = resolve; }));
  h.scheduler.start();
  void h.scheduler.request(); void h.scheduler.request(); void h.scheduler.request();
  release(); await h.flush(); assert.equal(h.reads(), 2);
  void h.scheduler.request(); release(); await h.flush();
  assert.equal(h.reads(), 2);
  await h.advance(1_500); assert.equal(h.reads(), 3);
  h.scheduler.stop(); release(); await h.flush();
  assert.equal(h.timers.size, 0); await h.scheduler.request(); assert.equal(h.reads(), 3);
});
