import type {
  AssistantMessageView,
  CoordinatorActionAccepted,
  CoordinatorEventListener,
  CoordinatorModelConfig,
  CoordinatorModelUpdate,
  CoordinatorQuote,
  CoordinatorResult,
  CoordinatorRunResult,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
  CoordinatorSessionContext,
  CoordinatorSessionReady,
  CoordinatorThinkingLevel,
} from '@multivac/contracts';

export interface CoordinatorSessionRecoveryIdentity {
  piSessionId: string;
  piSessionPath: string;
}

export interface CoordinatorModelSelectionRecoveryInput extends CoordinatorSessionRecoveryIdentity {
  model: CoordinatorModelConfig;
}

export interface CreateCoordinatorSessionInput {
  assistantSessionId: string;
  config: CoordinatorRuntimeConfig;
  /** 仅当 continueRecent 确认没有历史 session 时调用。 */
  resolveNewSessionConfig?: () => Promise<CoordinatorRuntimeConfig>;
  resolveRecoveredSessionConfig?: (
    identity: CoordinatorSessionRecoveryIdentity,
  ) => Promise<CoordinatorRuntimeConfig | null>;
  persistModelSelectionRecovery?: (
    input: CoordinatorModelSelectionRecoveryInput,
  ) => Promise<void>;
  /** 从应用层已有 cursor 恢复时，对应下一条公共事件之前的 sequence。 */
  initialEventSequence?: number;
  /** Pi session 文件目录；缺省使用适配器的默认目录（全局协调会话）。 */
  sessionDir?: string;
}

export interface ContinueCoordinatorSessionInput {
  binding: CoordinatorSessionBinding;
  config: CoordinatorRuntimeConfig;
  /** Pi session 文件目录；缺省使用适配器的默认目录（全局协调会话）。 */
  sessionDir?: string;
  /** 从应用层已有 cursor 恢复时，对应下一条公共事件之前的 sequence。 */
  initialEventSequence?: number;
}

export interface CoordinatorHistorySnapshot {
  piSessionId: string;
  leafEntryId: string | null;
  messages: AssistantMessageView[];
}

export interface CoordinatorSelectionSnapshot {
  piSessionId: string;
  piSessionPath: string;
  model: CoordinatorModelConfig;
  availableThinkingLevels: CoordinatorThinkingLevel[];
  /** live 与 Pi transcript 均一致才可向上层确认成功。 */
  durable: boolean;
}

/**
 * 上层只依赖该端口；Pi 的 Session、Message、Event 和 Model 类型不得越过此边界。
 */
export interface CoordinatorAdapter {
  readModelSelection(assistantSessionId: string): CoordinatorResult<CoordinatorSelectionSnapshot>;
  validateModelSelection(assistantSessionId: string): Promise<CoordinatorResult<boolean>>;
  isBusy(assistantSessionId: string): CoordinatorResult<boolean>;
  readPersistedModelSelection(identity: CoordinatorSessionRecoveryIdentity): CoordinatorResult<{
    provider: string; modelId: string; thinkingLevel: CoordinatorThinkingLevel;
  } | null>;
  createSession(input: CreateCoordinatorSessionInput): Promise<CoordinatorResult<CoordinatorSessionReady>>;
  continueRecentSession(input: CreateCoordinatorSessionInput): Promise<CoordinatorResult<CoordinatorSessionReady>>;
  continueSession(input: ContinueCoordinatorSessionInput): Promise<CoordinatorResult<CoordinatorSessionReady>>;
  readActiveBranch(assistantSessionId: string): CoordinatorResult<CoordinatorHistorySnapshot>;
  isStreaming(assistantSessionId: string): CoordinatorResult<boolean>;
  /**
   * context、quote 与 text 属于同一次发送：上下文与引用先落入会话，再由正文触发本轮。
   * 二者都以用户数据进入模型上下文。
   */
  prompt(
    assistantSessionId: string, text: string, quote?: CoordinatorQuote, context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorRunResult>>;
  steer(
    assistantSessionId: string, text: string, quote?: CoordinatorQuote, context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>>;
  followUp(
    assistantSessionId: string, text: string, quote?: CoordinatorQuote, context?: CoordinatorSessionContext,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>>;
  abort(assistantSessionId: string): Promise<CoordinatorResult<CoordinatorActionAccepted>>;
  setModel(
    assistantSessionId: string,
    model: CoordinatorModelConfig,
    assertCurrent?: () => void,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>>;
  setThinkingLevel(
    assistantSessionId: string,
    level: CoordinatorThinkingLevel,
    assertCurrent?: () => void,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>>;
  subscribe(assistantSessionId: string, listener: CoordinatorEventListener): CoordinatorResult<() => void>;
  disposeSession(assistantSessionId: string): void;
  dispose(): void;
}
