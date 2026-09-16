import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type AgentSessionEventListener,
  type CreateAgentSessionOptions,
  type CreateModelRuntimeOptions,
  type SettingsStorage,
} from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { COORDINATOR_TOOL_ALLOWLIST } from '../src/runtime/executors/coordinator-tools.js';
import {
  DefaultPiCoordinatorSessionFactory,
  createCoordinatorSettingsManager,
  type PiCoordinatorAgentSession,
  type PiCoordinatorModel,
} from '../src/runtime/executors/pi-session-factory.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'test', modelId: 'model', thinkingLevel: 'off' },
  retry: { enabled: true, maxRetries: 4, baseDelayMs: 250 },
  compaction: { enabled: false, reserveTokens: 3_000, keepRecentTokens: 5_000 },
};

test('SettingsManager 使用本次 runtime 配置且不持久化覆盖值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-settings-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, '{ invalid json');

  try {
    const { settingsManager, diagnostics } = await createCoordinatorSettingsManager({
      cwd,
      agentDir,
      config,
    });

    assert.equal(diagnostics[0]?.code, 'SETTINGS_LOAD_FAILED');
    assert.deepEqual(settingsManager.getRetrySettings(), config.retry);
    assert.deepEqual(settingsManager.getCompactionSettings(), config.compaction);
    assert.deepEqual(settingsManager.getDefaultTools(), []);
    assert.equal(await readFile(settingsPath, 'utf8'), '{ invalid json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class ReloadFailingStorage implements SettingsStorage {
  globalReads = 0;

  constructor(private readonly globalSettings: object) {}

  withLock(scope: 'global' | 'project', fn: (current: string | undefined) => string | undefined): void {
    const current =
      scope === 'global'
        ? this.globalReads++ === 0
          ? JSON.stringify(this.globalSettings)
          : '{ invalid json'
        : undefined;
    fn(current);
  }
}

function piModel(provider: string, id: string): PiCoordinatorModel {
  return { provider, id } as PiCoordinatorModel;
}

function factorySession(thinkingLevel: 'off' | 'low' = 'low'): PiCoordinatorAgentSession {
  return {
    sessionId: 'pi-production-factory',
    sessionFile: '/sessions/pi-production-factory.jsonl',
    model: piModel('test', 'model'),
    thinkingLevel,
    getActiveBranch: () => [],
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    subscribe: (_listener: AgentSessionEventListener) => () => {},
    getActiveToolNames: () => [...COORDINATOR_TOOL_ALLOWLIST],
    setModel: async () => {},
    setThinkingLevel: () => {},
    dispose: () => {},
  };
}

test('默认 factory 直接装配受控资源、最终 settings 和 thinking 诊断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-production-factory-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const installMarker = join(root, 'package-install-marker');
  const installer = join(root, 'installer.mjs');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(installer, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(installMarker)}, 'installed');`);

  const storage = new ReloadFailingStorage({
    npmCommand: [process.execPath, installer],
    packages: ['npm:multivac-untrusted-package'],
    extensions: ['/untrusted/extension.mjs'],
    skills: ['/untrusted/skill'],
    prompts: ['/untrusted/prompt.md'],
    themes: ['/untrusted/theme.json'],
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 2 },
  });
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
  const modelRuntime = {
    getModel: (provider: string, modelId: string) =>
      provider === 'test' && modelId === 'model' ? piModel(provider, modelId) : undefined,
    hasConfiguredAuth: (provider: string) => provider === 'test',
  } as unknown as ModelRuntime;
  let capturedAgentOptions: CreateAgentSessionOptions | undefined;
  let capturedRuntimeOptions: CreateModelRuntimeOptions | undefined;
  const session = factorySession('low');
  const factory = new DefaultPiCoordinatorSessionFactory({
    createSettingsManager: () => settingsManager,
    createModelRuntime: async (options) => {
      capturedRuntimeOptions = options;
      return modelRuntime;
    },
    createAgentSession: async (options) => {
      capturedAgentOptions = options;
      return { session: session as never, extensionsResult: options.resourceLoader!.getExtensions() };
    },
  });

  try {
    const result = await factory.create({ cwd, agentDir, sessionDir, config });

    assert.equal(capturedRuntimeOptions?.allowModelNetwork, false);
    assert.ok(capturedAgentOptions);
    assert.ok(capturedAgentOptions.resourceLoader);
    assert.equal(capturedAgentOptions?.noTools, 'all');
    assert.deepEqual(capturedAgentOptions?.tools, [...COORDINATOR_TOOL_ALLOWLIST]);
    assert.deepEqual(
      capturedAgentOptions?.customTools?.map((tool) => tool.name),
      [...COORDINATOR_TOOL_ALLOWLIST],
    );
    assert.equal(capturedAgentOptions?.resourceLoader instanceof DefaultResourceLoader, false);
    assert.deepEqual(capturedAgentOptions?.resourceLoader?.getAgentsFiles(), { agentsFiles: [] });
    assert.deepEqual(capturedAgentOptions?.resourceLoader?.getSkills(), {
      skills: [],
      diagnostics: [],
    });
    assert.deepEqual(settingsManager.getRetrySettings(), config.retry);
    assert.deepEqual(settingsManager.getCompactionSettings(), config.compaction);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === 'SETTINGS_LOAD_FAILED'), true);
    assert.deepEqual(result.diagnostics.find((diagnostic) => diagnostic.code === 'THINKING_LEVEL_ADJUSTED'), {
      code: 'THINKING_LEVEL_ADJUSTED',
      message: '请求的 thinking level off 已按模型能力调整为 low。',
      requestedThinkingLevel: 'off',
      actualThinkingLevel: 'low',
    });

    await capturedAgentOptions.resourceLoader.reload();
    assert.deepEqual(settingsManager.getRetrySettings(), config.retry);
    assert.deepEqual(settingsManager.getCompactionSettings(), config.compaction);
    await assert.rejects(access(installMarker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
