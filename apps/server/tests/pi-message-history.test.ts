import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { mapPiActiveBranch } from '../src/runtime/executors/pi-message-history.js';

const timestamp = '2026-09-14T08:00:00.000Z';

function entry(value: unknown): SessionEntry {
  return value as SessionEntry;
}

test('同时间戳正文身份计入不可见助手消息，历史去重不改变计数', () => {
  const hidden = entry({ type: 'message', id: 'hidden', timestamp,
    message: { role: 'assistant', timestamp: 9, content: [{ type: 'thinking', thinking: 'secret' }] } });
  const visible = ['second', 'third'].map((id) => entry({
    type: 'message', id, timestamp,
    message: { role: 'assistant', timestamp: 9, content: [{ type: 'text', text: id }] },
  }));
  assert.deepEqual(mapPiActiveBranch('pi-1', [hidden, hidden, ...visible])
    .map((message) => message.runtimeMessageId), ['assistant:9:2', 'assistant:9:3']);
});

test('Pi active branch 只映射 user/assistant 文本并按 path 稳定去重', () => {
  const entries = [
    entry({
      type: 'message', id: 'user-1', parentId: null, timestamp,
      message: {
        role: 'user', timestamp: 1,
        content: [{ type: 'text', text: '第一条' }, { type: 'image', data: 'secret', mimeType: 'image/png' }],
      },
    }),
    entry({ type: 'thinking_level_change', id: 'thinking-level', parentId: 'user-1', timestamp, thinkingLevel: 'high' }),
    entry({
      type: 'message', id: 'assistant-1', parentId: 'thinking-level', timestamp,
      message: {
        role: 'assistant', timestamp: 1, api: 'test', provider: 'test', model: 'model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        content: [
          { type: 'thinking', thinking: '隐藏推理' },
          { type: 'text', text: '第二条' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { secret: true } },
        ],
      },
    }),
    entry({
      type: 'message', id: 'tool-result', parentId: 'assistant-1', timestamp,
      message: { role: 'toolResult', timestamp: 1, toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: '隐藏工具结果' }], isError: false },
    }),
    entry({
      type: 'message', id: 'assistant-thinking-only', parentId: 'tool-result', timestamp,
      message: {
        role: 'assistant', timestamp: 1, api: 'test', provider: 'test', model: 'model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', content: [{ type: 'thinking', thinking: '仍然隐藏' }],
      },
    }),
    entry({ type: 'custom_message', id: 'custom', parentId: 'assistant-thinking-only', timestamp, customType: 'secret', content: '隐藏自定义消息', display: true }),
    entry({
      type: 'message', id: 'user-1', parentId: null, timestamp,
      message: { role: 'user', timestamp: 1, content: '重复条目' },
    }),
  ];

  assert.deepEqual(mapPiActiveBranch('pi-1', entries), [
    {
      id: 'pi-1:user-1',
      piSessionId: 'pi-1',
      piEntryId: 'user-1',
      role: 'user',
      text: '第一条',
      createdAt: timestamp,
    },
    {
      id: 'pi-1:assistant-1',
      piSessionId: 'pi-1',
      piEntryId: 'assistant-1',
      role: 'assistant',
      text: '第二条',
      createdAt: timestamp,
      runtimeMessageId: 'assistant:1',
    },
  ]);
});

test('跨会话引用从 details 还原来源会话，上下文 custom message 不进入可见历史', () => {
  const entries = [
    entry({
      type: 'custom_message', id: 'context-1', parentId: null, timestamp, customType: 'multivac.context',
      content: '用户当前正在工作区里查看会话「导航」', display: false,
      details: { version: 1, sessionId: 'work-1', title: '导航' },
    }),
    entry({
      type: 'custom_message', id: 'quote-1', parentId: 'context-1', timestamp, customType: 'multivac.quote',
      content: '用户引用了工作区会话「导航」中助手的回复的一段内容', display: false,
      details: {
        version: 1, sourceEntryId: 'source-entry', sourceRole: 'assistant', text: '顶栏只保留两个入口',
        sourcePiSessionId: 'pi-work-1', sourceSessionId: 'work-1', sourceTitle: '导航',
      },
    }),
    entry({
      type: 'message', id: 'user-1', parentId: 'quote-1', timestamp,
      message: { role: 'user', timestamp: 1, content: [{ type: 'text', text: '这个怎么落地？' }] },
    }),
  ];
  const [message] = mapPiActiveBranch('pi-global', entries);
  assert.equal(mapPiActiveBranch('pi-global', entries).length, 1);
  assert.deepEqual(message?.quote, {
    sourcePiSessionId: 'pi-work-1', sourcePiEntryId: 'source-entry', sourceRole: 'assistant',
    text: '顶栏只保留两个入口', sourceSessionId: 'work-1', sourceTitle: '导航',
  });
});
