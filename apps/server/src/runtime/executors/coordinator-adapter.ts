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
  WorkingDirectory,
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
  /**
   * 会话工作目录（类型 + 绝对路径），取自 Multivac 会话记录；工具、设置与会话运行时都以它的路径为 cwd，
   * 文件工具的目录边界也以它为准。每次创建或恢复都由调用方传入，适配器不保存共享 cwd，
   * 也不使用服务进程的启动目录。
   */
  workingDirectory: WorkingDirectory;
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
  /** 会话工作目录，取自 Multivac 会话记录；恢复时覆盖 Pi 会话头中的 cwd，不读取会话头。 */
  workingDirectory: WorkingDirectory;
  /** Pi session 文件目录；缺省使用适配器的默认目录（全局协调会话）。 */
  sessionDir?: string;
  /** 从应用层已有 cursor 恢复时，对应下一条公共事件之前的 sequence。 */
  initialEventSequence?: number;
}

/** 按目标路径判定目录边界的文件工具。 */
export type CoordinatorPathToolName = 'read' | 'edit' | 'write';

/**
 * 文件工具访问会话工作目录之外的路径时发出的授权请求。工作目录内的访问不产生请求；
 * bash 以工作目录为 cwd 执行，不做命令分级，也不产生请求。
 */
export interface CoordinatorToolAuthorizationRequest {
  assistantSessionId: string;
  toolName: CoordinatorPathToolName;
  /** Pi 工具调用 id，与运行轨迹中的工具记录对应。 */
  toolCallId: string;
  /** Agent 在工具参数中给出的原始路径。 */
  requestedPath: string;
  /** 解析后的真实绝对路径：已展开 `~`、消去 `..`、跟随符号链接（目标不存在时沿最近的已存在祖先解析）。 */
  targetPath: string;
  /** 构建该会话运行时所用的工作目录记录（类型 + 路径）。 */
  workingDirectory: WorkingDirectory;
}

/**
 * 拒绝原因会作为工具错误结果回传 Agent。endTurn 表示本轮随之结束（授权等待超时）：
 * 该调用以拒绝原因结束后，适配器中止本轮，Agent 不再继续；缺省时本轮继续，由 Agent 回应拒绝。
 */
export type CoordinatorToolAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: string; endTurn?: boolean };

/**
 * 目录外访问的授权决定。在 Pi 执行工具之前调用，等待期间本轮 Turn 保持运行；
 * signal 是本轮的中止信号，取消本轮时被中止，实现应随之尽快结束等待。
 * 抛错或 signal 已中止时，该次调用一律不执行。
 */
export type CoordinatorToolAuthorizer = (
  request: CoordinatorToolAuthorizationRequest,
  signal: AbortSignal,
) => Promise<CoordinatorToolAuthorizationDecision>;

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
  /** 只读 Pi transcript 中的模型选择；cwd 为会话记录中的工作目录，打开会话时不读取会话头。 */
  readPersistedModelSelection(identity: CoordinatorSessionRecoveryIdentity, cwd: string): CoordinatorResult<{
    provider: string; modelId: string; thinkingLevel: CoordinatorThinkingLevel;
  } | null>;
  createSession(input: CreateCoordinatorSessionInput): Promise<CoordinatorResult<CoordinatorSessionReady>>;
  /**
   * 只供全局 Multivac 在尚无绑定时使用：接续其 Pi session 目录中最近的 session。
   * 工作会话总是 createSession 新建、continueSession 按绑定恢复，不走这条路径。
   */
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
