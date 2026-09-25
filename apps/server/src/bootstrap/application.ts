import { GLOBAL_ASSISTANT_SESSION_ID, type CoordinatorRuntimeConfig } from '@multivac/contracts';
import { createFakeAssistantTestRequestHandler } from '../adapters/http/fake-assistant-test-routes.js';
import { AssistantSessionService, AssistantSessionServiceError } from '../application/assistant-session-service.js';
import { createNewSessionRuntimeConfigResolver } from '../application/new-session-runtime-config.js';
import { AssistantEventProjector } from '../application/assistant-event-projector.js';
import { AssistantEventStream } from '../application/assistant-event-stream.js';
import { AssistantTurnCommandService } from '../application/assistant-turn-command-service.js';
import { AssistantOperationLock } from '../application/assistant-operation-lock.js';
import { SessionModelSelectionService } from '../application/session-model-selection-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../application/session-runtimes.js';
import { WorkspaceSessionService } from '../application/workspace-session-service.js';
import { ModelSettingsService } from '../application/model-settings-service.js';
import { ModelAccessService } from '../application/model-access-service.js';
import { PiModelAccessBackend } from '../runtime/executors/pi-model-access-backend.js';
import { FakeModelAccessBackend } from '../runtime/executors/fake-model-access-backend.js';
import { FileModelAccessStore } from '../storage/file-model-access-store.js';
import { FakeCoordinatorAdapter } from '../runtime/executors/fake-coordinator-adapter.js';
import { PiCoordinatorAdapter } from '../runtime/executors/pi-coordinator-adapter.js';
import { FakeModelSettingsCatalogFactory } from '../runtime/executors/fake-model-settings-catalog.js';
import { PiModelSettingsCatalogFactory } from '../runtime/executors/pi-model-settings-catalog.js';
import { resolveMultivacDataPaths } from '../storage/data-paths.js';
import { FileModelSettingsStore } from '../storage/file-model-settings-store.js';
import { FileModelSelectionRecoveryRepository } from '../storage/file-model-selection-recovery-store.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantCommandRepository,
  SqliteAssistantEventRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
} from '../storage/sqlite-assistant-store.js';
import { createMultivacHttpServer } from './server.js';
import type { StoredModelSettingsState } from '../modules/model-settings/model-settings.js';
import type { ModelSettingsCatalogFactory } from '../modules/model-settings/model-settings.js';
import type { ModelAccessBackend } from '../modules/model-settings/model-access.js';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';

function runtimeConfig(environment: NodeJS.ProcessEnv): CoordinatorRuntimeConfig {
  return {
    systemPrompt: '你是 Multivac 的全局助手。',
    authorizedContext: [],
    model: {
      source: 'base',
      provider: environment.MULTIVAC_PROVIDER?.trim() || 'openai',
      modelId: environment.MULTIVAC_MODEL?.trim() || 'gpt-4.1-mini',
      thinkingLevel: 'off',
    },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 250 },
    compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 12_000 },
  };
}

/** 工作会话与全局 Multivac 使用同一套模型、重试与压缩配置，只替换角色说明。 */
function workRuntimeConfig(base: CoordinatorRuntimeConfig): CoordinatorRuntimeConfig {
  return { ...base, systemPrompt: '你是 Multivac 工作区中的工作会话助手，专注推进用户在本会话中安排的工作。' };
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

function fakeModelSettingsState(): StoredModelSettingsState {
  return {
    revision: 0,
    profiles: [{
      profileId: 'fixture-openai',
      displayName: 'GPT Fixture',
      provider: 'fixture',
      modelId: 'gpt-fixture',
      protocol: 'openai-responses',
      endpoint: 'https://fixture.example/v1',
    }, {
      profileId: 'fixture-anthropic',
      displayName: 'Claude Fixture',
      provider: 'fixture-anthropic',
      modelId: 'claude-fixture',
      protocol: 'anthropic-messages',
      endpoint: 'https://anthropic.fixture.example',
    }, {
      profileId: 'fixture-missing-auth',
      displayName: '未认证 Fixture',
      provider: 'missing-auth',
      modelId: 'missing-auth-model',
      protocol: 'openai-completions',
      endpoint: 'http://127.0.0.1:11434/v1',
    }],
    defaultProfileId: 'fixture-openai',
    commands: [],
  };
}

export interface MultivacApplicationOptions {
  coordinatorAdapter?: CoordinatorAdapter;
  modelAccessBackend?: ModelAccessBackend;
  modelSettingsCatalogFactory?: ModelSettingsCatalogFactory;
  modelAccessTimeoutMs?: number;
}
export function createMultivacApplication(environment: NodeJS.ProcessEnv = process.env, options: MultivacApplicationOptions = {}) {
  const paths = resolveMultivacDataPaths(environment.MULTIVAC_DATA_DIR);
  const store = new SqliteAssistantStore(paths.databasePath);
  const failedFakePrompts = new Set<string>();
  const fakeMode = environment.MULTIVAC_FAKE_ASSISTANT === '1';
  const fakeAccessBackend = fakeMode ? new FakeModelAccessBackend() : null;
  const fakeAdapter = fakeMode
    ? new FakeCoordinatorAdapter({
        history: fakeHistory(),
        // 只有全局会话带演示历史；新建的工作会话从空会话开始。
        seedsHistory: (assistantSessionId) => assistantSessionId === GLOBAL_ASSISTANT_SESSION_ID,
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
  const modelSettingsStore = new FileModelSettingsStore(paths.modelSettingsPath, fakeMode ? {
    initialState: fakeModelSettingsState(),
  } : undefined);
  const modelSettingsService = new ModelSettingsService(
    modelSettingsStore,
    options.modelSettingsCatalogFactory ?? (fakeMode
      ? new FakeModelSettingsCatalogFactory((provider) => fakeAccessBackend!.authenticated(provider))
      : new PiModelSettingsCatalogFactory({ candidateRoot: paths.modelCandidateDir })),
  );
  const modelAccessService = new ModelAccessService({
    settings: modelSettingsService, backend: options.modelAccessBackend ?? fakeAccessBackend ?? new PiModelAccessBackend(),
    store: new FileModelAccessStore(paths.modelAccessPath),
    ...(options.modelAccessTimeoutMs === undefined ? {} : { timeoutMs: options.modelAccessTimeoutMs }),
    ...(fakeAccessBackend ? { now: () => Date.now() + fakeAccessBackend.clockOffset } : {}),
  });
  const unsubscribeModelChanges = modelSettingsService.onConfigurationChanged(() => modelAccessService.configurationChanged());
  const adapter = options.coordinatorAdapter ?? fakeAdapter ?? new PiCoordinatorAdapter({ sessionDir: paths.assistantSessionDir });
  const commandRepository = new SqliteAssistantCommandRepository(store);
  const eventRepository = new SqliteAssistantEventRepository(store);
  const eventStream = new AssistantEventStream();
  const baseRuntimeConfig = runtimeConfig(environment);
  const selectionRepository = new SqliteSessionSelectionRepository(store);
  const operationLock = new AssistantOperationLock();
  const service = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    eventRepository,
    // 工具执行记录按命令锚点回填到所属 Turn，分页读取需要同一份回执视图。
    commandRepository,
    runtimeConfig: baseRuntimeConfig,
    selectionRepository,
    modelSelectionRecoveryRepository: new FileModelSelectionRecoveryRepository(
      paths.modelSelectionRecoveryDir,
    ),
    resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(modelSettingsService, baseRuntimeConfig),
    onInitialized: () => { commandService.reconcileStartupReceipts(); projector.start(); },
  });
  const commandService: AssistantTurnCommandService = new AssistantTurnCommandService({
    sessionService: service,
    adapter,
    commandRepository,
    eventStream,
    operationLock,
    validateSelectionForSend: () => selectionService.validateForSend(),
    withSelectionForSend: (dispatch) => selectionService.withSelectionForSend(dispatch),
  });
  const selectionService: SessionModelSelectionService = new SessionModelSelectionService({
    adapter, sessionService: service, repository: selectionRepository,
    settings: modelSettingsService, access: modelAccessService, lock: operationLock,
    isRunning: () => commandService.isRunning(),
  });
  // 工作会话的 Pi session 文件放在独立子目录：全局会话首次初始化会接续目录中最近的
  // session，不能误接到工作会话上。
  const workSessionDir = paths.workSessionDir;
  const workConfig = workRuntimeConfig(baseRuntimeConfig);
  const bindingRepository = new SqliteAssistantBindingRepository(store);
  const pageStateRepository = new SqliteAssistantPageStateRepository(store);
  interface WorkspaceSessionRuntime extends SessionRuntime {
    session: AssistantSessionService;
  }
  const sessionRuntimes = new SessionRuntimeRegistry<WorkspaceSessionRuntime>((record) => {
    const session = new AssistantSessionService({
      adapter,
      bindingRepository,
      pageStateRepository,
      eventRepository,
      commandRepository,
      runtimeConfig: workConfig,
      selectionRepository,
      kind: 'work',
      sessionDir: workSessionDir,
      assistantSessionId: record.sessionId,
      resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(modelSettingsService, workConfig),
    });
    return {
      sessionId: record.sessionId,
      session,
      initialize: () => session.initialize(),
      dispose: () => adapter.disposeSession(record.sessionId),
    };
  }, [{
    sessionId: GLOBAL_ASSISTANT_SESSION_ID,
    session: service,
    initialize: () => service.initialize(),
    dispose: () => undefined,
  }]);
  const workspaceSessionService = new WorkspaceSessionService({
    repository: new SqliteSessionRegistryRepository(store),
    runtimes: sessionRuntimes,
  });
  const projector = new AssistantEventProjector({
    adapter,
    eventRepository,
    eventStream,
    assistantSessionId: 'global-coordinator',
    currentPromptCommandId: () => commandService.currentPromptCommandId(),
  });
  const ready = modelSettingsService.initialize()
    .then(() => service.initialize())
    .then(() => commandService.reconcileOnStartup())
    .catch((error: unknown) => {
      // 未绑定且默认失效时仍发布管理接口；修复后首次成功初始化会安装事件投影。
      if (!(error instanceof AssistantSessionServiceError &&
        ['DEFAULT_MODEL_UNAVAILABLE', 'ASSISTANT_SESSION_UNAVAILABLE', 'ASSISTANT_SESSION_RECOVERY_FAILED', 'ASSISTANT_SESSION_BINDING_MISMATCH'].includes(error.code))) throw error;
    });
  const testRequestHandler = environment.MULTIVAC_E2E_CONTROL === '1' && fakeAdapter
    ? createFakeAssistantTestRequestHandler({
        adapter: fakeAdapter,
        eventRepository,
        eventStream,
        modelAccessService,
        fakeAccessBackend: fakeAccessBackend!,
        configureModelSelectionForTest: async (empty) => {
          const next = fakeModelSettingsState();
          if (empty) { next.profiles = []; next.defaultProfileId = null; }
          await modelSettingsService.replaceStateForTest(next);
        },
        reset: async () => {
          failedFakePrompts.clear();
          await modelAccessService.resetForTest();
          fakeAccessBackend!.reset();
          await modelSettingsService.replaceStateForTest(fakeModelSettingsState());
        },
      })
    : undefined;
  const server = createMultivacHttpServer({
    service,
    commandService,
    eventRepository,
    eventStream,
    modelSettingsService,
    modelAccessService,
    selectionService,
    workspaceSessionService,
    ...(testRequestHandler ? { testRequestHandler } : {}),
  });

  return {
    server,
    paths,
    ready,
    close() {
      unsubscribeModelChanges();
      void modelAccessService.close();
      projector.close();
      sessionRuntimes.releaseAll();
      eventStream.clear();
      adapter.dispose();
      store.close();
    },
  };
}
