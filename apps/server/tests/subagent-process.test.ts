import test from 'node:test';
import assert from 'node:assert/strict';
import { piExecutionProcess } from '../src/runtime/executors/pi-execution-process.js';

test('Pi 独立过程保留有序工具输入输出与消息，不包含配置或凭据条目', () => {
  const output = '工具返回\n'.repeat(2000);
  const entries = piExecutionProcess([
    { type: 'model_change', id: 'config', secret: '不公开' },
    { type: 'message', id: 'user', message: { role: 'user', content: '目标数据' } },
    { type: 'message', id: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '核对条件' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a.ts' } }] } },
    { type: 'message', id: 'result', message: { role: 'toolResult', toolName: 'read', toolCallId: 'call', content: [{ type: 'text', text: output }] } },
    { type: 'message', id: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: '有界结论' }] } },
  ]);
  assert.deepEqual(entries.map(item => item.role), ['user', 'thinking', 'tool', 'tool', 'assistant']);
  assert.equal(entries[3]!.text, output); assert.equal(entries[2]!.phase, 'input'); assert.equal(entries[3]!.phase, 'output');
  assert.equal(entries[2]!.toolCallId, entries[3]!.toolCallId);
  assert.ok(!JSON.stringify(entries).includes('不公开'));
});
