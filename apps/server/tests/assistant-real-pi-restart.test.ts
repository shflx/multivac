import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEventListener,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { COORDINATOR_TOOL_ALLOWLIST } from '../src/runtime/executors/coordinator-tools.js';
import {
  DefaultPiCoordinatorSessionFactory,
  type PiCoordinatorModel,
} from '../src/runtime/executors/pi-session-factory.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
} from '../src/storage/sqlite-assistant-store.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'test', modelId: 'model', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

function model(): PiCoordinatorModel {
  return {
    provider: 'test', id: 'model', api: 'openai-responses', baseUrl: 'https://test.example/v1',
  } as PiCoordinatorModel;
}

function createSessionResult(options: CreateAgentSessionOptions) {
  const sessionManager = options.sessionManager;
  assert.ok(sessionManager);
  const selectedModel = model();
  const session = {
    sessionManager,
    get sessionId() {
      return sessionManager.getSessionId();
    },
    get sessionFile() {
      return sessionManager.getSessionFile();
    },
    get model() {
      return selectedModel;
    },
    get thinkingLevel() {
      return 'off' as const;
    },
    getActiveToolNames: () => [...COORDINATOR_TOOL_ALLOWLIST],
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    subscribe: (_listener: AgentSessionEventListener) => () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    dispose: () => {},
  } as unknown as AgentSession;
  return {
    session,
    extensionsResult: options.resourceLoader!.getExtensions(),
  };
}

function createFactory(cwd: string, agentDir: string) {
  const runtime = {
    getModel: (provider: string, modelId: string) =>
      provider === 'test' && modelId === 'model' ? model() : undefined,
    hasConfiguredAuth: (provider: string) => provider === 'test',
    getAuth: async () => ({ auth: {} }),
  } as unknown as ModelRuntime;

  return new DefaultPiCoordinatorSessionFactory({
    createModelRuntime: async () => runtime,
    createSettingsManager: () => SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
    createAgentSession: async (options) => createSessionResult(options),
  });
}

function createService(root: string) {
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new PiCoordinatorAdapter({
    cwd,
    agentDir,
    sessionDir,
    sessionFactory: createFactory(cwd, agentDir),
  });
  return {
    store,
    adapter,
    sessionDir,
    service: new AssistantSessionService({
      adapter,
      bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      runtimeConfig: config,
    }),
  };
}

test('真实 Pi 空会话在 binding 前落盘，关闭后可按同一路径和 ID 恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-real-pi-empty-restart-'));
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'agent'), { recursive: true });

  try {
    const first = createService(root);
    const binding = await first.service.initialize();
    await access(binding.piSessionPath);

    const persisted = SessionManager.open(binding.piSessionPath, first.sessionDir, join(root, 'workspace'));
    assert.equal(persisted.getSessionId(), binding.piSessionId);
    assert.deepEqual(persisted.getBranch().filter((entry) => entry.type === 'message'), []);

    first.adapter.dispose();
    first.store.close();

    const second = createService(root);
    const restoredBinding = await second.service.initialize();
    const page = await second.service.getSessionPage({ limit: 10 });
    assert.deepEqual(restoredBinding, binding);
    assert.equal(page.piSessionId, binding.piSessionId);
    assert.deepEqual(page.messages, []);

    const reopened = SessionManager.open(
      restoredBinding.piSessionPath,
      second.sessionDir,
      join(root, 'workspace'),
    );
    assert.equal(reopened.getSessionId(), restoredBinding.piSessionId);
    assert.deepEqual(reopened.getBranch().filter((entry) => entry.type === 'message'), []);

    second.adapter.dispose();
    second.store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('已有 binding 的缺失 Pi 路径不会在 open 流程中创建替代会话文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-real-pi-missing-binding-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const missingPath = join(sessionDir, 'missing.jsonl');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  try {
    const resources = await createFactory(cwd, agentDir).open({
      cwd,
      agentDir,
      sessionDir,
      sessionPath: missingPath,
      config,
    });
    await assert.rejects(access(missingPath));
    resources.session.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
