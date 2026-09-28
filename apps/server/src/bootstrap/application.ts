import { homedir } from 'node:os';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorRuntimeConfig,
  type CoordinatorSessionContext,
} from '@multivac/contracts';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import {
  createFakeAssistantTestRequestHandler,
  E2E_RESTART_EXIT_CODE,
} from '../adapters/http/fake-assistant-test-routes.js';
import { AssistantSessionServiceError } from '../application/assistant-session-service.js';
import { createNewSessionRuntimeConfigResolver } from '../application/new-session-runtime-config.js';
import { AssistantEventStream } from '../application/assistant-event-stream.js';
import { SessionRuntimeRegistry } from '../application/session-runtimes.js';
import {
  AssistantSessionRuntime,
  type AssistantSessionRuntimeDependencies,
} from '../application/assistant-session-runtime.js';
import { WorkspaceSessionService } from '../application/workspace-session-service.js';
import { ProjectService } from '../application/project-service.js';
import { SessionWorkingDirectories } from '../application/session-working-directories.js';
import { ToolAuthorizationService } from '../application/tool-authorization-service.js';
import { PreferencesService } from '../application/preferences-service.js';
import { TempDirectoryCleaner } from '../application/temp-directory-cleaner.js';
import {
  createQuoteSourceResolver,
  createSessionContextResolver,
} from '../application/session-context-resolver.js';
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
import { resolveMultivacWorkPaths } from '../storage/work-paths.js';
import { DirectoryTrash, systemTrash } from '../storage/trash.js';
import {
  optionalEnvironmentValue,
  resolveToolAuthorizationTimeoutMs,
  resolveTrashDirectory,
} from '../environment.js';
import { FileModelSettingsStore } from '../storage/file-model-settings-store.js';
import { FileModelSelectionRecoveryRepository } from '../storage/file-model-selection-recovery-store.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantCommandRepository,
  SqliteAssistantEventRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqlitePreferenceRepository,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteTempDirectoryCleanupRepository,
  SqliteToolAuthorizationRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
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

/**
 * 栈式深入的子会话首轮承接父会话背景：选中内容与深入时的父会话摘录。
 * 父会话名取当前名称，父会话已不在时沿用深入时的名称。
 */
function parentContext(
  registry: SessionRegistryRepository,
  sessionId: string,
): CoordinatorSessionContext | undefined {
  const record = registry.get(sessionId);
  if (!record?.parentSessionId || !record.origin) return undefined;
  return {
    kind: 'parent-session',
    sessionId: record.parentSessionId,
    title: registry.get(record.parentSessionId)?.title ?? record.origin.parentTitle,
    excerpt: record.origin.parentExcerpt,
    selection: record.origin.text,
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
  /** 授权等待时限（毫秒）；优先于环境变量 MULTIVAC_TOOL_AUTHORIZATION_TIMEOUT_MS，缺省 30 分钟。 */
  toolAuthorizationTimeoutMs?: number;
}
export function createMultivacApplication(environment: NodeJS.ProcessEnv = process.env, options: MultivacApplicationOptions = {}) {
  const paths = resolveMultivacDataPaths(environment.MULTIVAC_DATA_DIR);
  // 工作文件根目录与内部数据目录分根；两者相互包含时在这里明确报错，服务不启动。
  const workPaths = resolveMultivacWorkPaths(optionalEnvironmentValue(environment.MULTIVAC_WORK_ROOT), paths.dataDir);
  // 到期的临时目录移到废纸篓：默认系统废纸篓，测试与 E2E 经 MULTIVAC_TRASH_DIR 指向临时目录。
  const trashDirectory = resolveTrashDirectory(environment.MULTIVAC_TRASH_DIR);
  const store = new SqliteAssistantStore(paths.databasePath);
  const eventStream = new AssistantEventStream();
  // 目录外访问的授权：所有会话共用一个授权服务，按会话 id 区分。启动时先把上一进程遗留的
  // 待授权请求置为已失效（原来的等待无法恢复，旧批准不得放行），再接受任何命令。
  const toolAuthorizationTimeoutMs = options.toolAuthorizationTimeoutMs ??
    resolveToolAuthorizationTimeoutMs(environment.MULTIVAC_TOOL_AUTHORIZATION_TIMEOUT_MS);
  const toolAuthorization = new ToolAuthorizationService({
    repository: new SqliteToolAuthorizationRepository(store),
    eventStream,
    // 请求关联发起它的那一轮（发送命令）；运行时在首次访问会话时创建。
    currentCommandId: (sessionId) => sessionRuntimes.get(sessionId)?.commands.currentPromptCommandId() ?? null,
    // “本项目内”的授权按会话当前所在的项目匹配；全局 Multivac 与默认工作区的会话不属于项目。
    projectOf: (sessionId) => {
      const record = sessionRegistry.get(sessionId);
      if (!record || record.kind !== 'work') return null;
      return workspaceRepository.get(record.workspaceId)?.project?.projectId ?? null;
    },
    // 记住的授权不覆盖用户主目录、工作文件根目录与内部数据目录（等于或包含它们的目录只能单次批准）。
    rememberBoundary: { homeDir: homedir(), workRoot: workPaths.workRoot, dataDir: paths.dataDir },
    ...(toolAuthorizationTimeoutMs === undefined ? {} : { timeoutMs: toolAuthorizationTimeoutMs }),
  });
  toolAuthorization.invalidateOnStartup();
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
        authorizeToolCall: toolAuthorization.authorize,
        // 服务重启后按绑定恢复的会话照常对账模型，E2E 可以验证重启相关的行为。
        persistSessionModels: true,
        promptScenarioResolver: (text) => {
          if (text.includes('越界写入场景')) return 'outsideWrite';
          if (text.includes('越界读取场景')) return 'outsideRead';
          if (text.includes('压缩失败后最终失败')) return 'compactionFailureThenFailure';
          if (text.includes('压缩失败后成功')) return 'compactionFailureThenSuccess';
          if (text.includes('工具失败后最终失败')) return 'toolFailureThenFailure';
          if (text.includes('工具失败后成功')) return 'toolFailureThenSuccess';
          if (text.includes('多步工具场景')) return 'multiStepTools';
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
  // 适配器在会话间共享，只固定 Pi session 文件目录（内部数据目录）；工作目录按会话传入。
  // 每个会话都注入目录边界扩展，文件工具越界时由授权服务生成请求并等待用户决定。
  const adapter = options.coordinatorAdapter ?? fakeAdapter ?? new PiCoordinatorAdapter({
    sessionDir: paths.assistantSessionDir,
    authorizeToolCall: toolAuthorization.authorize,
  });
  const commandRepository = new SqliteAssistantCommandRepository(store);
  const eventRepository = new SqliteAssistantEventRepository(store);
  const baseRuntimeConfig = runtimeConfig(environment);
  const selectionRepository = new SqliteSessionSelectionRepository(store);
  const runtimeDependencies: AssistantSessionRuntimeDependencies = {
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    commandRepository,
    eventRepository,
    selectionRepository,
    eventStream,
    modelSettingsService,
    modelAccessService,
  };
  const sessionRegistry = new SqliteSessionRegistryRepository(store);
  // 偏好保存在服务端；临时目录的清理计划随会话归档、恢复与归入项目登记或取消。
  const preferencesService = new PreferencesService(new SqlitePreferenceRepository(store));
  const cleanupPlans = new SqliteTempDirectoryCleanupRepository(store);
  // 会话对外提供之前补齐存量会话的工作目录：全局 Multivac 指向 multivac/，工作会话补建临时目录。
  const workingDirectories = new SessionWorkingDirectories(workPaths, sessionRegistry, paths.dataDir, { plans: cleanupPlans });
  workingDirectories.prepareOnStartup();
  // 每个会话的运行时都以会话记录中的工作目录为 cwd，每次创建或恢复 Pi 会话时重新读取。
  const workingDirectoryOf = (sessionId: string) => () => workingDirectories.resolveForRuntime(sessionId);
  // 全局协调会话常驻：启动时恢复，并且只有它可以接续目录中最近的 Pi session。
  // 它在 <工作文件根目录>/multivac/ 中执行，可以直接在其中完成轻工作。
  const coordinator = new AssistantSessionRuntime(runtimeDependencies, {
    sessionId: GLOBAL_ASSISTANT_SESSION_ID,
    kind: 'coordinator',
    runtimeConfig: baseRuntimeConfig,
    resolveWorkingDirectory: workingDirectoryOf(GLOBAL_ASSISTANT_SESSION_ID),
    resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(modelSettingsService, baseRuntimeConfig),
    modelSelectionRecoveryRepository: new FileModelSelectionRecoveryRepository(
      paths.modelSelectionRecoveryDir,
    ),
    // 工作区侧栏把当前焦点会话作为上下文交给全局 Multivac；解析时才用到下方的会话集合。
    resolveContext: (refs) => resolveCoordinatorContext(refs),
    resolveQuoteSource: (sessionId) => resolveQuoteSource(sessionId),
  });
  const { session: service, commands: commandService, selection: selectionService } = coordinator;
  // 工作会话的 Pi session 文件放在独立子目录：全局会话首次初始化会接续目录中最近的
  // session，不能误接到工作会话上。工作会话运行时在首次访问时创建，归档后释放。
  const workConfig = workRuntimeConfig(baseRuntimeConfig);
  const sessionRuntimes = new SessionRuntimeRegistry<AssistantSessionRuntime>((record) =>
    new AssistantSessionRuntime(runtimeDependencies, {
      sessionId: record.sessionId,
      kind: 'work',
      runtimeConfig: workConfig,
      resolveWorkingDirectory: workingDirectoryOf(record.sessionId),
      sessionDir: paths.workSessionDir,
      resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(modelSettingsService, workConfig),
      resolveQuoteSource: (sessionId) => resolveQuoteSource(sessionId),
      resolveInitialContext: async () => parentContext(sessionRegistry, record.sessionId),
    }), [coordinator]);
  // 项目与工作区：项目自动带一个同名工作区，项目托管目录在工作文件根目录的 projects/ 下。
  const workspaceRepository = new SqliteWorkspaceRepository(store);
  const projectRepository = new SqliteProjectRepository(store);
  const projectService = new ProjectService({
    projects: projectRepository,
    workspaces: workspaceRepository,
    workPaths,
    dataDir: paths.dataDir,
  });
  const workspaceSessionService = new WorkspaceSessionService({
    repository: sessionRegistry,
    workingDirectories,
    workspaces: workspaceRepository,
    sceneRepository: new SqliteWorkspaceSceneRepository(store),
    pageStateRepository: runtimeDependencies.pageStateRepository,
    runtimes: sessionRuntimes,
    tempRetentionDays: () => preferencesService.tempRetentionDays(),
    readSessionHistory: async (record) => {
      await sessionRuntimes.acquire(record).initialize();
      const snapshot = adapter.readActiveBranch(record.sessionId);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      return { piSessionId: snapshot.value.piSessionId, messages: snapshot.value.messages };
    },
  });
  // 临时目录的到期清理只在服务运行时进行：启动时补做一次到期检查，之后定时检查；
  // 修改保留时长后按新时长立即检查一次。Multivac 工作目录与项目目录永不清理。
  const tempDirectoryCleaner = new TempDirectoryCleaner({
    plans: cleanupPlans,
    registry: sessionRegistry,
    projects: projectRepository,
    paths: workPaths,
    dataDir: paths.dataDir,
    trash: trashDirectory
      ? new DirectoryTrash(trashDirectory)
      : systemTrash({ platform: process.platform, homeDir: homedir(), xdgDataHome: environment.XDG_DATA_HOME }),
    retentionDays: () => preferencesService.tempRetentionDays(),
    hasRuntime: (sessionId) => sessionRuntimes.get(sessionId) !== undefined,
  });
  tempDirectoryCleaner.start();
  const unsubscribePreferenceChanges = preferencesService.onChanged(() => tempDirectoryCleaner.sweepSafely());
  const sessionAccess = {
    resolveSession: (sessionId: string) => workspaceSessionService.resolve(sessionId),
    acquireRuntime: (record: Parameters<typeof sessionRuntimes.acquire>[0]) => sessionRuntimes.acquire(record),
    adapter,
  };
  const resolveCoordinatorContext = createSessionContextResolver({
    ownerSessionId: GLOBAL_ASSISTANT_SESSION_ID,
    ...sessionAccess,
  });
  // 跨会话引用：任一会话都可以引用工作区中其他会话已落入可读历史的消息。
  const resolveQuoteSource = createQuoteSourceResolver(sessionAccess);
  const resolveSession = (sessionId: string) => {
    const runtime = sessionRuntimes.acquire(workspaceSessionService.resolve(sessionId));
    return { service: runtime.session, commandService: runtime.commands, selectionService: runtime.selection };
  };
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
        toolAuthorization,
        tempDirectoryCleaner,
        restartProcess: () => process.exit(E2E_RESTART_EXIT_CODE),
        configureModelSelectionForTest: async (empty) => {
          const next = fakeModelSettingsState();
          if (empty) { next.profiles = []; next.defaultProfileId = null; }
          await modelSettingsService.replaceStateForTest(next);
        },
        reset: async () => {
          failedFakePrompts.clear();
          toolAuthorization.setTimeoutForTest(null);
          toolAuthorization.resetGrantsForTest();
          workspaceSessionService.resetForTest();
          projectService.resetForTest();
          workingDirectories.clearSessionsForTest();
          tempDirectoryCleaner.resetForTest();
          preferencesService.resetForTest();
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
    projectService,
    resolveSession,
    toolAuthorization: {
      service: toolAuthorization,
      requireSession: (sessionId) => { workspaceSessionService.resolve(sessionId); },
    },
    preferences: {
      preferences: preferencesService,
      tempDirectoryUsage: () => tempDirectoryCleaner.usage(),
    },
    ...(testRequestHandler ? { testRequestHandler } : {}),
  });

  return {
    server,
    paths,
    workPaths,
    ready,
    close() {
      unsubscribeModelChanges();
      unsubscribePreferenceChanges();
      tempDirectoryCleaner.stop();
      toolAuthorization.dispose();
      void modelAccessService.close();
      coordinator.dispose();
      sessionRuntimes.releaseAll();
      eventStream.clear();
      adapter.dispose();
      store.close();
    },
  };
}
