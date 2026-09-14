import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CoordinatorDiagnostic,
  CoordinatorRuntimeConfig,
  CoordinatorThinkingLevel,
} from '@multivac/contracts';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import type {
  PiCoordinatorAgentSession,
  PiCoordinatorModel,
  PiCoordinatorOpenSessionFactoryInput,
  PiCoordinatorSessionFactory,
  PiCoordinatorSessionFactoryInput,
  PiCoordinatorSessionResources,
} from '../src/runtime/executors/pi-session-factory.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是协调助手。',
  authorizedContext: [{ referenceId: 'project', label: '项目摘要', content: '只读内容' }],
  model: { provider: 'test', modelId: 'model-1', thinkingLevel: 'medium' },
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 },
  compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

function model(provider: string, id: string): PiCoordinatorModel {
  return { provider, id } as PiCoordinatorModel;
}

class StubSession implements PiCoordinatorAgentSession {
  readonly calls: Array<{ method: string; value?: string }> = [];
  readonly listeners = new Set<AgentSessionEventListener>();
  sessionId = 'pi-1';
  sessionFile: string | undefined = '/sessions/pi-1.jsonl';
  model: PiCoordinatorModel | undefined = model('test', 'model-1');
  thinkingLevel = config.model.thinkingLevel;
  disposed = false;
  unsubscribeCount = 0;
  persistedMessageCount = 0;
  settledCount = 0;

  constructor(
    private readonly clampThinking: (
      level: CoordinatorThinkingLevel,
    ) => CoordinatorThinkingLevel = (level) => level,
  ) {}

  async prompt(text: string): Promise<void> {
    this.calls.push({ method: 'prompt', value: text });
    this.emit({ type: 'agent_start' } as AgentSessionEvent);
    this.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        api: 'test',
        provider: 'test',
        model: 'model-1',
        usage: {
          input: 5,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7,
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
        stopReason: 'stop',
        timestamp: 1,
      },
    } as AgentSessionEvent);
    this.persistedMessageCount += 1;
    this.emit({ type: 'agent_settled' } as AgentSessionEvent);
    this.settledCount += 1;
  }

  async steer(text: string): Promise<void> {
    this.calls.push({ method: 'steer', value: text });
  }

  async followUp(text: string): Promise<void> {
    this.calls.push({ method: 'followUp', value: text });
  }

  async abort(): Promise<void> {
    this.calls.push({ method: 'abort' });
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCount += 1;
      this.listeners.delete(listener);
    };
  }

  getActiveToolNames(): string[] {
    return ['list_authorized_context', 'propose_task'];
  }

  async setModel(nextModel: PiCoordinatorModel): Promise<void> {
    this.calls.push({ method: 'setModel', value: `${nextModel.provider}/${nextModel.id}` });
    this.model = nextModel;
  }

  setThinkingLevel(level: CoordinatorThinkingLevel): void {
    this.calls.push({ method: 'setThinkingLevel', value: level });
    this.thinkingLevel = this.clampThinking(level);
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

class StubFactory implements PiCoordinatorSessionFactory {
  readonly calls: Array<{ method: string; input: PiCoordinatorSessionFactoryInput }> = [];

  private readonly resourceQueue: PiCoordinatorSessionResources[];

  constructor(resources: PiCoordinatorSessionResources | PiCoordinatorSessionResources[]) {
    this.resourceQueue = Array.isArray(resources) ? [...resources] : [resources];
  }

  async create(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    this.calls.push({ method: 'create', input });
    return this.nextResources();
  }

  async open(input: PiCoordinatorOpenSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    this.calls.push({ method: 'open', input });
    return this.nextResources();
  }

  async continue(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    this.calls.push({ method: 'continue', input });
    return this.nextResources();
  }

  private nextResources(): PiCoordinatorSessionResources {
    const next = this.resourceQueue.shift();
    assert.ok(next, 'StubFactory 缺少下一组 session resources');
    return next;
  }
}

function resources(session = new StubSession()): PiCoordinatorSessionResources {
  const models = new Map([
    ['test/model-1', model('test', 'model-1')],
    ['test/model-2', model('test', 'model-2')],
    ['unauth/model', model('unauth', 'model')],
  ]);

  return {
    session,
    modelRuntime: {
      getModel: (provider, modelId) => models.get(`${provider}/${modelId}`),
      hasConfiguredAuth: (provider) => provider === 'test',
    },
    diagnostics: [],
  };
}

async function flushPromiseRejections(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('PiCoordinatorAdapter 直接委托 Pi session 能力并返回映射后的 run result', async () => {
  const session = new StubSession();
  const factory = new StubFactory(resources(session));
  const adapter = new PiCoordinatorAdapter({
    cwd: '/workspace',
    agentDir: '/agent',
    sessionDir: '/sessions',
    sessionFactory: factory,
    now: () => '2026-09-14T08:00:00.000Z',
  });

  const created = await adapter.createSession({
    assistantSessionId: 'assistant-1',
    config,
    initialEventSequence: 4,
  });
  assert.equal(created.ok, true);
  assert.equal(factory.calls[0]?.method, 'create');
  assert.deepEqual(factory.calls[0]?.input, {
    cwd: '/workspace',
    agentDir: '/agent',
    sessionDir: '/sessions',
    config,
  });

  const events: string[] = [];
  const subscription = adapter.subscribe('assistant-1', (event) => {
    events.push(`${event.sequence}:${event.type}`);
  });
  assert.equal(subscription.ok, true);

  const run = await adapter.prompt('assistant-1', '开始工作');
  assert.deepEqual(run, {
    ok: true,
    value: {
      status: 'completed',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 7,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    },
  });
  assert.deepEqual(events, [
    '5:coordinator.run.started',
    '6:coordinator.message.ended',
    '7:coordinator.run.completed',
  ]);

  await adapter.steer('assistant-1', '调整方向');
  await adapter.followUp('assistant-1', '稍后执行');
  await adapter.abort('assistant-1');
  const switched = await adapter.setModel('assistant-1', {
    provider: 'test',
    modelId: 'model-2',
    thinkingLevel: 'high',
  });
  assert.deepEqual(switched, {
    ok: true,
    value: {
      model: { provider: 'test', modelId: 'model-2', thinkingLevel: 'high' },
      diagnostics: [],
    },
  });
  assert.deepEqual(
    session.calls.map((call) => call.method),
    ['prompt', 'steer', 'followUp', 'abort', 'setModel', 'setThinkingLevel'],
  );

  adapter.disposeSession('assistant-1');
  assert.equal(session.unsubscribeCount, 1);
  assert.equal(session.disposed, true);
});

test('PiCoordinatorAdapter 隔离订阅异常且不影响持久化、settled 和其他订阅者', async () => {
  const session = new StubSession();
  const diagnostics: CoordinatorDiagnostic[] = [];
  const adapter = new PiCoordinatorAdapter({
    sessionFactory: new StubFactory(resources(session)),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await adapter.createSession({ assistantSessionId: 'assistant-1', config });

  const received: string[] = [];
  const failingSubscription = adapter.subscribe('assistant-1', (event) => {
    if (event.type === 'coordinator.message.ended') {
      throw new Error('SECRET_SUBSCRIBER_ERROR');
    }
  });
  const healthySubscription = adapter.subscribe('assistant-1', (event) => {
    received.push(event.type);
  });
  assert.equal(failingSubscription.ok, true);
  assert.equal(healthySubscription.ok, true);

  const run = await adapter.prompt('assistant-1', '开始工作');

  assert.equal(run.ok, true);
  assert.equal(session.persistedMessageCount, 1);
  assert.equal(session.settledCount, 1);
  assert.deepEqual(received, [
    'coordinator.run.started',
    'coordinator.message.ended',
    'coordinator.run.completed',
  ]);
  assert.deepEqual(diagnostics, [{
    code: 'EVENT_LISTENER_FAILED',
    message: '协调助手公共事件订阅者处理 coordinator.message.ended 时失败，事件已继续分发。',
    eventType: 'coordinator.message.ended',
  }]);
  assert.equal(JSON.stringify(diagnostics).includes('SECRET_SUBSCRIBER_ERROR'), false);

  if (healthySubscription.ok) {
    healthySubscription.value();
  }
  session.emit({ type: 'agent_start' } as AgentSessionEvent);
  assert.equal(received.length, 3);
});

test('PiCoordinatorAdapter 隔离异步订阅和诊断拒绝且不产生未处理拒绝', async () => {
  const session = new StubSession();
  const diagnostics: CoordinatorDiagnostic[] = [];
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const adapter = new PiCoordinatorAdapter({
      sessionFactory: new StubFactory(resources(session)),
      onDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
        if (diagnostics.length === 1) {
          throw new Error('SECRET_DIAGNOSTIC_IMMEDIATE_REJECTION');
        }

        await Promise.resolve();
        throw new Error('SECRET_DIAGNOSTIC_DELAYED_REJECTION');
      },
    });
    await adapter.createSession({ assistantSessionId: 'assistant-1', config });

    adapter.subscribe('assistant-1', async (event) => {
      if (event.type === 'coordinator.run.started') {
        throw new Error('SECRET_LISTENER_IMMEDIATE_REJECTION');
      }
      if (event.type === 'coordinator.message.ended') {
        await Promise.resolve();
        throw new Error('SECRET_LISTENER_DELAYED_REJECTION');
      }
    });

    const received: string[] = [];
    adapter.subscribe('assistant-1', (event) => received.push(event.type));

    const run = await adapter.prompt('assistant-1', '开始工作');
    await flushPromiseRejections();

    assert.equal(run.ok, true);
    assert.equal(session.persistedMessageCount, 1);
    assert.equal(session.settledCount, 1);
    assert.deepEqual(received, [
      'coordinator.run.started',
      'coordinator.message.ended',
      'coordinator.run.completed',
    ]);
    assert.deepEqual(diagnostics, [
      {
        code: 'EVENT_LISTENER_FAILED',
        message: '协调助手公共事件订阅者处理 coordinator.run.started 时失败，事件已继续分发。',
        eventType: 'coordinator.run.started',
      },
      {
        code: 'EVENT_LISTENER_FAILED',
        message: '协调助手公共事件订阅者处理 coordinator.message.ended 时失败，事件已继续分发。',
        eventType: 'coordinator.message.ended',
      },
    ]);
    assert.equal(JSON.stringify(diagnostics).includes('SECRET_'), false);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('PiCoordinatorAdapter 替换同一会话时释放旧订阅和 session', async () => {
  const oldSession = new StubSession();
  const nextSession = new StubSession();
  nextSession.sessionId = 'pi-2';
  nextSession.sessionFile = '/sessions/pi-2.jsonl';
  const factory = new StubFactory([resources(oldSession), resources(nextSession)]);
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory });
  await adapter.createSession({ assistantSessionId: 'assistant-1', config });
  const oldEvents: string[] = [];
  adapter.subscribe('assistant-1', (event) => oldEvents.push(event.type));

  const replaced = await adapter.createSession({ assistantSessionId: 'assistant-1', config });

  assert.equal(replaced.ok, true);
  assert.equal(oldSession.unsubscribeCount, 1);
  assert.equal(oldSession.disposed, true);
  oldSession.emit({ type: 'agent_start' } as AgentSessionEvent);
  assert.deepEqual(oldEvents, []);

  const nextEvents: string[] = [];
  adapter.subscribe('assistant-1', (event) => nextEvents.push(event.type));
  nextSession.emit({ type: 'agent_start' } as AgentSessionEvent);
  assert.deepEqual(nextEvents, ['coordinator.run.started']);
});

test('PiCoordinatorAdapter 在 create、continue 和 setters 返回 thinking clamp 诊断', async () => {
  const clamp = (): CoordinatorThinkingLevel => 'off';
  const createSession = new StubSession(clamp);
  createSession.thinkingLevel = 'off';
  const createAdapter = new PiCoordinatorAdapter({
    sessionFactory: new StubFactory(resources(createSession)),
  });
  const created = await createAdapter.createSession({
    assistantSessionId: 'assistant-create',
    config,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.model.thinkingLevel, 'off');
  assert.equal(created.value.diagnostics[0]?.code, 'THINKING_LEVEL_ADJUSTED');

  const continuedSession = new StubSession(clamp);
  continuedSession.thinkingLevel = 'off';
  const continueAdapter = new PiCoordinatorAdapter({
    sessionFactory: new StubFactory(resources(continuedSession)),
  });
  const continued = await continueAdapter.continueSession({
    binding: {
      assistantSessionId: 'assistant-continue',
      piSessionId: continuedSession.sessionId,
      piSessionPath: continuedSession.sessionFile!,
      updatedAt: '2026-09-14T07:00:00.000Z',
    },
    config,
  });
  assert.equal(continued.ok, true);
  if (!continued.ok) return;
  assert.equal(continued.value.model.thinkingLevel, 'off');
  assert.equal(continued.value.diagnostics[0]?.code, 'THINKING_LEVEL_ADJUSTED');

  const setModel = await continueAdapter.setModel('assistant-continue', {
    provider: 'test',
    modelId: 'model-2',
    thinkingLevel: 'high',
  });
  assert.equal(setModel.ok, true);
  if (!setModel.ok) return;
  assert.equal(setModel.value.model.thinkingLevel, 'off');
  assert.deepEqual(setModel.value.diagnostics[0], {
    code: 'THINKING_LEVEL_ADJUSTED',
    message: '请求的 thinking level high 已按模型能力调整为 off。',
    requestedThinkingLevel: 'high',
    actualThinkingLevel: 'off',
  });

  const setThinking = await continueAdapter.setThinkingLevel('assistant-continue', 'low');
  assert.equal(setThinking.ok, true);
  if (!setThinking.ok) return;
  assert.equal(setThinking.value.model.thinkingLevel, 'off');
  assert.equal(setThinking.value.diagnostics[0]?.code, 'THINKING_LEVEL_ADJUSTED');
});

test('PiCoordinatorAdapter 继续会话使用绑定路径，绑定不匹配时保留原绑定', async () => {
  const session = new StubSession();
  const factory = new StubFactory(resources(session));
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory });
  const binding = {
    assistantSessionId: 'assistant-1',
    piSessionId: 'pi-1',
    piSessionPath: '/sessions/pi-1.jsonl',
    updatedAt: '2026-09-14T07:00:00.000Z',
  };

  const continued = await adapter.continueSession({ binding, config });
  assert.equal(continued.ok, true);
  assert.equal(factory.calls[0]?.method, 'open');
  assert.equal((factory.calls[0]?.input as PiCoordinatorOpenSessionFactoryInput).sessionPath, binding.piSessionPath);

  adapter.dispose();
  const mismatchedSession = new StubSession();
  mismatchedSession.sessionId = 'different';
  const mismatchAdapter = new PiCoordinatorAdapter({
    sessionFactory: new StubFactory(resources(mismatchedSession)),
  });
  const mismatch = await mismatchAdapter.continueSession({ binding, config });
  assert.deepEqual(mismatch, {
    ok: false,
    error: {
      code: 'SESSION_BINDING_MISMATCH',
      message: 'Pi 会话与现有协调助手绑定不一致。',
      recoverableBinding: binding,
    },
  });
  assert.equal(mismatchedSession.disposed, true);
});

test('PiCoordinatorAdapter 在模型缺失或无认证时返回稳定诊断', async () => {
  const session = new StubSession();
  const adapter = new PiCoordinatorAdapter({ sessionFactory: new StubFactory(resources(session)) });
  await adapter.createSession({ assistantSessionId: 'assistant-1', config });

  assert.deepEqual(await adapter.setModel('assistant-1', {
    provider: 'missing',
    modelId: 'model',
    thinkingLevel: 'off',
  }), {
    ok: false,
    error: { code: 'MODEL_NOT_FOUND', message: '未找到模型 missing/model。' },
  });
  assert.deepEqual(await adapter.setModel('assistant-1', {
    provider: 'unauth',
    modelId: 'model',
    thinkingLevel: 'off',
  }), {
    ok: false,
    error: { code: 'MODEL_AUTH_UNAVAILABLE', message: '模型提供方 unauth 没有可用认证。' },
  });
});

test('PiCoordinatorAdapter 恢复失败时保留原绑定供上层对账', async () => {
  const binding = {
    assistantSessionId: 'assistant-1',
    piSessionId: 'pi-1',
    piSessionPath: '/missing/pi-1.jsonl',
    updatedAt: '2026-09-14T07:00:00.000Z',
  };
  const factory: PiCoordinatorSessionFactory = {
    create: async () => resources(),
    open: async () => {
      throw new Error('missing');
    },
    continue: async () => resources(),
  };
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory });

  assert.deepEqual(await adapter.continueSession({ binding, config }), {
    ok: false,
    error: {
      code: 'SESSION_OPEN_FAILED',
      message: 'Pi 协调助手运行时初始化失败。',
      recoverableBinding: binding,
    },
  });
});

test('PiCoordinatorAdapter 拒绝重复授权引用和无持久化路径的 session', async () => {
  const invalidConfig: CoordinatorRuntimeConfig = {
    ...config,
    authorizedContext: [
      { referenceId: 'same', label: 'A', content: 'A' },
      { referenceId: 'same', label: 'B', content: 'B' },
    ],
  };
  const session = new StubSession();
  const factory = new StubFactory(resources(session));
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory });

  const invalid = await adapter.createSession({ assistantSessionId: 'assistant-1', config: invalidConfig });
  assert.equal(invalid.ok, false);
  assert.equal(factory.calls.length, 0);

  session.sessionFile = undefined;
  const noPath = await adapter.createSession({ assistantSessionId: 'assistant-1', config });
  assert.deepEqual(noPath, {
    ok: false,
    error: {
      code: 'RUNTIME_OPERATION_FAILED',
      message: 'Pi SessionManager 未提供可持久化的 session path。',
    },
  });
  assert.equal(session.disposed, true);
});
