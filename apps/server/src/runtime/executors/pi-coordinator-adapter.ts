import { createPiSkills, type PiSkills } from './pi-skills.js';
import type { SkillSource } from '../../modules/skills/skill-source.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { COORDINATOR_THINKING_LEVELS, assistantErrorMessage } from '@multivac/contracts';
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
  CoordinatorSkill,
  CoordinatorSessionContext,
  CoordinatorResult,
  CoordinatorRunResult,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
  CoordinatorSessionReady,
  CoordinatorThinkingLevel,
  WorkingDirectory,
} from '@multivac/contracts';
import { getAgentDir, SessionManager, buildSessionContext, parseSessionEntries } from '@earendil-works/pi-coding-agent';
import { resolveRuntimeConfig } from '../../runtime-config.js';
import { resolvePiInstancePaths } from './pi-instance-paths.js';
import type {
  ContinueCoordinatorSessionInput,
  CoordinatorAdapter,
  CoordinatorTurnPreparation,
  CoordinatorHistorySnapshot,
  CoordinatorInternalTools,
  CoordinatorImage,
  CoordinatorServerNotice,
  CoordinatorToolAuthorizer,
  CoordinatorProjectFileScope,
  CreateCoordinatorSessionInput,
  CoordinatorTaskLease,
  CoordinatorSessionRecoveryIdentity,
} from '../../modules/sessions/coordinator-adapter.js';
import { createPiInternalToolSet } from './pi-internal-tools.js';
import type { BashExecutionPort } from './managed-bash-tool.js';
import type { NativeTaskLease } from './native-task-tools.js';
import { mapPiActiveBranch, imageIdentity } from './pi-message-history.js';
import {
  ASSISTANT_QUOTE_CUSTOM_TYPE,
  assistantQuoteDetails,
  renderAssistantQuoteForModel,
  ASSISTANT_CONTEXT_CUSTOM_TYPE,
  ASSISTANT_NOTICE_CUSTOM_TYPE,
  ASSISTANT_SKILL_CUSTOM_TYPE,
  assistantSkillDetails,
  renderSessionContextForModel,
} from './pi-quote-carriage.js';
import { PiCoordinatorEventMapper } from './pi-event-mapper.js';
import {
  DefaultPiCoordinatorSessionFactory,
  PI_HARNESS,
  PiCoordinatorSessionFactoryError,
  thinkingLevelDiagnostic,
  type PiCoordinatorAgentSession,
  type PiCoordinatorModelRuntime,
  type PiCoordinatorSessionFactory,
  type PiCoordinatorSessionFactoryInput,
  type PiCoordinatorSessionResources,
} from './pi-session-factory.js';

interface ActivePiSession {
  session: PiCoordinatorAgentSession;
  /** 构建该会话运行时所用的工作目录（来自会话记录）；只读核对 transcript 时沿用。 */
  cwd: string;
  modelRuntime: PiCoordinatorModelRuntime;
  mapper: PiCoordinatorEventMapper;
  listeners: Set<CoordinatorEventListener>;
  unsubscribePi: () => void;
  modelConfig: CoordinatorModelConfig;
  prepareModel: PiCoordinatorSessionResources['prepareModel'];
  turnBaseSelection?: import('../../modules/sessions/coordinator-adapter.js').CoordinatorSelectionSnapshot;
  turnConfigurationError?: boolean;
  /** 授权决定要求结束本轮的工具调用：这些调用以拒绝原因结束后中止本轮。 */
  turnEndingToolCalls: Set<string>;
}

/**
 * 适配器在所有会话间共享，只持有 Pi 的 agentDir 与 session 文件目录；
 * 会话工作目录（cwd）随每次创建或恢复传入，不在适配器上固定。
 */
export interface PiCoordinatorAdapterOptions {
  usageRecorder?: import('../../modules/usage/model-usage.js').ModelUsageRecorder;
  executionDiagnostics?: import('../../application/execution-diagnostics.js').ExecutionDiagnostics;
  bashProcesses?: BashExecutionPort;
  taskProtectedPaths?: readonly string[];
  agentDir?: string;
  sessionDir?: string;
  modelsPath?: string | null;
  temporaryRoot?: string;
  sessionFactory?: PiCoordinatorSessionFactory;
  now?: () => string;
  sourceInstanceIdFactory?: () => string;
  onDiagnostic?: (diagnostic: CoordinatorDiagnostic) => void;
  /**
   * 文件工具访问会话工作目录之外的路径时的授权决定；缺省时一律拒绝，越界操作不会执行。
   * 目录边界扩展在所有会话（工作会话与全局 Multivac）中都会注入，与是否提供该选项无关。
   */
  authorizeToolCall?: CoordinatorToolAuthorizer;
  projectFileScope?: CoordinatorProjectFileScope;
}

function ok<T>(value: T): CoordinatorResult<T> {
  return { ok: true, value };
}

function failure<T>(error: CoordinatorError): CoordinatorResult<T> {
  return { ok: false, error };
}

/** 会话工作目录必须是绝对路径：相对路径会按服务进程的启动目录解析。 */
function validateWorkingDirectory(directory: WorkingDirectory): string | undefined {
  return directory.path.trim() && isAbsolute(directory.path) ? undefined : '会话工作目录必须是绝对路径。';
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
/** 会话身份属于其他 harness：Pi 不打开、不读取。 */
const FOREIGN_HARNESS = { code: 'SESSION_BINDING_MISMATCH', message: '会话属于其他执行器，不能由 Pi 打开。' } as const;

export class PiCoordinatorAdapter implements CoordinatorAdapter {
  readonly harness = PI_HARNESS;
  readonly capabilities = {
    turnExecution: true, imageInput: true, steering: true, toolStopProof: true, skills: true,
    // 原生接口存在不代表应用能力已可用：查询端口未接入，压缩写盘失败需要先完成一致性核对。
    contextSnapshot: false, nativeCompaction: false,
  } as const;
  private taskMode: ((sessionId: string) => 'workspace' | 'native-isolated' | null) | undefined;
  private taskLease: ((sessionId: string, phase: Parameters<NativeTaskLease>[0], marker: string, bytes: number) => number) | undefined;
  private readonly bashProcesses: BashExecutionPort | undefined;
  private readonly taskProtectedPaths: readonly string[];
  private readonly sessions = new Map<string, ActivePiSession>();
  private readonly persistedSelections = new Map<string, { key: string; value: CoordinatorModelState | null }>();
  private readonly agentDir: string;
  private readonly modelsPath: string | null;
  private readonly sessionDir: string | undefined;
  private readonly sessionFactory: PiCoordinatorSessionFactory;
  private readonly now: () => string;
  private readonly sourceInstanceIdFactory: () => string;
  private readonly onDiagnostic: ((diagnostic: CoordinatorDiagnostic) => void) | undefined;
  private readonly authorizeToolCall: CoordinatorToolAuthorizer | undefined;
  private readonly optionsProjectFileScope: CoordinatorProjectFileScope | undefined;

  private readonly executionDiagnostics: PiCoordinatorAdapterOptions['executionDiagnostics'];
  private readonly usageRecorder: PiCoordinatorAdapterOptions['usageRecorder'];

  constructor(options: PiCoordinatorAdapterOptions = {}) {
    this.executionDiagnostics = options.executionDiagnostics;
    this.usageRecorder = options.usageRecorder;
    this.bashProcesses = options.bashProcesses;
    this.taskProtectedPaths = options.taskProtectedPaths ?? [];
    this.agentDir = options.agentDir ?? resolvePiInstancePaths(resolveRuntimeConfig(), getAgentDir).agentDir;
    this.sessionDir = options.sessionDir;
    this.modelsPath = options.modelsPath === undefined ? this.agentDir + '/models.json' : options.modelsPath;
    this.sessionFactory =
      options.sessionFactory ??
      new DefaultPiCoordinatorSessionFactory({
        ...(options.modelsPath === undefined ? {} : { modelsPath: options.modelsPath }),
        ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
      });
    this.now = options.now ?? (() => new Date().toISOString());
    this.sourceInstanceIdFactory = options.sourceInstanceIdFactory ?? randomUUID;
    this.onDiagnostic = options.onDiagnostic;
    this.authorizeToolCall = options.authorizeToolCall;
    this.optionsProjectFileScope = options.projectFileScope;
  }

  async createSession(
    input: CreateCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    if (!input.assistantSessionId.trim()) {
      return failure({ code: 'INVALID_CONFIGURATION', message: 'assistantSessionId 不能为空。' });
    }

    const invalidConfig = validateConfig(input.config) ?? validateWorkingDirectory(input.workingDirectory);
    if (invalidConfig) {
      return failure({ code: 'INVALID_CONFIGURATION', message: invalidConfig });
    }

    try {
      const resources = await this.sessionFactory.create(this.factoryInput(
        input.assistantSessionId, input.config, input.workingDirectory, input.sessionDir, input.internalTools,
      ));
      return this.activateSession(
        input.assistantSessionId,
        input.workingDirectory.path,
        resources,
        input.initialEventSequence ?? 0,
        input.config.model.thinkingLevel,
        input.internalTools,
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
    const invalidConfig = validateConfig(input.config) ?? validateWorkingDirectory(input.workingDirectory);
    if (invalidConfig) {
      return failure({ code: 'INVALID_CONFIGURATION', message: invalidConfig });
    }

    try {
      const resources = await this.sessionFactory.continue({
        ...this.factoryInput(
          input.assistantSessionId, input.config, input.workingDirectory, input.sessionDir, input.internalTools,
        ),
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
        input.workingDirectory.path,
        resources,
        input.initialEventSequence ?? 0,
        input.config.model.thinkingLevel,
        input.internalTools,
      );
    } catch (error) {
      return failure(this.mapFactoryError(error, 'RUNTIME_OPERATION_FAILED'));
    }
  }

  async continueSession(
    input: ContinueCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    if (input.binding.harness !== this.harness) {
      return failure({ ...FOREIGN_HARNESS, recoverableBinding: input.binding });
    }
    const invalidConfig = validateConfig(input.config) ?? validateWorkingDirectory(input.workingDirectory);
    if (invalidConfig) {
      return failure({
        code: 'INVALID_CONFIGURATION',
        message: invalidConfig,
        recoverableBinding: input.binding,
      });
    }

    try {
      // 恢复一律按绑定路径打开，cwd 取自会话记录，不读取 Pi 会话头中的 cwd。
      const resources = await this.sessionFactory.open({
        ...this.factoryInput(
          input.binding.assistantSessionId, input.config, input.workingDirectory, input.sessionDir, input.internalTools,
        ),
        sessionPath: input.binding.runtimeSessionRef,
      });

      if (
        resources.session.sessionId !== input.binding.runtimeSessionId ||
        resources.session.sessionFile !== input.binding.runtimeSessionRef
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
        input.workingDirectory.path,
        resources,
        input.initialEventSequence ?? 0,
        input.config.model.thinkingLevel,
        input.internalTools,
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
      runtimeSessionId: active.session.sessionId,
      leafEntryId: branch.at(-1)?.id ?? null,
      branchEntryIds: branch.map(entry => entry.id),
      messages: mapPiActiveBranch(active.session.sessionId, branch, assistantSessionId),
    });
  }

  readPersistedHistory(
    identity: CoordinatorSessionRecoveryIdentity,
    cwd: string,
  ): CoordinatorResult<CoordinatorHistorySnapshot> {
    if (identity.harness !== this.harness) return failure(FOREIGN_HARNESS);
    try {
      // 只读：自行读出文件内容交给内存中的 SessionManager，不经 SessionManager.open（它在文件为空时会写入会话头）。
      const manager = SessionManager.inMemory(cwd, undefined, parseSessionEntries(readFileSync(identity.runtimeSessionRef, 'utf8')));
      if (manager.getSessionId() !== identity.runtimeSessionId) {
        return failure({ code: 'SESSION_BINDING_MISMATCH', message: 'Pi session 身份不一致。' });
      }
      const branch = manager.getBranch();
      return ok({
        runtimeSessionId: identity.runtimeSessionId,
        leafEntryId: branch.at(-1)?.id ?? null,
        branchEntryIds: branch.map(entry => entry.id),
        messages: mapPiActiveBranch(identity.runtimeSessionId, branch),
      });
    } catch {
      return failure({ code: 'SESSION_OPEN_FAILED', message: 'Pi 会话历史不可读取。' });
    }
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
    if (active.turnConfigurationError) return ok(false);
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

  /** stat 同时观察 inode 与 ctime，覆盖同路径替换及保留 mtime 的改写。 */
  private persistedSelectionVersion(path: string): string {
    const real = realpathSync(path);
    const value = statSync(real, { bigint: true });
    if (!value.isFile()) throw new Error('Pi session 不是普通文件。');
    return JSON.stringify([real, String(value.dev), String(value.ino), String(value.mtimeNs), String(value.ctimeNs), String(value.size)]);
  }

  readPersistedModelSelection(identity: CoordinatorSessionRecoveryIdentity, cwd: string) {
    if (identity.harness !== this.harness) return failure<CoordinatorModelState | null>(FOREIGN_HARNESS);
    const path = identity.runtimeSessionRef;
    try {
      const version = this.persistedSelectionVersion(path);
      const key = JSON.stringify([identity.harness, identity.runtimeSessionId, path, cwd, version]);
      const cached = this.persistedSelections.get(path);
      if (cached?.key === key) {
        this.persistedSelections.delete(path); this.persistedSelections.set(path, cached);
        return ok(cached.value ? { ...cached.value } : null);
      }
      this.persistedSelections.delete(path);
      // 显式传入 cwd，SessionManager.open 不会读取会话头中的 cwd。
      const manager = SessionManager.open(path, this.sessionDir, cwd);
      if (manager.getSessionId() !== identity.runtimeSessionId) return failure<CoordinatorModelState | null>({ code: 'SESSION_BINDING_MISMATCH', message: 'Pi session 身份不一致。' });
      const context = buildSessionContext(manager.getBranch());
      if (!COORDINATOR_THINKING_LEVELS.includes(context.thinkingLevel as CoordinatorThinkingLevel)) {
        return failure<CoordinatorModelState | null>({ code: 'INVALID_CONFIGURATION', message: 'Pi 历史推理等级不支持。' });
      }
      if (version !== this.persistedSelectionVersion(path)) throw new Error('Pi session 在读取期间变化。');
      const value = context.model ? { ...context.model, thinkingLevel: context.thinkingLevel as CoordinatorThinkingLevel } : null;
      this.persistedSelections.set(path, { key, value });
      // 活跃会话每个文件只留一个版本；离线恢复读取也有总量上限。
      if (this.persistedSelections.size > 128) this.persistedSelections.delete(this.persistedSelections.keys().next().value!);
      return ok<CoordinatorModelState | null>(value ? { ...value } : null);
    } catch {
      this.persistedSelections.delete(path);
      return failure<CoordinatorModelState | null>({ code: 'SESSION_OPEN_FAILED', message: 'Pi 模型历史不可读取。' });
    }
  }

  private inspectionVersion(active: ActivePiSession): string | undefined {
    try {
      const optionalFile = (path: string) => {
        try { return this.persistedSelectionVersion(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
      };
      const model = active.session.model;
      return JSON.stringify([this.persistedSelectionVersion(active.session.sessionFile!),
        this.modelsPath ? optionalFile(this.modelsPath) : 'disabled', optionalFile(this.agentDir + '/models-store.json'),
        model ? { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
          reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap, input: model.input,
          contextWindow: model.contextWindow, maxTokens: model.maxTokens } : null]);
    } catch { return undefined; }
  }

  readModelSelection(assistantSessionId: string) {
    const active = this.sessions.get(assistantSessionId);
    if (!active) return this.sessionNotActive<import('../../modules/sessions/coordinator-adapter.js').CoordinatorSelectionSnapshot>();
    if (active.turnBaseSelection) return ok(active.turnBaseSelection);
    const actual = this.modelState(active.session);
    const persisted = this.readPersistedModelSelection(
      { harness: this.harness, runtimeSessionId: active.session.sessionId, runtimeSessionRef: active.session.sessionFile! },
      active.cwd,
    );
    const inspectionVersion = this.inspectionVersion(active);
    return ok({
      ...(inspectionVersion ? { inspectionVersion } : {}),
      runtimeSessionId: active.session.sessionId,
      runtimeSessionRef: active.session.sessionFile!,
      model: { ...active.modelConfig, ...actual },
      availableThinkingLevels: active.session.getAvailableThinkingLevels?.() ?? [],
      durable: !active.turnConfigurationError && persisted.ok && persisted.value !== null && persisted.value.provider === actual.provider &&
        persisted.value.modelId === actual.modelId && persisted.value.thinkingLevel === actual.thinkingLevel,
    });
  }

  async prepareTurnExecution(sessionId: string, config: CoordinatorModelConfig, instructions: string): Promise<CoordinatorResult<CoordinatorTurnPreparation>> {
    const active = this.sessions.get(sessionId);
    if (!active) return this.sessionNotActive<CoordinatorTurnPreparation>();
    if (active.turnConfigurationError || active.turnBaseSelection || !active.session.applyTurnConfig || !active.prepareModel) {
      return failure<CoordinatorTurnPreparation>({ code: 'RUNTIME_OPERATION_FAILED', message: '当前 Pi 运行时不支持安全的本轮配置，或仍有未收尾运行。' });
    }
    const prepared = await active.prepareModel(config);
    const base = this.readModelSelection(sessionId);
    if (!base.ok || !base.value.durable || active.session.isStreaming || active.session.isIdle === false ||
      !active.session.applyTurnConfig) throw new Error('会话尚未安全落定，不能应用本轮智能体。');
    // Pi 可选等级以目标模型的真实能力为准；激活后复核，任何归一化都作为拒绝处理。
    let restoreSession: (() => void) | undefined;
    let restored = false;
    const previousConfig = active.modelConfig;
    const restore = () => {
      if (restored) return;
      restored = true;
      try { restoreSession?.(); }
      catch (error) { active.turnConfigurationError = true; throw error; }
      finally {
        prepared.rollback();
        active.modelConfig = previousConfig;
        delete active.turnBaseSelection;
      }
    };
    return ok({
      model: prepared.config,
      activate: () => {
        if (restored || active.turnBaseSelection || active.session.isStreaming || active.session.isIdle === false) throw new Error('运行状态已变化，消息未发送。');
        prepared.activate();
        active.turnBaseSelection = base.value;
        active.modelConfig = prepared.config;
        try {
          restoreSession = active.session.applyTurnConfig!(prepared.model, config.thinkingLevel, instructions);
          const levels = active.session.getAvailableThinkingLevels?.() ?? [];
          if (!levels.includes(config.thinkingLevel) || active.session.thinkingLevel !== config.thinkingLevel ||
            active.session.model?.provider !== config.provider || active.session.model?.id !== config.modelId) {
            throw new Error('智能体模型或推理等级与 Pi 实际能力不一致；未发送，不会静默降级。');
          }
        } catch (error) {
          if (!restoreSession) active.turnConfigurationError = true;
          restore();
          throw error;
        }
      },
      restore,
    });
  }

  async prompt(
    assistantSessionId: string,
    text: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
    notice?: CoordinatorServerNotice,
    images?: readonly CoordinatorImage[],
    skill?: CoordinatorSkill,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    active.mapper.resetRunResult();
    try {
      // 服务端通知最先落入会话；上下文与引用随后，再发正文：引用紧挨正文，正文 entry 的父节点即引用 entry，
      // 恢复时无需解析正文。
      if (notice) await this.appendNotice(active, notice);
      if (context) await this.appendContext(active, context);
      if (skill) await this.appendSkill(active, skill);
      if (quote) await this.appendQuote(active, quote);
      if (images?.length && !this.supportsImageInput(assistantSessionId)) return failure({ code: 'RUNTIME_OPERATION_FAILED', message: '当前模型不支持图片输入或图片能力未确定。' });
      await active.session.prompt(text, images?.length ? { images: images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data })) } : undefined);
    } catch (error) {
      const settled = active.mapper.getLastRunResult();
      if (settled) return ok(settled);
      if (active.mapper.isAbortRequested() && error instanceof Error && error.name === 'AbortError') {
        return ok({ status: 'cancelled' });
      }
      return failure({ code: 'RUNTIME_OPERATION_FAILED', message: assistantErrorMessage(error) ?? 'Pi prompt 执行失败，原因未提供。' });
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
    images?: readonly CoordinatorImage[],
    skill?: CoordinatorSkill,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'steer', text, quote, context, images, skill);
  }

  followUp(
    assistantSessionId: string,
    text: string,
    quote?: CoordinatorQuote,
    context?: CoordinatorSessionContext,
    images?: readonly CoordinatorImage[],
    skill?: CoordinatorSkill,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    return this.callSessionAction(assistantSessionId, 'followUp', text, quote, context, images, skill);
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
    if (active.session.sessionFile) this.persistedSelections.delete(active.session.sessionFile);
    active.unsubscribePi();
    active.listeners.clear();
    active.session.dispose();
  }

  dispose(): void {
    this.persistedSelections.clear();
    for (const assistantSessionId of [...this.sessions.keys()]) {
      this.disposeSession(assistantSessionId);
    }
  }

  taskToolsStopped(sessionId: string): boolean {
    const active = this.sessions.get(sessionId);
    return active?.session.taskToolsStopped?.() === true && !active.session.isStreaming;
  }
  get protectedPaths(): readonly string[] { return [this.agentDir, ...this.taskProtectedPaths]; }
  bindTaskLease(lease: CoordinatorTaskLease, mode?: (sessionId: string) => 'workspace' | 'native-isolated' | null): void {
    if (this.taskLease) throw new Error('任务执行租约已经接入。');
    this.taskLease = lease;
    this.taskMode = mode;
  }

  private skillsFor: ((id: string) => PiSkills) | undefined;
  bindSkills(source: SkillSource): void { this.skillsFor = (id) => createPiSkills(source, id); }

  private factoryInput(
    assistantSessionId: string,
    config: CoordinatorRuntimeConfig,
    workingDirectory: WorkingDirectory,
    sessionDir = this.sessionDir,
    internalTools?: CoordinatorInternalTools,
  ): PiCoordinatorSessionFactoryInput {
    const authorize = this.authorizeToolCall;
    const taskMode = this.taskMode?.(assistantSessionId) ?? null;
    return {
      ...(this.skillsFor && !config.readingOnly ? { skills: this.skillsFor(assistantSessionId) } : {}),
      cwd: workingDirectory.path,
      ...(!config.readingOnly && taskMode !== 'native-isolated' && this.optionsProjectFileScope ? {
        projectDirectories: () => this.optionsProjectFileScope!(assistantSessionId, workingDirectory),
      } : {}),
      assistantSessionId,
      ...(this.executionDiagnostics ? { executionDiagnostics: this.executionDiagnostics } : {}),
      ...(this.usageRecorder ? { usageRecorder: this.usageRecorder } : {}),
      ...(this.bashProcesses ? { bashProcesses: this.bashProcesses } : {}),
      ...(taskMode ? {
        ...(taskMode === 'workspace' ? { taskExecution: true } : { taskIsolation: true }), taskProtectedPaths: this.taskProtectedPaths,
        taskLease: (phase, marker, bytes) => {
          if (!this.taskLease) throw new Error('任务执行租约尚未接入。');
          return this.taskLease(assistantSessionId, phase, marker, bytes);
        },
      } : {}),
      agentDir: this.agentDir,
      ...(sessionDir === undefined ? {} : { sessionDir }),
      config,
      // 内部工具按会话种类传入；调用时带上会话 id，交给服务端注册表执行。
      ...(internalTools ? { internalTools: createPiInternalToolSet(assistantSessionId, internalTools) } : {}),
      // 目录边界判定只知道工具调用本身，会话身份与工作目录记录在这里补齐。
      ...(authorize
        ? {
            authorizeOutsideAccess: async (access, signal) => {
              const decision = await authorize(
                { ...access, assistantSessionId, workingDirectory: { ...workingDirectory } }, signal,
              );
              // 授权等待超时：该调用照常以拒绝原因结束（原因写入工具结果），随后中止本轮。
              if (!decision.allowed && decision.endTurn) {
                this.sessions.get(assistantSessionId)?.turnEndingToolCalls.add(access.toolCallId);
              }
              return decision;
            },
          }
        : {}),
    };
  }

  private activateSession(
    assistantSessionId: string,
    cwd: string,
    resources: PiCoordinatorSessionResources,
    initialSequence: number,
    requestedThinkingLevel: CoordinatorThinkingLevel,
    internalTools?: CoordinatorInternalTools,
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
      runtimeSessionId: resources.session.sessionId,
      sourceInstanceId: this.sourceInstanceIdFactory(),
      initialSequence,
      now: this.now,
      internalToolNames: [...(internalTools?.specs.map((spec) => spec.name) ?? []), ...resources.session.getActiveToolNames().filter(name => name === 'skill_load' || name === 'skill_resource')],
    });
    const listeners = new Set<CoordinatorEventListener>();
    const turnEndingToolCalls = new Set<string>();
    this.disposeSession(assistantSessionId);

    let unsubscribePi: () => void;
    try {
      unsubscribePi = resources.session.subscribe((event) => {
        const mapped = mapper.map(event);
        if (mapped) {
          for (const listener of [...listeners]) {
            try {
              void Promise.resolve(listener(mapped)).catch(() => {
                this.reportEventListenerFailure(mapped.type);
              });
            } catch {
              this.reportEventListenerFailure(mapped.type);
            }
          }
        }

        // 工具结果已经带着拒绝原因定稿，此时中止：本轮不再发起新的模型请求，Pi 按取消结束本轮。
        // abort 会等待本轮空闲，不能在事件回调里等待它。
        if (event.type === 'tool_execution_end' && turnEndingToolCalls.delete(event.toolCallId)) {
          mapper.markAbortRequested();
          void resources.session.abort().catch(() => {});
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
      cwd,
      modelRuntime: resources.modelRuntime,
      mapper,
      listeners,
      unsubscribePi,
      modelConfig: resources.appliedModelConfig,
      prepareModel: resources.prepareModel,
      turnEndingToolCalls,
    });

    const binding: CoordinatorSessionBinding = {
      assistantSessionId,
      harness: this.harness,
      runtimeSessionId: resources.session.sessionId,
      runtimeSessionRef: sessionPath,
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

  /**
   * 服务端通知以不显示的 custom message 进入上下文。它在模型看来同样是一条 user 消息，
   * 可信与否由系统提示词中的约定区分：只有服务端写入、以固定开头的单独一条消息才是提议的真实结果。
   */
  private appendNotice(active: ActivePiSession, notice: CoordinatorServerNotice): Promise<void> {
    return active.session.sendCustomMessage({
      customType: ASSISTANT_NOTICE_CUSTOM_TYPE,
      content: notice.text,
      display: false,
      details: { version: 1, kind: 'proposal-outcomes', proposalIds: [...notice.proposalIds] },
    });
  }

  /** 侧栏上下文（会话或项目）同样以不显示的 custom message 进入上下文，仍是用户数据。 */
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
        details: {
          version: 1,
          kind: context.kind,
          ...(context.kind === 'note' ? { snapshot: context.snapshot } : context.kind === 'reading' ? { reference: context.reference, currentPage: context.currentPage, referenceKind: context.referenceKind } : context.kind === 'focused-task' ? { taskId: context.taskId } : context.kind === 'focused-project' ? { projectId: context.projectId } : { sessionId: context.sessionId }),
          title: context.title,
        },
      },
      deliverAs ? { deliverAs } : undefined,
    );
  }

  /** Skill 正文以 custom message 进入上下文，不拼进用户消息；界面只按 details 显示 Skill 标签。 */
  private appendSkill(
    active: ActivePiSession,
    skill: CoordinatorSkill,
    deliverAs?: 'steer' | 'followUp',
  ): Promise<void> {
    return active.session.sendCustomMessage(
      {
        customType: ASSISTANT_SKILL_CUSTOM_TYPE,
        content: skill.content,
        display: false,
        details: assistantSkillDetails(skill),
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
    images?: readonly CoordinatorImage[],
    skill?: CoordinatorSkill,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    const active = this.sessions.get(assistantSessionId);
    if (!active) {
      return this.sessionNotActive();
    }

    try {
      if (action === 'abort') {
        active.mapper.markAbortRequested();
        await active.session.abort();
      } else {
        // 上下文与引用按与正文相同的方式入队，保证它们落在同一个接收点。
        if (context) await this.appendContext(active, context, action);
        if (skill) await this.appendSkill(active, skill, action);
        if (quote) await this.appendQuote(active, quote, action);
        if (images?.length && !this.supportsImageInput(assistantSessionId)) return failure({ code: 'RUNTIME_OPERATION_FAILED', message: '当前模型不支持图片输入或图片能力未确定。' });
        await active.session[action](text ?? '', images?.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data })));
      }
      return ok({ accepted: true });
    } catch (error) {
      return failure({
        code: 'RUNTIME_OPERATION_FAILED',
        message: assistantErrorMessage(error) ?? `Pi ${action} 执行失败，原因未提供。`,
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

  supportsImageInput(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.session.model?.input?.includes('image') === true;
  }

  readImageContents(sessionId: string, entryId: string): readonly CoordinatorImage[] {
    const entry = this.sessions.get(sessionId)?.session.getActiveBranch().find(value => value.id === entryId);
    if (entry?.type !== 'message' || !('content' in entry.message) || !Array.isArray(entry.message.content)) return [];
    return entry.message.content.filter(block => block.type === 'image').slice(0, 4).map(block => ({ id: imageIdentity(sessionId, block.data), mimeType: block.mimeType, data: block.data }));
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
