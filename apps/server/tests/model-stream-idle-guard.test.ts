import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { ModelStreamIdleTimeoutError, idleGuardedFetch } from '../src/runtime/executors/model-stream-idle-guard.js';

const encoder = new TextEncoder();

/** 按给定间隔依次产出分块的上游正文；stallAfter 之后不再产出也不结束，模拟中转挂起。 */
function upstream(chunks: string[], options: { gapMs?: number; stallAfter?: number } = {}) {
  let index = 0, cancelled: unknown = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.stallAfter !== undefined && index >= options.stallAfter) return new Promise<void>(() => {});
      if (options.gapMs) await sleep(options.gapMs);
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[index++]!));
    },
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 });
  return { body, cancelled: () => cancelled };
}

const fetchOf = (body: ReadableStream<Uint8Array> | null) => (async () => new Response(body, { status: 200 })) as typeof fetch;

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += new TextDecoder().decode(chunk.value);
  }
}

test('上游在响应头后挂起时按空闲超时中断，取消原始连接并给出可重试的超时错误', async () => {
  const source = upstream(['data: a\n\n', 'data: b\n\n'], { stallAfter: 1 });
  const response = await idleGuardedFetch(fetchOf(source.body), 30)('http://model.test');
  const reader = response.body!.getReader();

  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: a\n\n');
  const error = await reader.read().then(() => null, (cause: unknown) => cause);
  assert.ok(error instanceof ModelStreamIdleTimeoutError);
  // Pi 的可重试判定按英文关键词匹配。
  assert.match(error.message, /timeout/i);
  assert.ok(source.cancelled() instanceof ModelStreamIdleTimeoutError);
});

test('分块间隔小于阈值时完整透传并正常结束', async () => {
  const source = upstream(['a', 'b', 'c'], { gapMs: 10 });
  const response = await idleGuardedFetch(fetchOf(source.body), 50)('http://model.test');
  assert.equal(await readAll(response), 'abc');
  assert.equal(source.cancelled(), null);
});

test('下游消费慢（背压）不计入空闲', async () => {
  const source = upstream(['a', 'b']);
  const response = await idleGuardedFetch(fetchOf(source.body), 20)('http://model.test');
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'a');
  await sleep(60);
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'b');
  assert.equal((await reader.read()).done, true);
});

test('不读取 body 时保留原响应的其他读取方式，无正文响应原样返回', async () => {
  const response = await idleGuardedFetch(fetchOf(upstream(['{"ok":true}']).body), 20)('http://model.test');
  assert.ok(response.body);
  assert.deepEqual(await response.json(), { ok: true });

  const empty = new Response(null, { status: 204 });
  assert.equal(await idleGuardedFetch((async () => empty) as typeof fetch, 20)('http://model.test'), empty);
});

test('下游取消时取消原始正文', async () => {
  const source = upstream(['a', 'b']);
  const response = await idleGuardedFetch(fetchOf(source.body), 20)('http://model.test');
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel('stop');
  assert.equal(source.cancelled(), 'stop');
  assert.equal(source.body.locked, false);
});

test('正常 EOF 和读失败都释放原始 reader，读错误保持原对象', async () => {
  const normal = upstream(['完整响应']);
  assert.equal(await readAll(await idleGuardedFetch(fetchOf(normal.body), 20)('http://model.test')), '完整响应');
  assert.equal(normal.body.locked, false);
  const failure = new Error('controlled read failure');
  const failed = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } });
  const guarded = await idleGuardedFetch(fetchOf(failed), 20)('http://model.test');
  await assert.rejects(guarded.body!.getReader().read(), error => error === failure);
  assert.equal(failed.locked, false);
});

test('读取在途时取消，等待源流取消完成再释放 reader，不产生空闲超时', async () => {
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const source = new ReadableStream<Uint8Array>({ cancel: () => stopped }, { highWaterMark: 0 });
  const response = await idleGuardedFetch(fetchOf(source), 20)('http://model.test');
  const reader = response.body!.getReader();
  const pending = reader.read();
  await Promise.resolve();
  let cancelled = false;
  const cancelling = reader.cancel('user stop').then(() => { cancelled = true; });
  assert.equal((await pending).done, true);
  assert.equal(cancelled, false); assert.equal(source.locked, true);
  release(); await cancelling;
  assert.equal(cancelled, true); assert.equal(source.locked, false);
});
