import assert from 'node:assert/strict';
import test from 'node:test';
import type { VisibleAssistantMessage } from '../src/features/assistant/streaming-messages.js';
import { buildAssistantTimeline, type ToolExecution, type RunTrace } from '../src/features/assistant/tool-executions.js';
import { toolImageGroup } from '../src/features/assistant/tool-image-timeline.js';

const at = (second: number) => new Date(Date.UTC(2026, 10, 17, 0, 0, second)).toISOString();
function message(id: string, role: 'user' | 'assistant', second: number, extra: Partial<VisibleAssistantMessage> = {}): VisibleAssistantMessage {
  return { id, runtimeSessionId: 'pi', runtimeEntryId: id, role, text: id, createdAt: at(second), ...extra };
}
const image = (id: string, second: number) => message(id, 'assistant', second, { toolName: 'read', text: '模型专用提示', imageIds: [id] });
const tool = (id: string, second: number): ToolExecution => ({
  toolCallId: id, toolName: 'read', displayName: '读取文件', commandId: 'command', cursor: String(second),
  status: 'succeeded', summary: '读取完成', detail: null, isError: false, startedAt: at(second), endedAt: at(second + 1),
  detailState: 'absent', authorization: null,
});
const anchors = [{ commandId: 'command', runtimeEntryId: 'reply' }];
const shape = (timeline: ReturnType<typeof buildAssistantTimeline>) => timeline.map(item => item.kind === 'trace' ? 'trace' : item.message.id);

test('完整历史含工具和最终回复锚点：工具图片保留原消息身份，普通过程说明仍折叠', () => {
  const images = [image('image-a', 2), image('image-b', 4)];
  const timeline = buildAssistantTimeline([
    message('user', 'user', 0), message('note', 'assistant', 1), ...images, message('reply', 'assistant', 6),
  ], [tool('read-a', 1), tool('read-b', 3)], anchors, []);
  assert.deepEqual(shape(timeline), ['user', 'trace', 'image-a', 'image-b', 'reply']);
  const trace = timeline.find(item => item.kind === 'trace');
  assert.deepEqual(trace?.notes?.map(note => note.id), ['note']);
  assert.equal(trace?.tools.length, 2);
  assert.equal(trace?.replyFollows, true);
  assert.deepEqual(timeline.flatMap(item => item.kind === 'message' && item.message.toolName ? [item.message] : []), images);
  assert.deepEqual(toolImageGroup(timeline, 2, () => false), [2, 3]);
});

test('没有过程正文的已完成轮次仍显示两条工具图片，不产生只含模型提示的说明', () => {
  const timeline = buildAssistantTimeline([message('user', 'user', 0), image('image-a', 2), image('image-b', 4),
    message('reply', 'assistant', 6, { runtimeMessageId: 'assistant:reply' })],
  [tool('read-a', 1), tool('read-b', 3)], anchors, []);
  assert.deepEqual(shape(timeline), ['user', 'image-a', 'image-b', 'trace', 'reply']);
  assert.ok(timeline.filter(item => item.kind === 'trace').every(item => !item.notes?.length));
  assert.deepEqual(toolImageGroup(timeline, 1, () => false), [1, 2]);
});

test('带正文水位的工具图片也不能收进轨迹，普通说明按工具开始水位折叠', () => {
  const trace: RunTrace = {
    commandId: 'command', cursor: '8', status: 'succeeded', thinkingTruncated: false, startedAt: at(0), endedAt: at(8),
    entries: [
      { kind: 'message', cursor: '1', messageId: 'assistant:note' },
      { kind: 'tool', cursor: '2', toolCallId: 'read-a' },
      { kind: 'message', cursor: '3', messageId: 'assistant:image' },
      { kind: 'tool', cursor: '4', toolCallId: 'read-b' },
      { kind: 'message', cursor: '7', messageId: 'assistant:reply' },
    ],
  };
  const timeline = buildAssistantTimeline([
    message('user', 'user', 0), message('note', 'assistant', 1, { runtimeMessageId: 'assistant:note' }),
    { ...image('image-a', 3), runtimeMessageId: 'assistant:image' },
    message('reply', 'assistant', 7, { runtimeMessageId: 'assistant:reply' }),
  ], [tool('read-a', 2), tool('read-b', 4)], anchors, [trace]);
  assert.deepEqual(shape(timeline), ['user', 'trace', 'image-a', 'reply']);
  assert.deepEqual(timeline.find(item => item.kind === 'trace')?.notes?.map(note => note.id), ['note']);
});

test('运行中追加工具仍把先前正文收进轨迹，图片始终独立可见', () => {
  const history = [message('user', 'user', 0), image('image-a', 2),
    message('stream', 'assistant', 3, { commandId: 'command', streamCursor: 3 })];
  const running: RunTrace = { commandId: 'command', cursor: '3', status: 'running', thinkingTruncated: false,
    startedAt: at(0), endedAt: null, entries: [] };
  const first = buildAssistantTimeline(history, [tool('read-a', 1)], [], [running]);
  assert.ok(shape(first).includes('stream'));
  const next = buildAssistantTimeline([...history, image('image-b', 5)], [tool('read-a', 1), tool('read-b', 4)], [], [running]);
  assert.deepEqual(shape(next), ['user', 'trace', 'image-a', 'image-b']);
  assert.deepEqual(next.find(item => item.kind === 'trace')?.notes?.map(note => note.id), ['stream']);
});

test('分页窗口没有用户消息时也保留工具图片及顺序', () => {
  const timeline = buildAssistantTimeline([image('image-a', 2), image('image-b', 4), message('reply', 'assistant', 6)],
    [tool('read-a', 1), tool('read-b', 3)], anchors, []);
  assert.deepEqual(shape(timeline), ['image-a', 'image-b', 'trace', 'reply']);
  assert.deepEqual(toolImageGroup(timeline, 0, () => false), [0, 1]);
});

test('连续工具图片合组；普通文字与普通图片分别打断，组内成员不重复渲染', () => {
  const timeline = buildAssistantTimeline([image('a', 1), image('b', 2), message('text', 'assistant', 3),
    image('c', 4), message('ordinary-image', 'assistant', 5, { imageIds: ['photo'] }), image('d', 6)], [], [], []);
  assert.deepEqual(timeline.map((_, index) => toolImageGroup(timeline, index, () => false)), [[0, 1], [], [], [3], [], [5]]);
});

test('任务回应到达后从对应位置拆开图片组，不改变消息或来源身份', () => {
  const timeline = buildAssistantTimeline([image('a', 1), image('b', 2), image('c', 3)], [], [], []);
  assert.deepEqual(toolImageGroup(timeline, 0, () => false), [0, 1, 2]);
  const before = new Map([[1, ['已回应']]]);
  const breaks = (index: number) => before.has(index);
  assert.deepEqual(timeline.map((_, index) => toolImageGroup(timeline, index, breaks)), [[0], [1, 2], []]);
  assert.deepEqual(shape(timeline), ['a', 'b', 'c']);
});
