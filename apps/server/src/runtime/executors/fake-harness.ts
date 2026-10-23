import { join } from 'node:path';
import { createWebSettingsStore } from './pi-web-settings.js';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import type { StoredModelSettingsState } from '../../modules/model-settings/model-settings.js';
import { FakeCoordinatorAdapter } from './fake-coordinator-adapter.js';
import { FakeModelAccessBackend } from './fake-model-access-backend.js';
import { FakeModelSettingsCatalogFactory } from './fake-model-settings-catalog.js';
import type { HarnessFactory, HarnessRuntime } from './harness.js';
import { createMcpCredentialVault } from './pi-mcp-credentials.js';
import { mcpWireFactory } from './mcp-wire-factory.js';

/** Fake 执行器额外提供给 E2E 控制面的对象：按脚本回复的适配器、可拨动的模型访问后端与夹具状态。 */
export interface FakeHarnessRuntime extends HarnessRuntime {
  readonly adapter: FakeCoordinatorAdapter;
  readonly accessBackend: FakeModelAccessBackend;
  /** 已触发过的“失败场景”提示：同一提示第二次发送时成功，用于验证重试。 */
  readonly failedPrompts: Set<string>;
  readonly modelSettingsState: () => StoredModelSettingsState;
}

function fakeHistory() {
  return Array.from({ length: 72 }, (_, index) => ({
    id: `fixture:${index + 1}`,
    runtimeSessionId: 'fixture',
    runtimeEntryId: `entry-${String(index + 1).padStart(3, '0')}`,
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

/**
 * 演示与 E2E 用的 Fake 执行器：不发起真实模型调用，按提示中的场景关键字产生事件。
 * 只在显式开启 Fake 模式时装配。
 */
export const createFakeHarness: HarnessFactory<FakeHarnessRuntime> = (context) => {
  const failedFakePrompts = new Set<string>();
  const accessBackend = new FakeModelAccessBackend();
  const adapter = new FakeCoordinatorAdapter({
    bashProcesses: context.bashProcesses,
    // 动态事件与命令服务使用同一时钟；演示历史仍保留固定日期。
    now: () => new Date().toISOString(),
    history: fakeHistory(),
    // 只有全局会话带演示历史；新建的工作会话从空会话开始。
    seedsHistory: (assistantSessionId) => assistantSessionId === GLOBAL_ASSISTANT_SESSION_ID,
    sessionPathRoot: context.paths.assistantSessionDir,
    promptDelayMs: Number(context.environment.MULTIVAC_FAKE_PROMPT_DELAY_MS ?? 180),
    authorizeToolCall: context.authorizeToolCall,
    // 服务重启后按绑定恢复的会话照常对账模型，E2E 可以验证重启相关的行为。
    persistSessionModels: true,
    promptScenarioResolver: (text) => {
      // 按脚本调用全局 Multivac 的内部工具：消息中每行“内部工具：<名称> <JSON 参数>”各调用一次。
      if (text.includes('bash执行：')) return 'bash';
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
      if (text.includes('运行中调整场景')) return 'steerTools';
      if (text.includes('认证失败原因场景')) return 'failureWithReason';
      if (text.includes('失败场景') && !failedFakePrompts.has(text)) {
        failedFakePrompts.add(text);
        return 'failure';
      }
      if (text.includes('重试压缩场景')) return 'retryAndCompaction';
      return 'success';
    },
  });
  return {
    id: adapter.harness,
    adapter,
    modelSettingsCatalog: new FakeModelSettingsCatalogFactory((provider) => accessBackend.authenticated(provider)),
    modelAccess: accessBackend,
    createMcpCredentialVault: () => createMcpCredentialVault(context.paths.mcpCredentialPath, context.instance.instanceId),
    createMcpWires: mcpWireFactory,
    createWebSettingsStore: () => createWebSettingsStore(join(context.paths.dataDir, 'web', 'auth.json')),
    recordsUsage: false,
    initialModelSettings: fakeModelSettingsState(),
    accessClock: () => Date.now() + accessBackend.clockOffset,
    accessBackend,
    failedPrompts: failedFakePrompts,
    modelSettingsState: fakeModelSettingsState,
  };
};
