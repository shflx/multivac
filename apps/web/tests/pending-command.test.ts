import assert from 'node:assert/strict';
import test from 'node:test';
import { isPendingCommand, parsePendingCommand, pendingDraftRestoration, sameCommand, type PendingCommand } from '../src/features/assistant/pending-command.js';

function pending(patch: Partial<PendingCommand> = {}): PendingCommand {
  return {
    commandId: 'send-1', generation: 2, text: '你好', quote: null, contextRefs: [], draftVersion: 5,
    cleared: true, unknown: false, streamingBehavior: null, ...patch,
  };
}

test('待对账命令按契约逐项校验：裸 commandId 迁移为旧格式，非法字段整体丢弃', () => {
  const legacy = parsePendingCommand('send-legacy');
  assert.deepEqual(legacy && { commandId: legacy.commandId, text: legacy.text, draftVersion: legacy.draftVersion }, { commandId: 'send-legacy', text: null, draftVersion: null });
  assert.equal(isPendingCommand(legacy), false);
  assert.equal(parsePendingCommand(JSON.stringify('send-quoted'))?.commandId, 'send-quoted');

  const restored = parsePendingCommand(JSON.stringify(pending({ imageIds: ['a'.repeat(64)] })));
  assert.equal(isPendingCommand(restored), true);
  assert.deepEqual(restored?.imageIds, ['a'.repeat(64)]);

  assert.equal(parsePendingCommand(JSON.stringify({ ...pending(), streamingBehavior: 'later' })), null);
  assert.equal(parsePendingCommand(JSON.stringify({ ...pending(), generation: -1 })), null);
  assert.equal(parsePendingCommand('{坏的 JSON'), null);
  // 被改写的引用不复用，按无引用处理。
  assert.equal(parsePendingCommand(JSON.stringify({ ...pending(), quote: { text: 1 } }))?.quote, null);
});

test('命令身份由 commandId 与发送代数共同确定', () => {
  assert.equal(sameCommand({ commandId: 'send-1', generation: 2 }, pending()), true);
  assert.equal(sameCommand({ commandId: 'send-1', generation: 1 }, pending()), false);
  assert.equal(sameCommand(null, pending()), false);
});

test('重新进入会话：已清稿命令清空同内容草稿，未清稿命令恢复到空草稿，新编辑不被覆盖', () => {
  const latestPrompt = { commandId: 'send-1', generation: 2 };
  const state = { draft: '你好', agentId: null, quote: null };
  assert.deepEqual(pendingDraftRestoration(pending(), state, { draftVersion: 5, latestPrompt }), { kind: 'clear' });
  // 草稿已有新编辑：迟到命令不能清除。
  assert.deepEqual(pendingDraftRestoration(pending(), { ...state, draft: '新的输入' }, { draftVersion: 5, latestPrompt }), { kind: 'keep' });
  // 版本已前进：一律保留。
  assert.deepEqual(pendingDraftRestoration(pending(), state, { draftVersion: 6, latestPrompt }), { kind: 'keep' });
  // 不是最近一次发送：不清稿。
  assert.deepEqual(pendingDraftRestoration(pending(), state, { draftVersion: 5, latestPrompt: { commandId: 'send-0', generation: 1 } }), { kind: 'keep' });

  const unsent = pending({ cleared: false });
  assert.deepEqual(pendingDraftRestoration(unsent, { draft: '', agentId: null, quote: null }, { draftVersion: 5, latestPrompt }), { kind: 'restore' });
  assert.deepEqual(pendingDraftRestoration(unsent, { draft: '已在输入', agentId: null, quote: null }, { draftVersion: 5, latestPrompt }), { kind: 'keep' });
  assert.deepEqual(pendingDraftRestoration(pending({ cleared: false, agentId: 'reviewer' }), { draft: '', agentId: 'other', quote: null }, { draftVersion: 5, latestPrompt }), { kind: 'keep' });
});
