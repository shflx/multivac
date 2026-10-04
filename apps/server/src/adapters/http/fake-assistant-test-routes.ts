import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantCommandTerminalOutcome, AssistantPublicEvent, WorkspaceSceneState } from '@multivac/contracts';
import { GLOBAL_ASSISTANT_SESSION_ID, WindowIdSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import type { AssistantEventStream } from '../../application/assistant-event-stream.js';
import type { AssistantEventRepository } from '../../modules/sessions/assistant-turn.js';
import type { FakeCoordinatorAdapter } from '../../runtime/executors/fake-coordinator-adapter.js';
import type { ModelAccessService } from '../../application/model-access-service.js';
import type { FakeModelAccessBackend } from '../../runtime/executors/fake-model-access-backend.js';
import type { ToolAuthorizationService } from '../../application/tool-authorization-service.js';
import type { TempDirectoryCleaner } from '../../application/temp-directory-cleaner.js';
import type { WorkspaceSessionService } from '../../application/workspace-session-service.js';

/**
 * 测试控制路由请求重启时服务进程的退出码；E2E 服务脚本（scripts/e2e-server.mjs）
 * 见到它就用同一数据目录与工作文件根目录重新启动服务。
 */
export const E2E_RESTART_EXIT_CODE = 75;

/** HTTP 服务自身持有、只交给测试控制路由的操作。 */
export interface HttpServerTestControls {
  /** 断开全部全局事件流连接（模拟网络中断，窗口随后按游标续传），返回断开的条数。 */
  disconnectEventStreams(): number;
}

interface FakeAssistantTestRoutesOptions {
  adapter: FakeCoordinatorAdapter;
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  reset: () => Promise<void>;
  createRecovery?: (taskId: string) => unknown;
  modelAccessService?: ModelAccessService;
  fakeAccessBackend?: FakeModelAccessBackend;
  configureModelSelectionForTest?: (empty: boolean) => Promise<void>;
  toolAuthorization?: ToolAuthorizationService;
  /** 临时目录的到期清理：E2E 可以拨快它的时钟并立即检查一次。 */
  tempDirectoryCleaner?: TempDirectoryCleaner;
  /** 会话与工作区现场的服务：E2E 用它模拟 Multivac 在一轮中经内部工具所做的改动（同一套服务与事件）。 */
  workspaceSessions?: Pick<WorkspaceSessionService, 'rename' | 'getScene' | 'saveScene'>;
  /**
   * 模拟服务在运行中重启：直接结束进程（不做优雅关闭，内存中的等待随之消失），
   * 由 E2E 服务脚本用同一数据目录重新拉起。
   */
  restartProcess?: () => void;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function terminalEventType(
  outcome: Extract<AssistantCommandTerminalOutcome, 'succeeded' | 'failed' | 'cancelled'>,
): AssistantPublicEvent['type'] {
  if (outcome === 'succeeded') return 'assistant.run.succeeded';
  if (outcome === 'failed') return 'assistant.run.failed';
  return 'assistant.run.cancelled';
}

/** 仅供 Fake E2E 进程启用，生产服务器不会注册这些控制路由。 */
export function createFakeAssistantTestRequestHandler(options: FakeAssistantTestRoutesOptions) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    controls: HttpServerTestControls,
  ): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/__e2e/')) return false;

    try {
      if (request.method === 'POST' && url.pathname === '/api/__e2e/model-selection') {
        const body = await readJson(request) as { empty?: unknown; failure?: unknown };
        if (typeof body.empty === 'boolean') await options.configureModelSelectionForTest?.(body.empty);
        if (body.failure === 'fail' || body.failure === 'partial' || body.failure === null) options.adapter.setModelFailureForTest(body.failure);
        writeJson(response, 200, { configured: true }); return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/model-access' && options.fakeAccessBackend) {
        const body = await readJson(request) as { behavior?: unknown; advanceMs?: unknown; timeoutMs?: unknown };
        if (typeof body.timeoutMs === 'number') options.modelAccessService?.setCheckTimeoutForTest(body.timeoutMs);
        if (body.behavior !== undefined && ['pass', 'fail', 'wait', 'wait-read-failure'].includes(String(body.behavior))) {
          options.fakeAccessBackend.behavior = body.behavior as FakeModelAccessBackend['behavior'];
        }
        if (typeof body.advanceMs === 'number' && body.advanceMs >= 0) options.fakeAccessBackend.clockOffset += body.advanceMs;
        writeJson(response, 200, { configured: true }); return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/inbox/recovery' && options.createRecovery) {
        const body = await readJson(request) as { taskId?: unknown };
        if (typeof body.taskId !== 'string') { writeJson(response, 400, { error: 'taskId required' }); return true; }
        writeJson(response, 200, { request: options.createRecovery(body.taskId) }); return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/tool-authorization' && options.toolAuthorization) {
        const body = await readJson(request) as { timeoutMs?: unknown };
        const timeoutMs = body.timeoutMs;
        if (timeoutMs !== null && !(typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
          writeJson(response, 400, { error: 'invalid timeoutMs' });
          return true;
        }
        options.toolAuthorization.setTimeoutForTest(timeoutMs);
        writeJson(response, 200, { configured: true });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/temp-directories' && options.tempDirectoryCleaner) {
        // 拨快清理用的时钟（模拟保留期满）后立即做一次到期检查，返回检查结果（含移到废纸篓的位置）。
        const body = await readJson(request) as { advanceMs?: unknown };
        const advanceMs = body.advanceMs ?? 0;
        if (!(typeof advanceMs === 'number' && Number.isSafeInteger(advanceMs) && advanceMs >= 0)) {
          writeJson(response, 400, { error: 'invalid advanceMs' });
          return true;
        }
        options.tempDirectoryCleaner.advanceClockForTest(advanceMs);
        writeJson(response, 200, options.tempDirectoryCleaner.sweep());
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/workbench/multivac-change' && options.workspaceSessions) {
        // 模拟 Multivac 在发送命令 commandId 这一轮中（消息由窗口 windowId 发出）改名会话或改动工作区现场：
        // 与内部工具一样调用服务并带上来源，变更事件由服务发布。
        const body = await readJson(request) as {
          windowId?: unknown; commandId?: unknown; action?: unknown;
          sessionId?: unknown; title?: unknown; workspaceId?: unknown; scene?: unknown;
        };
        const windowId = body.windowId ?? null;
        if ((windowId !== null && !Check(WindowIdSchema, windowId)) || typeof body.commandId !== 'string' || !body.commandId) {
          writeJson(response, 400, { error: 'invalid origin' });
          return true;
        }
        const origin = { windowId: windowId as string | null, commandId: body.commandId };
        if (body.action === 'rename' && typeof body.sessionId === 'string' && typeof body.title === 'string') {
          writeJson(response, 200, options.workspaceSessions.rename(body.sessionId, body.title, origin));
          return true;
        }
        if (body.action === 'scene' && typeof body.workspaceId === 'string' && typeof body.scene === 'object' && body.scene) {
          const current = options.workspaceSessions.getScene(body.workspaceId);
          const scene = { ...current.scene, ...(body.scene as Partial<WorkspaceSceneState>) };
          writeJson(response, 200, options.workspaceSessions.saveScene(body.workspaceId, scene, { origin }));
          return true;
        }
        writeJson(response, 400, { error: 'invalid action' });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/events/disconnect') {
        // 模拟网络中断：服务端断开全部全局事件流连接，窗口随后按最后收到的游标续传。
        writeJson(response, 200, { disconnected: controls.disconnectEventStreams() });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/restart' && options.restartProcess) {
        const restart = options.restartProcess;
        // 响应写出后再退出，调用方据此开始等待服务重新就绪。
        response.once('finish', () => setTimeout(restart, 20));
        writeJson(response, 202, { restarting: true });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/reset') {
        await options.adapter.resetForTest();
        await options.reset();
        // 无命令正文仅由测试注入；reset 必须同步终结，避免下一用例从账本恢复它们。
        const event = options.eventRepository.append({
          sourceKey: `e2e-reset-body:${randomUUID()}`, assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID,
          commandId: null, type: 'assistant.run.cancelled', data: {}, occurredAt: new Date().toISOString(),
        });
        options.eventStream.publish(event);
        writeJson(response, 200, { reset: true });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/assistant/events/body') {
        const body = await readJson(request) as {
          messageId?: unknown; delta?: unknown; completed?: unknown; sessionId?: unknown;
        };
        if (typeof body.messageId !== 'string' || !body.messageId || body.messageId.length > 512 ||
            typeof body.delta !== 'string' || (body.completed !== undefined && typeof body.completed !== 'boolean') ||
            (body.sessionId !== undefined && typeof body.sessionId !== 'string')) {
          writeJson(response, 400, { error: 'invalid body' });
          return true;
        }
        // 缺省向全局会话推送；指定 sessionId 时推送到对应工作会话。
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : GLOBAL_ASSISTANT_SESSION_ID;
        const snapshot = options.adapter.readActiveBranch(sessionId);
        if (!snapshot.ok) throw new Error('Fake 会话不可读。');
        if (body.completed) {
          options.adapter.appendAssistantHistoryForTest(
            sessionId, body.delta, `entry-e2e-${randomUUID()}`, body.messageId,
          );
        }
        const event = options.eventRepository.append({
          sourceKey: `e2e-body:${randomUUID()}`, assistantSessionId: sessionId,
          commandId: null, occurredAt: new Date().toISOString(),
          type: body.completed ? 'assistant.message.changed' : 'assistant.message.delta',
          data: body.completed
            ? { messageId: body.messageId, role: 'assistant' }
            : { piSessionId: snapshot.value.piSessionId, messageId: body.messageId, delta: body.delta },
        });
        options.eventStream.publish(event);
        writeJson(response, 200, { cursor: event?.cursor });
        return true;
      }
      if (request.method === 'POST' && [
        '/api/__e2e/assistant/prompt-completion/arm',
        '/api/__e2e/assistant/prompt-completion/arm-streaming',
      ].includes(url.pathname)) {
        const body = request.headers['content-type']?.startsWith('application/json')
          ? await readJson(request) : {};
        if (typeof body !== 'object' || body === null ||
            ('terminalHistory' in body && !['persist', 'omit'].includes(String(body.terminalHistory))) ||
            ('simulateFollowUps' in body && typeof body.simulateFollowUps !== 'boolean')) {
          writeJson(response, 400, { error: 'invalid streaming test options' });
          return true;
        }
        options.adapter.armPromptCompletionBarrier(url.pathname.endsWith('arm-streaming'), {
          ...('terminalHistory' in body ? { terminalHistory: body.terminalHistory as 'persist' | 'omit' } : {}),
          ...('simulateFollowUps' in body ? { simulateFollowUps: body.simulateFollowUps as boolean } : {}),
        });
        writeJson(response, 200, { armed: true });
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/__e2e/assistant/prompt-completion/entered') {
        await options.adapter.waitForPromptCompletionBarrierEntry();
        writeJson(response, 200, { entered: true });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/assistant/prompt-completion/release') {
        options.adapter.releasePromptCompletionBarrier();
        writeJson(response, 200, { released: true });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/__e2e/assistant/events/late-terminal') {
        const body = await readJson(request);
        if (
          typeof body !== 'object' || body === null ||
          !('commandId' in body) || typeof body.commandId !== 'string' ||
          !('outcome' in body) || !['succeeded', 'failed', 'cancelled'].includes(String(body.outcome)) ||
          !('messageText' in body) || typeof body.messageText !== 'string'
        ) {
          writeJson(response, 400, { error: 'invalid body' });
          return true;
        }
        const outcome = body.outcome as Extract<
          AssistantCommandTerminalOutcome,
          'succeeded' | 'failed' | 'cancelled'
        >;
        const eventId = randomUUID();
        options.adapter.appendAssistantHistoryForTest(
          GLOBAL_ASSISTANT_SESSION_ID,
          body.messageText,
          `entry-e2e-${eventId}`,
        );
        const event = options.eventRepository.append({
          sourceKey: `e2e-late-terminal:${eventId}`,
          assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID,
          commandId: body.commandId,
          type: terminalEventType(outcome),
          data: {},
          occurredAt: new Date().toISOString(),
        });
        options.eventStream.publish(event);
        writeJson(response, 200, { cursor: event?.cursor ?? null });
        return true;
      }

      writeJson(response, 404, { error: 'not found' });
      return true;
    } catch (error) {
      writeJson(response, 409, {
        error: error instanceof Error ? error.message : 'fake test control failed',
      });
      return true;
    }
  };
}
