import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  COORDINATOR_EVENT_FIXTURES,
  type AssistantMessageView,
  type CoordinatorActionAccepted,
  type CoordinatorAdapterEvent,
  type CoordinatorEventListener,
  type CoordinatorModelConfig,
  type CoordinatorModelState,
  type CoordinatorModelUpdate,
  type CoordinatorQuote,
  type CoordinatorResult,
  type CoordinatorRunResult,
  type CoordinatorRuntimeConfig,
  type CoordinatorSessionBinding,
  type CoordinatorSessionContext,
  type CoordinatorSessionReady,
  type CoordinatorThinkingLevel,
  type WorkingDirectory,
} from '@multivac/contracts';
import type {
  ContinueCoordinatorSessionInput,
  CoordinatorAdapter,
  CoordinatorHistorySnapshot,
  CoordinatorToolAuthorizationDecision,
  CoordinatorToolAuthorizer,
  CreateCoordinatorSessionInput,
} from './coordinator-adapter.js';
import { COORDINATOR_TOOL_ALLOWLIST } from './pi-session-factory.js';
import { judgeToolCall } from './pi-tool-boundary.js';

/** 夹具场景之外，outsideWrite 模拟一次越界写入，走真实的目录边界判定与授权决定。 */
type FakePromptScenario = keyof typeof COORDINATOR_EVENT_FIXTURES | 'outsideWrite';

export interface FakeStreamingTestOptions {
  terminalHistory?: 'persist' | 'omit';
  simulateFollowUps?: boolean;
}

interface FakeStreamingMessage {
  messageId: string;
  partialText: string;
  promptNumber: number;
  terminalHistory: 'persist' | 'omit';
  followUps: string[] | null;
}

interface FakeSessionState {
  binding: CoordinatorSessionBinding;
  config: CoordinatorRuntimeConfig;
  model: CoordinatorModelConfig;
  sequence: number;
  sourceInstanceId: string;
  listeners: Set<CoordinatorEventListener>;
  history: AssistantMessageView[];
  /** 新建的会话从空历史开始；恢复的会话带 fixture 历史，便于验证分页与恢复。 */
  seededHistory: boolean;
  streaming: boolean;
  aborted: boolean;
  promptNumber: number;
  generation: number;
  activeStreamingMessage: FakeStreamingMessage | undefined;
  /** 创建或恢复时传入的工作目录；越界写入场景据此判定目录边界。 */
  workingDirectory: WorkingDirectory;
  /** 本轮授权等待的中止信号来源；abort 与测试重置时中止，等价于 Pi 本轮的 signal。 */
  authorizationAbort: AbortController | undefined;
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
  | {
      method: 'prompt' | 'steer' | 'followUp';
      assistantSessionId: string;
      text: string;
      quote?: CoordinatorQuote;
      context?: CoordinatorSessionContext;
    }
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
  /** 哪些会话以 fixture 历史开始；缺省全部会话都带 fixture 历史。 */
  seedsHistory?: (assistantSessionId: string) => boolean;
  /** 越界写入场景的授权决定；缺省时一律拒绝，与未接入授权的 Pi 适配器一致。 */
  authorizeToolCall?: CoordinatorToolAuthorizer;
  /**
   * 把会话的模型选择写到绑定的 piSessionPath，模拟 Pi transcript 跨进程保留：
   * 服务重启后按绑定恢复时可以照常对账模型。只有 Fake 服务进程（E2E）开启。
   */
  persistSessionModels?: boolean;
}

function ok<T>(value: T): CoordinatorResult<T> {
  return { ok: true, value };
}

/**
 * Fake 仅模拟公共端口，既不读取模型密钥，也不访问网络。只有越界写入场景触及文件系统：
 * 按真实规则判定目录边界，经批准后把一个探针文件写到工作目录的上一级。
 */
export class FakeCoordinatorAdapter implements CoordinatorAdapter {
  readonly calls: FakeCoordinatorCall[] = [];

  private readonly sessions = new Map<string, FakeSessionState>();
  /** 已释放（如归档）会话的最后状态，充当 Pi transcript：按绑定恢复时沿用其历史与模型。 */
  private readonly releasedSessions = new Map<string, FakeSessionState>();
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
  private readonly seedsHistory: (assistantSessionId: string) => boolean;
  private readonly authorizeToolCall: CoordinatorToolAuthorizer | undefined;
  private readonly persistSessionModels: boolean;
  private promptCompletionControl: FakePromptCompletionControl | null = null;
  private streamNextPrompt = false;
  private nextStreamingOptions: FakeStreamingTestOptions = {};
  private generation = 0;
  private activePromptCount = 0;
  private readonly promptIdleWaiters = new Set<() => void>();
  private modelFailureForTest: 'fail' | 'partial' | null = null;

  setModelFailureForTest(value: 'fail' | 'partial' | null): void { this.modelFailureForTest = value; }

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
    this.seedsHistory = options.seedsHistory ?? (() => true);
    this.authorizeToolCall = options.authorizeToolCall;
    this.persistSessionModels = options.persistSessionModels ?? false;
  }

  async createSession(
    input: CreateCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    this.calls.push({ method: 'createSession', input });
    const piSessionId = `pi-fake-${input.assistantSessionId}`;
    const binding: CoordinatorSessionBinding = {
      assistantSessionId: input.assistantSessionId,
      piSessionId,
      piSessionPath: `${input.sessionDir ?? this.sessionPathRoot}/${encodeURIComponent(piSessionId)}.jsonl`,
      updatedAt: this.now(),
    };

    return this.storeSession(binding, input.config, input.workingDirectory, input.initialEventSequence ?? 0, false);
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
      input.workingDirectory,
      input.initialEventSequence ?? 0,
      this.continueRecentResumesExisting,
    );
  }

  async continueSession(
    input: ContinueCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    this.calls.push({ method: 'continueSession', input });
    // Fake 历史只在内存中：不带 fixture 的会话恢复时沿用本进程内已有的历史（含已释放会话留下的历史）。
    const existing = this.sessions.get(input.binding.assistantSessionId)
      ?? this.releasedSessions.get(input.binding.assistantSessionId);
    const history = existing && !existing.seededHistory ? existing.history : undefined;
    this.releasedSessions.delete(input.binding.assistantSessionId);
    return this.storeSession(
      input.binding, input.config, input.workingDirectory, input.initialEventSequence ?? 0, true, history,
    );
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
  isBusy(assistantSessionId: string) { return this.isStreaming(assistantSessionId); }
  async validateModelSelection(assistantSessionId: string) {
    return this.sessions.has(assistantSessionId) ? ok(true) : this.sessionNotActive<boolean>();
  }

  readPersistedModelSelection(identity: { piSessionId: string; piSessionPath: string }) {
    const session = [...this.sessions.values(), ...this.releasedSessions.values()]
      .find((item) => item.binding.piSessionId === identity.piSessionId);
    if (session || !this.persistSessionModels) return ok(session ? this.modelState(session) : null);
    try {
      return ok(JSON.parse(readFileSync(identity.piSessionPath, 'utf8')) as CoordinatorModelState);
    } catch {
      return ok(null);
    }
  }

  readModelSelection(assistantSessionId: string) {
    const session = this.sessions.get(assistantSessionId);
    if (!session) return this.sessionNotActive<import('./coordinator-adapter.js').CoordinatorSelectionSnapshot>();
    return ok({ piSessionId: session.binding.piSessionId, piSessionPath: session.binding.piSessionPath,
      model: { ...session.model }, durable: true,
      // 手动设置的推理能力优先；未设置时按夹具 provider 判断。
      availableThinkingLevels: (session.model.reasoning ?? session.model.provider === 'fixture-anthropic')
        ? ['off', 'minimal', 'low', 'medium', 'high'] as CoordinatorThinkingLevel[] : ['off'] as CoordinatorThinkingLevel[] });
  }

  /** E2E 只在显式武装后阻塞下一次 prompt 终态，避免依赖固定延迟观察 processing。 */
  armPromptCompletionBarrier(streaming = false, options: FakeStreamingTestOptions = {}): void {
    if (this.promptCompletionControl) {
      throw new Error('Fake prompt completion barrier 已经武装。');
    }
    let markEntered!: () => void;
    this.streamNextPrompt = streaming;
    this.nextStreamingOptions = { ...options };
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
    runtimeMessageId?: string,
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
      ...(runtimeMessageId ? { runtimeMessageId } : {}),
    });
  }

  /** 仅供 E2E 在用例之间恢复确定性会话现场。 */
  async resetForTest(): Promise<void> {
    this.modelFailureForTest = null;
    this.generation += 1;
    this.streamNextPrompt = false;
    this.nextStreamingOptions = {};
    for (const session of this.sessions.values()) {
      session.generation = this.generation;
      session.streaming = false;
      session.aborted = true;
      session.activeStreamingMessage = undefined;
      // 等待授权的调用随本轮一起结束，请求记为已取消。
      session.authorizationAbort?.abort();
    }
    this.promptCompletionControl?.releaseNow();
    this.promptCompletionControl = null;
    this.releasedSessions.clear();
    await this.waitForPromptIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const session of this.sessions.values()) {
      session.history = session.seededHistory ? this.initialHistory(session.binding) : [];
      session.streaming = false;
      session.aborted = false;
      session.promptNumber = 0;
    }
  }

  async prompt(
    assistantSessionId: string,
    text: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    this.activePromptCount += 1;
    try {
      return await this.runPrompt(assistantSessionId, text, quote, context);
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
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    this.calls.push({
      method: 'prompt', assistantSessionId, text, ...(quote ? { quote } : {}), ...(context ? { context } : {}),
    });
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
    const runtimeMessageId = `assistant:prompt-${promptNumber}`;
    const streamResponse = this.streamNextPrompt;
    const streamingOptions = this.nextStreamingOptions;
    this.streamNextPrompt = false;
    this.nextStreamingOptions = {};
    const failed = scenario === 'failure' || scenario === 'toolFailureThenFailure' ||
      scenario === 'compactionFailureThenFailure';
    this.appendHistory(session, 'user', text, `prompt-${promptNumber}-user`, quote);
    if (scenario === 'outsideWrite') return this.runOutsideWrite(session, promptNumber, generation);

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
    } else if (scenario === 'multiStepTools') {
      // 与 Pi 一致：每轮生成的过程正文在调用工具前各自落入历史，最终回复最后落入。
      const fixtures = COORDINATOR_EVENT_FIXTURES.multiStepTools;
      for (const event of fixtures.slice(0, -1)) {
        this.emitEvents(session, [event]);
        if (event.type !== 'coordinator.message.ended') continue;
        const text = fixtures.flatMap((candidate) => candidate.type === 'coordinator.message.delta' &&
          candidate.channel === 'text' && candidate.messageId === event.messageId ? [candidate.delta] : []).join('');
        this.appendHistory(session, 'assistant', text, `prompt-${promptNumber}-${event.messageId.replaceAll(':', '-')}`);
        session.history.at(-1)!.runtimeMessageId = event.messageId;
      }
    } else if (intermediateFailureScenario) {
      const initialCount = scenario === 'toolFailureThenSuccess' || scenario === 'toolFailureThenFailure'
        ? 4
        : 3;
      this.emitEvents(session, COORDINATOR_EVENT_FIXTURES[scenario].slice(0, initialCount));
    } else {
      const fixtures = COORDINATOR_EVENT_FIXTURES[scenario];
      if (fixtures[0]?.type === 'coordinator.run.started') {
        this.emitEvents(session, fixtures.slice(0, 1));
      }
    }

    if (streamResponse) {
      const partialText = this.assistantResponseText.slice(0, Math.ceil(this.assistantResponseText.length / 2));
      session.activeStreamingMessage = {
        messageId: runtimeMessageId, partialText, promptNumber,
        terminalHistory: streamingOptions.terminalHistory ?? 'persist',
        followUps: streamingOptions.simulateFollowUps ? [] : null,
      };
      this.emitEvents(session, [{
        ...COORDINATOR_EVENT_FIXTURES.success[2]!,
        type: 'coordinator.message.delta', messageId: runtimeMessageId, channel: 'text',
        delta: partialText,
      }]);
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

    if (streamResponse && !failed && scenario !== 'cancelled') {
      this.emitEvents(session, [{
        ...COORDINATOR_EVENT_FIXTURES.success[2]!,
        type: 'coordinator.message.delta', messageId: runtimeMessageId, channel: 'text',
        delta: this.assistantResponseText.slice(Math.ceil(this.assistantResponseText.length / 2)),
      }]);
    }

    const followUps = session.activeStreamingMessage?.followUps ?? [];
    if (streamResponse && (failed || scenario === 'cancelled')) {
      this.settleStreamingMessageForTest(session, failed ? 'failed' : 'cancelled');
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
      session.history.at(-1)!.runtimeMessageId = runtimeMessageId;
      session.activeStreamingMessage = undefined;
      // 仅显式测试配置消费 followUp 队列；默认 Fake 仍只记录调用。
      for (const [index, followUp] of followUps.entries()) {
        const suffix = `prompt-${promptNumber}-follow-up-${index + 1}`;
        const messageId = `${runtimeMessageId}:followUp-${index + 1}`;
        const answer = `Fake followUp 已处理：${followUp}`;
        this.appendHistory(session, 'user', followUp, `${suffix}-user`);
        this.emitEvents(session, [
          { ...COORDINATOR_EVENT_FIXTURES.success[1]!, type: 'coordinator.message.started', role: 'assistant', messageId },
          { ...COORDINATOR_EVENT_FIXTURES.success[2]!, type: 'coordinator.message.delta', channel: 'text', messageId,
            delta: answer.slice(0, Math.ceil(answer.length / 2)) },
          { ...COORDINATOR_EVENT_FIXTURES.success[2]!, type: 'coordinator.message.delta', channel: 'text', messageId,
            delta: answer.slice(Math.ceil(answer.length / 2)) },
        ]);
        this.appendHistory(session, 'assistant', answer, `${suffix}-assistant`);
        session.history.at(-1)!.runtimeMessageId = messageId;
        this.emitEvents(session, [{ ...COORDINATOR_EVENT_FIXTURES.success[1]!,
          type: 'coordinator.message.ended', role: 'assistant', messageId, stopReason: 'stop' }]);
      }
    }

    if (scenario === 'retryAndCompaction') {
      this.emitEvents(session, COORDINATOR_EVENT_FIXTURES.success.slice(1));
    } else {
      const fixtures = COORDINATOR_EVENT_FIXTURES[scenario];
      const startOffset = scenario === 'multiStepTools' ? fixtures.length - 1
        : intermediateFailureScenario
          ? scenario === 'toolFailureThenSuccess' || scenario === 'toolFailureThenFailure' ? 4 : 3
          : fixtures[0]?.type === 'coordinator.run.started' ? 1 : 0;
      this.emitEvents(session, fixtures.slice(startOffset).filter((event) =>
        !streamResponse || event.type !== 'coordinator.message.delta'));
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
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({
      method: 'steer', assistantSessionId, text, ...(quote ? { quote } : {}), ...(context ? { context } : {}),
    });
    return this.acceptIfActive(assistantSessionId);
  }

  async followUp(
    assistantSessionId: string,
    text: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({
      method: 'followUp', assistantSessionId, text, ...(quote ? { quote } : {}), ...(context ? { context } : {}),
    });
    this.sessions.get(assistantSessionId)?.activeStreamingMessage?.followUps?.push(text);
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
      // 与 Pi 一致：先中止本轮的 signal，等待授权的调用随之结束。
      session.authorizationAbort?.abort();
      session.aborted = true;
      session.streaming = false;
      this.settleStreamingMessageForTest(session, 'cancelled');
      this.emitFixture(session, 'cancelled');
    }
    return ok({ accepted: true });
  }

  async setModel(
    assistantSessionId: string,
    model: CoordinatorModelConfig,
    assertCurrent?: () => void,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    assertCurrent?.();
    this.calls.push({ method: 'setModel', assistantSessionId, model });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    const failure = this.modelFailureForTest;
    this.modelFailureForTest = null;
    if (failure === 'fail') return { ok: false, error: { code: 'RUNTIME_OPERATION_FAILED', message: 'Fake Pi 切换失败。' } };
    // 与 Pi 一致：不支持推理的模型换用后推理等级归为 off。
    const reasoning = model.reasoning ?? model.provider !== 'fixture';
    session.model = { ...model, thinkingLevel: reasoning ? model.thinkingLevel : 'off' };
    this.persistSessionModel(session);
    if (failure === 'partial') return { ok: false, error: { code: 'RUNTIME_OPERATION_FAILED', message: 'Fake Pi 异步部分成功。' } };
    return ok({ model: this.modelState(session), diagnostics: [] });
  }

  async setThinkingLevel(
    assistantSessionId: string,
    level: CoordinatorThinkingLevel,
    assertCurrent?: () => void,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    assertCurrent?.();
    this.calls.push({ method: 'setThinkingLevel', assistantSessionId, level });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    session.model = { ...session.model, thinkingLevel: level };
    this.persistSessionModel(session);
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
    const session = this.sessions.get(assistantSessionId);
    if (session) this.releasedSessions.set(assistantSessionId, session);
    this.sessions.delete(assistantSessionId);
  }

  dispose(): void {
    this.calls.push({ method: 'dispose' });
    this.sessions.clear();
    this.releasedSessions.clear();
  }

  /**
   * 越界写入：Agent 调用 write 写入工作目录上一级的探针文件。与 Pi 一致，工具开始事件早于授权，
   * 目录边界判定与授权决定都走真实实现，等待期间本轮保持运行：
   * - 批准：写入文件，本轮正常完成；
   * - 拒绝：不写入，Agent 带着拒绝原因回应，本轮正常完成；
   * - 超时（endTurn）：不写入，该调用以原因结束后本轮按取消结束；
   * - 停止本轮：abort 中止 signal，等待随之结束，本轮取消。
   */
  private async runOutsideWrite(
    session: FakeSessionState,
    promptNumber: number,
    generation: number,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    const base = COORDINATOR_EVENT_FIXTURES.success;
    const toolCallId = `outside-write-${randomUUID()}`;
    const requestedPath = `../multivac-outside/${toolCallId}.txt`;
    const content = 'Fake 越界写入';
    // 与 Pi 一致：用户消息先落入历史并发出消息事件，界面据此在等待授权前就回读到这条消息。
    const userMessageId = `user:prompt-${promptNumber}`;
    this.emitEvents(session, [base[0]!, {
      ...base[0]!, type: 'coordinator.message.started', role: 'user', messageId: userMessageId,
    }, {
      ...base[0]!, type: 'coordinator.message.ended', role: 'user', messageId: userMessageId,
    }, {
      ...base[0]!, type: 'coordinator.tool.started', toolCallId, toolName: 'write',
      argumentKeys: ['path', 'content'], inputText: `path: ${requestedPath}\ncontent: ${content}`, inputTruncated: false,
    }]);

    const controller = new AbortController();
    session.authorizationAbort = controller;
    let decision: CoordinatorToolAuthorizationDecision;
    let targetPath: string | undefined;
    try {
      const verdict = await judgeToolCall('write', { path: requestedPath, content }, session.workingDirectory.path);
      if (verdict.type !== 'outside') throw new Error('越界写入场景的目标没有落在工作目录之外。');
      targetPath = verdict.targetPath;
      decision = this.authorizeToolCall
        ? await this.authorizeToolCall({
            assistantSessionId: session.binding.assistantSessionId, toolName: 'write', toolCallId,
            requestedPath, targetPath, workingDirectory: { ...session.workingDirectory },
          }, controller.signal)
        : { allowed: false, reason: `目标路径 ${targetPath} 位于会话工作目录之外，访问需要用户授权。` };
    } catch {
      decision = { allowed: false, reason: '授权请求没有完成，write 未执行。' };
    } finally {
      if (session.authorizationAbort === controller) session.authorizationAbort = undefined;
    }

    // 停止本轮或测试重置：abort 已发出取消终态。
    if (controller.signal.aborted || session.aborted || session.generation !== generation) {
      return ok({ status: 'cancelled' });
    }

    const executed = decision.allowed && targetPath !== undefined;
    if (executed) {
      await mkdir(dirname(targetPath!), { recursive: true });
      await writeFile(targetPath!, content);
    }
    this.emitEvents(session, [{
      ...base[0]!, type: 'coordinator.tool.ended', toolCallId, toolName: 'write', isError: !executed,
    }]);
    if (!decision.allowed && decision.endTurn) {
      session.streaming = false;
      session.aborted = true;
      this.emitFixture(session, 'cancelled');
      return ok({ status: 'cancelled' });
    }

    const messageId = `assistant:prompt-${promptNumber}`;
    const answer = executed ? `已写入 ${targetPath}。` : `没有写入：${decision.allowed ? '' : decision.reason}`;
    this.emitEvents(session, [
      { ...base[0]!, type: 'coordinator.message.started', role: 'assistant', messageId },
      { ...base[0]!, type: 'coordinator.message.delta', channel: 'text', messageId, delta: answer },
      { ...base[0]!, type: 'coordinator.message.ended', role: 'assistant', messageId, stopReason: 'stop' },
    ]);
    this.appendHistory(session, 'assistant', answer, `prompt-${promptNumber}-assistant`);
    session.history.at(-1)!.runtimeMessageId = messageId;
    this.emitEvents(session, [base.at(-1)!]);
    session.streaming = false;
    return ok({ status: 'completed' });
  }

  /** 终态前先保存可校准正文；omit 专门覆盖 Pi 历史没有该消息的情况。 */
  private settleStreamingMessageForTest(session: FakeSessionState, outcome: 'failed' | 'cancelled'): void {
    const message = session.activeStreamingMessage;
    if (!message || message.promptNumber !== session.promptNumber) return;
    session.activeStreamingMessage = undefined;
    if (message.terminalHistory === 'persist') {
      const text = `${message.partialText}（${outcome === 'failed' ? '失败' : '取消'}已校准）`;
      this.appendHistory(session, 'assistant', text, `prompt-${message.promptNumber}-assistant`);
      session.history.at(-1)!.runtimeMessageId = message.messageId;
    }
    this.emitEvents(session, [{ ...COORDINATOR_EVENT_FIXTURES.success[1]!,
      type: 'coordinator.message.ended', role: 'assistant', messageId: message.messageId,
      stopReason: outcome === 'failed' ? 'error' : 'aborted' }]);
  }

  private storeSession(
    binding: CoordinatorSessionBinding,
    config: CoordinatorRuntimeConfig,
    workingDirectory: WorkingDirectory,
    sequence: number,
    resumedExistingSession: boolean,
    history?: AssistantMessageView[],
  ): CoordinatorResult<CoordinatorSessionReady> {
    const seededHistory = this.seedsHistory(binding.assistantSessionId);
    const session: FakeSessionState = {
      binding,
      config,
      model: { ...config.model },
      sequence,
      sourceInstanceId: this.sourceInstanceIdFactory(),
      listeners: new Set(),
      history: history ?? (seededHistory ? this.initialHistory(binding) : []),
      seededHistory,
      streaming: false,
      aborted: false,
      promptNumber: 0,
      generation: this.generation,
      activeStreamingMessage: undefined,
      workingDirectory: { ...workingDirectory },
      authorizationAbort: undefined,
    };
    this.sessions.set(binding.assistantSessionId, session);
    this.persistSessionModel(session);

    return ok({
      binding,
      activeToolNames: [...COORDINATOR_TOOL_ALLOWLIST],
      model: this.modelState(session),
      modelConfig: { ...session.config.model },
      diagnostics: [],
      resumedExistingSession,
    });
  }

  /** 模型选择随会话写入 piSessionPath（Fake 的 transcript 替身），供重启后对账。 */
  private persistSessionModel(session: FakeSessionState): void {
    if (!this.persistSessionModels) return;
    writeFileSync(session.binding.piSessionPath, JSON.stringify(this.modelState(session)));
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

  private emitFixture(session: FakeSessionState, scenario: keyof typeof COORDINATOR_EVENT_FIXTURES): void {
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
        // 夹具只提供事件结构；时间戳使用当前时钟，前端时间线才能把工具记录放回所属 Turn。
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
    quote?: CoordinatorQuote,
  ): void {
    const piEntryId = `entry-${suffix}`;
    session.history.push({
      id: `${session.binding.piSessionId}:${piEntryId}`,
      piSessionId: session.binding.piSessionId,
      piEntryId,
      role,
      text,
      createdAt: this.now(),
      // 与 Pi 投影一致：引用随所属用户消息一起回到历史，而不是独立条目。
      ...(quote && role === 'user'
        ? {
            quote: {
              sourcePiSessionId: quote.source?.piSessionId ?? session.binding.piSessionId,
              sourcePiEntryId: quote.sourcePiEntryId,
              sourceRole: quote.sourceRole,
              text: quote.text,
              ...(quote.source ? { sourceSessionId: quote.source.sessionId, sourceTitle: quote.source.title } : {}),
            },
          }
        : {}),
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
