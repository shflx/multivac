import { createNoteVaultRequestHandler } from '../adapters/http/note-vault-routes.js';
import { createNoteEncryptionRequestHandler } from '../adapters/http/note-encryption-routes.js';
import { notesFailure } from '../adapters/http/notes-routes.js';
import type { NoteEncryption } from '../modules/notes/encryption.js';
import type { NoteHttpAccess } from '../adapters/http/note-access.js';
import { createNoteSecurityRequestHandler } from '../adapters/http/note-security-routes.js';
import type { NoteSecurityService } from '../application/note-security-service.js';
import { createTerminalRoutes, attachTerminalWebSockets } from '../adapters/http/terminal-routes.js';
import type { TerminalService } from '../application/terminal-service.js';
import type { SessionContextManagementService } from '../application/session-context-management-service.js';
import { createWebSettingsRequestHandler } from '../adapters/http/web-settings-routes.js';
import { createNotificationChannelRequestHandler } from '../adapters/http/notification-channel-routes.js';
import type { NotificationChannelManagementService } from '../application/notification-channel-management-service.js';
import type { WebSettingsService } from '../application/web-settings-service.js';
import { createNoteSuggestionsRequestHandler } from '../adapters/http/note-suggestions-routes.js';
import type { NoteSuggestionsService } from '../application/note-suggestions-service.js';
import { createNoteAssistantRequestHandler } from '../adapters/http/note-assistant-routes.js';
import type { NoteAssistantService } from '../application/note-assistant-service.js';
import { createNotesRequestHandler } from '../adapters/http/notes-routes.js';
import type { NotesService } from '../application/notes-service.js';
import type { InboxService } from '../application/inbox-service.js';
import type { UsageStatisticsService } from '../application/usage-statistics-service.js';
import { createUsageRequestHandler } from '../adapters/http/usage-routes.js';
import { createInboxHandler } from '../adapters/http/inbox-routes.js';
import { createConversationConfirmationHandler } from '../adapters/http/conversation-confirmation-routes.js';
import type { ManagedProcessService } from '../application/managed-process-service.js';
import { createProcessRequestHandler } from '../adapters/http/process-routes.js';
import type { RunsService } from '../application/runs-service.js';
import { createSkillRequestHandler } from '../adapters/http/skill-routes.js';
import type { SkillService } from '../application/skill-service.js';
import type { McpManagementService } from '../application/mcp-management-service.js';
import { createMcpRequestHandler } from '../adapters/http/mcp-routes.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GLOBAL_ASSISTANT_SESSION_ID, WINDOW_ID_HEADER } from '@multivac/contracts';
import { RemoteAccess, accessError } from '../adapters/http/remote-access.js';
import { LocalEntryPolicy } from '../adapters/http/local-entry-policy.js';
import { guardTerminalHttp, isTerminalPath } from '../adapters/http/terminal-entry.js';
import { markRemoteRequest, remoteRouteAllowed } from '../adapters/http/remote-policy.js';
import { createWebAssetsHandler } from '../adapters/http/web-assets.js';
import type { AssistantSessionService } from '../application/assistant-session-service.js';
import { createAssistantRequestHandler, type AssistantRoutesOptions } from '../adapters/http/assistant-routes.js';
import type { AssistantTurnCommandService } from '../application/assistant-turn-command-service.js';
import type { AssistantEventStream } from '../application/assistant-event-stream.js';
import type { AssistantEventRepository } from '../modules/sessions/assistant-turn.js';
import type { ModelSettingsService } from '../application/model-settings-service.js';
import { createModelSettingsRequestHandler } from '../adapters/http/model-settings-routes.js';
import type { ModelAccessService } from '../application/model-access-service.js';
import { createModelAccessRequestHandler } from '../adapters/http/model-access-routes.js';
import type { SessionModelSelectionService } from '../application/session-model-selection-service.js';
import type { WorkspaceSessionService } from '../application/workspace-session-service.js';
import type { ProjectService } from '../application/project-service.js';
import { createWorkspaceSessionRequestHandler } from '../adapters/http/workspace-session-routes.js';
import {
  createPreferencesRequestHandler,
  type PreferencesRoutesOptions,
} from '../adapters/http/preferences-routes.js';
import {
  createToolAuthorizationRequestHandler,
  type ToolAuthorizationRoutesOptions,
} from '../adapters/http/tool-authorization-routes.js';
import type { WorkbenchEvents } from '../application/workbench-events.js';
import type { ProposalService } from '../application/proposals/proposal-service.js';
import { createProposalRequestHandler } from '../adapters/http/proposal-routes.js';
import { createEventStreamRequestHandler } from '../adapters/http/event-stream-routes.js';
import type { HttpServerTestControls } from '../adapters/http/fake-assistant-test-routes.js';
import type { SessionFilesService } from '../application/session-files-service.js';
import { createSessionFilesRequestHandler } from '../adapters/http/session-files-routes.js';
import type { ProjectResourceService } from '../application/project-resource-service.js';
import { createProjectResourceRequestHandler } from '../adapters/http/project-resource-routes.js';
import type { TaskService } from '../application/task-service.js';
import type { TaskExecutionService } from '../application/task-execution-service.js';
import type { HumanRequestService } from '../application/human-request-service.js';
import { createHumanRequestHandler } from '../adapters/http/human-request-routes.js';
import type { ArtifactService } from '../application/artifact-service.js';
import { createArtifactHandler } from '../adapters/http/artifact-routes.js';
import { createTaskRequestHandler } from '../adapters/http/task-routes.js';
import { createAgentRequestHandler } from '../adapters/http/agent-routes.js';
import type { AgentService } from '../application/agent-service.js';
import { createReadingRequestHandler } from '../adapters/http/reading-routes.js';
import type { ReadingService } from '../application/reading-service.js';
import type { NoteImagesService } from '../application/note-images-service.js';
import { createNoteImagesRequestHandler } from '../adapters/http/note-images-routes.js';
import { createImageRequestHandler } from '../adapters/http/image-routes.js';
import type { ImageService } from '../application/image-service.js';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

const fallbackLocalPolicy = new LocalEntryPolicy();

function reject(response: ServerResponse, code: 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED'): void {
  response.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify({
    error: {
      code,
      message: code === 'HOST_NOT_ALLOWED' ? 'Host 不在本地服务允许范围内。' : 'Origin 不在本地服务允许范围内。',
    },
  }));
}

export interface MultivacHttpServerOptions {
  terminals?: TerminalService;
  webSettings?: WebSettingsService;
  notificationChannels?: NotificationChannelManagementService;
  remoteAccess?: RemoteAccess;
  webRoot?: string;
  skills?: SkillService;
  mcpManagement?: McpManagementService;
  mcpResources?: import('../application/mcp-resource-service.js').McpResourceService;
  reading?: ReadingService;
  usage?: UsageStatisticsService;
  noteSecurity?: NoteSecurityService;
  noteEncryption?: NoteEncryption;
  noteAccess?: NoteHttpAccess;
  notes?: NotesService;
  noteAssistant?: NoteAssistantService;
  noteSuggestions?: NoteSuggestionsService;
  images?: ImageService;
  noteImages?: NoteImagesService;
  managedProcesses?: ManagedProcessService;
  stopSessionProcesses?: (sessionId: string, commandId: string) => Promise<void>;
  runs?: RunsService;
  tasks?: TaskService;
  /** 智能体（命名执行配置）；未提供时不开放智能体接口。 */
  agents?: AgentService;
  taskExecution?: TaskExecutionService;
  humanRequests?: HumanRequestService;
  inbox?: InboxService;
  artifacts?: ArtifactService;
  service: AssistantSessionService;
  commandService: AssistantTurnCommandService;
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  pageStateBodyLimitBytes?: number;
  turnBodyLimitBytes?: number;
  /** 全局事件流的心跳间隔（毫秒），缺省 15 秒。 */
  heartbeatMs?: number | undefined;
  /** 全局事件流的积压上限；缺省见 `GLOBAL_EVENT_STREAM_MAX_QUEUED_*`。 */
  maxQueuedEvents?: number | undefined;
  maxQueuedBytes?: number | undefined;
  modelSettingsService?: ModelSettingsService;
  modelAccessService?: ModelAccessService;
  selectionService?: SessionModelSelectionService;
  contextService?: SessionContextManagementService | undefined;
  /** 工作区与项目接口；两者同时提供时开放。 */
  workspaceSessionService?: WorkspaceSessionService;
  sessionFiles?: SessionFilesService;
  /** 项目资料；未提供时不开放资料接口。 */
  projectResources?: ProjectResourceService;
  projectService?: ProjectService;
  /** 授权请求的查询与决定；未提供时不开放授权接口。 */
  toolAuthorization?: ToolAuthorizationRoutesOptions;
  /** 全局 Multivac 对话内的提议（确认卡）的查询与决定；未提供时不开放提议接口。 */
  proposals?: ProposalService;
  /** 偏好与临时目录占用；未提供时不开放偏好接口。 */
  preferences?: PreferencesRoutesOptions;
  /** 按会话 id 取得会话服务；缺省只开放全局协调会话。 */
  resolveSession?: AssistantRoutesOptions['resolveSession'];
  /** 工作台变更事件；提供时全局事件流（`/api/events`）同时推送变更，并以窗口 id 登记连接。 */
  workbenchEvents?: WorkbenchEvents;
  testRequestHandler?: (
    request: IncomingMessage,
    response: ServerResponse,
    controls: HttpServerTestControls,
  ) => Promise<boolean>;
}

/** 原生 HTTP factory 保持依赖可注入，测试不会触碰真实 Pi 或用户数据。 */
export function createMultivacHttpServer(options: MultivacHttpServerOptions): Server {
  const terminalRoutes = options.terminals ? createTerminalRoutes(options.terminals) : undefined;
  const webSettingsRoutes = options.webSettings ? createWebSettingsRequestHandler(options.webSettings) : undefined;
  const notificationRoutes = options.notificationChannels ? createNotificationChannelRequestHandler(options.notificationChannels) : undefined;
  const noteSuggestionRoutes = options.noteSuggestions ? createNoteSuggestionsRequestHandler(options.noteSuggestions) : undefined;
  const noteAssistantRoutes = options.noteAssistant ? createNoteAssistantRequestHandler(options.noteAssistant) : undefined;
  const noteImageRoutes = options.noteImages ? createNoteImagesRequestHandler(options.noteImages) : undefined;
  const noteEncryptionRoutes = options.noteEncryption ? createNoteEncryptionRequestHandler(options.noteEncryption) : undefined;
  const noteVaultRoutes = options.noteSecurity ? createNoteVaultRequestHandler(options.noteSecurity) : undefined;
  const noteSecurityRoutes = options.noteSecurity ? createNoteSecurityRequestHandler(options.noteSecurity) : undefined;
  const notesRoutes = options.notes ? createNotesRequestHandler(options.notes) : undefined;
  const mcpRoutes = options.mcpManagement ? createMcpRequestHandler(options.mcpManagement, options.mcpResources) : undefined;
  const skillRoutes = options.skills ? createSkillRequestHandler(options.skills) : undefined;
  const readingRoutes = options.reading ? createReadingRequestHandler(options.reading) : undefined;
  const usageRoutes = options.usage ? createUsageRequestHandler(options.usage) : undefined;
  const processRoutes = options.managedProcesses && options.tasks ? createProcessRequestHandler(options.managedProcesses, options.tasks, options.workspaceSessionService, options.stopSessionProcesses) : undefined;
  const agentRoutes = options.agents ? createAgentRequestHandler(options.agents) : undefined;
  const taskRoutes = options.tasks ? createTaskRequestHandler(options.tasks, options.taskExecution, options.humanRequests, options.runs) : undefined;
  const inboxRoutes = options.inbox ? createInboxHandler(options.inbox, options.artifacts) : undefined;
  const conversationConfirmations = options.inbox ? createConversationConfirmationHandler(options.inbox) : undefined;
  const humanRequestRoutes = options.humanRequests ? createHumanRequestHandler(options.humanRequests) : undefined;
  const artifactRoutes = options.artifacts ? createArtifactHandler(options.artifacts) : undefined;
  const assistantRoutes = createAssistantRequestHandler(options);
  const sessionFilesRoutes = options.sessionFiles ? createSessionFilesRequestHandler(options.sessionFiles) : undefined;
  const projectResourceRoutes = options.projectResources ? createProjectResourceRequestHandler(options.projectResources) : undefined;
  const imageRoutes = options.images ? createImageRequestHandler(options.images) : undefined;
  const eventStreamRoutes = createEventStreamRequestHandler({
    ...(options.noteAccess ? { noteAccess: options.noteAccess } : {}),
    eventRepository: options.eventRepository,
    eventStream: options.eventStream,
    workbenchEvents: options.workbenchEvents,
    heartbeatMs: options.heartbeatMs,
    maxQueuedEvents: options.maxQueuedEvents,
    maxQueuedBytes: options.maxQueuedBytes,
  });
  const testControls: HttpServerTestControls = {
    disconnectEventStreams: () => eventStreamRoutes.disconnectAll(),
  };
  const modelAccessRoutes = options.modelAccessService ? createModelAccessRequestHandler(options.modelAccessService) : undefined;
  const workspaceSessionRoutes = options.workspaceSessionService && options.projectService
    ? createWorkspaceSessionRequestHandler(options.workspaceSessionService, options.projectService, options.stopSessionProcesses)
    : undefined;
  const toolAuthorizationRoutes = options.toolAuthorization
    ? createToolAuthorizationRequestHandler(options.toolAuthorization)
    : undefined;
  const proposalRoutes = options.proposals ? createProposalRequestHandler(options.proposals) : undefined;
  const preferencesRoutes = options.preferences ? createPreferencesRequestHandler(options.preferences) : undefined;
  const modelSettingsRoutes = options.modelSettingsService
    ? createModelSettingsRequestHandler(options.modelSettingsService)
    : undefined;
  const webAssets = options.webRoot ? createWebAssetsHandler(options.webRoot) : undefined;
  const terminalAccess = options.remoteAccess ?? new RemoteAccess({ enabled: false, token: '', origin: '', host: '127.0.0.1' });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let path: string;
    try { path = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { accessError(response, 400, 'INVALID_REQUEST', '请求地址无效。'); return; }
    if (isTerminalPath(path) && !guardTerminalHttp(request, response, terminalAccess)) return;
    const access = options.remoteAccess?.identify(request);
    if (options.remoteAccess && !access) {
      accessError(response, 403, 'ACCESS_DENIED', '此访问地址、来源或外部访问配置不允许请求。');
      return;
    }
    const remote = access?.kind === 'remote';
    if (!remote && !hostAllowed(request.headers.host)) {
      reject(response, 'HOST_NOT_ALLOWED');
      return;
    }
    const origin = request.headers.origin;
    if (!remote && !options.remoteAccess && !fallbackLocalPolicy.allows(request)) {
      reject(response, 'ORIGIN_NOT_ALLOWED');
      return;
    }
    if (origin && !remote) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      if (remote) { accessError(response, 403, 'ACCESS_DENIED', '远程入口只接受同源请求。'); return; }
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
        'access-control-allow-headers': `content-type, last-event-id, if-match, ${WINDOW_ID_HEADER}, x-note-access, x-note-window, x-note-grants`,
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }

    const execute = async () => {
      if (access && options.remoteAccess && await options.remoteAccess.handle(request, response, access)) return;
      if (webAssets && await webAssets(request, response)) return;
      if (remote && access) {
        if (!access.authenticated) { accessError(response, 401, 'LOGIN_REQUIRED', '请使用访问 token 登录。'); return; }
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (!remoteRouteAllowed(request.method ?? '', path)) { accessError(response, 403, 'ACCESS_DENIED', '远程入口只开放全局 Multivac 对话与 Inbox。'); return; }
        markRemoteRequest(request);
      }
      if (options.testRequestHandler && await options.testRequestHandler(request, response, testControls)) return;
      if (await eventStreamRoutes.handle(request, response, remote && access && options.remoteAccess ? {
        sessionId: GLOBAL_ASSISTANT_SESSION_ID,
        bind: close => options.remoteAccess!.bind(access, close),
      } : undefined)) return;
      if (terminalRoutes && await terminalRoutes(request, response)) return;
      if (processRoutes && await processRoutes(request, response)) return;
      if (skillRoutes && await skillRoutes(request, response)) return;
      if (mcpRoutes && await mcpRoutes(request, response)) return;
      if (readingRoutes && await readingRoutes(request, response)) return;
      if (noteVaultRoutes && await noteVaultRoutes(request, response)) return;
      if (noteEncryptionRoutes && await noteEncryptionRoutes(request, response)) return;
      if (noteSecurityRoutes && await noteSecurityRoutes(request, response)) return;
      if (noteImageRoutes && await noteImageRoutes(request, response)) return;
      if (notesRoutes && await notesRoutes(request, response)) return;
      if (noteAssistantRoutes && await noteAssistantRoutes(request, response)) return;
      if (noteSuggestionRoutes && await noteSuggestionRoutes(request, response)) return;
      if (taskRoutes && await taskRoutes(request, response)) return;
      if (agentRoutes && await agentRoutes(request, response)) return;
      if (conversationConfirmations && await conversationConfirmations(request, response)) return;
      if (inboxRoutes && await inboxRoutes(request, response)) return;
      if (humanRequestRoutes && await humanRequestRoutes(request, response)) return;
      if (artifactRoutes && await artifactRoutes(request, response)) return;
      if (modelAccessRoutes && await modelAccessRoutes(request, response)) return;
      if (modelSettingsRoutes && await modelSettingsRoutes(request, response)) return;
      if (toolAuthorizationRoutes && await toolAuthorizationRoutes(request, response)) return;
      if (proposalRoutes && await proposalRoutes(request, response)) return;
      if (webSettingsRoutes && await webSettingsRoutes(request, response)) return;
      if (notificationRoutes && await notificationRoutes(request, response)) return;
      if (preferencesRoutes && await preferencesRoutes(request, response)) return;
      if (usageRoutes && await usageRoutes(request, response)) return;
      if (projectResourceRoutes && await projectResourceRoutes(request, response, access ?? undefined)) return;
      if (workspaceSessionRoutes && await workspaceSessionRoutes(request, response)) return;
      if (sessionFilesRoutes && await sessionFilesRoutes(request, response, access ?? undefined)) return;
      if (imageRoutes && await imageRoutes(request, response)) return;
      await assistantRoutes.handle(request, response);
    };
    void (options.noteAccess && !remote ? options.noteAccess.run(request, response, execute) : execute()).catch((error: unknown) => {
      if (!response.headersSent) notesFailure(response, error);
      else response.destroy();
    });
  });
  const closeTerminals = options.terminals ? attachTerminalWebSockets(server, options.terminals, terminalAccess) : () => {};
  const closeServer = server.close.bind(server);
  // 原生 server.close 会等待 keep-alive/SSE 长连接；必须先释放事件流连接才能完成关闭。
  server.close = ((callback?: (error?: Error) => void) => {
    closeTerminals();
    options.remoteAccess?.close();
    eventStreamRoutes.disconnectAll();
    if (options.modelAccessService) {
      void options.modelAccessService.close().then(() => closeServer(callback));
      return server;
    }
    return closeServer(callback);
  }) as Server['close'];
  return server;
}
