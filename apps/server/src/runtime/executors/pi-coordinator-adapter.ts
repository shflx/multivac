import { randomUUID } from 'node:crypto';
import { COORDINATOR_THINKING_LEVELS } from '@multivac/contracts';
import { ModelSettingsServiceError } from '../../modules/model-settings/model-settings.js';
import type {
  CoordinatorActionAccepted,
  CoordinatorAdapterEvent,
  CoordinatorDiagnostic,
  CoordinatorError,
  CoordinatorEventListener,
  CoordinatorModelConfig,
  CoordinatorModelState,
  CoordinatorModelUpdate,
  CoordinatorQuote,
  CoordinatorSessionContext,
  CoordinatorResult,
  CoordinatorRunResult,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
  CoordinatorSessionReady,
  CoordinatorThinkingLevel,
} from '@multivac/contracts';
import { getAgentDir, SessionManager, buildSessionContext } from '@earendil-works/pi-coding-agent';
import type {
  ContinueCoordinatorSessionInput,
  CoordinatorAdapter,
  CoordinatorHistorySnapshot,
  CreateCoordinatorSessionInput,
} from './coordinator-adapter.js';
import { mapPiActiveBranch } from './pi-message-history.js';
import {
  ASSISTANT_QUOTE_CUSTOM_TYPE,
  assistantQuoteDetails,
  renderAssistantQuoteForModel,
  ASSISTANT_CONTEXT_CUSTOM_TYPE,
  renderSessionContextForModel,
} from './pi-quote-carriage.js';
import { PiCoordinatorEventMapper } from './pi-event-mapper.js';
import {
  DefaultPiCoordinatorSessionFactory,
  PiCoordinatorSessionFactoryError,
  thinkingLevelDiagnostic,
  type PiCoordinatorAgentSession,
  type PiCoordinatorModelRuntime,
  type PiCoordinatorSessionFactory,
  type PiCoordinatorSessionResources,
} from './pi-session-factory.js';

interface ActivePiSession {
  session: PiCoordinatorAgentSession;
  modelRuntime: PiCoordinatorModelRuntime;
  mapper: PiCoordinatorEventMapper;
  listeners: Set<CoordinatorEventListener>;
  unsubscribePi: () => void;
  modelConfig: CoordinatorModelConfig;
  prepareModel: PiCoordinatorSessionResources['prepareModel'];
}

export interface PiCoordinatorAdapterOptions {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  modelsPath?: string | null;
  sessionFactory?: PiCoordinatorSessionFactory;
  now?: () => string;
  sourceInstanceIdFactory?: () => string;
  onDiagnostic?: (diagnostic: CoordinatorDiagnostic) => void;
}

function ok<T>(value: T): CoordinatorResult<T> {
  return { ok: true, value };
}

function failure<T>(error: CoordinatorError): CoordinatorResult<T> {
  return { ok: false, error };
}

function validateConfig(config: CoordinatorRuntimeConfig): string | undefined {
  if (!config.systemPrompt.trim()) {
    return 'Multivac systemPrompt 不能为空。';
  }

  if (!config.model.provider.trim() || !config.model.modelId.trim()) {
    return 'Multivac provider 和 modelId 不能为空。';
  }

  if (
    !Number.isInteger(config.retry.maxRetries) ||
    config.retry.maxRetries < 0 ||
    !Number.isFinite(config.retry.baseDelayMs) ||
    config.retry.baseDelayMs < 0
  ) {
    return 'Multivac retry 配置必须是非负数。';
  }

  if (
    !Number.isFinite(config.compaction.reserveTokens) ||
    config.compaction.reserveTokens < 0 ||
    !Number.isFinite(config.compaction.keepRecentTokens) ||
    config.compaction.keepRecentTokens < 0
  ) {
    return 'Multivac compaction token 配置必须是非负数。';
  }

  const referenceIds = new Set<string>();
  for (const context of config.authorizedContext) {
    if (!context.referenceId.trim() || !context.label.trim()) {
      return '已授权资料的 referenceId 和 label 不能为空。';
    }
    if (referenceIds.has(context.referenceId)) {
      return `已授权资料 referenceId 重复：${context.referenceId}。`;
    }
    referenceIds.add(context.referenceId);
  }

  return undefined;
}

/** Pi 对象只保留在执行器内部，上层只能观察 Multivac 契约和稳定错误。 */
export class PiCoordinatorAdapter implements CoordinatorAdapter {
  private readonly sessions = new Map<string, ActivePiSession>();
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionDir: string | undefined;
  private readonly sessionFactory: PiCoordinatorSessionFactory;
  private readonly now: () => string;
  private readonly sourceInstanceIdFactory: () => string;
  private readonly onDiagnostic: ((diagnostic: CoordinatorDiagnostic) => void) | undefined;

  constructor(options: PiCoordinatorAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? getAgentDir();
    this.sessionDir = options.sessionDir;
    this.sessionFactory =
      options.sessionFactory ??
      new DefaultPiCoordinatorSessionFactory({
        ...(options.modelsPath === undefined ? {} : { modelsPath: options.modelsPath }),
      });
    this.now = options.now ?? (() => new Date().toISOString());
    this.sourceInstanceIdFactory = options.sourceInstanceIdFactory ?? randomUUID;
    this.onDiagnostic = options.onDiagnostic;
  }

  async createSession(
    input: CreateCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    if (!input.assistantSessionId.trim()) {
      return failure({ code: 'INVALID_CONFIGURATION', message: 'assistantSessionId 不能为空。' });
    }

    const invalidConfig = validateConfig(input.config);
    if (invalidConfig) {
      return failure({ code: 'INVALID_CONFIGURATION', message: invalidConfig });
    }

    try {
      const resources = await this.sessionFactory.create(this.factoryInput(input.config, input.sessionDir));
      return this.activateSession(
        input.assistantSessionId,
        resources,
        input.initialEventSequence ?? 0,
        input.config.model.thinkingLevel,
      );
    } catch (error) {
      return failure(this.mapFactoryError(error, 'RUNTIME_OPERATION_FAILED'));
    }
  }

  async continueRecentSession(
    input: CreateCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    if (!input.assistantSessionId.trim()) {
      return failure({ code: 'INVALID_CONFIGURATION', message: 'assistantSessionId 不能为空。' });
    }
    const invalidConfig = validateConfig(input.config);
    if (invalidConfig) {
      return failure({ code: 'INVALID_CONFIGURATION', message: invalidConfig });
    }

    try {
      const resources = await this.sessionFactory.continue({
        ...this.factoryInput(input.config),
        ...(input.resolveNewSessionConfig
          ? { resolveNewSessionConfig: input.resolveNewSessionConfig }
          : {}),
        ...(input.resolveRecoveredSessionConfig
          ? { resolveRecoveredSessionConfig: input.resolveRecoveredSessionConfig }
          : {}),
        ...(input.persistModelSelectionRecovery
          ? { persistModelSelectionRecovery: input.persistModelSelectionRecovery }
          : {}),
      });
      return this.activateSession(
        input.assistantSessionId,
        resources,
        input.initialEventSequence ?? 0,
        input.config.model.thinkingLevel,
      );
    } catch (error) {
      return failure(this.mapFactoryError(error, 'RUNTIME_OPERATION_FAILED'));
    }
  }

  async continueSession(
    input: ContinueCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    const invalidConfig = validateConfig(input.config);
    if (invalidConfig) {
      return failure({
        code: 'INVALID_CONFIGURATION',
        message: invalidConfig,
        recoverableBinding: input.binding,
      });
    }

    try {
      const resources = await this.sessionFactory.open({
        ...this.factoryInput(input.config, input.sessionDir),
        sessionPath: input.binding.piSessionPath,
      });

      if (
        resources.session.sessionId !== input.binding.piSessionId ||
        resources.session.sessionFile !== input.binding.piSessionPath
      ) {
        resources.session.dispose();
        return failure({
          code: 'SESSION_BINDING_MISMATCH',
          message: 'Pi 会话与现有 Multivac 绑定不一致。',
          recoverableBinding: input.binding,
        });
      }

      return this.activateSession(
        input.binding.assistantSessionId,
        resources,
        input.initialEventSequence ?? 0,
        input.config.model.thinkingLevel,
      );
    } catch (error) {
      return failure({
        ...this.mapFactoryError(error, 'SESSION_OPEN_FAILED'),
        recoverableBinding: input.binding,
      });
    }
  }

  readActiveBranch(
    assistantSessionId: string,
  ): CoordinatorResult<CoordinatorHistorySnapshot> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    const branch = active.session.getActiveBranch();
    return ok({
      piSessionId: active.session.sessionId,
      leafEntryId: branch.at(-1)?.id ?? null,
      messages: mapPiActiveBranch(active.session.sessionId, branch),
    });
  }

  isStreaming(assistantSessionId: string): CoordinatorResult<boolean> {
    const active = this.sessions.get(assistantSessionId);
    return active ? ok(active.session.isStreaming) : this.sessionNotActive();
  }
  isBusy(assistantSessionId: string): CoordinatorResult<boolean> {
    const active = this.sessions.get(assistantSessionId);
    return active ? ok(active.session.isIdle === undefined ? active.session.isStreaming : !active.session.isIdle) : this.sessionNotActive();
  }

  async validateModelSelection(assistantSessionId: string): Promise<CoordinatorResult<boolean>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) return this.sessionNotActive();
    if (!active.prepareModel) return ok(active.modelRuntime.hasConfiguredAuth(active.session.model?.provider ?? ''));
    try {
      const candidate = await active.prepareModel(active.modelConfig);
      const current = active.session.model;
      const snapshot = (model: typeof current) => model ? JSON.stringify({
        provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
        reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap,
        input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      }) : null;
      return ok(snapshot(candidate.model) === snapshot(current));
    } catch { return ok(false); }
  }

  readPersistedModelSelection(identity: { piSessionId: string; piSessionPath: string }) {
    try {
      const manager = SessionManager.open(identity.piSessionPath, this.sessionDir, this.cwd);
      if (manager.getSessionId() !== identity.piSessionId) return failure<CoordinatorModelState | null>({ code: 'SESSION_BINDING_MISMATCH', message: 'Pi session 身份不一致。' });
      const context = buildSessionContext(manager.getBranch());
      if (!COORDINATOR_THINKING_LEVELS.includes(context.thinkingLevel as CoordinatorThinkingLevel)) {
        return failure<CoordinatorModelState | null>({ code: 'INVALID_CONFIGURATION', message: 'Pi 历史推理等级不支持。' });
      }
      return ok<CoordinatorModelState | null>(context.model ? { ...context.model, thinkingLevel: context.thinkingLevel as CoordinatorThinkingLevel } : null);
    } catch {
      return failure<CoordinatorModelState | null>({ code: 'SESSION_OPEN_FAILED', message: 'Pi 模型历史不可读取。' });
    }
  }

  readModelSelection(assistantSessionId: string) {
    const active = this.sessions.get(assistantSessionId);
    if (!active) return this.sessionNotActive<import('./coordinator-adapter.js').CoordinatorSelectionSnapshot>();
    const actual = this.modelState(active.session);
    const persisted = this.readPersistedModelSelection({ piSessionId: active.session.sessionId, piSessionPath: active.session.sessionFile! });
    return ok({
      piSessionId: active.session.sessionId,
      piSessionPath: active.session.sessionFile!,
      model: { ...active.modelConfig, ...actual },
      availableThinkingLevels: active.session.getAvailableThinkingLevels?.() ?? [],
      durable: persisted.ok && persisted.value !== null && persisted.value.provider === actual.provider &&
        persisted.value.modelId === actual.modelId && persisted.value.thinkingLevel === actual.thinkingLevel,
    });
  }

  async prompt(
    assistantSessionId: string,
    text: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    active.mapper.resetRunResult();
    try {
      // 上下文与引用先入会话再发正文：引用紧挨正文，正文 entry 的父节点即引用 entry，
      // 恢复时无需解析正文。
      if (context) await this.appendContext(active, context);
      if (quote) await this.appendQuote(active, quote);
      await active.session.prompt(text);
    } catch {
      return failure({ code: 'RUNTIME_OPERATION_FAILED', message: 'Pi prompt 执行失败。' });
    }

    const result = active.mapper.getLastRunResult();
    if (!result) {
      return failure({
        code: 'RUNTIME_OPERATION_FAILED',
        message: 'Pi prompt 已结束，但未收到 agent_settled 结果事件。',
      });
    }

    return ok(result);
  }

  steer(
    assistantSessionId: string,
    text: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'steer', text, quote, context);
  }

  followUp(
    assistantSessionId: string,
    text: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'followUp', text, quote, context);
  }

  abort(assistantSessionId: string): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'abort');
  }

  async setModel(
    assistantSessionId: string,
    modelConfig: CoordinatorModelConfig,
    assertCurrent?: () => void,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    let prepared: Awaited<ReturnType<NonNullable<PiCoordinatorSessionResources['prepareModel']>>> | undefined;
    try { prepared = await active.prepareModel?.(modelConfig); }
    catch { return failure({ code: 'RUNTIME_OPERATION_FAILED', message: 'Pi 目标模型的认证、能力或端点复核失败。' }); }
    const model = prepared?.model ?? active.modelRuntime.getModel(modelConfig.provider, modelConfig.modelId);
    if (!model) {
      return failure({
        code: 'MODEL_NOT_FOUND',
        message: `未找到模型 ${modelConfig.provider}/${modelConfig.modelId}。`,
      });
    }
    if (!prepared && !active.modelRuntime.hasConfiguredAuth(model.provider)) {
      return failure({
        code: 'MODEL_AUTH_UNAVAILABLE',
        message: `模型提供方 ${model.provider} 没有可用认证。`,
      });
    }

    try {
      assertCurrent?.();
      prepared?.activate();
      await active.session.setModel(model);
      active.modelConfig = prepared?.config ?? modelConfig;
      active.session.setThinkingLevel(modelConfig.thinkingLevel);
      return ok(this.modelUpdate(active.session, modelConfig.thinkingLevel));
    } catch {
      // 异步失败可能已切换；只对未改变实际模型的失败恢复运行配置。
      if (active.session.model === model) active.modelConfig = prepared?.config ?? modelConfig;
      else prepared?.rollback();
      return failure({ code: 'RUNTIME_OPERATION_FAILED', message: 'Pi 模型切换失败。' });
    }
  }

  async setThinkingLevel(
    assistantSessionId: string,
    level: CoordinatorThinkingLevel,
    assertCurrent?: () => void,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    try {
      assertCurrent?.();
      active.session.setThinkingLevel(level);
      return ok(this.modelUpdate(active.session, level));
    } catch {
      return failure({ code: 'RUNTIME_OPERATION_FAILED', message: 'Pi thinking level 设置失败。' });
    }
  }

  subscribe(
    assistantSessionId: string,
    listener: CoordinatorEventListener,
  ): CoordinatorResult<() => void> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    active.listeners.add(listener);
    return ok(() => active.listeners.delete(listener));
  }

  disposeSession(assistantSessionId: string): void {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return;
    }

    this.sessions.delete(assistantSessionId);
    active.unsubscribePi();
    active.listeners.clear();
    active.session.dispose();
  }

  dispose(): void {
    for (const assistantSessionId of [...this.sessions.keys()]) {
      this.disposeSession(assistantSessionId);
    }
  }

  private factoryInput(config: CoordinatorRuntimeConfig, sessionDir = this.sessionDir) {
    return {
      cwd: this.cwd,
      agentDir: this.agentDir,
      ...(sessionDir === undefined ? {} : { sessionDir }),
      config,
    };
  }

  private activateSession(
    assistantSessionId: string,
    resources: PiCoordinatorSessionResources,
    initialSequence: number,
    requestedThinkingLevel: CoordinatorThinkingLevel,
  ): CoordinatorResult<CoordinatorSessionReady> {
    const sessionPath = resources.session.sessionFile;
    if (!sessionPath) {
      resources.session.dispose();
      return failure({
        code: 'RUNTIME_OPERATION_FAILED',
        message: 'Pi SessionManager 未提供可持久化的 session path。',
      });
    }

    const mapper = new PiCoordinatorEventMapper({
      initialMessageIds: resources.session.getActiveBranch().flatMap((entry) =>
        entry.type === 'message' && entry.message.role === 'assistant'
          ? [`assistant:${entry.message.timestamp}`] : []),
      assistantSessionId,
      piSessionId: resources.session.sessionId,
      sourceInstanceId: this.sourceInstanceIdFactory(),
      initialSequence,
      now: this.now,
    });
    const listeners = new Set<CoordinatorEventListener>();
    this.disposeSession(assistantSessionId);

    let unsubscribePi: () => void;
    try {
      unsubscribePi = resources.session.subscribe((event) => {
        const mapped = mapper.map(event);
        if (!mapped) {
          return;
        }

        for (const listener of [...listeners]) {
          try {
            void Promise.resolve(listener(mapped)).catch(() => {
              this.reportEventListenerFailure(mapped.type);
            });
          } catch {
            this.reportEventListenerFailure(mapped.type);
          }
        }
      });
    } catch {
      resources.session.dispose();
      return failure({
        code: 'RUNTIME_OPERATION_FAILED',
        message: 'Pi 事件订阅初始化失败。',
      });
    }

    this.sessions.set(assistantSessionId, {
      session: resources.session,
      modelRuntime: resources.modelRuntime,
      mapper,
      listeners,
      unsubscribePi,
      modelConfig: resources.appliedModelConfig,
      prepareModel: resources.prepareModel,
    });

    const binding: CoordinatorSessionBinding = {
      assistantSessionId,
      piSessionId: resources.session.sessionId,
      piSessionPath: sessionPath,
      updatedAt: this.now(),
    };

    const diagnostics = [...resources.diagnostics];
    const thinkingDiagnostic = thinkingLevelDiagnostic(
      requestedThinkingLevel,
      resources.session.thinkingLevel,
    );
    if (
      thinkingDiagnostic &&
      !diagnostics.some((diagnostic) =>
        diagnostic.code === thinkingDiagnostic.code &&
        diagnostic.message === thinkingDiagnostic.message)
    ) {
      diagnostics.push(thinkingDiagnostic);
    }

    return ok({
      binding,
      activeToolNames: resources.session.getActiveToolNames(),
      model: this.modelState(resources.session),
      modelConfig: resources.appliedModelConfig,
      diagnostics,
      resumedExistingSession: resources.resumedExistingSession,
    });
  }

  /** 工作区会话上下文同样以不显示的 custom message 进入上下文，仍是用户数据。 */
  private appendContext(
    active: ActivePiSession,
    context: CoordinatorSessionContext,
    deliverAs?: 'steer' | 'followUp',
  ): Promise<void> {
    return active.session.sendCustomMessage(
      {
        customType: ASSISTANT_CONTEXT_CUSTOM_TYPE,
        content: renderSessionContextForModel(context),
        display: false,
        details: { version: 1, kind: context.kind, sessionId: context.sessionId, title: context.title },
      },
      deliverAs ? { deliverAs } : undefined,
    );
  }

  /** 引用以 custom message 进入上下文，仍是用户数据，不会成为 system/developer 指令。 */
  private appendQuote(
    active: ActivePiSession,
    quote: CoordinatorQuote,
    deliverAs?: 'steer' | 'followUp',
  ): Promise<void> {
    return active.session.sendCustomMessage(
      {
        customType: ASSISTANT_QUOTE_CUSTOM_TYPE,
        content: renderAssistantQuoteForModel(quote),
        display: false,
        details: assistantQuoteDetails(quote),
      },
      deliverAs ? { deliverAs } : undefined,
    );
  }

  private async callSessionAction(
    assistantSessionId: string,
    action: 'steer' | 'followUp' | 'abort',
    text?: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    try {
      if (action === 'abort') {
        await active.session.abort();
      } else {
        // 上下文与引用按与正文相同的方式入队，保证它们落在同一个接收点。
        if (context) await this.appendContext(active, context, action);
        if (quote) await this.appendQuote(active, quote, action);
        await active.session[action](text ?? '');
      }
      return ok({ accepted: true });
    } catch {
      return failure({
        code: 'RUNTIME_OPERATION_FAILED',
        message: `Pi ${action} 执行失败。`,
      });
    }
  }

  private modelState(session: PiCoordinatorAgentSession): CoordinatorModelState {
    return {
      provider: session.model?.provider ?? '',
      modelId: session.model?.id ?? '',
      thinkingLevel: session.thinkingLevel,
    };
  }

  private modelUpdate(
    session: PiCoordinatorAgentSession,
    requestedThinkingLevel: CoordinatorThinkingLevel,
  ): CoordinatorModelUpdate {
    const diagnostic = thinkingLevelDiagnostic(
      requestedThinkingLevel,
      session.thinkingLevel,
    );

    return {
      model: this.modelState(session),
      diagnostics: diagnostic ? [diagnostic] : [],
    };
  }

  private reportDiagnostic(diagnostic: CoordinatorDiagnostic): void {
    try {
      void Promise.resolve(this.onDiagnostic?.(diagnostic)).catch(() => {});
    } catch {
      // 诊断消费者的同步抛错和异步拒绝都终止在这里，避免递归诊断。
    }
  }

  private reportEventListenerFailure(eventType: CoordinatorAdapterEvent['type']): void {
    this.reportDiagnostic({
      code: 'EVENT_LISTENER_FAILED',
      message: `Multivac 公共事件订阅者处理 ${eventType} 时失败，事件已继续分发。`,
      eventType,
    });
  }

  private sessionNotActive<T>(): CoordinatorResult<T> {
    return failure({ code: 'SESSION_NOT_ACTIVE', message: 'Multivac 会话未激活。' });
  }

  private mapFactoryError(
    error: unknown,
    fallbackCode: CoordinatorError['code'],
  ): CoordinatorError {
    if (error instanceof PiCoordinatorSessionFactoryError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof ModelSettingsServiceError && error.code === 'DEFAULT_MODEL_UNAVAILABLE') {
      return { code: 'DEFAULT_MODEL_UNAVAILABLE', message: '全局默认模型当前无法使用，请修复后重试。' };
    }

    return { code: fallbackCode, message: 'Multivac 的 Pi 运行时初始化失败。' };
  }
}
