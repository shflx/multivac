import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { SendAssistantMessageCommandSchema, type AssistantExecutor } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

const executor: AssistantExecutor = { agentId: 'reviewer', revision: 2, name: '代码审查', modelProfileId: 'test', modelName: '测试模型', provider: 'test', modelId: 'test', thinkingLevel: 'high' };

test('发送只接受稳定智能体身份，拒绝客户端执行快照与仅标记消息', () => {
  const command = { commandId: 'send-1', assistantSessionId: 'work-1', text: '审查 user@example.com 和 @代码审查', contextRefs: [], agentId: 'reviewer' };
  assert.equal(Check(SendAssistantMessageCommandSchema, command), true);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...command, executor }), false);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...command, text: '' }), false);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...command, text: '', imageIds: ['a'.repeat(64)] }), true);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...command, agentId: ['reviewer', 'general'] }), false);
});

test('草稿选择与私有执行快照落盘；历史锚点保留当时名称与模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-agent-contract-'));
  const path = join(directory, 'data.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    store.bindings.insertIfAbsent({ assistantSessionId: 'work-1', piSessionId: 'pi-1', piSessionPath: join(directory, 'pi-1.jsonl'), updatedAt: '2026-10-15T00:00:00.000Z' });
    const draft = store.pageStates.save('work-1', { draft: '正文', agentId: 'reviewer', quote: null, anchorEntryId: null, anchorOffsetPx: 0, revision: 0 });
    assert.equal(draft.agentId, 'reviewer');
    store.commands.createAccepted({ commandId: 'send-1', assistantSessionId: 'work-1', kind: 'send', payloadFingerprint: 'fixed', piSessionId: 'pi-1', agentExecution: { executor, instructions: '固定指令', model: { provider: 'test', modelId: 'test', thinkingLevel: 'high' } } });
    store.commands.preparePromptAnchor('send-1', null);
    store.commands.anchorPrompt('send-1', 'entry-1');
    store.close();
    store = new SqliteAssistantStore(path);
    assert.equal(store.pageStates.get('work-1').agentId, 'reviewer');
    assert.deepEqual(store.commands.get('send-1')?.executor, executor);
    assert.equal(store.commands.get('send-1')?.agentExecution?.instructions, '固定指令');
    assert.deepEqual(store.commands.listCommandAnchors('work-1')[0]?.executor, executor);
    assert.equal(store.pageStates.get('legacy').agentId ?? null, null);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
