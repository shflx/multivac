import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskService } from '../src/application/task-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture(options: { cancelHangs?: boolean; respondsToAbort?: boolean; networkError?: boolean } = {}) {
  const store = new SqliteAssistantStore(':memory:');
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {} });
  const events = new AssistantEventStream();
  let release!: (receipt: any) => void;
  let sends = 0;
  let cancels = 0;
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, events, requestIdleTimeoutMs: 100, stopTimeoutMs: 20,
    prepare: async () => ({ directory: { kind: 'task-isolated', path: '/test-only' }, baseline: null }),
    createSession: async () => {},
    runtime: () => ({ commands: {
      currentPromptCommandId: () => 'active',
      send: async (_command, delivery) => {
        sends++;
        events.publish({ type: 'assistant.command.handed_to_pi', cursor: '1', assistantSessionId: _command.assistantSessionId, commandId: _command.commandId, occurredAt: new Date().toISOString(), data: { dispatchMode: 'prompt' } } as any);
        if (options.networkError) throw new Error('ECONNRESET');
        return new Promise(resolve => {
          release = resolve;
          if (options.respondsToAbort) delivery?.signal?.addEventListener('abort', () => resolve({ terminalOutcome: 'cancelled' } as any), { once: true });
        });
      },
      cancel: async () => { cancels++; if (options.cancelHangs) return new Promise(() => {}); return {} as any; },
    } }),
  });
  const task = tasks.create({ commandId: 'create', title: '请求故障注入', goal: '核对' }).task;
  return { store, tasks, events, execution, task,
    current: () => tasks.get(task.taskId), run: () => store.taskRuns.get(tasks.get(task.taskId).currentRunId!)!,
    start: async () => { await execution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' }); await flush(); },
    release: () => release({ terminalOutcome: 'succeeded', piSessionId: 'pi', piEntryId: 'checkpoint' }),
    counts: () => ({ sends, cancels }), close: () => { execution.dispose(); store.close(); },
  };
}

for (const cancelHangs of [false, true]) test(`永久请求悬挂且取消${cancelHangs ? '悬挂' : '返回'}时，有界进入恢复并阻止重复执行`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = fixture({ cancelHangs });
  try {
    await f.start();
    t.mock.timers.tick(100); await flush();
    t.mock.timers.tick(20); await flush();
    assert.equal(f.current().status, 'recovery');
    assert.equal(f.run().requestTimeout?.phase, 'first-response');
    assert.equal(f.run().stopConfirmed, false);
    assert.equal(f.run().stopIntent, 'pause');
    assert.equal(f.current().pauseSource, 'environment');
    await assert.rejects(f.execution.control(f.task.taskId, { commandId: 'unsafe', revision: f.current().revision, action: 'resume' }), /尚未确认停止/);
    assert.deepEqual(f.counts(), { sends: 1, cancels: 1 });
    // 原请求迟到终结才补齐停止证据，不覆盖暂停，更不自动重试。
    f.release(); await f.execution.idle();
    assert.equal(f.run().stopConfirmed, true);
    assert.equal(f.current().status, 'paused');
    assert.equal(f.run().piEntryId, 'checkpoint');
    assert.equal(f.counts().sends, 1);
    const sessionId = f.run().sessionId;
    await f.execution.control(f.task.taskId, { commandId: 'user-resume', revision: f.current().revision, action: 'resume' }); await flush();
    assert.equal(f.counts().sends, 2);
    assert.equal(f.run().sessionId, sessionId);
    f.release(); await f.execution.idle();
  } finally { f.close(); }
});

test('响应取消的悬挂请求确认停止后暂停，正常网络错误直接失败收尾', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  for (const networkError of [false, true]) {
    const f = fixture({ respondsToAbort: true, networkError });
    try {
      await f.start();
      if (!networkError) { t.mock.timers.tick(100); await flush(); }
      await f.execution.idle();
      assert.equal(f.current().status, networkError ? 'failed' : 'paused');
      assert.equal(f.run().stopConfirmed, true);
      if (networkError) assert.match(f.current().reason, /ECONNRESET/);
    } finally { f.close(); }
  }
});

test('持续输出、长工具、原生工具和人工等待不误判，工具完成后重新计时', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = fixture();
  try {
    await f.start();
    let cursor = 1;
    const publish = (type: string, data: any) => f.events.publish({ type, data, cursor: String(++cursor), assistantSessionId: f.run().sessionId, commandId: f.run().commandId, occurredAt: new Date().toISOString() } as any);
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(90); publish('assistant.message.delta', { delta: '输出' }); }
    assert.equal(f.run().stopIntent, null);
    publish('assistant.tool.started', { toolCallId: 'tool', toolName: 'read' });
    t.mock.timers.tick(1000); await flush();
    assert.equal(f.run().stopIntent, null);
    publish('assistant.tool.ended', { toolCallId: 'tool', toolName: 'read', isError: false });
    f.execution.nativeLease(f.run().sessionId, 'starting', 'native', 0);
    t.mock.timers.tick(1000); await flush();
    assert.equal(f.run().stopIntent, null);
    f.execution.nativeLease(f.run().sessionId, 'settled', 'native', 0);
    let waiting = true;
    f.execution.setPendingRequest(() => waiting);
    t.mock.timers.tick(1000); await flush();
    assert.equal(f.run().stopIntent, null);
    waiting = false;
    publish('assistant.turn.started', {});
    t.mock.timers.tick(99); await flush();
    assert.equal(f.run().stopIntent, null);
    f.release(); await f.execution.idle();
    assert.equal(f.current().status, 'waiting');
    assert.equal(f.run().requestTimeout, undefined);
  } finally { f.close(); }
});

test('输出停滞记录阶段，用户取消意图不能被迟到成功覆盖', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = fixture();
  try {
    await f.start();
    f.events.publish({ type: 'assistant.message.delta', data: { delta: '输出' }, cursor: '2', assistantSessionId: f.run().sessionId, commandId: f.run().commandId, occurredAt: new Date().toISOString() } as any);
    t.mock.timers.tick(100); await flush();
    t.mock.timers.tick(20); await flush();
    assert.equal(f.run().requestTimeout?.phase, 'response-idle');
    const cancelling = f.execution.control(f.task.taskId, { commandId: 'user-cancel', revision: f.current().revision, action: 'cancel' });
    await flush(); f.release(); await cancelling; await f.execution.idle();
    assert.equal(f.current().status, 'cancelled');
    assert.equal(f.run().stopConfirmed, true);
  } finally { f.close(); }
});
