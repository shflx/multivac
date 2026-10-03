import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantRunTraceView } from '@multivac/contracts';
import { sessionStatus, type SessionStatusInput } from '../src/features/assistant/session-status.js';
import { SessionReadState } from '../src/features/assistant/session-read-state.js';

function trace(commandId: string, status: AssistantRunTraceView['status'], cursor = '1'): AssistantRunTraceView {
  return { commandId, status, cursor, entries: [], thinkingTruncated: false, startedAt: '2026-01-01T00:00:00Z', endedAt: status === 'running' ? null : '2026-01-01T00:00:01Z' };
}
function session(patch: Partial<SessionStatusInput> = {}): SessionStatusInput {
  return { status: 'ready', runFeedback: { phase: 'idle', message: '' }, runFeedbackCommandId: null, runFeedbackAfterCursor: 0, runBusy: false, submitting: false, cancelling: false, runTraces: [], ...patch };
}

test('只呈现处理中、未查看、已查看三态；成功、失败和停止均按是否查看区分', () => {
  assert.equal(sessionStatus(undefined), null);
  assert.equal(sessionStatus(session({ status: 'error' })), null);
  assert.equal(sessionStatus(session())?.kind, 'viewed');
  assert.equal(sessionStatus(session({ runTraces: [trace('remote', 'running')] }), 99)?.kind, 'processing');
  for (const result of ['succeeded', 'failed', 'cancelled'] as const) {
    const ended = session({ runTraces: [trace('remote', result, '20')] });
    assert.equal(sessionStatus(ended, 19)?.kind, 'unread');
    assert.equal(sessionStatus(ended, 20)?.kind, 'viewed');
    assert.equal(sessionStatus(ended, 21)?.kind, 'viewed');
  }
});

test('每一轮都有独立未查看状态，旧命令反馈不遮盖远端新一轮', () => {
  const oldFeedback = { runFeedback: { phase: 'succeeded' as const, message: '处理完成' }, runFeedbackCommandId: 'old' };
  assert.equal(sessionStatus(session({ ...oldFeedback, runTraces: [trace('remote', 'running', '20')] }), 10)?.kind, 'processing');
  assert.equal(sessionStatus(session({ ...oldFeedback, runTraces: [trace('old', 'succeeded', '10'), trace('remote', 'failed', '20')] }), 10)?.kind, 'unread');
  assert.equal(sessionStatus(session({ ...oldFeedback, runTraces: [trace('remote', 'succeeded', '20')] }), 20)?.kind, 'viewed');
});

test('新提交尚无轨迹时保留处理状态，终态事实优先于旧的处理中反馈', () => {
  assert.equal(sessionStatus(session({ runFeedback: { phase: 'reconciling', message: '正在发送' }, runFeedbackCommandId: 'new', runFeedbackAfterCursor: 10, runBusy: true, runTraces: [trace('old', 'succeeded', '10')] }), 10)?.kind, 'processing');
  assert.equal(sessionStatus(session({ runFeedback: { phase: 'processing', message: '正在处理' }, runFeedbackCommandId: 'current', runBusy: true, runTraces: [trace('current', 'failed', '20')] }), 10)?.kind, 'unread');
  assert.equal(sessionStatus(session({ runFeedback: { phase: 'authorization', message: '等待授权' }, runTraces: [trace('current', 'running')] }))?.kind, 'processing');
});

test('发送被拒绝且没有运行轨迹时，结果仍可被标记为已查看', () => {
  const rejected = session({ runFeedback: { phase: 'failed', message: '发送失败' }, runFeedbackCommandId: 'rejected', runFeedbackAfterCursor: 10, runTraces: [trace('old', 'succeeded', '10')] });
  const result = sessionStatus(rejected, 10)!;
  assert.equal(result.kind, 'unread');
  assert.equal(sessionStatus(rejected, result.endedCursor!)?.kind, 'viewed');
});

test('阅读水位持久保存、跨窗口同步且不被旧事件回退，每个会话互不影响', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const first = new SessionReadState(() => storage);
  const other = new SessionReadState(() => storage);
  assert.equal(other.get('a'), 0);
  first.mark('a', 20);
  const [key, value] = [...data.entries()][0]!;
  other.sync(key, value);
  assert.equal(other.get('a'), 20);
  other.sync(key, '10');
  assert.equal(other.get('a'), 20);
  first.mark('a', 10);
  assert.equal(new SessionReadState(() => storage).get('a'), 20);
  assert.equal(first.get('b'), 0);
  other.mark('a', 30);
  first.mark('a', 25);
  assert.equal(first.get('a'), 30);
});

test('本机存储不可用时保留当前窗口的阅读状态', () => {
  const state = new SessionReadState(() => { throw new Error('存储不可用'); });
  assert.equal(state.get('a'), 0);
  state.mark('a', 20);
  assert.equal(state.get('a'), 20);
  state.mark('a', NaN);
  assert.equal(state.get('a'), 20);
});
