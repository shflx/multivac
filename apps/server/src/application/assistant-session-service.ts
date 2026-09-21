import type {
  AssistantApiErrorCode,
  AssistantPageState,
  AssistantPageStatePut,
  AssistantSessionPageResponse,
  AssistantSessionQuery,
  AssistantStreamingMessageView,
  AssistantToolExecutionDetail,
  AssistantToolExecutionListResponse,
  AssistantToolExecutionQuery,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
} from '@multivac/contracts';
import {
  ASSISTANT_SESSION_DEFAULT_LIMIT,
  ASSISTANT_TOOL_LIST_DEFAULT_LIMIT,
  ASSISTANT_TOOL_SNAPSHOT_MAX_ITEMS,
  GLOBAL_ASSISTANT_SESSION_ID,
} from '@multivac/contracts';
import {
  AssistantPageStateRevisionConflictError,
  type AssistantPageStateRepository,
  type AssistantSessionBindingRepository,
} from '../modules/sessions/assistant-session.js';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';
import type {
  AssistantCommandAnchor,
  AssistantEventRepository,
} from '../modules/sessions/assistant-turn.js';
import type { AssistantCommandRepository } from '../modules/sessions/assistant-turn.js';
import { toolExecutionDetail, toolExecutionView } from './assistant-tool-executions.js';
import type { ModelSelectionRecoveryRepository } from '../modules/sessions/model-selection-recovery.js';
import { ModelSettingsServiceError } from '../modules/model-settings/model-settings.js';
import type { SessionSelectionRepository, StoredSessionSelection } from '../modules/sessions/session-model-selection.js';
import { sameSessionModelConfig } from '../modules/sessions/session-model-selection.js';

export class AssistantSessionServiceError extends Error {
  constructor(
    readonly code: AssistantApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantSessionServiceError';
  }
}

export interface AssistantSessionServiceOptions {
  adapter: CoordinatorAdapter;
  bindingRepository: AssistantSessionBindingRepository;
  pageStateRepository: AssistantPageStateRepository;
  runtimeConfig: CoordinatorRuntimeConfig;
  resolveNewSessionRuntimeConfig?: () => Promise<CoordinatorRuntimeConfig>;
  eventRepository?: AssistantEventRepository;
  commandRepository?: AssistantCommandRepository;
  assistantSessionId?: string;
  modelSelectionRecoveryRepository?: ModelSelectionRecoveryRepository;
  selectionRepository?: SessionSelectionRepository;
  now?: () => string;
  onInitialized?: () => void;
}

/** 编排固定全局助手的绑定恢复、只读分页和页面现场。 */
export class AssistantSessionService {
  private readonly assistantSessionId: string;
  private readonly now: () => string;
  private initialization: Promise<CoordinatorSessionBinding> | undefined;

  constructor(private readonly options: AssistantSessionServiceOptions) {
    this.assistantSessionId = options.assistantSessionId ?? GLOBAL_ASSISTANT_SESSION_ID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  initialize(): Promise<CoordinatorSessionBinding> {
    this.initialization ??= this.initializeOnce().then((binding) => {
      this.options.onInitialized?.();
      return binding;
    }).catch((error: unknown) => {
      this.initialization = undefined;
      if (error instanceof ModelSettingsServiceError && error.code === 'DEFAULT_MODEL_UNAVAILABLE') {
        throw new AssistantSessionServiceError('DEFAULT_MODEL_UNAVAILABLE', error.message);
      }
      throw error;
    });
    return this.initialization;
  }

  async getSessionPage(query: AssistantSessionQuery): Promise<AssistantSessionPageResponse> {
    const binding = await this.initialize();
    // 以下读取均同步执行：正文快照、历史与 cursor 属于同一事件循环窗口。
    const eventCursor = this.options.eventRepository?.latestCursor() ?? '0';
    const snapshot = this.options.adapter.readActiveBranch(this.assistantSessionId);
    if (!snapshot.ok) {
      throw new AssistantSessionServiceError(
        'ASSISTANT_SESSION_UNAVAILABLE',
        'Multivac 会话当前不可读取。',
      );
    }
    if (snapshot.value.piSessionId !== binding.piSessionId) {
      throw new AssistantSessionServiceError(
        'ASSISTANT_SESSION_BINDING_MISMATCH',
        'Multivac active branch 与已保存绑定不一致。',
      );
    }

    const messages = snapshot.value.messages;
    const streaming = new Map<string, AssistantStreamingMessageView>();
    const completed = new Set(messages.map((message) => message.runtimeMessageId));
    for (const event of this.options.eventRepository?.streamingEvents?.(this.assistantSessionId) ?? []) {
      if (event.type !== 'assistant.message.delta' || event.data.piSessionId !== binding.piSessionId ||
          completed.has(event.data.messageId)) continue;
      const id = event.data.messageId;
      const previous = streaming.get(id);
      streaming.set(id, {
        piSessionId: binding.piSessionId, messageId: id,
        text: (previous?.text ?? '') + event.data.delta,
        createdAt: previous?.createdAt ?? event.occurredAt,
      });
    }
    const end = query.before === undefined
      ? messages.length
      : messages.findIndex((message) => message.piEntryId === query.before);
    if (end < 0) {
      throw new AssistantSessionServiceError('INVALID_CURSOR', '分页游标无效或不属于当前分支。');
    }
    const limit = query.limit ?? ASSISTANT_SESSION_DEFAULT_LIMIT;
    const start = Math.max(0, end - limit);
    const page = messages.slice(start, end);
    // 工具执行记录由已落库的事件投影派生；快照只带摘要，与正文同一事件循环窗口读取。
    const toolExecutions = (this.options.eventRepository?.toolExecutionProjections?.(
      this.assistantSessionId,
      ASSISTANT_TOOL_SNAPSHOT_MAX_ITEMS,
    ) ?? []).map(toolExecutionView);
    const runTraces = this.options.eventRepository?.runTraceProjections?.(
      this.assistantSessionId,
      ASSISTANT_TOOL_SNAPSHOT_MAX_ITEMS,
    ) ?? [];
    // 命令锚点让前端把工具记录放回所属 Turn，不必比较跨进程时钟。
    const commandAnchors: AssistantCommandAnchor[] =
      this.options.commandRepository?.listCommandAnchors(this.assistantSessionId) ?? [];

    return {
      assistantSessionId: this.assistantSessionId,
      piSessionId: binding.piSessionId,
      messages: page,
      hasMore: start > 0,
      nextBefore: start > 0 ? page[0]?.piEntryId ?? null : null,
      cursor: `${binding.piSessionId}:${snapshot.value.leafEntryId ?? 'empty'}`,
      eventCursor,
      streamingMessages: [...streaming.values()].filter((message) => message.text.length > 0),
      toolExecutions,
      runTraces,
      commandAnchors,
    };
  }

  /** 按 cursor 向前分页读取工具执行摘要。 */
  async listToolExecutions(
    query: AssistantToolExecutionQuery = {},
  ): Promise<AssistantToolExecutionListResponse> {
    await this.initialize();
    if (query.before !== undefined) {
      const before = Number(query.before);
      if (!Number.isSafeInteger(before) || before < 0) {
        throw new AssistantSessionServiceError('INVALID_CURSOR', '工具执行分页游标无效。');
      }
    }
    const limit = query.limit ?? ASSISTANT_TOOL_LIST_DEFAULT_LIMIT;
    const projections = this.options.eventRepository?.toolExecutionProjections?.(
      this.assistantSessionId,
      limit + 1,
      query.before,
    ) ?? [];
    const hasMore = projections.length > limit;
    // 查询结果为升序，溢出探测项位于最前面；丢弃它才能保留最新的 limit 条。
    const page = hasMore ? projections.slice(1) : projections;
    return {
      assistantSessionId: this.assistantSessionId,
      tools: page.map(toolExecutionView),
      hasMore,
      nextBefore: hasMore ? page[0]?.cursor ?? null : null,
      latestCursor: this.options.eventRepository?.latestCursor() ?? '0',
    };
  }

  async getToolExecution(toolCallId: string): Promise<AssistantToolExecutionDetail> {
    await this.initialize();
    const projection = this.options.eventRepository?.toolExecutionProjection?.(
      this.assistantSessionId,
      toolCallId,
    );
    if (!projection) {
      throw new AssistantSessionServiceError('NOT_FOUND', '未找到该工具执行记录。');
    }
    return toolExecutionDetail(projection);
  }

  async getPageState(): Promise<AssistantPageState> {
    await this.initialize();
    return this.options.pageStateRepository.get(this.assistantSessionId);
  }

  async putPageState(input: AssistantPageStatePut): Promise<AssistantPageState> {
    await this.initialize();
    try {
      return this.options.pageStateRepository.save(this.assistantSessionId, input);
    } catch (error) {
      if (error instanceof AssistantPageStateRevisionConflictError) {
        throw new AssistantSessionServiceError(
          'PAGE_STATE_CONFLICT',
          '页面状态已在其他位置更新，请重新读取后再保存。',
        );
      }
      throw error;
    }
  }

  private async initializeOnce(): Promise<CoordinatorSessionBinding> {
    const savedBinding = this.options.bindingRepository.get(this.assistantSessionId);
    const selection = this.options.selectionRepository?.getSelection(this.assistantSessionId);
    // binding 丢失但选择账本仍在时，只恢复已知身份，不能扫描最近会话或消费新默认。
    const existing = savedBinding ?? (selection ? {
      assistantSessionId: this.assistantSessionId, piSessionId: selection.piSessionId,
      piSessionPath: selection.piSessionPath, updatedAt: this.now(),
    } : undefined);
    if (existing) {
      const config = this.configForBinding(existing);
      const restored = await this.options.adapter.continueSession({
        binding: existing,
        config: this.selectionConfig(existing, config),
      });
      if (!restored.ok) {
        throw new AssistantSessionServiceError(
          restored.error.code === 'SESSION_BINDING_MISMATCH'
            ? 'ASSISTANT_SESSION_BINDING_MISMATCH'
            : 'ASSISTANT_SESSION_RECOVERY_FAILED',
          restored.error.code === 'SESSION_BINDING_MISMATCH'
            ? '已保存的 Multivac 绑定与 Pi 会话不一致。'
            : '已保存的 Multivac 会话无法恢复。',
        );
      }
      let confirmed: CoordinatorSessionBinding;
      try {
        confirmed = savedBinding ?? this.options.bindingRepository.insertIfAbsent(
          this.bindingForModel(existing, restored.value.modelConfig),
        ).binding;
      } catch {
        this.options.adapter.disposeSession(this.assistantSessionId);
        throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', 'binding 恢复保存失败，Pi 选择引用已保留，禁止发布成功状态。');
      }
      if (confirmed.piSessionId !== existing.piSessionId || confirmed.piSessionPath !== existing.piSessionPath) {
        this.options.adapter.disposeSession(this.assistantSessionId);
        throw new AssistantSessionServiceError('ASSISTANT_SESSION_BINDING_MISMATCH', '恢复中的模型选择与并发写入的 binding 不一致。');
      }
      this.seedSelection(confirmed, restored.value.modelConfig);
      return confirmed;
    }

    const initialized = await this.options.adapter.continueRecentSession({
      assistantSessionId: this.assistantSessionId,
      config: this.options.runtimeConfig,
      ...(this.options.resolveNewSessionRuntimeConfig
        ? { resolveNewSessionConfig: this.options.resolveNewSessionRuntimeConfig }
        : {}),
      ...(this.options.modelSelectionRecoveryRepository
        ? {
            resolveRecoveredSessionConfig: async (identity) => {
              const selection = this.options.selectionRepository?.getSelection(this.assistantSessionId);
              if (selection) return this.selectionConfig({ ...identity, assistantSessionId: this.assistantSessionId, updatedAt: this.now() }, this.options.runtimeConfig);
              let record;
              try {
                record = await this.options.modelSelectionRecoveryRepository!.get(
                  identity.piSessionId,
                );
              } catch {
                return null;
              }
              if (!record) return null;
              if (
                record.assistantSessionId !== this.assistantSessionId ||
                record.piSessionPath !== identity.piSessionPath
              ) {
                return null;
              }
              return {
                ...this.options.runtimeConfig,
                model: {
                  thinkingLevel: this.options.runtimeConfig.model.thinkingLevel,
                  source: record.selectionKind,
                  provider: record.provider,
                  modelId: record.modelId,
                  ...(record.profileId ? { profileId: record.profileId } : {}),
                  ...(record.protocol ? { protocol: record.protocol } : {}),
                  ...(record.protocol ? { endpoint: record.endpoint } : {}),
                  ...(record.endpointMode ? { endpointMode: record.endpointMode } : {}),
                  ...(record.resolvedEndpoint !== undefined
                    ? { resolvedEndpoint: record.resolvedEndpoint }
                    : {}),
                },
              };
            },
            persistModelSelectionRecovery: async (recovery) => {
              // 切换后的账本覆盖初始化快照；不得用 saveIfAbsent 重写旧初始化意图。
              if (this.options.selectionRepository?.getSelection(this.assistantSessionId)) return;
              await this.options.modelSelectionRecoveryRepository!.saveIfAbsent({
                version: 1,
                phase: 'initialization-intent',
                selectionKind: recovery.model.source ?? 'base',
                assistantSessionId: this.assistantSessionId,
                piSessionId: recovery.piSessionId,
                piSessionPath: recovery.piSessionPath,
                provider: recovery.model.provider,
                modelId: recovery.model.modelId,
                profileId: recovery.model.profileId ?? null,
                protocol: recovery.model.protocol ?? null,
                endpoint: recovery.model.endpoint ?? null,
                ...(recovery.model.endpointMode ? { endpointMode: recovery.model.endpointMode } : {}),
                resolvedEndpoint: recovery.model.resolvedEndpoint ?? null,
                createdAt: this.now(),
              });
            },
          }
        : {}),
    });
    if (!initialized.ok) {
      if (initialized.error.code === 'DEFAULT_MODEL_UNAVAILABLE') {
        throw new AssistantSessionServiceError(
          'DEFAULT_MODEL_UNAVAILABLE',
          '全局默认模型当前无法使用；请修复模型配置或认证后重试，不会自动切换模型。',
        );
      }
      if (initialized.error.code === 'MODEL_SELECTION_RECOVERY_REQUIRED') {
        throw new AssistantSessionServiceError(
          'ASSISTANT_SESSION_RECOVERY_FAILED',
          '发现未绑定的 Pi session，但缺少可验证的模型选择恢复记录。',
        );
      }
      throw new AssistantSessionServiceError(
        'ASSISTANT_SESSION_UNAVAILABLE',
        'Multivac 会话初始化失败。',
      );
    }

    const selectedModel = initialized.value.modelConfig;
    const candidateBinding = this.bindingForModel(initialized.value.binding, selectedModel);
    let result: ReturnType<AssistantSessionBindingRepository['insertIfAbsent']>;
    try {
      result = this.options.bindingRepository.insertIfAbsent(candidateBinding);
    } catch (error) {
      this.options.adapter.disposeSession(this.assistantSessionId);
      throw error;
    }
    if (result.inserted || (
      result.binding.piSessionId === candidateBinding.piSessionId &&
      result.binding.piSessionPath === candidateBinding.piSessionPath
    )) {
      this.seedSelection(result.binding, selectedModel);
      return result.binding;
    }

    this.options.adapter.disposeSession(this.assistantSessionId);
    const winner = await this.options.adapter.continueSession({
      binding: result.binding,
      config: this.selectionConfig(result.binding, this.configForBinding(result.binding)),
    });
    if (!winner.ok) {
      throw new AssistantSessionServiceError(
        winner.error.code === 'SESSION_BINDING_MISMATCH'
          ? 'ASSISTANT_SESSION_BINDING_MISMATCH'
          : 'ASSISTANT_SESSION_RECOVERY_FAILED',
        '并发初始化产生的 Multivac 绑定无法恢复。',
      );
    }
    this.seedSelection(result.binding, winner.value.modelConfig);
    return result.binding;
  }

  private bindingForModel(binding: CoordinatorSessionBinding, selectedModel: CoordinatorRuntimeConfig['model']): CoordinatorSessionBinding {
    return {
      ...binding,
      modelProvider: selectedModel.provider,
      modelId: selectedModel.modelId,
      modelSource: selectedModel.source ?? 'base',
      ...(selectedModel.protocol
        ? { modelProtocol: selectedModel.protocol }
        : {}),
      ...(selectedModel.endpoint !== undefined
        ? { modelEndpoint: selectedModel.endpoint }
        : {}),
      ...(selectedModel.endpointMode ? { modelEndpointMode: selectedModel.endpointMode } : {}),
      ...(selectedModel.resolvedEndpoint !== undefined
        ? { modelResolvedEndpoint: selectedModel.resolvedEndpoint }
        : {}),
      ...(selectedModel.profileId
        ? { modelProfileId: selectedModel.profileId }
        : {}),
    };
  }

  private configForBinding(binding: CoordinatorSessionBinding): CoordinatorRuntimeConfig {
    const hasSelection = this.options.selectionRepository?.getSelection(this.assistantSessionId);
    const persisted = hasSelection ? null : this.options.adapter.readPersistedModelSelection(binding);
    if (persisted && !persisted.ok) {
      throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', 'Pi 历史模型无法核对，禁止用当前配置替代。');
    }
    if (!binding.modelProvider || !binding.modelId) {
      // 旧版绑定没有受控引用；保留 Pi 历史的基础模型与等级，不套环境中的新模型。
      return persisted?.ok && persisted.value ? {
        ...this.options.runtimeConfig,
        model: { source: 'base', ...persisted.value },
      } : this.options.runtimeConfig;
    }
    if (persisted?.ok && persisted.value && (persisted.value.provider !== binding.modelProvider || persisted.value.modelId !== binding.modelId)) {
      throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', '既有 binding 与 Pi 历史模型不一致，禁止回退到初始化模型。');
    }
    return {
      ...this.options.runtimeConfig,
      model: {
        thinkingLevel: this.options.runtimeConfig.model.thinkingLevel,
        source: binding.modelSource ?? 'base',
        provider: binding.modelProvider,
        modelId: binding.modelId,
        ...(binding.modelProtocol ? { protocol: binding.modelProtocol } : {}),
        ...(binding.modelEndpoint !== undefined ? { endpoint: binding.modelEndpoint } : {}),
        ...(binding.modelEndpointMode ? { endpointMode: binding.modelEndpointMode } : {}),
        ...(binding.modelResolvedEndpoint !== undefined
          ? { resolvedEndpoint: binding.modelResolvedEndpoint }
          : {}),
        ...(binding.modelProfileId ? { profileId: binding.modelProfileId } : {}),
      },
    };
  }

  private selectionConfig(binding: CoordinatorSessionBinding, fallback: CoordinatorRuntimeConfig): CoordinatorRuntimeConfig {
    const record = this.options.selectionRepository?.getSelection(this.assistantSessionId);
    if (!record) return fallback;
    if (record.sessionId !== this.assistantSessionId || record.piSessionId !== binding.piSessionId || record.piSessionPath !== binding.piSessionPath) {
      throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', '模型选择账本与 Pi session 身份不一致。');
    }
    const actual = this.options.adapter.readPersistedModelSelection(binding);
    if (!actual.ok) throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', 'Pi 模型历史无法对账。');
    if (!actual.value) throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', '已建立选择账本的 Pi session 缺少模型历史，禁止重写历史或套用默认。');
    let model = record.model;
    if (record.pending) {
      const candidates = [record.pending.previous, record.pending.target].filter((candidate) =>
        candidate.provider === actual.value?.provider && candidate.modelId === actual.value?.modelId);
      // Pi transcript 不保存端点；同 provider/id 的不同快照无法消除崩溃歧义。
      if (candidates.length === 0 || (candidates.length === 2 &&
        !sameSessionModelConfig(candidates[0]!, candidates[1]!))) {
        throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', '中断的模型切换无法安全核对真实配置，禁止自动重发或回退。');
      }
      model = candidates[0]!;
    } else if (actual.value && (model.provider !== actual.value.provider || model.modelId !== actual.value.modelId)) {
      throw new AssistantSessionServiceError('ASSISTANT_SESSION_RECOVERY_FAILED', 'Pi 模型历史与已确认选择不一致。');
    }
    return { ...fallback, model: { ...model, thinkingLevel: actual.value?.thinkingLevel ?? model.thinkingLevel } };
  }

  private seedSelection(binding: CoordinatorSessionBinding, model: CoordinatorRuntimeConfig['model']): void {
    const repository = this.options.selectionRepository;
    if (!repository || repository.getSelection(this.assistantSessionId)) return;
    const actual = this.options.adapter.readModelSelection(this.assistantSessionId);
    const selection: StoredSessionSelection = {
      sessionId: this.assistantSessionId, piSessionId: binding.piSessionId, piSessionPath: binding.piSessionPath,
      revision: 0, model: actual.ok ? actual.value.model : model, pending: null,
      recoveryError: actual.ok && actual.value.durable ? null : 'Pi 模型选择尚未可靠持久化。',
    };
    repository.saveSelection(selection);
  }
}
