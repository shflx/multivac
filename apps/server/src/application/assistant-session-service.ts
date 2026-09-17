import type {
  AssistantApiErrorCode,
  AssistantPageState,
  AssistantPageStatePut,
  AssistantSessionPageResponse,
  AssistantSessionQuery,
  AssistantStreamingMessageView,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
} from '@multivac/contracts';
import {
  ASSISTANT_SESSION_DEFAULT_LIMIT,
  GLOBAL_ASSISTANT_SESSION_ID,
} from '@multivac/contracts';
import {
  AssistantPageStateRevisionConflictError,
  type AssistantPageStateRepository,
  type AssistantSessionBindingRepository,
} from '../modules/sessions/assistant-session.js';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';
import type { AssistantEventRepository } from '../modules/sessions/assistant-turn.js';
import type { ModelSelectionRecoveryRepository } from '../modules/sessions/model-selection-recovery.js';
import { ModelSettingsServiceError } from '../modules/model-settings/model-settings.js';

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
  assistantSessionId?: string;
  modelSelectionRecoveryRepository?: ModelSelectionRecoveryRepository;
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

    return {
      assistantSessionId: this.assistantSessionId,
      piSessionId: binding.piSessionId,
      messages: page,
      hasMore: start > 0,
      nextBefore: start > 0 ? page[0]?.piEntryId ?? null : null,
      cursor: `${binding.piSessionId}:${snapshot.value.leafEntryId ?? 'empty'}`,
      eventCursor,
      streamingMessages: [...streaming.values()].filter((message) => message.text.length > 0),
    };
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
    const existing = this.options.bindingRepository.get(this.assistantSessionId);
    if (existing) {
      const restored = await this.options.adapter.continueSession({
        binding: existing,
        config: this.configForBinding(existing),
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
      return existing;
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
    const candidateBinding: CoordinatorSessionBinding = {
      ...initialized.value.binding,
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
      return result.binding;
    }

    this.options.adapter.disposeSession(this.assistantSessionId);
    const winner = await this.options.adapter.continueSession({
      binding: result.binding,
      config: this.configForBinding(result.binding),
    });
    if (!winner.ok) {
      throw new AssistantSessionServiceError(
        winner.error.code === 'SESSION_BINDING_MISMATCH'
          ? 'ASSISTANT_SESSION_BINDING_MISMATCH'
          : 'ASSISTANT_SESSION_RECOVERY_FAILED',
        '并发初始化产生的 Multivac 绑定无法恢复。',
      );
    }
    return result.binding;
  }

  private configForBinding(binding: CoordinatorSessionBinding): CoordinatorRuntimeConfig {
    if (!binding.modelProvider || !binding.modelId) return this.options.runtimeConfig;
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
}
