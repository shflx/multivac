import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitDecision, decisionLabel, groupToolMessages, resizePair } from './ui-state.js';

test('分隔线只调整相邻会话，保持总宽度和最小宽度', () => {
  const original = [480, 480, 480];
  assert.deepEqual(resizePair(original, 0, 80), [560, 400, 480]);
  assert.deepEqual(resizePair(original, 0, 1000), [640, 320, 480]);
  assert.deepEqual(resizePair(original, 1, -1000), [480, 320, 640]);
  assert.deepEqual(original, [480, 480, 480]);
  assert.deepEqual(resizePair([320, 320], 0, 20), [320, 320]);
});

test('澄清必须明确选择，自定义范围必须填写内容', () => {
  for (const choice of ['', 'other', 'custom']) assert.equal(canSubmitDecision('澄清', choice), false);
  assert.equal(canSubmitDecision('澄清', 'custom', '   '), false);
  assert.equal(canSubmitDecision('澄清', 'custom', '只使用公开摘要'), true);
  assert.equal(canSubmitDecision('澄清', 'allow'), true);
  assert.equal(canSubmitDecision('澄清', 'deny'), true);
});

test('验收和外发分别判断，不接受空修改意见或跨类型操作', () => {
  assert.equal(canSubmitDecision('验收', 'allow'), false);
  assert.equal(canSubmitDecision('验收', 'revise', ''), false);
  assert.equal(canSubmitDecision('验收', 'revise', '补齐失败状态'), true);
  assert.equal(canSubmitDecision('验收', 'accept'), true);
  assert.equal(canSubmitDecision('外发授权', 'accept'), false);
  assert.equal(canSubmitDecision('外发授权', 'deny'), true);
  assert.notEqual(decisionLabel('澄清', 'deny'), decisionLabel('外发授权', 'deny'));
});

test('同一次连续工具步骤归入一层，其他消息保持原顺序', () => {
  const messages = [
    { who: 'user', text: '检查代码' },
    { id: 'a', tool: true, groupId: 'run-1', groupLabel: '运行检查', status: 'running' },
    { id: 'b', tool: true, groupId: 'run-1', groupLabel: '运行检查', status: 'done' },
    { who: 'assistant', text: '检查完成' },
    { id: 'c', tool: true, groupId: 'run-2', status: 'cancelled' },
  ];
  const grouped = groupToolMessages(messages);
  assert.deepEqual(grouped.map(({ kind }) => kind), ['message', 'tools', 'message', 'tools']);
  assert.deepEqual(grouped[1].messages.map(({ id }) => id), ['a', 'b']);
  assert.equal(grouped[1].label, '运行检查');
  assert.deepEqual(grouped[3].messages.map(({ id }) => id), ['c']);
  assert.deepEqual(messages.map(({ id }) => id), [undefined, 'a', 'b', undefined, 'c']);
});
