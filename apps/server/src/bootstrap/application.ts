import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../application/assistant-session-service.js';
import { FakeCoordinatorAdapter } from '../runtime/executors/fake-coordinator-adapter.js';
import { PiCoordinatorAdapter } from '../runtime/executors/pi-coordinator-adapter.js';
import { resolveMultivacDataPaths } from '../storage/data-paths.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
} from '../storage/sqlite-assistant-store.js';
import { createMultivacHttpServer } from './server.js';

function runtimeConfig(environment: NodeJS.ProcessEnv): CoordinatorRuntimeConfig {
  return {
    systemPrompt: '你是 Multivac 的全局协调助手。',
    authorizedContext: [],
    model: {
      provider: environment.MULTIVAC_PROVIDER?.trim() || 'openai',
      modelId: environment.MULTIVAC_MODEL?.trim() || 'gpt-4.1-mini',
      thinkingLevel: 'off',
    },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 250 },
    compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 12_000 },
  };
}

function fakeHistory() {
  return Array.from({ length: 72 }, (_, index) => ({
    id: `fixture:${index + 1}`,
    piSessionId: 'fixture',
    piEntryId: `entry-${String(index + 1).padStart(3, '0')}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: index % 2 === 0
      ? `第 ${index + 1} 条历史请求：继续核对当前实现边界和恢复现场。`
      : `第 ${index + 1} 条历史回复：已记录当前进度，消息仍从 Pi active branch 读取。`,
    createdAt: new Date(Date.UTC(2026, 8, 14, 8, index)).toISOString(),
  }));
}

export function createMultivacApplication(environment: NodeJS.ProcessEnv = process.env) {
  const paths = resolveMultivacDataPaths(environment.MULTIVAC_DATA_DIR);
  const store = new SqliteAssistantStore(paths.databasePath);
  const adapter = environment.MULTIVAC_FAKE_ASSISTANT === '1'
    ? new FakeCoordinatorAdapter({ history: fakeHistory(), sessionPathRoot: paths.assistantSessionDir })
    : new PiCoordinatorAdapter({ sessionDir: paths.assistantSessionDir });
  const service = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    runtimeConfig: runtimeConfig(environment),
  });
  const server = createMultivacHttpServer({ service });

  return {
    server,
    paths,
    close() {
      adapter.dispose();
      store.close();
    },
  };
}
