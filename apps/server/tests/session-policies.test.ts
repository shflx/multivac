import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoordinatorRuntimeConfig, SendAssistantMessageCommand, TaskRun } from '@multivac/contracts';
import { noteSessionPolicy, readingSessionPolicy, taskSessionPolicy, workSessionPolicy } from '../src/application/session-policies.js';

const runtimeConfig = { systemPrompt: '测试' } as unknown as CoordinatorRuntimeConfig;
const tools = { specs: [], validate: () => ({ ok: true, value: null }), invoke: async () => ({ ok: true, value: null }) } as never;
const prepareText = (text: string) => ({ text });

function command(patch: Partial<SendAssistantMessageCommand>): SendAssistantMessageCommand {
  return { commandId: 'command', assistantSessionId: 'session', text: '你好', contextRefs: [], ...patch } as SendAssistantMessageCommand;
}

test('笔记讨论：不开放工具与 Skill，发送只接受当前讨论的冻结正文快照', async () => {
  let available = true;
  const policy = noteSessionPolicy({
    sessionId: 'session', noteId: 'note', runtimeConfig,
    requireNote: () => { if (!available) throw new Error('笔记已删除'); },
    context: () => { throw new Error('快照不属于当前讨论。'); },
  });
  assert.equal(policy.internalTools, undefined);
  assert.equal(policy.prepareText, undefined);
  const snapshot = { kind: 'note', snapshotId: 'snapshot' } as never;
  assert.doesNotThrow(() => policy.authorizeSend!(command({ contextRefs: [snapshot] })));
  assert.throws(() => policy.authorizeSend!(command({ contextRefs: [snapshot], imageIds: ['image'] })), /不接受跨应用引用、图片/);
  assert.throws(() => policy.authorizeSend!(command({ contextRefs: [] })), /冻结正文快照/);
  available = false;
  assert.throws(() => policy.authorizeSend!(command({ contextRefs: [snapshot] })), /笔记已不可用/);
  await assert.rejects(policy.resolveContext!([snapshot]), /快照不属于当前讨论/);
});

test('书伴：只开放相邻页工具，原文来源必须属于当前书籍', () => {
  const policy = readingSessionPolicy({ sessionId: 'session', bookId: 'book', runtimeConfig, internalTools: tools, prepareText, contextForRefs: async () => ({}) as never });
  assert.equal(policy.internalTools, tools);
  const ref = (bookId: string) => ({ kind: 'book', reference: { bookId } }) as never;
  assert.doesNotThrow(() => policy.authorizeSend!(command({ contextRefs: [ref('book')] })));
  assert.throws(() => policy.authorizeSend!(command({ contextRefs: [ref('other')] })), /当前书籍/);
});

test('任务会话：仅受理本次运行自身的命令，拒绝用户直接发送与运行中追加，停止意图后拒绝', () => {
  const run = { runId: 'run', commandId: 'task-run:run', status: 'running', stopIntent: null, stopConfirmed: false } as TaskRun;
  let current = { run, task: { status: 'running', sessionId: 'session', currentRunId: 'run' } };
  const policy = taskSessionPolicy({
    sessionId: 'session', run, runtime: { runtimeConfig, resolveNewSessionRuntimeConfig: async () => runtimeConfig },
    internalTools: tools, prepareText, currentRun: () => current,
  });
  assert.doesNotThrow(() => policy.authorizeSend!(command({ commandId: 'task-run:run' })));
  assert.throws(() => policy.authorizeSend!(command({ commandId: 'other' })), /不接受直接发送/);
  assert.throws(() => policy.authorizeSend!(command({ commandId: 'follow-up', streamingBehavior: 'followUp' })), /不接受直接发送/);
  current = { ...current, run: { ...run, stopIntent: 'pause' } };
  assert.throws(() => policy.authorizeSend!(command({ commandId: 'task-run:run' })), /不允许推进/);
});

test('工作会话：开放工作会话工具并可单轮调用智能体，不额外限制发送', () => {
  const policy = workSessionPolicy({ runtimeConfig, internalTools: tools, prepareText, resolveAgentExecution: async () => { throw new Error('未调用'); } });
  assert.equal(policy.authorizeSend, undefined);
  assert.equal(policy.internalTools, tools);
  assert.equal(typeof policy.resolveAgentExecution, 'function');
});
