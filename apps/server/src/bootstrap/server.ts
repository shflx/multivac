import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WINDOW_ID_HEADER } from '@multivac/contracts';
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

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

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
  /** 工作区与项目接口；两者同时提供时开放。 */
  workspaceSessionService?: WorkspaceSessionService;
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
  const assistantRoutes = createAssistantRequestHandler(options);
  const eventStreamRoutes = createEventStreamRequestHandler({
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
    ? createWorkspaceSessionRequestHandler(options.workspaceSessionService, options.projectService)
    : undefined;
  const toolAuthorizationRoutes = options.toolAuthorization
    ? createToolAuthorizationRequestHandler(options.toolAuthorization)
    : undefined;
  const proposalRoutes = options.proposals ? createProposalRequestHandler(options.proposals) : undefined;
  const preferencesRoutes = options.preferences ? createPreferencesRequestHandler(options.preferences) : undefined;
  const modelSettingsRoutes = options.modelSettingsService
    ? createModelSettingsRequestHandler(options.modelSettingsService)
    : undefined;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!hostAllowed(request.headers.host)) {
      reject(response, 'HOST_NOT_ALLOWED');
      return;
    }
    const origin = request.headers.origin;
    if (!originAllowed(origin)) {
      reject(response, 'ORIGIN_NOT_ALLOWED');
      return;
    }
    if (origin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
        'access-control-allow-headers': `content-type, last-event-id, if-match, ${WINDOW_ID_HEADER}`,
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }

    void (async () => {
      if (options.testRequestHandler && await options.testRequestHandler(request, response, testControls)) return;
      if (await eventStreamRoutes.handle(request, response)) return;
      if (modelAccessRoutes && await modelAccessRoutes(request, response)) return;
      if (modelSettingsRoutes && await modelSettingsRoutes(request, response)) return;
      if (toolAuthorizationRoutes && await toolAuthorizationRoutes(request, response)) return;
      if (proposalRoutes && await proposalRoutes(request, response)) return;
      if (preferencesRoutes && await preferencesRoutes(request, response)) return;
      if (workspaceSessionRoutes && await workspaceSessionRoutes(request, response)) return;
      await assistantRoutes.handle(request, response);
    })();
  });
  const closeServer = server.close.bind(server);
  // 原生 server.close 会等待 keep-alive/SSE 长连接；必须先释放事件流连接才能完成关闭。
  server.close = ((callback?: (error?: Error) => void) => {
    eventStreamRoutes.disconnectAll();
    if (options.modelAccessService) {
      void options.modelAccessService.close().then(() => closeServer(callback));
      return server;
    }
    return closeServer(callback);
  }) as Server['close'];
  return server;
}
