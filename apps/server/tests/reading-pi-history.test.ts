import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BookReference, CoordinatorRuntimeConfig } from '@multivac/contracts';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';

// 模型使用本机脚本，Pi 的上下文写入、持久化、恢复和历史投影全部走真实实现。
test('真实 Pi：阅读来源随各轮上下文持久化，恢复后用户与回答保留各自来源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-reading-history-'));
  const model = await startScriptedModel();
  const agentDir = join(root, 'agent'), cwd = join(root, 'work');
  const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir: join(root, 'sessions') });
  const config: CoordinatorRuntimeConfig = {
    systemPrompt: '只讨论引用原文。', authorizedContext: [], readingOnly: true,
    model: { provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
  };
  const reference: BookReference = {
    bookId: 'book-1', version: 'v1',
    start: { chapterId: 'c1', paragraphId: 'p1', offset: 0 },
    end: { chapterId: 'c1', paragraphId: 'p1', offset: 4 }, text: '真实原文',
  };
  const nextReference: BookReference = { ...reference, start: { ...reference.start, offset: 4 }, end: { ...reference.end, offset: 8 }, text: '后续原文' };
  try {
    await mkdir(cwd);
    await configureScriptedModel(agentDir, model.endpoint);
    const created = await adapter.createSession({ assistantSessionId: 'reading', config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.ok(created.ok, JSON.stringify(created));
    assert.deepEqual(created.value.activeToolNames, []);
    for (const source of [reference, nextReference]) {
      model.script({ text: `解释：${source.text}` });
      const run = await adapter.prompt('reading', '请解释', undefined, { kind: 'reading', title: '书', reference: source, excerpt: source.text, boundary: null, truncated: false });
      assert.ok(run.ok, JSON.stringify(run));
      assert.equal(run.value.status, 'completed');
    }
    const active = adapter.readActiveBranch('reading');
    assert.ok(active.ok);
    assert.deepEqual(active.value.messages.map(message => message.readingReference), [reference, reference, nextReference, nextReference]);
    assert.deepEqual(active.value.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(model.takeRequests().every(request => request.tools.length === 0));
    adapter.disposeSession('reading');
    const persisted = adapter.readPersistedHistory(created.value.binding, cwd);
    assert.ok(persisted.ok);
    assert.deepEqual(persisted.value.messages, active.value.messages);
    const restored = await adapter.continueSession({ binding: created.value.binding, config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.ok(restored.ok, JSON.stringify(restored));
    const history = adapter.readActiveBranch('reading');
    assert.ok(history.ok);
    assert.deepEqual(history.value.messages, active.value.messages);
  } finally {
    adapter.dispose();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
