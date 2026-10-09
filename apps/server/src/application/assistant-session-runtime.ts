import type { ImageService } from './image-service.js';
import type {
  AssistantContextRef, CoordinatorModelConfig, CoordinatorRuntimeConfig, CoordinatorSessionContext, WorkingDirectory,
} from '@multivac/contracts';
import type {
  CoordinatorAdapter,
  CoordinatorInternalTools,
  CoordinatorServerNotice,
} from '../runtime/executors/coordinator-adapter.js';
import type {
  AssistantPageStateRepository,
  AssistantSessionBindingRepository,
} from '../modules/sessions/assistant-session.js';
import type { AssistantCommandRepository, AssistantEventRepository } from '../modules/sessions/assistant-turn.js';
import type { ModelSelectionRecoveryRepository } from '../modules/sessions/model-selection-recovery.js';
import type { SessionSelectionRepository } from '../modules/sessions/session-model-selection.js';
import { AssistantEventProjector } from './assistant-event-projector.js';
import type { AssistantEventStream } from './assistant-event-stream.js';
import { AssistantOperationLock } from './assistant-operation-lock.js';
import { AssistantSessionService, AssistantSessionServiceError } from './assistant-session-service.js';
import { AssistantTurnCommandService, type QuoteSourceSession } from './assistant-turn-command-service.js';
import type { ModelAccessService } from './model-access-service.js';
import type { ModelSettingsService } from './model-settings-service.js';
import { SessionModelSelectionService } from './session-model-selection-service.js';
import type { SessionRuntime } from './session-runtimes.js';
import type { MessageFileSources } from './message-file-sources.js';

/** 所有会话共享的依赖：同一个 Pi 适配器、SQLite 仓储、公共事件流与模型配置。 */
export interface AssistantSessionRuntimeDependencies {
  stopExecution?: (sessionId: string, executionId: string) => Promise<void>;
  images?: ImageService;
  adapter: CoordinatorAdapter;
  bindingRepository: AssistantSessionBindingRepository;
  pageStateRepository: AssistantPageStateRepository;
  commandRepository: AssistantCommandRepository;
  eventRepository: AssistantEventRepository;
  selectionRepository: SessionSelectionRepository;
  eventStream: AssistantEventStream;
  modelSettingsService: ModelSettingsService;
  modelAccessService?: ModelAccessService;
  fileSources?: MessageFileSources;
}

export interface AssistantSessionRuntimeOptions {
  resolveBookQuote?: (quote: import('@multivac/contracts').AssistantBookQuote) => Promise<import('@multivac/contracts').CoordinatorBookQuote>;
  authorizeSend?: (command: import('@multivac/contracts').SendAssistantMessageCommand) => void;
  beforeSend?: () => void;
  sessionId: string;
  kind: 'coordinator' | 'work';
  runtimeConfig: CoordinatorRuntimeConfig;
  initialModel?: CoordinatorModelConfig;
  resolveNewSessionRuntimeConfig: () => Promise<CoordinatorRuntimeConfig>;
  /** 从会话记录读取工作目录（类型 + 路径）并确保其存在；每次创建或恢复 Pi 会话前调用。 */
  resolveWorkingDirectory: () => WorkingDirectory;
  sessionDir?: string;
  modelSelectionRecoveryRepository?: ModelSelectionRecoveryRepository;
  /** 解析发送时附带的上下文引用；未提供时该会话不接受上下文引用。 */
  resolveContext?: (refs: readonly AssistantContextRef[]) => Promise<CoordinatorSessionContext | undefined>;
  /** 读取跨会话引用的来源会话；未提供时该会话只接受同会话引用。 */
  resolveQuoteSource?: (sessionId: string) => Promise<QuoteSourceSession>;
  resolveFileQuote?: (quote: import('@multivac/contracts').AssistantFileQuote) => Promise<import('@multivac/contracts').CoordinatorFileQuote>;
  /** 会话首轮附带的上下文（栈式深入承接父会话背景）。 */
  resolveInitialContext?: () => Promise<CoordinatorSessionContext | undefined>;
  /** 服务端内部工具：按会话种类传入实际开放的集合。 */
  internalTools?: CoordinatorInternalTools;
  /** 待告诉模型的服务端通知（提议的处理结果）：只给全局 Multivac，在它开始新的一轮时随发送写入。 */
  takeServerNotice?: () => CoordinatorServerNotice | undefined;
}

/**
 * 单个会话的完整运行时：页面与历史读取、命令受理与对账、选模、Pi 事件投影。
 *
 * 每个会话持有自己的操作互斥区：发送 handoff 与选模只在同一会话内互斥，
 * 不同会话可以同时运行，一个会话的取消、失败或恢复不影响其他会话。
 */
export class AssistantSessionRuntime implements SessionRuntime {
  readonly sessionId: string;
  readonly session: AssistantSessionService;
  readonly commands: AssistantTurnCommandService;
  readonly selection: SessionModelSelectionService;
  private readonly projector: AssistantEventProjector;
  private readonly lock = new AssistantOperationLock();

  constructor(
    private readonly dependencies: AssistantSessionRuntimeDependencies,
    options: AssistantSessionRuntimeOptions,
  ) {
    this.sessionId = options.sessionId;
    const lock = this.lock;
    this.session = new AssistantSessionService({
      ...(dependencies.images ? { images: dependencies.images } : {}),
      adapter: dependencies.adapter,
      bindingRepository: dependencies.bindingRepository,
      pageStateRepository: dependencies.pageStateRepository,
      eventRepository: dependencies.eventRepository,
      // 工具执行记录按命令锚点回填到所属 Turn，分页读取需要同一份回执视图。
      commandRepository: dependencies.commandRepository,
      runtimeConfig: options.runtimeConfig,
      ...(options.initialModel ? { initialModel: options.initialModel } : {}),
      resolveWorkingDirectory: options.resolveWorkingDirectory,
      selectionRepository: dependencies.selectionRepository,
      assistantSessionId: options.sessionId,
      kind: options.kind,
      ...(dependencies.fileSources ? { fileSources: dependencies.fileSources } : {}),
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      ...(options.internalTools ? { internalTools: options.internalTools } : {}),
      ...(options.modelSelectionRecoveryRepository
        ? { modelSelectionRecoveryRepository: options.modelSelectionRecoveryRepository }
        : {}),
      resolveNewSessionRuntimeConfig: options.resolveNewSessionRuntimeConfig,
      // 首次成功初始化后才能中断上一进程遗留的回执并接入 Pi 事件；恢复按会话进行。
      onInitialized: () => {
        this.session.seedFileSources();
        this.commands.reconcileStartupReceipts();
        this.projector.start();
      },
    });
    this.commands = new AssistantTurnCommandService({
      ...(options.resolveBookQuote ? { resolveBookQuote: options.resolveBookQuote } : {}),
      ...(dependencies.images ? { images: dependencies.images } : {}),
      ...(options.authorizeSend ? { authorizeSend: options.authorizeSend } : {}),
      ...(options.resolveFileQuote ? { resolveFileQuote: options.resolveFileQuote } : {}),
      ...(dependencies.stopExecution ? { stopExecution: dependencies.stopExecution } : {}),
      sessionService: this.session,
      adapter: dependencies.adapter,
      commandRepository: dependencies.commandRepository,
      eventStream: dependencies.eventStream,
      assistantSessionId: options.sessionId,
      operationLock: lock,
      validateSelectionForSend: () => { options.beforeSend?.(); return this.selection.validateForSend(); },
      withSelectionForSend: (dispatch) => this.selection.withSelectionForSend(() => { options.beforeSend?.(); return dispatch(); }),
      ...(options.resolveContext ? { resolveContext: options.resolveContext } : {}),
      ...(options.resolveQuoteSource ? { resolveQuoteSource: options.resolveQuoteSource } : {}),
      ...(options.resolveInitialContext ? { resolveInitialContext: options.resolveInitialContext } : {}),
      ...(options.takeServerNotice ? { takeServerNotice: options.takeServerNotice } : {}),
    });
    this.selection = new SessionModelSelectionService({
      adapter: dependencies.adapter,
      ...(dependencies.stopExecution ? { stopExecution: dependencies.stopExecution } : {}),
      sessionService: this.session,
      repository: dependencies.selectionRepository,
      settings: dependencies.modelSettingsService,
      ...(dependencies.modelAccessService ? { access: dependencies.modelAccessService } : {}),
      lock,
      sessionId: options.sessionId,
      isRunning: () => this.commands.isRunning(),
    });
    this.projector = new AssistantEventProjector({
      adapter: dependencies.adapter,
      eventRepository: dependencies.eventRepository,
      eventStream: dependencies.eventStream,
      assistantSessionId: options.sessionId,
      currentPromptCommandId: () => this.commands.currentPromptCommandId(),
      onHistoryChanged: () => this.session.captureFileSources(),
    });
  }

  initialize(): Promise<unknown> {
    return this.session.initialize();
  }

  isRunning(): boolean {
    return this.commands.isRunning();
  }

  /**
   * 在本会话的互斥区内执行改变执行环境的最后一个操作（归入项目换工作目录）：
   * 先等排在前面的发送 handoff 与选模完成、进行中的初始化落定，再同步执行 operation。
   * 成功后互斥区关闭，排在后面的发送与选模一律拒绝（没有建立回执，可以重试到新的运行时上）；
   * 调用方在 operation 中释放本运行时。operation 抛错时互斥区照常可用。
   */
  retire<T>(operation: () => T): Promise<T> {
    return this.lock.runFinal(async () => {
      await this.session.settleInitialization();
      return operation();
    }, () => new AssistantSessionServiceError(
      'COMMAND_STATE_MISMATCH',
      '会话刚刚更换了工作目录，这次操作没有执行，请重试。',
    ));
  }

  /** 关闭事件投影并释放该会话的 Pi session；不影响其他会话。 */
  dispose(): void {
    this.session.close();
    this.projector.close();
    this.dependencies.adapter.disposeSession(this.sessionId);
  }
}
