import { randomUUID } from 'node:crypto';
import {
  COORDINATOR_EVENT_FIXTURES,
  type AssistantMessageView,
  type CoordinatorActionAccepted,
  type CoordinatorAdapterEvent,
  type CoordinatorEventListener,
  type CoordinatorModelConfig,
  type CoordinatorModelState,
  type CoordinatorModelUpdate,
  type CoordinatorResult,
  type CoordinatorRunResult,
  type CoordinatorRuntimeConfig,
  type CoordinatorSessionBinding,
  type CoordinatorSessionReady,
  type CoordinatorThinkingLevel,
} from '@multivac/contracts';
import type {
  ContinueCoordinatorSessionInput,
  CoordinatorAdapter,
  CoordinatorHistorySnapshot,
  CreateCoordinatorSessionInput,
} from './coordinator-adapter.js';
import { COORDINATOR_TOOL_ALLOWLIST } from './coordinator-tools.js';

type FakePromptScenario = keyof typeof COORDINATOR_EVENT_FIXTURES;

interface FakeSessionState {
  binding: CoordinatorSessionBinding;
  config: CoordinatorRuntimeConfig;
  model: CoordinatorModelConfig;
  sequence: number;
  sourceInstanceId: string;
  listeners: Set<CoordinatorEventListener>;
  history: AssistantMessageView[];
  streaming: boolean;
  aborted: boolean;
  promptNumber: number;
  generation: number;
}

interface FakePromptCompletionControl {
  entered: Promise<void>;
  release: Promise<void>;
  markEntered: () => void;
  releaseNow: () => void;
}

export type FakeCoordinatorCall =
  | { method: 'createSession'; input: CreateCoordinatorSessionInput }
  | { method: 'continueRecentSession'; input: CreateCoordinatorSessionInput }
  | { method: 'continueSession'; input: ContinueCoordinatorSessionInput }
  | { method: 'readActiveBranch'; assistantSessionId: string }
  | { method: 'prompt' | 'steer' | 'followUp'; assistantSessionId: string; text: string }
  | { method: 'abort' | 'disposeSession' | 'subscribe'; assistantSessionId: string }
  | { method: 'setModel'; assistantSessionId: string; model: CoordinatorModelConfig }
  | { method: 'setThinkingLevel'; assistantSessionId: string; level: CoordinatorThinkingLevel }
  | { method: 'dispose' };

export interface FakeCoordinatorAdapterOptions {
  promptScenario?: FakePromptScenario;
  now?: () => string;
  sourceInstanceIdFactory?: () => string;
  sessionPathRoot?: string;
  history?: readonly AssistantMessageView[];
  promptDelayMs?: number;
  promptBarrier?: Promise<void>;
  promptCompletionBarrier?: Promise<void>;
  promptReturnBarrier?: Promise<void>;
  abortBarrier?: Promise<void>;
  promptScenarioResolver?: (text: string) => FakePromptScenario;
  assistantResponseText?: string;
  continueRecentResumesExisting?: boolean;
  recentSessionModel?: CoordinatorModelConfig;
}

function ok<T>(value: T): CoordinatorResult<T> {
  return { ok: true, value };
}

/** Fake 仅模拟公共端口，既不读取模型密钥，也不访问文件系统或网络。 */
export class FakeCoordinatorAdapter implements CoordinatorAdapter {
  readonly calls: FakeCoordinatorCall[] = [];

  private readonly sessions = new Map<string, FakeSessionState>();
  private readonly promptScenario: FakePromptScenario;
  private readonly now: () => string;
  private readonly sourceInstanceIdFactory: () => string;
  private readonly sessionPathRoot: string;
  private readonly history: readonly AssistantMessageView[];
  private readonly promptDelayMs: number;
  private readonly promptBarrier: Promise<void> | undefined;
  private readonly promptCompletionBarrier: Promise<void> | undefined;
  private readonly promptReturnBarrier: Promise<void> | undefined;
  private readonly abortBarrier: Promise<void> | undefined;
  private readonly promptScenarioResolver: ((text: string) => FakePromptScenario) | undefined;
  private readonly assistantResponseText: string;
  private readonly continueRecentResumesExisting: boolean;
  private readonly recentSessionModel: CoordinatorModelConfig | undefined;
  private promptCompletionControl: FakePromptCompletionControl | null = null;
  private generation = 0;
  private activePromptCount = 0;
  private readonly promptIdleWaiters = new Set<() => void>();

  constructor(options: FakeCoordinatorAdapterOptions = {}) {
    this.promptScenario = options.promptScenario ?? 'success';
    this.now = options.now ?? (() => '2026-09-14T08:00:00.000Z');
    this.sourceInstanceIdFactory = options.sourceInstanceIdFactory ?? randomUUID;
    this.sessionPathRoot = options.sessionPathRoot ?? '/fake/pi-sessions';
    this.history = options.history ?? [];
    this.promptDelayMs = options.promptDelayMs ?? 0;
    this.promptBarrier = options.promptBarrier;
    this.promptCompletionBarrier = options.promptCompletionBarrier;
    this.promptReturnBarrier = options.promptReturnBarrier;
    this.abortBarrier = options.abortBarrier;
    this.promptScenarioResolver = options.promptScenarioResolver;
    this.assistantResponseText = options.assistantResponseText ?? 'Fake Multivac 已处理当前消息。';
    this.continueRecentResumesExisting = options.continueRecentResumesExisting ?? false;
    this.recentSessionModel = options.recentSessionModel;
  }

  async createSession(
    input: CreateCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    this.calls.push({ method: 'createSession', input });
    const piSessionId = `pi-fake-${input.assistantSessionId}`;
    const binding: CoordinatorSessionBinding = {
      assistantSessionId: input.assistantSessionId,
      piSessionId,
      piSessionPath: `${this.sessionPathRoot}/${encodeURIComponent(piSessionId)}.jsonl`,
      updatedAt: this.now(),
    };

    return this.storeSession(binding, input.config, input.initialEventSequence ?? 0, false);
  }

  async continueRecentSession(
    input: CreateCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    this.calls.push({ method: 'continueRecentSession', input });
    const piSessionId = `pi-fake-${input.assistantSessionId}`;
    let config = this.continueRecentResumesExisting
      ? {
          ...input.config,
          model: this.recentSessionModel ?? input.config.model,
        }
      : input.resolveNewSessionConfig
        ? await input.resolveNewSessionConfig()
        : input.config;
    const binding = {
      assistantSessionId: input.assistantSessionId,
      piSessionId,
      piSessionPath: `${this.sessionPathRoot}/${encodeURIComponent(piSessionId)}.jsonl`,
      updatedAt: this.now(),
    };
    if (this.continueRecentResumesExisting && input.resolveRecoveredSessionConfig) {
      const recovered = await input.resolveRecoveredSessionConfig({
        piSessionId,
        piSessionPath: binding.piSessionPath,
      });
      if (!recovered) {
        return { ok: false, error: {
          code: 'MODEL_SELECTION_RECOVERY_REQUIRED',
          message: 'Pi session 缺少模型选择恢复记录。',
        } };
      }
      config = recovered;
    }
    if (input.persistModelSelectionRecovery) {
      const resolvedEndpoint = config.model.resolvedEndpoint ?? config.model.endpoint ??
        `https://${config.model.provider}.example/v1`;
      config = {
        ...config,
        model: {
          ...config.model,
          source: config.model.source ?? 'base',
          protocol: config.model.protocol ?? 'openai-responses',
          endpoint: config.model.endpointMode === 'pi-native-dynamic'
            ? config.model.endpoint ?? null : config.model.source === 'controlled' ? config.model.endpoint ?? null : resolvedEndpoint,
          resolvedEndpoint: config.model.endpointMode === 'pi-native-dynamic' ? null : resolvedEndpoint,
        },
      };
      try {
        await input.persistModelSelectionRecovery({
          piSessionId,
          piSessionPath: binding.piSessionPath,
          model: config.model,
        });
      } catch {
        this.disposeSession(input.assistantSessionId);
        return { ok: false, error: {
          code: 'RUNTIME_OPERATION_FAILED',
          message: '模型选择恢复记录写入失败。',
        } };
      }
    }
    return this.storeSession(
      binding,
      config,
      input.initialEventSequence ?? 0,
      this.continueRecentResumesExisting,
    );
  }

  async continueSession(
    input: ContinueCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    this.calls.push({ method: 'continueSession', input });
    return this.storeSession(input.binding, input.config, input.initialEventSequence ?? 0, true);
  }

  readActiveBranch(
    assistantSessionId: string,
  ): CoordinatorResult<CoordinatorHistorySnapshot> {
    this.calls.push({ method: 'readActiveBranch', assistantSessionId });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    return ok({
      piSessionId: session.binding.piSessionId,
      leafEntryId: session.history.at(-1)?.piEntryId ?? null,
      messages: session.history.map((message) => ({ ...message })),
    });
  }

  isStreaming(assistantSessionId: string): CoordinatorResult<boolean> {
    const session = this.sessions.get(assistantSessionId);
    return session ? ok(session.streaming) : this.sessionNotActive();
  }

  /** E2E 只在显式武装后阻塞下一次 prompt 终态，避免依赖固定延迟观察 processing。 */
  armPromptCompletionBarrier(): void {
    if (this.promptCompletionControl) {
      throw new Error('Fake prompt completion barrier 已经武装。');
    }
    let markEntered!: () => void;
    let releaseNow!: () => void;
    this.promptCompletionControl = {
      entered: new Promise<void>((resolve) => { markEntered = resolve; }),
      release: new Promise<void>((resolve) => { releaseNow = resolve; }),
      markEntered,
      releaseNow,
    };
  }

  waitForPromptCompletionBarrierEntry(): Promise<void> {
    if (!this.promptCompletionControl) {
      return Promise.reject(new Error('Fake prompt completion barrier 尚未武装。'));
    }
    return this.promptCompletionControl.entered;
  }

  releasePromptCompletionBarrier(): void {
    this.promptCompletionControl?.releaseNow();
  }

  appendAssistantHistoryForTest(
    assistantSessionId: string,
    text: string,
    piEntryId: string,
  ): void {
    const session = this.sessions.get(assistantSessionId);
    if (!session) throw new Error('Multivac 会话未激活。');
    session.history.push({
      id: `${session.binding.piSessionId}:${piEntryId}`,
      piSessionId: session.binding.piSessionId,
      piEntryId,
      role: 'assistant',
      text,
      createdAt: this.now(),
    });
  }

  /** 仅供 E2E 在用例之间恢复确定性会话现场。 */
  async resetForTest(): Promise<void> {
    this.generation += 1;
    for (const session of this.sessions.values()) {
      session.generation = this.generation;
      session.streaming = false;
      session.aborted = true;
    }
    this.promptCompletionControl?.releaseNow();
    this.promptCompletionControl = null;
    await this.waitForPromptIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const session of this.sessions.values()) {
      session.history = this.initialHistory(session.binding);
      session.streaming = false;
      session.aborted = false;
      session.promptNumber = 0;
    }
  }

  async prompt(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    this.activePromptCount += 1;
    try {
      return await this.runPrompt(assistantSessionId, text);
    } finally {
      this.activePromptCount -= 1;
      if (this.activePromptCount === 0) {
        for (const resolve of this.promptIdleWaiters) resolve();
        this.promptIdleWaiters.clear();
      }
    }
  }

  private async runPrompt(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    this.calls.push({ method: 'prompt', assistantSessionId, text });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }
    const generation = session.generation;
    await this.promptBarrier;

    const scenario = this.promptScenarioResolver?.(text) ?? this.promptScenario;
    session.streaming = true;
    session.aborted = false;
    session.promptNumber += 1;
    const promptNumber = session.promptNumber;
    this.appendHistory(session, 'user', text, `prompt-${promptNumber}-user`);

    const intermediateFailureScenario =
      scenario === 'toolFailureThenSuccess' ||
      scenario === 'toolFailureThenFailure' ||
      scenario === 'compactionFailureThenSuccess' ||
      scenario === 'compactionFailureThenFailure';
    if (scenario === 'retryAndCompaction') {
      this.emitEvents(session, COORDINATOR_EVENT_FIXTURES.success.slice(0, 1));
      for (const event of COORDINATOR_EVENT_FIXTURES.retryAndCompaction) {
        this.emitEvents(session, [event]);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } else if (intermediateFailureScenario) {
      this.emitEvents(session, COORDINATOR_EVENT_FIXTURES[scenario].slice(0, 3));
    } else {
      const fixtures = COORDINATOR_EVENT_FIXTURES[scenario];
      if (fixtures[0]?.type === 'coordinator.run.started') {
        this.emitEvents(session, fixtures.slice(0, 1));
      }
    }

    await this.promptCompletionBarrier;
    const promptCompletionControl = this.promptCompletionControl;
    if (promptCompletionControl) {
      promptCompletionControl.markEntered();
      await promptCompletionControl.release;
      if (this.promptCompletionControl === promptCompletionControl) {
        this.promptCompletionControl = null;
      }
    }
    if (session.generation !== generation || session.promptNumber !== promptNumber) return ok({ status: 'cancelled' });
    if (this.promptDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.promptDelayMs));
    }
    // 取消后可以开始新 Turn；旧延迟任务不得借用新 Turn 重置的 aborted 状态。
    if (session.generation !== generation || session.promptNumber !== promptNumber) return ok({ status: 'cancelled' });

    if (session.aborted) {
      return ok({ status: 'cancelled' });
    }

    if (
      scenario !== 'failure' &&
      scenario !== 'cancelled' &&
      scenario !== 'toolFailureThenFailure' &&
      scenario !== 'compactionFailureThenFailure'
    ) {
      // Pi 在终态事件可见前已经更新 SessionManager；Fake 保持相同的快照顺序。
      this.appendHistory(
        session,
        'assistant',
        this.assistantResponseText,
        `prompt-${promptNumber}-assistant`,
      );
    }

    if (scenario === 'retryAndCompaction') {
      this.emitEvents(session, COORDINATOR_EVENT_FIXTURES.success.slice(1));
    } else {
      const fixtures = COORDINATOR_EVENT_FIXTURES[scenario];
      const startOffset = intermediateFailureScenario
        ? 3
        : fixtures[0]?.type === 'coordinator.run.started' ? 1 : 0;
      this.emitEvents(session, fixtures.slice(startOffset));
    }
    session.streaming = false;
    await this.promptReturnBarrier;

    const finalEvent: CoordinatorAdapterEvent | undefined =
      scenario === 'retryAndCompaction'
        ? COORDINATOR_EVENT_FIXTURES.success.at(-1)
        : COORDINATOR_EVENT_FIXTURES[scenario].at(-1);
    const usage = finalEvent && 'usage' in finalEvent ? finalEvent.usage : undefined;
    const status =
      scenario === 'failure' ||
      scenario === 'toolFailureThenFailure' ||
      scenario === 'compactionFailureThenFailure'
        ? 'failed'
        : scenario === 'cancelled'
          ? 'cancelled'
          : 'completed';

    return ok({ status, ...(usage === undefined ? {} : { usage }) });
  }

  async steer(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({ method: 'steer', assistantSessionId, text });
    return this.acceptIfActive(assistantSessionId);
  }

  async followUp(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({ method: 'followUp', assistantSessionId, text });
    return this.acceptIfActive(assistantSessionId);
  }

  async abort(assistantSessionId: string): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({ method: 'abort', assistantSessionId });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    await this.abortBarrier;
    if (session.streaming && !session.aborted) {
      session.aborted = true;
      session.streaming = false;
      this.emitFixture(session, 'cancelled');
    }
    return ok({ accepted: true });
  }

  async setModel(
    assistantSessionId: string,
    model: CoordinatorModelConfig,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    this.calls.push({ method: 'setModel', assistantSessionId, model });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    session.model = { ...model };
    return ok({ model: this.modelState(session), diagnostics: [] });
  }

  async setThinkingLevel(
    assistantSessionId: string,
    level: CoordinatorThinkingLevel,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    this.calls.push({ method: 'setThinkingLevel', assistantSessionId, level });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    session.model = { ...session.model, thinkingLevel: level };
    return ok({ model: this.modelState(session), diagnostics: [] });
  }

  subscribe(
    assistantSessionId: string,
    listener: CoordinatorEventListener,
  ): CoordinatorResult<() => void> {
    this.calls.push({ method: 'subscribe', assistantSessionId });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    session.listeners.add(listener);
    return ok(() => session.listeners.delete(listener));
  }

  disposeSession(assistantSessionId: string): void {
    this.calls.push({ method: 'disposeSession', assistantSessionId });
    this.sessions.delete(assistantSessionId);
  }

  dispose(): void {
    this.calls.push({ method: 'dispose' });
    this.sessions.clear();
  }

  private storeSession(
    binding: CoordinatorSessionBinding,
    config: CoordinatorRuntimeConfig,
    sequence: number,
    resumedExistingSession: boolean,
  ): CoordinatorResult<CoordinatorSessionReady> {
    const session: FakeSessionState = {
      binding,
      config,
      model: { ...config.model },
      sequence,
      sourceInstanceId: this.sourceInstanceIdFactory(),
      listeners: new Set(),
      history: this.initialHistory(binding),
      streaming: false,
      aborted: false,
      promptNumber: 0,
      generation: this.generation,
    };
    this.sessions.set(binding.assistantSessionId, session);

    return ok({
      binding,
      activeToolNames: [...COORDINATOR_TOOL_ALLOWLIST],
      model: this.modelState(session),
      modelConfig: { ...session.config.model },
      diagnostics: [],
      resumedExistingSession,
    });
  }

  private initialHistory(binding: CoordinatorSessionBinding): AssistantMessageView[] {
    const seen = new Set<string>();
    return this.history.flatMap((message) => {
      if (seen.has(message.piEntryId)) return [];
      seen.add(message.piEntryId);
      return [{
        ...message,
        id: `${binding.piSessionId}:${message.piEntryId}`,
        piSessionId: binding.piSessionId,
      }];
    });
  }

  private waitForPromptIdle(): Promise<void> {
    if (this.activePromptCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.promptIdleWaiters.add(resolve));
  }

  private emitFixture(session: FakeSessionState, scenario: FakePromptScenario): void {
    this.emitEvents(session, COORDINATOR_EVENT_FIXTURES[scenario]);
  }

  private emitEvents(
    session: FakeSessionState,
    fixtures: readonly CoordinatorAdapterEvent[],
  ): void {
    for (const fixture of fixtures) {
      session.sequence += 1;
      const cursor = `${session.binding.piSessionId}:${session.sourceInstanceId}:${session.sequence}`;
      const event = {
        ...fixture,
        eventId: cursor,
        cursor,
        sequence: session.sequence,
        sourceInstanceId: session.sourceInstanceId,
        assistantSessionId: session.binding.assistantSessionId,
        piSessionId: session.binding.piSessionId,
        occurredAt: this.now(),
      } as CoordinatorAdapterEvent;

      for (const listener of [...session.listeners]) {
        listener(event);
      }
    }
  }

  private acceptIfActive(
    assistantSessionId: string,
  ): CoordinatorResult<CoordinatorActionAccepted> {
    return this.sessions.has(assistantSessionId)
      ? ok({ accepted: true })
      : this.sessionNotActive();
  }

  private appendHistory(
    session: FakeSessionState,
    role: 'user' | 'assistant',
    text: string,
    suffix: string,
  ): void {
    const piEntryId = `entry-${suffix}`;
    session.history.push({
      id: `${session.binding.piSessionId}:${piEntryId}`,
      piSessionId: session.binding.piSessionId,
      piEntryId,
      role,
      text,
      createdAt: this.now(),
    });
  }

  private modelState(session: FakeSessionState): CoordinatorModelState {
    return {
      provider: session.model.provider,
      modelId: session.model.modelId,
      thinkingLevel: session.model.thinkingLevel,
    };
  }

  private sessionNotActive<T>(): CoordinatorResult<T> {
    return {
      ok: false,
      error: { code: 'SESSION_NOT_ACTIVE', message: 'Multivac 会话未激活。' },
    };
  }
}
