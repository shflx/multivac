import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessageView } from '@multivac/contracts';
import {
  SESSION_CONTEXT_MAX_CHARS,
  SESSION_CONTEXT_MESSAGE_MAX_CHARS,
  buildProjectContext,
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

test('项目上下文写明主目录、其他目录与默认约束，交给模型时说明来源项目', () => {
  const project = {
    projectId: 'project-1', name: 'Multivac 开发',
    directories: [{ kind: 'mounted' as const, path: '/code/multivac' }, { kind: 'managed' as const, path: '/work/projects/资料' }],
    defaultConstraints: '', createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
  };
  const context = buildProjectContext(project);
  assert.equal(context.kind, 'focused-project');
  assert.equal(context.excerpt, ['目录：', '- 挂载 /code/multivac（主目录）', '- 托管 /work/projects/资料', '默认约束：（未设置）'].join('\n'));
  const rendered = renderSessionContextForModel(context);
  assert.match(rendered, /项目「Multivac 开发」/u);
  assert.match(rendered, /仅供理解上下文/u);
});
