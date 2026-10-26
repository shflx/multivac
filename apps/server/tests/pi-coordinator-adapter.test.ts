import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CoordinatorDiagnostic,
  CoordinatorRuntimeConfig,
  CoordinatorThinkingLevel,
} from '@multivac/contracts';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { config, flushPromiseRejections, model, resources, StubFactory, StubSession } from './fixtures/pi-session-stub.js';

test('Pi 图片参数保持内容顺序，运行中追加透传，不支持能力明确拒绝', async () => {
  const session = new StubSession();
  session.model = { ...model('test', 'model-1'), input: ['text', 'image'] };
  const adapter = new PiCoordinatorAdapter({ sessionFactory: new StubFactory(resources(session)) });
  try {
    assert.ok((await adapter.createSession({ assistantSessionId: 'pictures', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } })).ok);
    const images = [{ id: 'first', mimeType: 'image/png', data: 'AA==' }, { id: 'second', mimeType: 'image/jpeg', data: 'AQ==' }];
    assert.ok((await adapter.prompt('pictures', '', undefined, undefined, undefined, images)).ok);
    assert.deepEqual(session.receivedImages, images.map(({ id: _id, ...image }) => ({ type: 'image', ...image })));
    await adapter.steer('pictures', '补充', undefined, undefined, images);
    assert.equal(session.receivedImages?.[1]?.data, 'AQ==');
    await adapter.followUp('pictures', '', undefined, undefined, images);
    assert.equal(session.receivedImages?.[0]?.data, 'AA==');
    session.model = { ...model('test', 'model-1'), input: ['text'] };
    assert.equal(adapter.supportsImageInput('pictures'), false);
    assert.equal((await adapter.prompt('pictures', '', undefined, undefined, undefined, images)).ok, false);
  } finally { adapter.dispose(); }
});

test('PiCoordinatorAdapter 直接委托 Pi session 能力并返回映射后的 run result', async () => {
  const session = new StubSession();
  const factory = new StubFactory(resources(session));
  const adapter = new PiCoordinatorAdapter({
    agentDir: '/agent',
    sessionDir: '/sessions',
    sessionFactory: factory,
    now: () => '2026-09-14T08:00:00.000Z',
  });

  const created = await adapter.createSession({
    assistantSessionId: 'assistant-1',
    config,
    workingDirectory: { kind: 'session-temp', path: '/workspace' },
    initialEventSequence: 4,
  });
  assert.equal(created.ok, true);
  assert.equal(factory.calls[0]?.method, 'create');
  assert.deepEqual(factory.calls[0]?.input, {
    assistantSessionId: 'assistant-1',
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

test('PiCoordinatorAdapter 使用 continueRecent 并从 active branch 映射历史', async () => {
  const session = new StubSession();
  session.branch = [
    {
      type: 'message',
      id: 'entry-1',
      parentId: null,
      timestamp: '2026-09-14T08:00:00.000Z',
      message: { role: 'user', content: '恢复历史', timestamp: 1 },
    },
  ];
  const factory = new StubFactory(resources(session));
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory });

  const initialized = await adapter.continueRecentSession({
    workingDirectory: { kind: 'session-temp', path: '/workspace' },
    assistantSessionId: 'assistant-recent',
    config,
  });

  assert.equal(initialized.ok, true);
  assert.equal(factory.calls[0]?.method, 'continue');
  assert.deepEqual(adapter.readActiveBranch('assistant-recent'), {
    ok: true,
    value: {
      runtimeSessionId: 'pi-1',
      leafEntryId: 'entry-1',
      messages: [{
        id: 'pi-1:entry-1',
        runtimeSessionId: 'pi-1',
        runtimeEntryId: 'entry-1',
        role: 'user',
        text: '恢复历史',
        createdAt: '2026-09-14T08:00:00.000Z',
        runtimeMessageId: 'user:1',
      }],
    },
  });
});

test('PiCoordinatorAdapter continueRecent 透传新会话默认 resolver 给可注入 factory', async () => {
  const session = new StubSession();
  const controlledConfig: CoordinatorRuntimeConfig = {
    ...config,
    model: {
      provider: 'test',
      modelId: 'model-2',
      thinkingLevel: 'medium',
      protocol: 'openai-responses',
      endpoint: null,
      resolvedEndpoint: 'https://official.example/v1',
    },
  };
  let resolverCalled = false;
  const factory: PiCoordinatorSessionFactory = {
    create: async () => resources(session),
    open: async () => resources(session),
    continue: async (input) => {
      assert.ok(input.resolveNewSessionConfig);
      const resolved = await input.resolveNewSessionConfig();
      return {
        ...resources(session),
        appliedModelConfig: resolved.model,
        resumedExistingSession: false,
      };
    },
  };
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory });

  const initialized = await adapter.continueRecentSession({
    workingDirectory: { kind: 'session-temp', path: '/workspace' },
    assistantSessionId: 'assistant-controlled-default',
    config,
    resolveNewSessionConfig: async () => {
      resolverCalled = true;
      return controlledConfig;
    },
  });

  assert.equal(resolverCalled, true);
  assert.equal(initialized.ok, true);
  if (!initialized.ok) return;
  assert.deepEqual(initialized.value.modelConfig, controlledConfig.model);
  assert.equal(initialized.value.resumedExistingSession, false);
});

test('PiCoordinatorAdapter 隔离订阅异常且不影响持久化、settled 和其他订阅者', async () => {
  const session = new StubSession();
  const diagnostics: CoordinatorDiagnostic[] = [];
  const adapter = new PiCoordinatorAdapter({
    sessionFactory: new StubFactory(resources(session)),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await adapter.createSession({ assistantSessionId: 'assistant-1', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });

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
    message: 'Multivac 公共事件订阅者处理 coordinator.message.ended 时失败，事件已继续分发。',
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
    await adapter.createSession({ assistantSessionId: 'assistant-1', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });

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
        message: 'Multivac 公共事件订阅者处理 coordinator.run.started 时失败，事件已继续分发。',
        eventType: 'coordinator.run.started',
      },
      {
        code: 'EVENT_LISTENER_FAILED',
        message: 'Multivac 公共事件订阅者处理 coordinator.message.ended 时失败，事件已继续分发。',
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
  await adapter.createSession({ assistantSessionId: 'assistant-1', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });
  const oldEvents: string[] = [];
  adapter.subscribe('assistant-1', (event) => oldEvents.push(event.type));

  const replaced = await adapter.createSession({ assistantSessionId: 'assistant-1', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });

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
    workingDirectory: { kind: 'session-temp', path: '/workspace' },
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
    workingDirectory: { kind: 'session-temp', path: '/workspace' },
    binding: {
      assistantSessionId: 'assistant-continue', harness: 'pi',
      runtimeSessionId: continuedSession.sessionId,
      runtimeSessionRef: continuedSession.sessionFile!,
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

test('PiCoordinatorAdapter 按每次传入的会话工作目录构建运行时，不在共享实例上固定 cwd', async () => {
  const first = new StubSession();
  const second = new StubSession();
  second.sessionId = 'pi-2';
  second.sessionFile = '/sessions/pi-2.jsonl';
  const factory = new StubFactory([resources(first), resources(second), resources(new StubSession())]);
  const adapter = new PiCoordinatorAdapter({ sessionDir: '/sessions', sessionFactory: factory });

  assert.equal((await adapter.createSession({ assistantSessionId: 'work-a', config, workingDirectory: { kind: 'session-temp', path: '/work/a' } })).ok, true);
  const binding = {
    assistantSessionId: 'work-b', harness: 'pi', runtimeSessionId: 'pi-2', runtimeSessionRef: '/sessions/pi-2.jsonl',
    updatedAt: '2026-09-14T07:00:00.000Z',
  };
  assert.equal((await adapter.continueSession({ binding, config, workingDirectory: { kind: 'session-temp', path: '/work/b' } })).ok, true);
  assert.equal((await adapter.continueRecentSession({ assistantSessionId: 'global', config, workingDirectory: { kind: 'session-temp', path: '/work/multivac' } })).ok, true);
  assert.deepEqual(factory.calls.map((call) => [call.method, call.input.cwd, call.input.sessionDir]), [
    ['create', '/work/a', '/sessions'],
    ['open', '/work/b', '/sessions'],
    ['continue', '/work/multivac', '/sessions'],
  ]);

  // 相对路径会按服务进程的启动目录解析，一律拒绝，不调用 Pi。
  for (const cwd of ['', 'relative/dir']) {
    const invalid = await adapter.createSession({ assistantSessionId: 'work-c', config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.equal(invalid.ok, false);
    assert.equal(!invalid.ok && invalid.error.code, 'INVALID_CONFIGURATION');
  }
  assert.equal(factory.calls.length, 3);
  adapter.dispose();
});

test('PiCoordinatorAdapter 动态目录来源跨创建与恢复生效，真实隔离模式不注入项目范围', async () => {
  const factory = new StubFactory(resources(new StubSession()));
  let current = ['/project/a'];
  const calls: string[] = [];
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory, projectFileScope: (id) => { calls.push(id); return current; } });
  try {
    await adapter.createSession({ assistantSessionId: 'work-a', config, workingDirectory: { kind: 'session-temp', path: '/work/a' } });
    const source = factory.calls[0]!.input.projectDirectories!;
    assert.deepEqual(source(), ['/project/a']);
    current = ['/project/b'];
    assert.deepEqual(source(), ['/project/b']);
    assert.deepEqual(calls, ['work-a', 'work-a']);
    for (const kind of ['task-isolated', 'worktree'] as const) {
      await adapter.createSession({ assistantSessionId: kind, config, workingDirectory: { kind, path: '/ordinary-name' } });
      assert.equal(factory.calls.at(-1)!.input.projectDirectories, undefined);
      assert.equal(factory.calls.at(-1)!.input.taskIsolation, true);
    }
    await adapter.continueSession({ binding: { assistantSessionId: 'restored', harness: 'pi', runtimeSessionId: 'pi-1', runtimeSessionRef: '/sessions/pi-1.jsonl', updatedAt: '2026-09-14T07:00:00.000Z' }, config, workingDirectory: { kind: 'session-temp', path: '/work/restored' } });
    assert.deepEqual(factory.calls.at(-1)!.input.projectDirectories!(), ['/project/b']);
  } finally { adapter.dispose(); }
});

test('PiCoordinatorAdapter 把目录外访问交给授权决定，并补齐会话身份与工作目录记录', async () => {
  const first = new StubSession();
  const second = new StubSession();
  second.sessionId = 'pi-2';
  second.sessionFile = '/sessions/pi-2.jsonl';
  const factory = new StubFactory([resources(first), resources(second)]);
  const requests: unknown[] = [];
  const adapter = new PiCoordinatorAdapter({
    sessionDir: '/sessions',
    sessionFactory: factory,
    authorizeToolCall: async (request, signal) => {
      requests.push({ request, aborted: signal.aborted });
      return { allowed: false, reason: '测试拒绝' };
    },
  });

  await adapter.createSession({
    assistantSessionId: 'work-a', config, workingDirectory: { kind: 'session-temp', path: '/work/a' },
  });
  await adapter.continueSession({
    binding: {
      assistantSessionId: 'global', harness: 'pi', runtimeSessionId: 'pi-2', runtimeSessionRef: '/sessions/pi-2.jsonl',
      updatedAt: '2026-09-14T07:00:00.000Z',
    },
    config,
    workingDirectory: { kind: 'multivac', path: '/work/multivac' },
  });

  const access = { toolName: 'write' as const, requestedPath: '../x', targetPath: '/work/x' };
  const signal = new AbortController().signal;
  assert.deepEqual(
    await factory.calls[0]!.input.authorizeOutsideAccess!({ ...access, toolCallId: 'call-a' }, signal),
    { allowed: false, reason: '测试拒绝' },
  );
  await factory.calls[1]!.input.authorizeOutsideAccess!({ ...access, toolCallId: 'call-b' }, signal);
  assert.deepEqual(requests, [
    {
      request: {
        ...access, toolCallId: 'call-a', assistantSessionId: 'work-a',
        workingDirectory: { kind: 'session-temp', path: '/work/a' },
      },
      aborted: false,
    },
    {
      request: {
        ...access, toolCallId: 'call-b', assistantSessionId: 'global',
        workingDirectory: { kind: 'multivac', path: '/work/multivac' },
      },
      aborted: false,
    },
  ]);
  adapter.dispose();
});

test('PiCoordinatorAdapter 继续会话使用绑定路径，绑定不匹配时保留原绑定', async () => {
  const session = new StubSession();
  const factory = new StubFactory(resources(session));
  const adapter = new PiCoordinatorAdapter({ sessionFactory: factory });
  const binding = {
    assistantSessionId: 'assistant-1', harness: 'pi',
    runtimeSessionId: 'pi-1',
    runtimeSessionRef: '/sessions/pi-1.jsonl',
    updatedAt: '2026-09-14T07:00:00.000Z',
  };

  const continued = await adapter.continueSession({ binding, config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });
  assert.equal(continued.ok, true);
  assert.equal(factory.calls[0]?.method, 'open');
  assert.equal((factory.calls[0]?.input as PiCoordinatorOpenSessionFactoryInput).sessionPath, binding.runtimeSessionRef);

  adapter.dispose();
  const mismatchedSession = new StubSession();
  mismatchedSession.sessionId = 'different';
  const mismatchAdapter = new PiCoordinatorAdapter({
    sessionFactory: new StubFactory(resources(mismatchedSession)),
  });
  const mismatch = await mismatchAdapter.continueSession({ binding, config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });
  assert.deepEqual(mismatch, {
    ok: false,
    error: {
      code: 'SESSION_BINDING_MISMATCH',
      message: 'Pi 会话与现有 Multivac 绑定不一致。',
      recoverableBinding: binding,
    },
  });
  assert.equal(mismatchedSession.disposed, true);
});

test('PiCoordinatorAdapter 在模型缺失或无认证时返回稳定诊断', async () => {
  const session = new StubSession();
  const adapter = new PiCoordinatorAdapter({ sessionFactory: new StubFactory(resources(session)) });
  await adapter.createSession({ assistantSessionId: 'assistant-1', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });

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
    assistantSessionId: 'assistant-1', harness: 'pi',
    runtimeSessionId: 'pi-1',
    runtimeSessionRef: '/missing/pi-1.jsonl',
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

  assert.deepEqual(await adapter.continueSession({ binding, config, workingDirectory: { kind: 'session-temp', path: '/workspace' } }), {
    ok: false,
    error: {
      code: 'SESSION_OPEN_FAILED',
      message: 'Multivac 的 Pi 运行时初始化失败。',
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

  const invalid = await adapter.createSession({ assistantSessionId: 'assistant-1', config: invalidConfig, workingDirectory: { kind: 'session-temp', path: '/workspace' } });
  assert.equal(invalid.ok, false);
  assert.equal(factory.calls.length, 0);

  session.sessionFile = undefined;
  const noPath = await adapter.createSession({ assistantSessionId: 'assistant-1', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });
  assert.deepEqual(noPath, {
    ok: false,
    error: {
      code: 'RUNTIME_OPERATION_FAILED',
      message: 'Pi SessionManager 未提供可持久化的 session path。',
    },
  });
  assert.equal(session.disposed, true);
});
