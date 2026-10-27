import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { WorkbenchEventSchema, type AssistantPublicEvent } from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { subscribeModelSelectionLifecycle } from '../src/application/model-selection-events.js';

test('生命周期通知覆盖全局与工作会话，工具仅通知上下文，排除增量事件，解除订阅后停止发布', () => {
  const stream = new AssistantEventStream();
  const workbench = new WorkbenchEvents();
  const changes: unknown[] = [];
  const contextChanges: unknown[] = [];
  workbench.subscribe(event => { assert.ok(Check(WorkbenchEventSchema, event)); if (event.type === 'session-context.changed') contextChanges.push(event); else changes.push(event); });
  const stop = subscribeModelSelectionLifecycle(stream, workbench);
  let cursor = 0;
  const emit = (sessionId: string, type: string) => stream.publish({
    assistantSessionId: sessionId, type, cursor: String(++cursor), eventId: String(cursor), commandId: null,
    occurredAt: '2026-10-21T00:00:00.000Z', data: {},
  } as AssistantPublicEvent);
  const lifecycle = ['assistant.command.accepted', 'assistant.command.handed_to_pi', 'assistant.command.rejected',
    'assistant.command.reconciled', 'assistant.turn.started', 'assistant.turn.ended', 'assistant.run.processing',
    'assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled', 'assistant.retry.started',
    'assistant.retry.ended', 'assistant.compaction.started', 'assistant.compaction.ended'];
  for (const sessionId of ['global-coordinator', 'work-session']) {
    for (const type of lifecycle) emit(sessionId, type);
    for (const type of ['assistant.tool.started', 'assistant.tool.updated', 'assistant.tool.ended',
      'assistant.message.delta', 'assistant.thinking.delta', 'assistant.queue.updated']) emit(sessionId, type);
  }
  assert.equal(changes.length, lifecycle.length * 2);
  assert.equal(contextChanges.length, 4);
  assert.equal((changes[0] as { sessionId: string }).sessionId, 'global-coordinator');
  assert.equal((changes.at(-1) as { sessionId: string }).sessionId, 'work-session');
  stop(); emit('work-session', 'assistant.run.succeeded');
  assert.equal(changes.length, lifecycle.length * 2);
  assert.ok(Check(WorkbenchEventSchema, { type: 'model-selection.changed', seq: 1, sessionId: null }));
  assert.equal(Check(WorkbenchEventSchema, { type: 'model-selection.changed', seq: 1, sessionId: null, model: 'secret' }), false);
});
