import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AssistantPublicEvent, ToolAuthorizationRequest } from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import {
  ToolAuthorizationService,
  ToolAuthorizationServiceError,
} from '../src/application/tool-authorization-service.js';
import type {
  CoordinatorToolAuthorizationDecision,
  CoordinatorToolAuthorizationRequest,
} from '../src/runtime/executors/coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantCommandRepository,
  SqliteAssistantStore,
  SqliteToolAuthorizationRepository,
} from '../src/storage/sqlite-assistant-store.js';

const SESSION_ID = 'work-authorization';
const COMMAND_ID = 'command-authorization';

function accessRequest(toolCallId: string, toolName: 'read' | 'edit' | 'write' = 'write'): CoordinatorToolAuthorizationRequest {
  return {
    assistantSessionId: SESSION_ID,
    toolName,
    toolCallId,
    requestedPath: '../outside/target.txt',
    targetPath: '/outside/target.txt',
    workingDirectory: { kind: 'session-temp', path: '/work/sessions/authorization' },
  };
}

async function withStore(run: (context: {
  store: SqliteAssistantStore;
  events: AssistantPublicEvent[];
  eventStream: AssistantEventStream;
  service: (options?: { timeoutMs?: number; now?: () => Date }) => ToolAuthorizationService;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multivac-tool-authorization-'));
  const store = new SqliteAssistantStore(join(root, 'multivac.sqlite'));
  new SqliteAssistantBindingRepository(store).insertIfAbsent({
    assistantSessionId: SESSION_ID, piSessionId: 'pi-authorization', piSessionPath: '/pi/authorization.jsonl',
    updatedAt: '2026-09-28T08:00:00.000Z',
  });
  new SqliteAssistantCommandRepository(store).createAccepted({
    commandId: COMMAND_ID, assistantSessionId: SESSION_ID, kind: 'send', payloadFingerprint: 'fingerprint',
    piSessionId: 'pi-authorization',
  });
  const eventStream = new AssistantEventStream();
  const events: AssistantPublicEvent[] = [];
  eventStream.subscribe((event) => events.push(event));
  const services: ToolAuthorizationService[] = [];
  try {
    await run({
      store,
      events,
      eventStream,
      service: (options = {}) => {
        const created = new ToolAuthorizationService({
          repository: new SqliteToolAuthorizationRepository(store),
          eventStream,
          currentCommandId: (sessionId) => sessionId === SESSION_ID ? COMMAND_ID : null,
          ...options,
        });
        services.push(created);
        return created;
      },
    });
  } finally {
    for (const service of services) service.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** 等待中的授权决定：记录是否已经给出结果。 */
function track(promise: Promise<CoordinatorToolAuthorizationDecision>) {
  const state: { decision?: CoordinatorToolAuthorizationDecision } = {};
  void promise.then((decision) => { state.decision = decision; });
  return state;
}

function authorizationEvents(events: AssistantPublicEvent[]) {
  return events.flatMap((event) =>
    event.type === 'assistant.authorization.requested' || event.type === 'assistant.authorization.resolved'
      ? [{ type: event.type, status: event.data.request.status, commandId: event.commandId }]
      : []);
}

function assertServiceError(code: ToolAuthorizationServiceError['code'], pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ToolAuthorizationServiceError);
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

test('越界调用生成待授权请求并等待；批准放行这一次，重复提交同一决定返回同一结果，冲突决定报冲突', async () => {
  await withStore(async ({ events, service: create }) => {
    const now = new Date('2026-09-28T08:00:00.000Z');
    const service = create({ now: () => now });
    const waiting = service.authorize(accessRequest('call-approve'), new AbortController().signal);
    const state = track(waiting);

    const [pending] = service.list(SESSION_ID);
    assert.deepEqual({ ...pending, requestId: typeof pending?.requestId }, {
      requestId: 'string',
      sessionId: SESSION_ID,
      commandId: COMMAND_ID,
      toolName: 'write',
      toolCallId: 'call-approve',
      requestedPath: '../outside/target.txt',
      targetPath: '/outside/target.txt',
      workingDirectory: { kind: 'session-temp', path: '/work/sessions/authorization' },
      status: 'pending',
      createdAt: '2026-09-28T08:00:00.000Z',
      expiresAt: '2026-09-28T08:30:00.000Z',
      decidedAt: null,
    } satisfies Record<keyof ToolAuthorizationRequest, unknown>);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.decision, undefined, '用户决定之前一直等待');

    const approved = service.decide(SESSION_ID, pending!.requestId, 'once');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedAt, '2026-09-28T08:00:00.000Z');
    assert.deepEqual(await waiting, { allowed: true });

    // 幂等：同一决定返回同一结果，不再发事件；相反的决定报冲突。
    assert.deepEqual(service.decide(SESSION_ID, pending!.requestId, 'once'), approved);
    assert.throws(() => service.decide(SESSION_ID, pending!.requestId, 'deny'), assertServiceError('AUTHORIZATION_CONFLICT', /已批准/u));
    assert.deepEqual(authorizationEvents(events), [
      { type: 'assistant.authorization.requested', status: 'pending', commandId: COMMAND_ID },
      { type: 'assistant.authorization.resolved', status: 'approved', commandId: COMMAND_ID },
    ]);
  });
});

test('拒绝时原因回传 Agent 且本轮继续；其他会话或不存在的请求按不存在处理', async () => {
  await withStore(async ({ service: create }) => {
    const service = create();
    const waiting = service.authorize(accessRequest('call-deny', 'read'), new AbortController().signal);
    const [pending] = service.list(SESSION_ID);

    assert.throws(() => service.decide('other-session', pending!.requestId, 'deny'), assertServiceError('NOT_FOUND'));
    assert.throws(() => service.decide(SESSION_ID, 'missing', 'deny'), assertServiceError('NOT_FOUND'));
    assert.equal(service.decide(SESSION_ID, pending!.requestId, 'deny').status, 'denied');

    const decision = await waiting;
    assert.equal(decision.allowed, false);
    assert.ok(!decision.allowed);
    assert.match(decision.reason, /用户拒绝了这次授权：没有读取 \/outside\/target\.txt/u);
    assert.equal(decision.endTurn, undefined, '拒绝后本轮继续，由 Agent 回应');
    assert.equal(service.decide(SESSION_ID, pending!.requestId, 'deny').status, 'denied');
    assert.throws(() => service.decide(SESSION_ID, pending!.requestId, 'once'), assertServiceError('AUTHORIZATION_CONFLICT', /已拒绝/u));
  });
});

test('等待中停止本轮：等待立即结束，请求记为已取消，之后的批准不执行任何操作', async () => {
  await withStore(async ({ events, service: create }) => {
    const service = create();
    const controller = new AbortController();
    const waiting = service.authorize(accessRequest('call-cancel'), controller.signal);
    const [pending] = service.list(SESSION_ID);

    controller.abort();
    const decision = await waiting;
    assert.equal(decision.allowed, false);
    assert.equal(service.list(SESSION_ID)[0]!.status, 'cancelled');
    assert.throws(() => service.decide(SESSION_ID, pending!.requestId, 'once'), assertServiceError('AUTHORIZATION_NOT_PENDING', /已取消/u));
    assert.equal(service.list(SESSION_ID)[0]!.status, 'cancelled');

    // 本轮已取消时到达的调用不再生成请求。
    const late = await service.authorize(accessRequest('call-late'), controller.signal);
    assert.equal(late.allowed, false);
    assert.equal(service.list(SESSION_ID).length, 1);
    assert.deepEqual(authorizationEvents(events).map((event) => event.status), ['pending', 'cancelled']);
  });
});

test('等待超时：请求记为已过期并要求结束本轮，过期请求可查、批准被拒绝', async () => {
  await withStore(async ({ service: create }) => {
    const service = create({ timeoutMs: 30 });
    const started = Date.now();
    const decision = await service.authorize(accessRequest('call-expire'), new AbortController().signal);
    assert.ok(Date.now() - started >= 25);
    assert.deepEqual(decision, {
      allowed: false,
      reason: '等待用户授权超时，请求已过期：没有写入 /outside/target.txt。本轮到此结束。',
      endTurn: true,
    });

    const [expired] = service.list(SESSION_ID);
    assert.equal(expired!.status, 'expired');
    assert.equal(Date.parse(expired!.expiresAt) - Date.parse(expired!.createdAt), 30);
    assert.throws(() => service.decide(SESSION_ID, expired!.requestId, 'once'), assertServiceError('AUTHORIZATION_NOT_PENDING', /已过期/u));
    assert.throws(() => service.decide(SESSION_ID, expired!.requestId, 'deny'), assertServiceError('AUTHORIZATION_NOT_PENDING'));

    // 测试时限只影响之后的请求，传 null 恢复启动时的配置。
    service.setTimeoutForTest(10_000);
    void service.authorize(accessRequest('call-longer'), new AbortController().signal);
    const longer = service.list(SESSION_ID)[1]!;
    assert.equal(Date.parse(longer.expiresAt) - Date.parse(longer.createdAt), 10_000);
  });
});

test('服务停止后重启：上次遗留的待授权请求置为已失效，旧等待不会被放行，批准返回明确错误', async () => {
  await withStore(async ({ events, service: create }) => {
    const before = create();
    const state = track(before.authorize(accessRequest('call-restart'), new AbortController().signal));
    const [pending] = before.list(SESSION_ID);
    // 与进程退出一致：停止时不改记录，也不恢复等待中的调用。
    before.dispose();
    assert.equal(before.list(SESSION_ID)[0]!.status, 'pending');

    const after = create();
    const invalidated = after.invalidateOnStartup();
    assert.deepEqual(invalidated.map((request) => [request.requestId, request.status]), [[pending!.requestId, 'invalidated']]);
    assert.throws(() => after.decide(SESSION_ID, pending!.requestId, 'once'), assertServiceError('AUTHORIZATION_NOT_PENDING', /已失效/u));
    assert.equal(after.list(SESSION_ID)[0]!.status, 'invalidated');
    assert.notEqual(after.list(SESSION_ID)[0]!.decidedAt, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.decision, undefined, '旧进程的等待不再得到任何决定');
    // 再次对账没有可失效的请求。
    assert.deepEqual(after.invalidateOnStartup(), []);
    assert.deepEqual(authorizationEvents(events).map((event) => event.status), ['pending', 'invalidated']);
  });
});

test('待授权却没有等待方的请求不能被放行，决定时按失效处理', async () => {
  await withStore(async ({ service: create }) => {
    const other = create();
    void other.authorize(accessRequest('call-orphan'), new AbortController().signal);
    const [pending] = other.list(SESSION_ID);

    // 另一个服务实例（没有这次等待）收到批准：请求失效，不会执行。
    const service = create();
    assert.throws(() => service.decide(SESSION_ID, pending!.requestId, 'once'), assertServiceError('AUTHORIZATION_NOT_PENDING', /已失效/u));
    assert.equal(service.list(SESSION_ID)[0]!.status, 'invalidated');
  });
});

test('会话的授权请求含历史，按创建顺序返回', async () => {
  await withStore(async ({ service: create }) => {
    const service = create({ now: () => new Date('2026-09-28T08:00:00.000Z') });
    for (const id of ['call-1', 'call-2', 'call-3']) {
      void service.authorize(accessRequest(id), new AbortController().signal);
    }
    const [first] = service.list(SESSION_ID);
    service.decide(SESSION_ID, first!.requestId, 'deny');
    assert.deepEqual(service.list(SESSION_ID).map((request) => [request.toolCallId, request.status]), [
      ['call-1', 'denied'], ['call-2', 'pending'], ['call-3', 'pending'],
    ]);
    assert.deepEqual(service.list('other-session'), []);
  });
});
