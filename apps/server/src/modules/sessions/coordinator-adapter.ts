import type {
  AssistantMessageView,
  CoordinatorActionAccepted,
  CoordinatorEventListener,
  CoordinatorHarnessId,
  CoordinatorModelConfig,
  CoordinatorModelUpdate,
  CoordinatorQuote,
  CoordinatorResult,
  CoordinatorRunResult,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
  CoordinatorSessionContext,
  CoordinatorSessionReady,
  CoordinatorSkill,
  CoordinatorThinkingLevel,
  WorkingDirectory,
} from '@multivac/contracts';
import type { InternalToolOutcome, InternalToolSpec } from '../internal-tools/internal-tool.js';
import type { SkillSource } from '../skills/skill-source.js';

/**
 * 会话内部工具（端口视图）：工具说明与统一的调用入口。
 * 按会话种类随创建 / 恢复传入；适配器把它们注入 Pi（customTools），
 * 在目录边界中按效果类别声明规则，调用一律经 invoke 进入服务端注册表。
 */
export interface CoordinatorInternalTools {
  readonly specs: readonly InternalToolSpec[];
  /** 参数校验（与 invoke 同一规则）；失败原因是模型可读的中文，调用不会执行。 */
  validate(toolName: string, args: unknown): { ok: true; value: unknown } | { ok: false; reason: string };
  /**
   * 执行一次调用：校验参数、按 toolCallId 幂等（有副作用的调用重放时返回原结果，不重复执行），
   * 再交给工具的执行函数。不会抛错，失败以 { ok: false, reason } 返回。
   */
  invoke(invocation: CoordinatorInternalToolInvocation, signal: AbortSignal): Promise<InternalToolOutcome>;
}

export interface CoordinatorInternalToolInvocation {
  assistantSessionId: string;
  toolName: string;
  /** Pi 工具调用 id，与运行轨迹中的工具记录对应；幂等命令 id 由它派生。 */
  toolCallId: string;
  args: unknown;
}

/**
 * 服务端通知：由服务端生成、随下一轮发送进入模型上下文的系统侧信息（目前是提议的处理结果）。
 * 它不来自用户输入、引用或工具返回；适配器把它作为这一轮最先落入会话的一条不显示的消息，
 * 正文以 `SERVER_NOTICE_MARKER` 开头，系统提示词写明只有这样的消息才是真实结果。
 */
export interface CoordinatorServerNotice {
  text: string;
  /** 通知涉及的提议，写进会话记录便于追溯。 */
  proposalIds: readonly string[];
}

/** 执行器会话的身份：所属 harness 与它解释的会话 id、会话引用。 */
export interface CoordinatorSessionRecoveryIdentity {
  harness: CoordinatorHarnessId;
  runtimeSessionId: string;
  runtimeSessionRef: string;
}

export interface CoordinatorModelSelectionRecoveryInput extends CoordinatorSessionRecoveryIdentity {
  model: CoordinatorModelConfig;
}

export interface CreateCoordinatorSessionInput {
  assistantSessionId: string;
  config: CoordinatorRuntimeConfig;
  /**
   * 会话工作目录（类型 + 绝对路径），取自 Multivac 会话记录；工具、设置与会话运行时都以它的路径为 cwd，
   * 相对文件路径也以它为准；普通项目文件范围另按当前服务端记录判定。每次创建或恢复都由调用方传入，适配器不保存共享 cwd，
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
  /** 本会话实际开放的内部工具；未注入的工具不可调用。 */
  internalTools?: CoordinatorInternalTools;
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
  /** 本会话的内部工具；恢复时与新建时注入同一组。 */
  internalTools?: CoordinatorInternalTools;
}

/** 按目标路径判定目录边界的文件工具。 */
export type CoordinatorPathToolName = 'read' | 'edit' | 'write';

/**
 * 文件工具超出 cwd 和当前项目文件范围时发出的授权请求，有效独立授权仍由授权服务判定；
 * bash 默认使用会话 cwd，单次可选目录由启动入口按当前范围校验；不做命令分级，也不产生范围外执行授权请求。
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

/** 当前文件目录范围的服务端来源；不得接收模型声明的项目或目录。 */
export type CoordinatorProjectFileScope = (sessionId: string, runtimeDirectory: WorkingDirectory) => readonly string[];

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
  /** 仅供内部续读核对分支前缀，不向模型公开底层 entry 标识。 */
  branchEntryIds?: readonly string[];
  runtimeSessionId: string;
  leafEntryId: string | null;
  messages: AssistantMessageView[];
}

export interface CoordinatorSelectionSnapshot {
  /** 展示校验输入的版本；缺少该能力时展示不复用检查。仅适配层内部使用。 */
  inspectionVersion?: string;
  runtimeSessionId: string;
  runtimeSessionRef: string;
  model: CoordinatorModelConfig;
  availableThinkingLevels: CoordinatorThinkingLevel[];
  /** live 与 Pi transcript 均一致才可向上层确认成功。 */
  durable: boolean;
}

/**
 * 上层只依赖该端口；Pi 的 Session、Message、Event 和 Model 类型不得越过此边界。
 */
export interface CoordinatorTurnPreparation {
  model: CoordinatorModelConfig;
  activate(): void;
  restore(): void;
}

/**
 * 执行器的能力声明。上层据此明确拒绝或降级，不以某个方法是否存在推断能力；
 * 不支持的能力对应的方法仍须实现，并返回失败或 false。
 */
export interface CoordinatorCapabilities {
  /** 单轮临时执行配置（工作会话单轮调用智能体），见 prepareTurnExecution。 */
  readonly turnExecution: boolean;
  /** 可能接受图片输入；具体会话仍须由 supportsImageInput 按实际模型确认。 */
  readonly imageInput: boolean;
  /** 运行中引导与排队追加（steer / followUp）。 */
  readonly steering: boolean;
  /** 能证明任务执行工具已停止；不能证明时停止确认保持未完成。 */
  readonly toolStopProof: boolean;
  /** 能把 Skill 交给 Agent（见 bindSkills）；不支持时会话中没有 Skill 工具。 */
  readonly skills: boolean;
}

/** 任务执行工具的额度租约：工具副作用前登记、真实结束后结算，返回剩余字节；租约失效时抛错。 */
export type CoordinatorTaskLease = (sessionId: string, phase: 'starting' | 'settled', marker: string, bytes: number) => number;

export interface CoordinatorAdapter {
  /** 执行器标识。创建的绑定带上它；续接与读取持久历史只接受同一 harness 的身份，其他身份以 SESSION_BINDING_MISMATCH 拒绝。 */
  readonly harness: CoordinatorHarnessId;
  readonly capabilities: CoordinatorCapabilities;
  /** 执行器自身的内部目录（凭据、会话文件等）；任务目录、Git 通道与托管进程不得触及。 */
  readonly protectedPaths: readonly string[];
  /** 装配时接入任务执行额度租约，只调用一次；未接入时任务工具拒绝执行。 */
  bindTaskLease(lease: CoordinatorTaskLease): void;
  /** 装配时接入 Skill 来源，之后新建或恢复的会话按它装载 Skill；capabilities.skills 为 false 时忽略。 */
  bindSkills(source: SkillSource): void;
  /** 准备本轮临时配置，不写永久选模；activate/restore 均同步并在同一运行中配对。不支持时返回失败。 */
  prepareTurnExecution(sessionId: string, model: CoordinatorModelConfig, instructions: string): Promise<CoordinatorResult<CoordinatorTurnPreparation>>;
  /** 当前会话的实际模型是否接受图片；未打开或不支持时为 false。 */
  supportsImageInput(sessionId: string): boolean;
  /** 历史消息中由执行器保存的图片内容；不支持或不存在时返回空列表。 */
  readImageContents(sessionId: string, entryId: string): readonly CoordinatorImage[];
  /** 任务执行工具及其进程是否已证明停止；无法证明时为 false。 */
  taskToolsStopped(sessionId: string): boolean;
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
  /**
   * 只读 Pi transcript 中 active branch 的可见消息（与 readActiveBranch 同一投影：只有用户与助手正文），
   * 不打开会话、不建立运行时，也不写任何文件；供读取未打开或已归档会话的最近内容。
   * cwd 为会话记录中的工作目录，不读取会话头。
   */
  readPersistedHistory(identity: CoordinatorSessionRecoveryIdentity, cwd: string): CoordinatorResult<CoordinatorHistorySnapshot>;
  isStreaming(assistantSessionId: string): CoordinatorResult<boolean>;
  /**
   * context、quote 与 text 属于同一次发送：上下文与引用先落入会话，再由正文触发本轮。
   * 二者都以用户数据进入模型上下文。notice 是服务端通知（提议的结果），在它们之前落入会话。
   * skill 是用户明确选择的 Skill 正文，同样以用户数据落在引用之前，正文只保留本次请求。
   */
  prompt(
    assistantSessionId: string, text: string, quote?: CoordinatorQuote, context?: CoordinatorSessionContext,
    notice?: CoordinatorServerNotice,
    images?: readonly CoordinatorImage[],
    skill?: CoordinatorSkill,
  ): Promise<CoordinatorResult<CoordinatorRunResult>>;
  steer(
    assistantSessionId: string, text: string, quote?: CoordinatorQuote, context?: CoordinatorSessionContext,
    images?: readonly CoordinatorImage[],
    skill?: CoordinatorSkill,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>>;
  followUp(
    assistantSessionId: string, text: string, quote?: CoordinatorQuote, context?: CoordinatorSessionContext,
    images?: readonly CoordinatorImage[],
    skill?: CoordinatorSkill,
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

/** 图片数据仅在服务端资源读取到 Pi 的边界内存在，不进入公共事件。 */
export interface CoordinatorImage { id: string; mimeType: string; data: string }
