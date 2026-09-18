import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { waitForServerReady } from './dev-readiness.mjs';

test('后端尚未就绪或消息不匹配时不放行，监听成功才启动前端', async () => {
  const server = new EventEmitter();
  let started = false;
  const ready = waitForServerReady(server).then(() => { started = true; });
  server.emit('message', null);
  server.emit('message', { type: 'other' });
  await Promise.resolve();
  assert.equal(started, false);
  server.emit('message', { type: 'multivac.ready' });
  await ready;
  assert.equal(started, true);
  assert.equal(server.listenerCount('message'), 0);
  assert.equal(server.listenerCount('exit'), 0);
  assert.equal(server.listenerCount('error'), 0);
});

test('后端就绪前退出时拒绝启动前端并释放监听器', async () => {
  const server = new EventEmitter();
  const ready = waitForServerReady(server);
  server.emit('exit', 1, null);
  await assert.rejects(ready, /后端在就绪前退出/);
  assert.equal(server.listenerCount('message'), 0);
});

test('后端就绪前被停止时不放行', async () => {
  const server = new EventEmitter();
  const ready = waitForServerReady(server);
  server.emit('exit', null, 'SIGTERM');
  await assert.rejects(ready, /SIGTERM/);
});

test('进程启动失败时传播错误，不启动前端', async () => {
  const server = new EventEmitter();
  const ready = waitForServerReady(server);
  server.emit('error', new Error('spawn failed'));
  await assert.rejects(ready, /spawn failed/);
  assert.equal(server.listenerCount('message'), 0);
});
