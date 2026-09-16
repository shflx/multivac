import { randomUUID } from 'node:crypto';
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
  CoordinatorResult,
  CoordinatorRunResult,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
  CoordinatorSessionReady,
  CoordinatorThinkingLevel,
} from '@multivac/contracts';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  ContinueCoordinatorSessionInput,
  CoordinatorAdapter,
  CoordinatorHistorySnapshot,
  CreateCoordinatorSessionInput,
} from './coordinator-adapter.js';
import { mapPiActiveBranch } from './pi-message-history.js';
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
      const resources = await this.sessionFactory.create(this.factoryInput(input.config));
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
        ...this.factoryInput(input.config),
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

  async prompt(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    active.mapper.resetRunResult();
    try {
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
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'steer', text);
  }

  followUp(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'followUp', text);
  }

  abort(assistantSessionId: string): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'abort');
  }

  async setModel(
    assistantSessionId: string,
    modelConfig: CoordinatorModelConfig,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    const model = active.modelRuntime.getModel(modelConfig.provider, modelConfig.modelId);
    if (!model) {
      return failure({
        code: 'MODEL_NOT_FOUND',
        message: `未找到模型 ${modelConfig.provider}/${modelConfig.modelId}。`,
      });
    }
    if (!active.modelRuntime.hasConfiguredAuth(model.provider)) {
      return failure({
        code: 'MODEL_AUTH_UNAVAILABLE',
        message: `模型提供方 ${model.provider} 没有可用认证。`,
      });
    }

    try {
      await active.session.setModel(model);
      active.session.setThinkingLevel(modelConfig.thinkingLevel);
      return ok(this.modelUpdate(active.session, modelConfig.thinkingLevel));
    } catch {
      return failure({ code: 'RUNTIME_OPERATION_FAILED', message: 'Pi 模型切换失败。' });
    }
  }

  async setThinkingLevel(
    assistantSessionId: string,
    level: CoordinatorThinkingLevel,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    try {
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

  private factoryInput(config: CoordinatorRuntimeConfig) {
    return {
      cwd: this.cwd,
      agentDir: this.agentDir,
      ...(this.sessionDir === undefined ? {} : { sessionDir: this.sessionDir }),
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

  private async callSessionAction(
    assistantSessionId: string,
    action: 'steer' | 'followUp' | 'abort',
    text?: string,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    try {
      if (action === 'abort') {
        await active.session.abort();
      } else {
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
