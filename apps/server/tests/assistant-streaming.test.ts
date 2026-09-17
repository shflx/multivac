import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AssistantMessageView, AssistantPublicEvent, AssistantSessionPageResponse } from '@multivac/contracts';
import { SqliteAssistantStore, SqliteAssistantEventRepository, SqliteAssistantBindingRepository, SqliteAssistantCommandRepository } from '../src/storage/sqlite-assistant-store.js';
import { admitStreamingSnapshot, appendStreamingDelta, loadStreamingHistory, reconcileStreamingMessages } from '../../web/src/features/assistant/streaming-messages.js';

function delta(cursor: number, messageId: string, text: string): Extract<AssistantPublicEvent, { type: 'assistant.message.delta' }> {
  return {
    cursor: String(cursor), eventId: `event:${cursor}`, assistantSessionId: 'global-coordinator',
    commandId: null, occurredAt: '2026-09-17T00:00:00Z', type: 'assistant.message.delta',
    data: { piSessionId: 'pi-1', messageId, delta: text },
  };
}

const empty: AssistantSessionPageResponse = {
  assistantSessionId: 'global-coordinator', piSessionId: 'pi-1', messages: [],
  streamingMessages: [], hasMore: false, nextBefore: null, cursor: 'pi-1:empty', eventCursor: '0',
};

test('正文按多消息身份依次拼接，快照水位去重，迟到快照保留新增量', () => {
  let messages = appendStreamingDelta([], delta(1, 'assistant:1', '第一'));
  const snapshot = { ...empty, eventCursor: '1', streamingMessages: messages.map((message) => ({
    messageId: message.runtimeMessageId!, piSessionId: message.piSessionId,
    text: message.text, createdAt: message.createdAt,
  })) };
  messages = reconcileStreamingMessages([], snapshot);
  messages = appendStreamingDelta(messages, delta(1, 'assistant:1', '第一'));
  messages = appendStreamingDelta(messages, delta(2, 'assistant:1', '条'));
  messages = appendStreamingDelta(messages, delta(3, 'assistant:1:2', '第二条'));
  messages = reconcileStreamingMessages(messages, snapshot);
  assert.deepEqual(messages.map((message) => message.text), ['第一条', '第二条']);
  const completed = {
    ...messages[0]!, id: 'pi-1:entry-1', piEntryId: 'entry-1', text: '校准第一条',
  };
  delete completed.streamCursor;
  messages = reconcileStreamingMessages(messages, {
    ...empty, messages: [completed], eventCursor: '2', streamingMessages: [],
  });
  assert.deepEqual(messages.map((message) => message.text), ['校准第一条', '第二条']);
  messages = appendStreamingDelta(messages, delta(1, 'assistant:1', '重复'));
  assert.equal(messages[0]?.text, '校准第一条');
  messages = reconcileStreamingMessages(messages, { ...empty, messages: [completed], eventCursor: '4' }, ['pi-1:assistant:1:2']);
  assert.deepEqual(messages.map((message) => message.text), ['校准第一条']);
});

test('迟到恢复快照拒绝水位回退，保留历史身份排除同身份旧 stream', () => {
  const current = [{
    ...appendStreamingDelta([], delta(8, 'assistant:1', '完整正文'))[0]!,
    id: 'pi-1:entry-1', piEntryId: 'entry-1', streamCursor: undefined,
  }];
  const stale = { ...empty, eventCursor: '5', streamingMessages: [{
    piSessionId: 'pi-1', messageId: 'assistant:1', text: '完整', createdAt: current[0]!.createdAt,
  }] };
  assert.deepEqual(admitStreamingSnapshot(5, 8, 10), {
    admitted: false, historyCursor: 8, resumeCursor: 10,
  });
  assert.deepEqual(admitStreamingSnapshot(9, 8, 10), {
    admitted: true, historyCursor: 9, resumeCursor: 10,
  });
  const merged = reconcileStreamingMessages(current, stale);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.text, '完整正文');
  assert.equal(merged[0]?.streamCursor, undefined);
});

test('超过30条 replay 正文向前分页补齐历史，保持顺序并维护可达的最早分页边界', async () => {
  const history: AssistantMessageView[] = Array.from({ length: 112 }, (_, index) => ({
    id: `pi-1:entry-${index + 1}`, piSessionId: 'pi-1', piEntryId: `entry-${index + 1}`,
    role: 'assistant', runtimeMessageId: `assistant:${index + 1}`, text: `完整正文${index + 1}`,
    createdAt: '2026-09-17T00:00:00Z',
  }));
  const pageAt = (end: number): AssistantSessionPageResponse => ({
    ...empty, eventCursor: '200', messages: history.slice(Math.max(0, end - 30), end),
    hasMore: end > 30, nextBefore: end > 30 ? `entry-${end - 29}` : null,
  });
  let current = history.slice(42, 72);
  for (let number = 73; number <= 112; number += 1) {
    current = appendStreamingDelta(current, delta(number, `assistant:${number}`, `正文${number}`));
  }
  const latest = pageAt(112);
  // 在补读完成前，单个最新页不能让分页外已显示正文消失。
  const incomplete = reconcileStreamingMessages(current, latest);
  assert.equal(incomplete.filter((message) => Number(message.runtimeMessageId?.split(':')[1]) >= 73).length, 40);
  const requests: string[] = [];
  const snapshot = await loadStreamingHistory(current, latest, async (before) => {
    requests.push(before);
    return { ...pageAt(Number(before.slice(6)) - 1), eventCursor: '220' };
  }, () => true);
  assert.deepEqual(requests, ['entry-83', 'entry-53']);
  assert.equal(snapshot.page.eventCursor, '200');
  assert.equal(snapshot.page.hasMore, true);
  assert.equal(snapshot.page.nextBefore, 'entry-43');
  const merged = reconcileStreamingMessages(current, snapshot.page, snapshot.discardedStreamIds);
  assert.deepEqual(merged.map((message) => message.id), history.slice(42).map((message) => message.id));
  assert.equal(merged.some((message) => message.streamCursor !== undefined), false);
  assert.deepEqual(snapshot.discardedStreamIds, []);
});

test('无持久化替换的终态正文只在查至历史起点后移除，水位后的新增量不被旧结果移除', async () => {
  const current = appendStreamingDelta([], delta(1, 'missing', '正文'));
  const snapshot = await loadStreamingHistory(current, { ...empty, eventCursor: '2' },
    async () => { throw new Error('不应分页'); }, () => true);
  assert.deepEqual(snapshot.discardedStreamIds, ['pi-1:missing']);
  assert.deepEqual(reconcileStreamingMessages(current, snapshot.page, snapshot.discardedStreamIds), []);
  const newer = appendStreamingDelta(current, delta(3, 'missing', '新增'));
  assert.equal(reconcileStreamingMessages(newer, snapshot.page, snapshot.discardedStreamIds)[0]?.text, '正文新增');
});

test('SQLite 正文在重开数据库后恢复，重复源不重复，终态清除在途正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-streaming-'));
  const path = join(root, 'data.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    new SqliteAssistantBindingRepository(store).insertIfAbsent({
      assistantSessionId: 'global-coordinator', piSessionId: 'pi-1',
      piSessionPath: '/tmp/pi-1.jsonl', updatedAt: '2026-09-17T00:00:00Z',
    });
    let repository = new SqliteAssistantEventRepository(store);
    for (const event of [delta(1, 'assistant:1', '第一'), delta(2, 'assistant:1', '条'), delta(3, 'assistant:1:2', '第二条')]) {
      const input = {
        sourceKey: event.eventId, assistantSessionId: event.assistantSessionId,
        commandId: null, type: event.type, data: event.data, occurredAt: event.occurredAt,
      };
      assert.ok(repository.append(input));
      assert.equal(repository.append(input), null);
    }
    const snapshotCursor = repository.latestCursor();
    store.close();
    store = new SqliteAssistantStore(path);
    repository = new SqliteAssistantEventRepository(store);
    assert.equal(repository.latestCursor(), snapshotCursor);
    assert.equal(repository.streamingEvents('global-coordinator').length, 3);
    assert.deepEqual(repository.streamingEvents('other'), []);
    for (const type of ['assistant.run.failed', 'assistant.run.cancelled', 'assistant.run.succeeded'] as const) {
      repository.append({
        sourceKey: type, assistantSessionId: 'global-coordinator', commandId: null,
        type, data: {}, occurredAt: '2026-09-17T00:00:00Z',
      });
      assert.deepEqual(repository.streamingEvents('global-coordinator'), []);
      const event = delta(Number(repository.latestCursor()) + 1, 'next', '下次');
      repository.append({
        sourceKey: event.eventId, assistantSessionId: event.assistantSessionId, commandId: null,
        type: event.type, data: event.data, occurredAt: event.occurredAt,
      });
    }
    const commands = new SqliteAssistantCommandRepository(store);
    for (const commandId of ['old-run', 'new-run', 'interrupted-run']) {
      commands.createAccepted({ commandId, assistantSessionId: 'global-coordinator', kind: 'send',
        payloadFingerprint: commandId, piSessionId: 'pi-1' });
    }
    repository.append({ sourceKey: 'new-body', assistantSessionId: 'global-coordinator', commandId: 'new-run',
      type: 'assistant.message.delta', data: { piSessionId: 'pi-1', messageId: 'new-run-body', delta: '当前正文' },
      occurredAt: '2026-09-17T00:00:00Z' });
    repository.append({ sourceKey: 'old-terminal', assistantSessionId: 'global-coordinator', commandId: 'old-run',
      type: 'assistant.run.failed', data: {}, occurredAt: '2026-09-17T00:00:00Z' });
    assert.ok(repository.streamingEvents('global-coordinator').some((event) =>
      event.type === 'assistant.message.delta' && event.data.messageId === 'new-run-body'));
    repository.append({ sourceKey: 'interrupted-body', assistantSessionId: 'global-coordinator', commandId: 'interrupted-run',
      type: 'assistant.message.delta', data: { piSessionId: 'pi-1', messageId: 'interrupted-body', delta: '旧正文' },
      occurredAt: '2026-09-17T00:00:00Z' });
    commands.reconcile('interrupted-run', 'failed', { code: 'COMMAND_INTERRUPTED', message: '已中断' });
    assert.equal(repository.streamingEvents('global-coordinator').some((event) =>
      event.type === 'assistant.message.delta' && event.data.messageId === 'interrupted-body'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
