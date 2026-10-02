import { homedir } from 'node:os';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorRuntimeConfig,
  type CoordinatorSessionContext,
  type Workspace,
} from '@multivac/contracts';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import {
  createFakeAssistantTestRequestHandler,
  E2E_RESTART_EXIT_CODE,
} from '../adapters/http/fake-assistant-test-routes.js';
import { AssistantSessionServiceError } from '../application/assistant-session-service.js';
import { createNewSessionRuntimeConfigResolver } from '../application/new-session-runtime-config.js';
import { AssistantEventStream } from '../application/assistant-event-stream.js';
import { WorkbenchEvents } from '../application/workbench-events.js';
import type { AssistantTurnCommandService } from '../application/assistant-turn-command-service.js';
import { SessionRuntimeRegistry } from '../application/session-runtimes.js';
import {
  AssistantSessionRuntime,
  type AssistantSessionRuntimeDependencies,
} from '../application/assistant-session-runtime.js';
import { WorkspaceSessionService } from '../application/workspace-session-service.js';
import { ProjectService } from '../application/project-service.js';
import { SessionWorkingDirectories } from '../application/session-working-directories.js';
import { ToolAuthorizationService } from '../application/tool-authorization-service.js';
import {
  InternalToolService,
  MULTIVAC_INTERNAL_TOOLS,
  type InternalToolServices,
  type InternalToolTurn,
} from '../application/internal-tools/index.js';
import { ProposalService } from '../application/proposals/proposal-service.js';
import {
  exampleProposeRenameSessionTool,
  exampleRenameSessionKind,
  type ExampleRenameSessionDependencies,
} from '../application/proposals/example-rename-session.js';
import {
  createProjectKind,
  mountDirectoryKind,
  moveSessionToProjectKind,
  setPrimaryDirectoryKind,
  unmountDirectoryKind,
  type MoveSessionProposalDependencies,
  type ProjectProposalDependencies,
} from '../application/proposals/project-proposals.js';
import { PreferencesService } from '../application/preferences-service.js';
import { SessionTranscriptReader } from '../application/session-transcripts.js';
import { TempDirectoryRemovalPolicy } from '../application/temp-directory-removal.js';
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
  SqliteInternalToolCallRepository,
  SqlitePreferenceRepository,
  SqliteProjectRepository,
  SqliteProposalRepository,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteTempDirectoryCleanupRepository,
  SqliteToolAuthorizationRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../storage/sqlite-assistant-store.js';
import { createMultivacHttpServer } from './server.js';
import { SessionFilesService } from '../application/session-files-service.js';
import { MessageFileSources } from '../application/message-file-sources.js';
import { SqliteMessageFileSourceRepository } from '../storage/sqlite-assistant-store.js';
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
 * 栈式子会话首轮承接父会话背景：新建时的父会话摘录，以及（从选中内容深入时）选中内容。
 * 父会话名取当前名称，父会话已不在时沿用新建时的名称。
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
    ...(record.origin.text === undefined ? {} : { selection: record.origin.text }),
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
  // 工作台变更事件：会话、项目、工作区现场与记住的授权在各服务中变更后发布，经全局事件流推给各窗口。
  const workbenchEvents = new WorkbenchEvents();
  // 目录外访问的授权：所有会话共用一个授权服务，按会话 id 区分。启动时先把上一进程遗留的
  // 待授权请求置为已失效（原来的等待无法恢复，旧批准不得放行），再接受任何命令。
  const toolAuthorizationTimeoutMs = options.toolAuthorizationTimeoutMs ??
    resolveToolAuthorizationTimeoutMs(environment.MULTIVAC_TOOL_AUTHORIZATION_TIMEOUT_MS);
  const toolAuthorization = new ToolAuthorizationService({
    repository: new SqliteToolAuthorizationRepository(store),
    eventStream,
    workbenchEvents,
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
          // 按脚本调用全局 Multivac 的内部工具：消息中每行“内部工具：<名称> <JSON 参数>”各调用一次。
          if (text.includes('内部工具：')) return 'internalTools';
          // 把这一轮随发送收到的服务端通知（提议的结果）原样写进回复，用来观察通知是否送达。
          if (text.includes('复述服务端通知')) return 'serverNotice';
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
  // 全局 Multivac 的内部工具：只注入全局 Multivac 的运行时（工作会话不带），调用走与界面相同的服务。
  // 服务在下方创建，工具只在调用时才用到它们。
  const internalToolServices: InternalToolServices = {
    projects: {
      listWorkspaces: () => projectService.listWorkspaces(),
      listProjects: () => projectService.listProjects(),
      // 只改名、只改默认约束：不扩大权限的管理动作；修改目录的更新与新建项目只在下方的提议种类中。
      renameProject: (projectId, name, origin) => projectService.renameProject(projectId, name, origin),
      setDefaultConstraints: (projectId, text, origin) => projectService.setDefaultConstraints(projectId, text, origin),
    },
    sessions: {
      list: (listOptions) => workspaceSessionService.list(listOptions),
      get: (sessionId) => workspaceSessionService.get(sessionId),
      isRunning: (sessionId) => workspaceSessionService.isRunning(sessionId),
      getScene: (workspaceId) => workspaceSessionService.getScene(workspaceId),
      presentedScene: (workspaceId) => workspaceSessionService.presentedScene(workspaceId),
      changeScene: (workspaceId, change, origin) => workspaceSessionService.changeScene(workspaceId, change, origin),
      create: (input, origin) => workspaceSessionService.create(input, origin),
      rename: (sessionId, title, origin) => workspaceSessionService.rename(sessionId, title, origin),
      previewArchive: (sessionId) => workspaceSessionService.previewArchive(sessionId),
      archive: (sessionId, origin) => workspaceSessionService.archive(sessionId, origin),
      restore: (sessionId, origin) => workspaceSessionService.restore(sessionId, origin),
    },
    transcripts: { readMessages: (sessionId) => sessionTranscripts.readMessages(sessionId) },
    // 切换界面的导航只推给发起对话的窗口；窗口没有连接时推不到，由工具如实说明。
    windows: {
      navigate: (windowId, target, origin) =>
        workbenchEvents.publishToWindow(windowId, { type: 'window.navigate', origin, target }),
      isOpen: (windowId) => workbenchEvents.hasWindow(windowId),
    },
  };
  // 示例提议（给会话改名）只在测试控制开启时（E2E 服务与测试）注册，用来验证确认卡机制；正式环境没有它。
  const exampleProposals = environment.MULTIVAC_E2E_CONTROL === '1';
  // 对话内的提议（确认卡）：提议类工具只经它生成待确认的提议；确认与取消只经 HTTP 接口由用户发起，
  // 扩大权限的执行器按种类注册在这里（拿得到扩大权限的服务方法），内部工具拿不到。
  // 启动时先把上一进程中正在执行的提议记为执行失败（结果未知，不重新执行），再接受任何命令。
  const exampleSessions: ExampleRenameSessionDependencies['sessions'] = {
    get: (sessionId) => workspaceSessionService.get(sessionId),
    rename: (sessionId, title, origin) => workspaceSessionService.rename(sessionId, title, origin),
  };
  // 项目与归入项目的提议种类：执行器拿得到新建项目、修改目录与归入项目的服务方法（与界面同一套校验），内部工具拿不到。
  const projectProposalDependencies: ProjectProposalDependencies = {
    projects: {
      getProject: (projectId) => projectService.getProject(projectId),
      previewProject: (input) => projectService.previewProject(input),
      createProject: (input, origin) => projectService.createProject(input, origin),
      previewDirectories: (projectId, directories) => projectService.previewDirectories(projectId, directories),
      normalizeDirectoryPath: (path) => projectService.normalizeDirectoryPath(path),
      directoryOwner: (path) => projectService.directoryOwner(path),
      updateProject: (projectId, input, origin) => projectService.updateProject(projectId, input, origin),
    },
  };
  const moveSessionProposalDependencies: MoveSessionProposalDependencies = {
    sessions: {
      get: (sessionId) => workspaceSessionService.get(sessionId),
      isRunning: (sessionId) => workspaceSessionService.isRunning(sessionId),
      previewMoveToProject: (sessionId, projectId) => workspaceSessionService.previewMoveToProject(sessionId, projectId),
      moveToProject: (sessionId, input, origin) => workspaceSessionService.moveToProject(sessionId, input, origin),
    },
    workspaces: (): readonly Workspace[] => projectService.listWorkspaces().workspaces,
  };
  const proposals: ProposalService = new ProposalService({
    repository: new SqliteProposalRepository(store),
    workbenchEvents,
    kinds: [
      createProjectKind(projectProposalDependencies),
      mountDirectoryKind(projectProposalDependencies),
      unmountDirectoryKind(projectProposalDependencies),
      setPrimaryDirectoryKind(projectProposalDependencies),
      moveSessionToProjectKind(moveSessionProposalDependencies),
      ...(exampleProposals ? [exampleRenameSessionKind({
        sessions: exampleSessions,
        workspaceName: (workspaceId: string): string =>
          projectService.listWorkspaces().workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.name ??
            workspaceId,
      })] : []),
    ],
  });
  proposals.reconcileOnStartup();
  const internalTools = new InternalToolService({
    tools: exampleProposals ? [...MULTIVAC_INTERNAL_TOOLS, exampleProposeRenameSessionTool] : MULTIVAC_INTERNAL_TOOLS,
    services: internalToolServices,
    calls: new SqliteInternalToolCallRepository(store),
    proposals,
    // 调用关联发起它的那一轮（全局 Multivac 当前的发送命令）、发出这条消息的窗口与它发送时的当前视图。
    currentTurn: (sessionId): InternalToolTurn | null => {
      const commands: AssistantTurnCommandService | undefined = sessionRuntimes.get(sessionId)?.commands;
      const commandId = commands?.currentPromptCommandId() ?? null;
      return commands && commandId
        ? {
            commandId,
            windowId: commands.currentPromptWindowId(),
            view: commands.currentPromptView(),
            updateView: (view) => commands.updatePromptView(commandId, view),
          }
        : null;
    },
  });
  const commandRepository = new SqliteAssistantCommandRepository(store);
  const eventRepository = new SqliteAssistantEventRepository(store);
  const baseRuntimeConfig = runtimeConfig(environment);
  const selectionRepository = new SqliteSessionSelectionRepository(store);
  const runtimeDependencies: AssistantSessionRuntimeDependencies = {
    fileSources: new MessageFileSources(new SqliteMessageFileSourceRepository(store)),
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
  // Multivac 读取其他会话的最近内容：只读，打开中的读内存，未打开或已归档的读 Pi session 文件，不建立运行时。
  const sessionTranscripts = new SessionTranscriptReader({
    registry: sessionRegistry, bindings: runtimeDependencies.bindingRepository, adapter,
  });
  // 偏好保存在服务端；临时目录的清理计划随会话归档、恢复与归入项目登记或取消。
  const preferencesService = new PreferencesService(new SqlitePreferenceRepository(store));
  const cleanupPlans = new SqliteTempDirectoryCleanupRepository(store);
  const workspaceRepository = new SqliteWorkspaceRepository(store);
  const projectRepository = new SqliteProjectRepository(store);
  // 能否移除一个临时目录的统一判定：受保护的目录、其他会话的引用与所属会话的运行时。
  // 运行时注册表在下方创建，判定只在请求与定时检查中调用，那时它已就绪。
  const tempDirectoryRemoval = new TempDirectoryRemovalPolicy({
    registry: sessionRegistry,
    projects: projectRepository,
    paths: workPaths,
    dataDir: paths.dataDir,
    hasRuntime: (sessionId): boolean => sessionRuntimes.get(sessionId) !== undefined,
  });
  // 会话对外提供之前补齐存量会话的工作目录：全局 Multivac 指向 multivac/，工作会话补建临时目录。
  const workingDirectories = new SessionWorkingDirectories(workPaths, sessionRegistry, paths.dataDir, {
    plans: cleanupPlans,
    removal: tempDirectoryRemoval,
  });
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
    resolveFileQuote: (quote) => sessionFiles.validateQuote(quote),
    internalTools,
    // 提议的处理结果在全局 Multivac 下一轮开始时以服务端通知告诉模型（不来自用户输入或工具返回）。
    takeServerNotice: () => proposals.takeNotice(GLOBAL_ASSISTANT_SESSION_ID),
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
      resolveFileQuote: (quote) => sessionFiles.validateQuote(quote),
      resolveInitialContext: async () => parentContext(sessionRegistry, record.sessionId),
    }), [coordinator]);
  // 项目与工作区：项目自动带一个同名工作区，项目托管目录在工作文件根目录的 projects/ 下。
  const projectService = new ProjectService({
    projects: projectRepository,
    workspaces: workspaceRepository,
    workPaths,
    dataDir: paths.dataDir,
    events: workbenchEvents,
  });
  const workspaceSessionService = new WorkspaceSessionService({
    validateFileQuote: (quote) => sessionFiles.validateQuote(quote),
    repository: sessionRegistry,
    workingDirectories,
    workspaces: workspaceRepository,
    sceneRepository: new SqliteWorkspaceSceneRepository(store),
    pageStateRepository: runtimeDependencies.pageStateRepository,
    runtimes: sessionRuntimes,
    tempRetentionDays: () => preferencesService.tempRetentionDays(),
    recentDays: () => preferencesService.get().recentDays ?? 7,
    events: workbenchEvents,
    readSessionHistory: async (record) => {
      await sessionRuntimes.acquire(record).initialize();
      const snapshot = adapter.readActiveBranch(record.sessionId);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      return { piSessionId: snapshot.value.piSessionId, messages: snapshot.value.messages };
    },
  });
  // 临时目录的到期清理只在服务运行时进行：启动时补做一次到期检查，之后定时检查；
  const sessionFiles: SessionFilesService = new SessionFilesService(workspaceSessionService, paths.dataDir);
  // 修改保留时长后按新时长立即检查一次。Multivac 工作目录与项目目录永不清理。
  const tempDirectoryCleaner = new TempDirectoryCleaner({
    plans: cleanupPlans,
    registry: sessionRegistry,
    removal: tempDirectoryRemoval,
    paths: workPaths,
    trash: trashDirectory
      ? new DirectoryTrash(trashDirectory)
      : systemTrash({ platform: process.platform, homeDir: homedir(), xdgDataHome: environment.XDG_DATA_HOME }),
    retentionDays: () => preferencesService.tempRetentionDays(),
  });
  tempDirectoryCleaner.start();
  const unsubscribePreferenceChanges = preferencesService.onChanged((preferences) => {
    tempDirectoryCleaner.sweepSafely();
    workbenchEvents.publish({ type: 'preferences.changed', preferences });
  });
  const unsubscribeActivity = eventStream.subscribe((event) => {
    if (!['assistant.command.handed_to_pi', 'assistant.turn.started', 'assistant.turn.ended', 'assistant.tool.ended'].includes(event.type)) return;
    const record = sessionRegistry.get(event.assistantSessionId);
    if (!record || record.kind !== 'work' || !record.workingDirectory) return;
    const { piSessionPath: _path, origin: _origin, ...session } = record;
    workbenchEvents.publish({ type: 'session.changed', change: 'activity', origin: { windowId: null, commandId: null }, session: { ...session, workingDirectory: record.workingDirectory } });
  });
  const sessionAccess = {
    resolveSession: (sessionId: string) => workspaceSessionService.resolve(sessionId),
    acquireRuntime: (record: Parameters<typeof sessionRuntimes.acquire>[0]) => sessionRuntimes.acquire(record),
    adapter,
  };
  // Multivac 侧栏的上下文：工作区正在看的会话，或设置 · 项目页选中的项目。
  const resolveCoordinatorContext = createSessionContextResolver({
    ownerSessionId: GLOBAL_ASSISTANT_SESSION_ID,
    ...sessionAccess,
    resolveProject: (projectId) => projectService.getProject(projectId),
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
        workspaceSessions: workspaceSessionService,
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
          proposals.resetForTest();
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
    sessionFiles,
    workbenchEvents,
    toolAuthorization: {
      service: toolAuthorization,
      requireSession: (sessionId) => { workspaceSessionService.resolve(sessionId); },
    },
    proposals,
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
      unsubscribeActivity();
      tempDirectoryCleaner.stop();
      toolAuthorization.dispose();
      void modelAccessService.close();
      coordinator.dispose();
      sessionRuntimes.releaseAll();
      eventStream.clear();
      workbenchEvents.clear();
      adapter.dispose();
      store.close();
    },
  };
}
