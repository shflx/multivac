import type {
  AssistantApiErrorCode,
  AssistantPageState,
  AssistantPageStatePut,
  AssistantSessionPageResponse,
  AssistantSessionQuery,
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
  eventRepository?: AssistantEventRepository;
  assistantSessionId?: string;
}

/** 编排固定全局助手的绑定恢复、只读分页和页面现场。 */
export class AssistantSessionService {
  private readonly assistantSessionId: string;
  private initialization: Promise<CoordinatorSessionBinding> | undefined;

  constructor(private readonly options: AssistantSessionServiceOptions) {
    this.assistantSessionId = options.assistantSessionId ?? GLOBAL_ASSISTANT_SESSION_ID;
  }

  initialize(): Promise<CoordinatorSessionBinding> {
    this.initialization ??= this.initializeOnce().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  async getSessionPage(query: AssistantSessionQuery): Promise<AssistantSessionPageResponse> {
    const binding = await this.initialize();
    // 先固定公共事件 cursor，再读取 Pi 快照；窗口内的新事件会由 SSE replay 补齐。
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
        config: this.options.runtimeConfig,
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
    });
    if (!initialized.ok) {
      throw new AssistantSessionServiceError(
        'ASSISTANT_SESSION_UNAVAILABLE',
        'Multivac 会话初始化失败。',
      );
    }

    const result = this.options.bindingRepository.insertIfAbsent(initialized.value.binding);
    if (result.inserted || (
      result.binding.piSessionId === initialized.value.binding.piSessionId &&
      result.binding.piSessionPath === initialized.value.binding.piSessionPath
    )) {
      return result.binding;
    }

    this.options.adapter.disposeSession(this.assistantSessionId);
    const winner = await this.options.adapter.continueSession({
      binding: result.binding,
      config: this.options.runtimeConfig,
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
}
