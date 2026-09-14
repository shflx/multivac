import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AssistantMessageView, CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
} from '../src/storage/sqlite-assistant-store.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是协调助手。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

const history: AssistantMessageView[] = [{
  id: 'fixture:entry-1',
  piSessionId: 'fixture',
  piEntryId: 'entry-1',
  role: 'assistant',
  text: '服务重启后仍从 Pi adapter 恢复。',
  createdAt: '2026-09-14T08:00:00.000Z',
}];

function createService(databasePath: string) {
  const store = new SqliteAssistantStore(databasePath);
  const adapter = new FakeCoordinatorAdapter({ history, sessionPathRoot: '/fake/restart' });
  const service = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    runtimeConfig: config,
  });
  return { store, adapter, service };
}

test('使用同一数据目录重启后恢复 binding、Pi 历史和页面状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-restart-'));
  const databasePath = join(root, 'data.sqlite');

  try {
    const first = createService(databasePath);
    const firstPage = await first.service.getSessionPage({ limit: 10 });
    const savedState = await first.service.putPageState({
      draft: '重启后草稿', anchorEntryId: 'entry-1', anchorOffsetPx: 9, revision: 0,
    });
    assert.equal(firstPage.messages[0]?.text, history[0]?.text);
    first.adapter.dispose();
    first.store.close();

    const second = createService(databasePath);
    const [secondPage, secondState] = await Promise.all([
      second.service.getSessionPage({ limit: 10 }),
      second.service.getPageState(),
    ]);
    assert.equal(secondPage.messages[0]?.text, history[0]?.text);
    assert.deepEqual(secondState, savedState);
    assert.equal(second.adapter.calls[0]?.method, 'continueSession');
    assert.equal(second.adapter.calls.some((call) => call.method === 'continueRecentSession'), false);
    second.adapter.dispose();
    second.store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
