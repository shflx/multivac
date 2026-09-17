import type {
  AssistantMessageView,
  CoordinatorActionAccepted,
  CoordinatorEventListener,
  CoordinatorModelConfig,
  CoordinatorModelUpdate,
  CoordinatorResult,
  CoordinatorRunResult,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
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
}

export interface ContinueCoordinatorSessionInput {
  binding: CoordinatorSessionBinding;
  config: CoordinatorRuntimeConfig;
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
  prompt(assistantSessionId: string, text: string): Promise<CoordinatorResult<CoordinatorRunResult>>;
  steer(assistantSessionId: string, text: string): Promise<CoordinatorResult<CoordinatorActionAccepted>>;
  followUp(assistantSessionId: string, text: string): Promise<CoordinatorResult<CoordinatorActionAccepted>>;
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
