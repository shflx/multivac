import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmRequests, type ConfirmRequestOptions } from '../src/components/confirm-requests.js';
import { wrapFocusIndex } from '../src/components/focus-trap.js';

interface Options extends ConfirmRequestOptions {
  title: string;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('确认与取消分别结算为 true / false，结算后卡片关闭', async () => {
  const requests = new ConfirmRequests<Options>();
  let notified = 0;
  requests.subscribe(() => { notified += 1; });

  const accepted = requests.request({ title: '归档' });
  const shown = requests.snapshot();
  assert.equal(shown?.options.title, '归档');
  assert.equal(shown?.busy, false);
  assert.equal(shown?.error, '');
  // 快照在状态不变时保持同一引用。
  assert.equal(requests.snapshot(), shown);
  await requests.accept();
  assert.equal(await accepted, true);
  assert.equal(requests.snapshot(), null);

  const cancelled = requests.request({ title: '撤销' });
  assert.notEqual(requests.snapshot()?.id, shown?.id);
  requests.cancel();
  assert.equal(await cancelled, false);
  assert.equal(requests.snapshot(), null);
  assert.equal(notified, 4);
});

test('同一时刻只有一张卡：打开期间的新请求直接按取消结算，不顶替正在显示的卡', async () => {
  const requests = new ConfirmRequests<Options>();
  const first = requests.request({ title: '第一张' });
  assert.equal(await requests.request({ title: '第二张' }), false);
  assert.equal(requests.snapshot()?.options.title, '第一张');
  await requests.accept();
  assert.equal(await first, true);
});

test('异步确认：执行期间忙碌且不可取消，成功后才结算为 true', async () => {
  const requests = new ConfirmRequests<Options>();
  const gate = deferred();
  let calls = 0;
  const result = requests.request({ title: '归档', action: () => { calls += 1; return gate.promise; } });

  const accepting = requests.accept();
  assert.equal(requests.snapshot()?.busy, true);
  requests.cancel();
  await requests.accept();
  assert.equal(calls, 1, '忙碌时重复确认不会再次执行');
  assert.notEqual(requests.snapshot(), null, '忙碌时取消无效');

  gate.resolve();
  await accepting;
  assert.equal(await result, true);
  assert.equal(requests.snapshot(), null);
});

test('异步确认失败：卡片留在原处显示原因，可以重试成功，也可以取消', async () => {
  const requests = new ConfirmRequests<Options>();
  let attempts = 0;
  const retried = requests.request({
    title: '归档',
    action: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('会话正在运行，请先停止后再归档。');
    },
  });

  await requests.accept();
  assert.deepEqual(
    { busy: requests.snapshot()?.busy, error: requests.snapshot()?.error },
    { busy: false, error: '会话正在运行，请先停止后再归档。' },
  );
  await requests.accept();
  assert.equal(attempts, 2);
  assert.equal(await retried, true);

  const cancelled = requests.request({ title: '归档', action: () => Promise.reject('不是 Error') });
  await requests.accept();
  assert.equal(requests.snapshot()?.error, '操作没有完成，请重试。');
  requests.cancel();
  assert.equal(await cancelled, false);
});

test('宿主卸载时仍在显示的确认按取消结算，之后仍可发起新的确认', async () => {
  const requests = new ConfirmRequests<Options>();
  const pending = requests.request({ title: '离开' });
  requests.dispose();
  assert.equal(await pending, false);
  assert.equal(requests.snapshot(), null);

  const next = requests.request({ title: '再次离开' });
  await requests.accept();
  assert.equal(await next, true);
});

test('Tab 在模态层内循环：首尾相接，焦点不在其中时从头或尾进入', () => {
  // 中间位置交给浏览器按顺序移动。
  assert.equal(wrapFocusIndex(3, 1, false), null);
  assert.equal(wrapFocusIndex(3, 1, true), null);
  // 最后一个再 Tab 回到第一个，第一个 Shift+Tab 回到最后一个。
  assert.equal(wrapFocusIndex(3, 2, false), 0);
  assert.equal(wrapFocusIndex(3, 0, true), 2);
  // 焦点在卡片容器上。
  assert.equal(wrapFocusIndex(2, -1, false), 0);
  assert.equal(wrapFocusIndex(2, -1, true), 1);
  // 只有一个可聚焦元素时停在原处。
  assert.equal(wrapFocusIndex(1, 0, false), 0);
  // 没有可聚焦元素时也不放焦点出去。
  assert.equal(wrapFocusIndex(0, -1, false), -1);
});
