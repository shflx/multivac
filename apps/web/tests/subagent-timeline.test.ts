import assert from 'node:assert/strict';
import test from 'node:test';
import type { SubagentListItem, SubagentProcessEntry } from '@multivac/contracts';
import { subagentTimeline } from '../src/features/subagents/subagent-timeline.js';

const item = (overrides: Partial<SubagentListItem> = {}) => ({ id: 'run', parentCommandId: 'cmd', status: 'succeeded', stopConfirmed: true,
  startedAt: '2026-11-07T00:00:00.000Z', createdAt: '2026-11-07T00:00:00.000Z', endedAt: '2026-11-07T00:01:00.000Z', ...overrides }) as SubagentListItem;
const entries: SubagentProcessEntry[] = [
  { id: 'u', role: 'user', text: '委派输入' },
  { id: 't', role: 'thinking', text: '先看看' },
  { id: 'b1', role: 'tool', toolName: 'bash', toolCallId: 'c1', phase: 'input', text: JSON.stringify({ command: 'npm test', timeout: 60 }) },
  { id: 'b2', role: 'tool', toolName: 'bash', toolCallId: 'c1', phase: 'output', text: 'ok' },
  { id: 'n', role: 'assistant', text: '环境正常，继续读源码。' },
  { id: 'r1', role: 'tool', toolName: 'read', toolCallId: 'c2', phase: 'input', text: JSON.stringify({ path: 'src/a.ts' }) },
  { id: 'a', role: 'assistant', text: '结论' },
];

test('委派过程整理为一轮会话：输入、含过程说明的轨迹与最终回复', () => {
  const timeline = subagentTimeline(item(), entries);
  assert.equal(timeline.input?.text, '委派输入');
  assert.equal(timeline.reply?.text, '结论');
  assert.deepEqual(timeline.trace?.entries.map(entry => entry.kind), ['thinking', 'tool', 'thinking', 'tool']);
  assert.deepEqual(timeline.records.map(record => [record.detail, record.status]), [['运行 npm test', 'succeeded'], ['读取 src/a.ts', 'failed']]);
});

test('执行中缺少输出的工具显示为运行中，最后的过程说明不当作回复', () => {
  const timeline = subagentTimeline(item({ status: 'running', stopConfirmed: false, endedAt: null }), entries.slice(0, 6));
  assert.equal(timeline.reply, null);
  assert.equal(timeline.trace?.status, 'running');
  assert.equal(timeline.records.at(-1)?.status, 'running');
});
