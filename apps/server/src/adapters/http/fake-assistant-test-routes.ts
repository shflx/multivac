import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantCommandTerminalOutcome, AssistantPublicEvent } from '@multivac/contracts';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import type { AssistantEventStream } from '../../application/assistant-event-stream.js';
import type { AssistantEventRepository } from '../../modules/sessions/assistant-turn.js';
import type { FakeCoordinatorAdapter } from '../../runtime/executors/fake-coordinator-adapter.js';
import type { ModelAccessService } from '../../application/model-access-service.js';
import type { FakeModelAccessBackend } from '../../runtime/executors/fake-model-access-backend.js';

interface FakeAssistantTestRoutesOptions {
  adapter: FakeCoordinatorAdapter;
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  reset: () => Promise<void>;
  modelAccessService?: ModelAccessService;
  fakeAccessBackend?: FakeModelAccessBackend;
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
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/__e2e/')) return false;

    try {
      if (request.method === 'POST' && url.pathname === '/api/__e2e/model-access' && options.fakeAccessBackend) {
        const body = await readJson(request) as { behavior?: unknown; advanceMs?: unknown; timeoutMs?: unknown };
        if (typeof body.timeoutMs === 'number') options.modelAccessService?.setCheckTimeoutForTest(body.timeoutMs);
        if (body.behavior !== undefined && ['pass', 'fail', 'wait', 'wait-read-failure'].includes(String(body.behavior))) {
          options.fakeAccessBackend.behavior = body.behavior as FakeModelAccessBackend['behavior'];
        }
        if (typeof body.advanceMs === 'number' && body.advanceMs >= 0) options.fakeAccessBackend.clockOffset += body.advanceMs;
        writeJson(response, 200, { configured: true }); return true;
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
        const body = await readJson(request) as { messageId?: unknown; delta?: unknown; completed?: unknown };
        if (typeof body.messageId !== 'string' || !body.messageId || body.messageId.length > 512 ||
            typeof body.delta !== 'string' || (body.completed !== undefined && typeof body.completed !== 'boolean')) {
          writeJson(response, 400, { error: 'invalid body' });
          return true;
        }
        const snapshot = options.adapter.readActiveBranch(GLOBAL_ASSISTANT_SESSION_ID);
        if (!snapshot.ok) throw new Error('Fake 会话不可读。');
        if (body.completed) {
          options.adapter.appendAssistantHistoryForTest(
            GLOBAL_ASSISTANT_SESSION_ID, body.delta, `entry-e2e-${randomUUID()}`, body.messageId,
          );
        }
        const event = options.eventRepository.append({
          sourceKey: `e2e-body:${randomUUID()}`, assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID,
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
