import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatus } from './session-status.js';

test('会话处理与阅读状态不借用任务完成状态', () => {
  assert.equal(sessionStatus().label, '已查看');
  assert.equal(sessionStatus({ messages: [{ trace: true, status: 'running' }] }).label, '处理中');
  assert.equal(sessionStatus({ messages: [{ trace: true, status: 'done' }, { text: '结果' }] }).label, '未查看');
  assert.equal(sessionStatus({ messages: [{ trace: true, status: 'done' }, { text: '结果' }], readCount: 2 }).label, '已查看');
});

test('等待授权仍为处理中，失败和取消也需要查看结果', () => {
  assert.equal(sessionStatus({ messages: [], readCount: 0 }, true).label, '处理中');
  for (const status of ['failed', 'cancelled']) {
    assert.equal(sessionStatus({ messages: [{ trace: true, status }] }).label, '未查看');
  }
});
