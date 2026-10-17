import assert from 'node:assert/strict';
import type { CoordinatorRuntimeConfig, CoordinatorThinkingLevel } from '@multivac/contracts';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import type {
  PiCoordinatorAgentSession,
  PiCoordinatorModel,
  PiCoordinatorOpenSessionFactoryInput,
  PiCoordinatorSessionFactory,
  PiCoordinatorSessionFactoryInput,
  PiCoordinatorSessionResources,
} from '../../src/runtime/executors/pi-session-factory.js';

/** Pi 适配器测试共用的替身：不启动真实 Pi，按 Pi session 的接口记录调用并发出事件。 */

export const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [{ referenceId: 'project', label: '项目摘要', content: '只读内容' }],
  model: { provider: 'test', modelId: 'model-1', thinkingLevel: 'medium' },
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 },
  compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

export function model(provider: string, id: string): PiCoordinatorModel {
  return { provider, id } as PiCoordinatorModel;
}

export class StubSession implements PiCoordinatorAgentSession {
  receivedImages: { type: 'image'; mimeType: string; data: string }[] | undefined;
  readonly calls: Array<{ method: string; value?: string }> = [];
  readonly listeners = new Set<AgentSessionEventListener>();
  sessionId = 'pi-1';
  sessionFile: string | undefined = '/sessions/pi-1.jsonl';
  isStreaming = false;
  model: PiCoordinatorModel | undefined = model('test', 'model-1');
  thinkingLevel = config.model.thinkingLevel;
  disposed = false;
  unsubscribeCount = 0;
  persistedMessageCount = 0;
  settledCount = 0;
  branch: ReturnType<PiCoordinatorAgentSession['getActiveBranch']> = [];

  constructor(
    private readonly clampThinking: (
      level: CoordinatorThinkingLevel,
    ) => CoordinatorThinkingLevel = (level) => level,
  ) {}

  async prompt(text: string, options?: { images?: { type: 'image'; mimeType: string; data: string }[] }): Promise<void> {
    this.receivedImages = options?.images;
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

  getActiveBranch() {
    return this.branch;
  }

  async steer(text: string, images?: { type: 'image'; mimeType: string; data: string }[]): Promise<void> {
    this.receivedImages = images;
    this.calls.push({ method: 'steer', value: text });
  }

  async followUp(text: string, images?: { type: 'image'; mimeType: string; data: string }[]): Promise<void> {
    this.receivedImages = images;
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
    return ['read', 'bash', 'edit', 'write'];
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

export class StubFactory implements PiCoordinatorSessionFactory {
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

export function resources(session = new StubSession()): PiCoordinatorSessionResources {
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
    resumedExistingSession: false,
    appliedModelConfig: config.model,
  };
}

export async function flushPromiseRejections(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
