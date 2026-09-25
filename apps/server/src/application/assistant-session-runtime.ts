import type { AssistantContextRef, CoordinatorRuntimeConfig, CoordinatorSessionContext } from '@multivac/contracts';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';
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
import { AssistantSessionService } from './assistant-session-service.js';
import { AssistantTurnCommandService } from './assistant-turn-command-service.js';
import type { ModelAccessService } from './model-access-service.js';
import type { ModelSettingsService } from './model-settings-service.js';
import { SessionModelSelectionService } from './session-model-selection-service.js';
import type { SessionRuntime } from './session-runtimes.js';

/** 所有会话共享的依赖：同一个 Pi 适配器、SQLite 仓储、公共事件流与模型配置。 */
export interface AssistantSessionRuntimeDependencies {
  adapter: CoordinatorAdapter;
  bindingRepository: AssistantSessionBindingRepository;
  pageStateRepository: AssistantPageStateRepository;
  commandRepository: AssistantCommandRepository;
  eventRepository: AssistantEventRepository;
  selectionRepository: SessionSelectionRepository;
  eventStream: AssistantEventStream;
  modelSettingsService: ModelSettingsService;
  modelAccessService?: ModelAccessService;
}

export interface AssistantSessionRuntimeOptions {
  sessionId: string;
  kind: 'coordinator' | 'work';
  runtimeConfig: CoordinatorRuntimeConfig;
  resolveNewSessionRuntimeConfig: () => Promise<CoordinatorRuntimeConfig>;
  sessionDir?: string;
  modelSelectionRecoveryRepository?: ModelSelectionRecoveryRepository;
  /** 解析发送时附带的上下文引用；未提供时该会话不接受上下文引用。 */
  resolveContext?: (refs: readonly AssistantContextRef[]) => Promise<CoordinatorSessionContext | undefined>;
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

  constructor(
    private readonly dependencies: AssistantSessionRuntimeDependencies,
    options: AssistantSessionRuntimeOptions,
  ) {
    this.sessionId = options.sessionId;
    const lock = new AssistantOperationLock();
    this.session = new AssistantSessionService({
      adapter: dependencies.adapter,
      bindingRepository: dependencies.bindingRepository,
      pageStateRepository: dependencies.pageStateRepository,
      eventRepository: dependencies.eventRepository,
      // 工具执行记录按命令锚点回填到所属 Turn，分页读取需要同一份回执视图。
      commandRepository: dependencies.commandRepository,
      runtimeConfig: options.runtimeConfig,
      selectionRepository: dependencies.selectionRepository,
      assistantSessionId: options.sessionId,
      kind: options.kind,
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      ...(options.modelSelectionRecoveryRepository
        ? { modelSelectionRecoveryRepository: options.modelSelectionRecoveryRepository }
        : {}),
      resolveNewSessionRuntimeConfig: options.resolveNewSessionRuntimeConfig,
      // 首次成功初始化后才能中断上一进程遗留的回执并接入 Pi 事件；恢复按会话进行。
      onInitialized: () => {
        this.commands.reconcileStartupReceipts();
        this.projector.start();
      },
    });
    this.commands = new AssistantTurnCommandService({
      sessionService: this.session,
      adapter: dependencies.adapter,
      commandRepository: dependencies.commandRepository,
      eventStream: dependencies.eventStream,
      assistantSessionId: options.sessionId,
      operationLock: lock,
      validateSelectionForSend: () => this.selection.validateForSend(),
      withSelectionForSend: (dispatch) => this.selection.withSelectionForSend(dispatch),
      ...(options.resolveContext ? { resolveContext: options.resolveContext } : {}),
    });
    this.selection = new SessionModelSelectionService({
      adapter: dependencies.adapter,
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
    });
  }

  initialize(): Promise<unknown> {
    return this.session.initialize();
  }

  isRunning(): boolean {
    return this.commands.isRunning();
  }

  /** 关闭事件投影并释放该会话的 Pi session；不影响其他会话。 */
  dispose(): void {
    this.projector.close();
    this.dependencies.adapter.disposeSession(this.sessionId);
  }
}
