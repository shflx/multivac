import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CoordinatorRuntimeConfig, NoteSnapshot } from '@multivac/contracts';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';

// 真实Pi写盘/恢复及历史投影；模型输出由回环脚本控制，不作为真实模型质量或访问验证。
test('真实Pi：笔记每轮快照随用户与回答写盘并恢复，模型无文件与命令工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-note-pi-history-'));
  const model = await startScriptedModel();
  const agentDir = join(root, 'agent'), cwd = join(root, 'work');
  const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir: join(root, 'sessions') });
  const config: CoordinatorRuntimeConfig = {
    systemPrompt: '仅讨论当前笔记，建议由用户决定。', authorizedContext: [], readingOnly: true,
    model: { provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
  };
  const first: NoteSnapshot = { id: 'snapshot-v1', noteId: 'note-a', sessionId: 'note-session', revision: 1, selection: { start: 0, end: 4, text: '第一原文' } };
  const second: NoteSnapshot = { ...first, id: 'snapshot-v2', revision: 2, selection: null };
  try {
    await mkdir(cwd);
    await configureScriptedModel(agentDir, model.endpoint);
    const created = await adapter.createSession({ assistantSessionId: 'note-session', config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.ok(created.ok, JSON.stringify(created));
    assert.deepEqual(created.value.activeToolNames, []);
    for (const snapshot of [first, second]) {
      model.script({ text: `讨论正文v${snapshot.revision}` });
      const run = await adapter.prompt('note-session', '解释这篇笔记', undefined, { kind: 'note', title: '当前笔记', body: snapshot.revision === 1 ? '第一原文。' : '后来修改的正文。', snapshot, topic: null });
      assert.ok(run.ok, JSON.stringify(run)); assert.equal(run.value.status, 'completed');
    }
    const active = adapter.readActiveBranch('note-session');
    assert.ok(active.ok);
    assert.deepEqual(active.value.messages.map(message => message.noteContext), [first, first, second, second]);
    assert.deepEqual(active.value.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    const requests = model.takeRequests();
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.tools.length === 0));
    assert.ok(JSON.stringify(requests[0]).includes('第一原文'));
    assert.ok(JSON.stringify(requests[1]).includes('后来修改的正文'));
    adapter.disposeSession('note-session');
    const persisted = adapter.readPersistedHistory(created.value.binding, cwd);
    assert.ok(persisted.ok); assert.deepEqual(persisted.value.messages, active.value.messages);
    const restored = await adapter.continueSession({ binding: created.value.binding, config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.ok(restored.ok, JSON.stringify(restored));
    const history = adapter.readActiveBranch('note-session');
    assert.ok(history.ok); assert.deepEqual(history.value.messages, active.value.messages);
  } finally {
    adapter.dispose(); await model.close(); await rm(root, { recursive: true, force: true });
  }
});
