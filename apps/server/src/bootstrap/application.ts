import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { createFakeAssistantTestRequestHandler } from '../adapters/http/fake-assistant-test-routes.js';
import { AssistantSessionService } from '../application/assistant-session-service.js';
import { AssistantEventProjector } from '../application/assistant-event-projector.js';
import { AssistantEventStream } from '../application/assistant-event-stream.js';
import { AssistantTurnCommandService } from '../application/assistant-turn-command-service.js';
import { FakeCoordinatorAdapter } from '../runtime/executors/fake-coordinator-adapter.js';
import { PiCoordinatorAdapter } from '../runtime/executors/pi-coordinator-adapter.js';
import { resolveMultivacDataPaths } from '../storage/data-paths.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantCommandRepository,
  SqliteAssistantEventRepository,
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
  const failedFakePrompts = new Set<string>();
  const fakeAdapter = environment.MULTIVAC_FAKE_ASSISTANT === '1'
    ? new FakeCoordinatorAdapter({
        history: fakeHistory(),
        sessionPathRoot: paths.assistantSessionDir,
        promptDelayMs: Number(environment.MULTIVAC_FAKE_PROMPT_DELAY_MS ?? 180),
        promptScenarioResolver: (text) => {
          if (text.includes('压缩失败后最终失败')) return 'compactionFailureThenFailure';
          if (text.includes('压缩失败后成功')) return 'compactionFailureThenSuccess';
          if (text.includes('工具失败后最终失败')) return 'toolFailureThenFailure';
          if (text.includes('工具失败后成功')) return 'toolFailureThenSuccess';
          if (text.includes('失败场景') && !failedFakePrompts.has(text)) {
            failedFakePrompts.add(text);
            return 'failure';
          }
          if (text.includes('重试压缩场景')) return 'retryAndCompaction';
          return 'success';
        },
      })
    : null;
  const adapter = fakeAdapter ?? new PiCoordinatorAdapter({ sessionDir: paths.assistantSessionDir });
  const commandRepository = new SqliteAssistantCommandRepository(store);
  const eventRepository = new SqliteAssistantEventRepository(store);
  const eventStream = new AssistantEventStream();
  const service = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    eventRepository,
    runtimeConfig: runtimeConfig(environment),
  });
  const commandService = new AssistantTurnCommandService({
    sessionService: service,
    adapter,
    commandRepository,
    eventStream,
  });
  const projector = new AssistantEventProjector({
    adapter,
    eventRepository,
    eventStream,
    assistantSessionId: 'global-coordinator',
    currentPromptCommandId: () => commandService.currentPromptCommandId(),
  });
  const ready = service.initialize()
    .then(() => projector.start())
    .then(() => commandService.reconcileOnStartup());
  const testRequestHandler = environment.MULTIVAC_E2E_CONTROL === '1' && fakeAdapter
    ? createFakeAssistantTestRequestHandler({ adapter: fakeAdapter, eventRepository, eventStream })
    : undefined;
  const server = createMultivacHttpServer({
    service,
    commandService,
    eventRepository,
    eventStream,
    ...(testRequestHandler ? { testRequestHandler } : {}),
  });

  return {
    server,
    paths,
    ready,
    close() {
      projector.close();
      eventStream.clear();
      adapter.dispose();
      store.close();
    },
  };
}
