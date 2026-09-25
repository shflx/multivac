import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessageView } from '@multivac/contracts';
import {
  SESSION_CONTEXT_MAX_CHARS,
  SESSION_CONTEXT_MESSAGE_MAX_CHARS,
  buildSessionContext,
  sessionContextExcerpt,
} from '../src/modules/sessions/session-context.js';
import { renderSessionContextForModel } from '../src/runtime/executors/pi-quote-carriage.js';

function message(index: number, role: 'user' | 'assistant', text: string): AssistantMessageView {
  return {
    id: `m-${index}`, piSessionId: 'pi', piEntryId: `entry-${index}`, role, text,
    createdAt: '2026-09-25T00:00:00.000Z',
  };
}

test('会话上下文摘录最近几条消息并标明发言人', () => {
  const messages = Array.from({ length: 9 }, (_, index) =>
    message(index, index % 2 === 0 ? 'user' : 'assistant', `第 ${index + 1} 条`));
  assert.equal(sessionContextExcerpt(messages), [
    '助手：第 4 条', '用户：第 5 条', '助手：第 6 条', '用户：第 7 条', '助手：第 8 条', '用户：第 9 条',
  ].join('\n'));
  assert.equal(sessionContextExcerpt([]), '（该会话还没有消息）');
});

test('单条与总长度超限时截断，并从最早的消息开始舍弃', () => {
  const long = '长'.repeat(SESSION_CONTEXT_MESSAGE_MAX_CHARS + 50);
  const excerpt = sessionContextExcerpt(Array.from({ length: 6 }, (_, index) => message(index, 'user', long)));
  assert.ok(excerpt.length <= SESSION_CONTEXT_MAX_CHARS);
  assert.ok(excerpt.split('\n').every((line) => line.endsWith('…')));
});

test('交给模型的上下文说明来源会话且为用户数据', () => {
  const context = buildSessionContext('work-1', '梳理导航结构', [message(1, 'user', '先看顶栏')]);
  const rendered = renderSessionContextForModel(context);
  assert.match(rendered, /会话「梳理导航结构」/u);
  assert.match(rendered, /用户：先看顶栏/u);
  assert.match(rendered, /仅供理解上下文/u);
});
