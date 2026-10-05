import {
  assistantToolDisplayName,
  internalToolDisplay,
  type AssistantToolObjectRef,
  type CurrentViewSnapshot,
  type WindowNavigationTarget,
  type WorkbenchChangeOrigin,
} from '@multivac/contracts';
import type { Static, TSchema } from 'typebox';
import {
  internalToolArgumentsFingerprint,
  internalToolCommandId,
  InternalToolError,
  RESERVED_TOOL_NAMES,
  validateInternalToolArguments,
  type InternalToolCallRecord,
  type InternalToolCallRepository,
  type InternalToolEffect,
  type InternalToolOutcome,
  type InternalToolSpec,
  type InternalToolSuccess,
} from '../../modules/internal-tools/internal-tool.js';
import type {
  CoordinatorInternalToolInvocation,
  CoordinatorInternalTools,
} from '../../runtime/executors/coordinator-adapter.js';
import type { ProjectService } from '../project-service.js';
import type { TaskService } from '../task-service.js';
import type { HumanRequestService } from '../human-request-service.js';
import type { ArtifactService } from '../artifact-service.js';
import type { SessionTranscriptReader } from '../session-transcripts.js';
import type { WorkspaceSessionService } from '../workspace-session-service.js';

/**
 * 内部工具可以使用的服务端能力。只放按需收窄的接口（Pick 现有服务的方法），与界面操作走同一套服务与校验；
 * 不得放入任何扩大权限的方法（新建项目、挂载 / 卸载目录、设主目录、归入项目、授权决定与记住的授权）——
 * 这些只能由用户在界面的确认卡上确认后经对应接口完成。
 */
export interface InternalToolServices {
  reading?: Pick<import('../reading-service.js').ReadingService, 'list' | 'index' | 'position'>;
  tasks?: Pick<TaskService, 'list' | 'detail' | 'get' | 'relations' | 'groups'>;
  taskManagement?: Pick<TaskService, 'create' | 'update' | 'remove' | 'createGroup'>;
  taskRequestManagement?: Pick<HumanRequestService, 'page' | 'get' | 'respond'>;
  taskArtifactManagement?: Pick<ArtifactService, 'list' | 'read' | 'submit'>;
  humanTaskCompletion?: Pick<TaskService, 'confirmHumanCompletion'>;
  taskCompletion?: Pick<HumanRequestService, 'completeSession'>;
  taskControl?: Pick<import('../task-execution-service.js').TaskExecutionService, 'control'>;
  taskRequests?: Pick<HumanRequestService, 'askSession'>;
  taskArtifacts?: Pick<ArtifactService, 'registerSession'>;
  /**
   * 项目：查询，以及不扩大权限的管理动作（只改名、只改默认约束的收窄方法）。
   * 能修改目录的更新（updateProject）与新建项目属于扩大权限，不在这里，只能经提议由用户确认。
   */
  projects: Pick<ProjectService, 'listWorkspaces' | 'listProjects' | 'renameProject' | 'setDefaultConstraints'>;
  /**
   * 工作会话：查询，以及不扩大权限、可以撤回的管理动作（新建、改名、归档前的核对、归档、恢复）。
   * 归入项目（moveToProject）改变会话的工作目录，属于扩大权限，不在这里。
   */
  sessions: Pick<
    WorkspaceSessionService,
    | 'list' | 'get' | 'isRunning' | 'getScene' | 'presentedScene' | 'changeScene'
    | 'create' | 'rename' | 'previewArchive' | 'archive' | 'restore'
  >;
  /** 只读读取工作会话的可见消息（不打开会话、不建立运行时）。 */
  transcripts: Pick<SessionTranscriptReader, 'readMessages'>;
  /** 切换发起窗口的界面（只推给这个窗口的导航指令）。 */
  windows: WindowNavigator;
}

/**
 * 只作用于发起对话的窗口的导航：切到工作区面板与某个工作区、打开管理中的某一页。
 * 只推给这个窗口，其他窗口收不到；窗口没有连着工作台事件流（已关闭、刷新后换了窗口 id）时不推送，返回 false，
 * 不会改为广播。导航不改变任何数据，现场的变化由会话服务保存并照常推给各窗口。
 */
export interface WindowNavigator {
  navigate(windowId: string, target: WindowNavigationTarget, origin: WorkbenchChangeOrigin): boolean;
  /** 这个窗口是否还连着（界面是否还打开着）。 */
  isOpen(windowId: string): boolean;
}

/** 一次调用的上下文：执行函数从这里拿服务与调用身份。 */
export interface InternalToolCallContext {
  /** 发起调用的会话（全局 Multivac 或工作会话）。 */
  sessionId: string;
  toolCallId: string;
  /**
   * 由会话与 toolCallId 派生的幂等命令 id。有副作用的服务调用以它去重（例如作为新建会话的客户端 id），
   * 同一次调用重放时不重复产生副作用。
   */
  commandId: string;
  /**
   * 发起这次调用的那一轮：全局 Multivac 当前发送命令的 id（与回执、运行轨迹的 commandId 一致）；
   * 不在一轮之中时为 null。
   */
  turnCommandId: string | null;
  /**
   * 发出这一轮消息的浏览器窗口（发送请求携带的窗口 id）；不在一轮之中或发送时没有窗口身份时为 null。
   * 只作用于发起窗口的改动（如切换页面的导航）按它投递。
   */
  originWindowId: string | null;
  /**
   * 这次调用引起的变更的来源（`{ windowId: originWindowId, commandId: turnCommandId }`）。
   * 调用服务的写方法时原样传入，服务发布的工作台变更事件据此注明是 Multivac 在哪一轮、为哪个窗口所做；
   * 各窗口（包括发起窗口）都会应用这类变更。
   */
  origin: WorkbenchChangeOrigin;
  /**
   * 发起窗口在发送这一轮消息（或在这一轮中追加消息）时的当前视图：面板、当前工作区与栏位、管理页与选中对象，
   * 只含 id。不在一轮之中、或发送时没有带视图（例如不是从界面发出的消息）时为 null，不能据此猜测。
   */
  originView: CurrentViewSnapshot | null;
  /**
   * 记下这一轮中发起窗口的界面已被切换（导航成功、或改了它正在看的工作区的现场）：本轮之后的工具调用以它为当前视图，
   * 而不是发送时的旧快照。只作用于这一轮；用户在这一轮中从同一窗口追加消息时，以追加时带来的快照为准。
   */
  noteOriginView(view: CurrentViewSnapshot): void;
  services: InternalToolServices;
  /** 本轮的中止信号；停止本轮时中止，长时间的操作应随之结束。 */
  signal: AbortSignal;
}

/**
 * 提议类工具生成的提议：确认之前不执行任何操作。kind 是注册的提议种类（见 `application/proposals`），
 * payload 是参数快照，按该种类的 schema 校验。
 */
export interface InternalToolProposal {
  kind: string;
  payload: unknown;
}

/** 提议的来源：哪个会话、哪次工具调用、哪一轮、哪个窗口。 */
export type InternalToolProposalOrigin =
  Pick<InternalToolCallContext, 'sessionId' | 'toolCallId' | 'commandId' | 'turnCommandId' | 'originWindowId'>;

/** 提出的结果：生成的待确认提议（卡片标题、提出时核对不通过的原因）与涉及的对象。 */
export interface ProposalSubmission {
  proposalId: string;
  title: string;
  /** 可以提出、但目前不能执行的原因（卡片写明，不能确认）；可以执行时为 null。 */
  problem: string | null;
  refs: AssistantToolObjectRef[];
}

/**
 * 提议的去处（对话内确认卡，`ProposalService`）；未接入时提议类工具明确报告“尚不支持”，不执行任何操作。
 * 它只能生成待确认的提议：确认与取消只经界面（HTTP 接口）由用户发起，不在这里，也不在任何工具能拿到的服务中。
 */
export interface InternalToolProposalSink {
  submit(proposal: InternalToolProposal, origin: InternalToolProposalOrigin): Promise<ProposalSubmission>;
}

/** 提议类工具的上下文：除只读服务外，只能经 propose 生成提议。 */
export interface InternalToolProposeContext extends InternalToolCallContext {
  propose(proposal: InternalToolProposal): Promise<ProposalSubmission>;
}

/** 服务端给出的原因可能不以句号结尾（例如以路径结尾）：补上句号再接下一句。 */
function sentence(text: string): string {
  return /[。！？.!?]$/u.test(text) ? text : `${text}。`;
}

/**
 * 提议类工具的统一返回：告诉模型已提出、等待用户确认（不要说已经完成），结果会在下一轮由服务端通知；
 * 提出时核对不通过的，说明卡片上写明了原因、用户只能取消。
 */
export function proposedToolResult(submission: ProposalSubmission): InternalToolSuccess {
  if (submission.problem) {
    return {
      content: `已提出「${submission.title}」（提议 ${submission.proposalId}），但目前不能执行：${sentence(submission.problem)}` +
        '对话中的确认卡已写明原因，用户只能取消；请把原因告诉用户，不要说已经完成。',
      result: { summary: '已提出，但目前不能执行', refs: submission.refs },
    };
  }
  return {
    content: `已提出「${submission.title}」（提议 ${submission.proposalId}），等待用户在对话中的确认卡上确认；` +
      '确认之前没有执行任何操作，不要说已经完成。用户确认或取消后，结果会在下一轮开始时由 Multivac 服务端通知你。',
    result: { summary: '已提出，等待你确认', refs: submission.refs },
  };
}

interface InternalToolDefinitionBase<TParams extends TSchema> {
  /** 工具名：小写字母开头，只含小写字母、数字与下划线；展示口径登记在契约 INTERNAL_TOOL_DISPLAY。 */
  name: string;
  /** 给模型的中文说明：能做什么、何时使用、返回什么。 */
  description: string;
  parameters: TParams;
  /**
   * 会改变用户正在看的界面（切换页面、工作区或工作区的布局）：提示词据此写明只在用户明确要求
   * “打开 / 切到 / 放到”时调用（工具本身不判断意图）。
   */
  changesView?: boolean;
}

/**
 * 内部工具定义。执行函数成功时返回给模型的中文正文与公开的结果（摘要与对象），
 * 可预期的失败抛出 InternalToolError（模型可读的中文原因）。
 */
export type InternalToolDefinition<TParams extends TSchema = TSchema> =
  | (InternalToolDefinitionBase<TParams> & {
      effect: 'query' | 'manage';
      execute(params: Static<TParams>, context: InternalToolCallContext): Promise<InternalToolSuccess>;
    })
  | (InternalToolDefinitionBase<TParams> & {
      /** 扩大权限的操作：执行函数只能经 context.propose 生成提议，不能直接执行。 */
      effect: 'propose';
      execute(params: Static<TParams>, context: InternalToolProposeContext): Promise<InternalToolSuccess>;
    });

/** 保留参数类型推断的定义辅助函数（用法同 Pi 的 defineTool）。 */
export function defineInternalTool<TParams extends TSchema>(
  definition: InternalToolDefinition<TParams>,
): InternalToolDefinition {
  return definition as unknown as InternalToolDefinition;
}

export interface InternalToolServiceOptions {
  tools: readonly InternalToolDefinition[];
  services: InternalToolServices;
  /** 有副作用的调用账本（manage / propose）。 */
  calls: InternalToolCallRepository;
  /** 会话当前这一轮：发送命令的 id、发出消息的窗口与它的当前视图；不在一轮之中时为 null。 */
  currentTurn: (sessionId: string) => InternalToolTurn | null;
  /** 对话内确认卡；未接入时提议类工具报告尚不支持。 */
  proposals?: InternalToolProposalSink;
  now?: () => Date;
}

/** 发起调用的那一轮：发送命令、发出消息的窗口，以及该窗口发送时的当前视图（可以缺省为没有）。 */
export interface InternalToolTurn {
  commandId: string;
  windowId: string | null;
  view?: CurrentViewSnapshot | null;
  /** 更新这一轮的当前视图（导航之后）；没有提供时导航不影响本轮之后的工具看到的视图。 */
  updateView?: (view: CurrentViewSnapshot) => void;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const EFFECTS: readonly InternalToolEffect[] = ['query', 'manage', 'propose'];

/** 注册时发现的定义错误属于程序错误，启动即失败。 */
function assertDefinitions(tools: readonly InternalToolDefinition[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`内部工具名 ${tool.name} 不合法。`);
    if (RESERVED_TOOL_NAMES.includes(tool.name)) throw new Error(`内部工具 ${tool.name} 与 Pi 内置工具重名。`);
    if (names.has(tool.name)) throw new Error(`内部工具 ${tool.name} 重复注册。`);
    if (!EFFECTS.includes(tool.effect)) throw new Error(`内部工具 ${tool.name} 的效果类别不合法。`);
    if (!internalToolDisplay(tool.name)) throw new Error(`内部工具 ${tool.name} 没有在契约中登记展示口径。`);
    if (!tool.description.trim()) throw new Error(`内部工具 ${tool.name} 缺少说明。`);
    names.add(tool.name);
  }
}

/**
 * 全局 Multivac 内部工具的注册表与统一调用入口（实现适配器端口 CoordinatorInternalTools）。
 *
 * 一次调用依次经过：按名称找到工具 → 按 schema 校验参数 → 幂等（manage / propose）→ 执行函数 → 统一结果。
 * 幂等：由会话与 toolCallId 派生命令 id，先在账本写入 running 再执行、结束时写入结果。同一调用再次到达时
 * 只读账本：已结束的原样返回原结果；本进程中仍在执行的等待同一结果；上一进程中开始、结果未知的不再执行，
 * 说明结果未知（与命令回执的恢复约束一致：恢复只读对账，不重新发起）。查询没有副作用，不记账本。
 */
export class InternalToolService implements CoordinatorInternalTools {
  readonly specs: readonly InternalToolSpec[];
  private readonly tools: ReadonlyMap<string, InternalToolDefinition>;
  private readonly inFlight = new Map<string, Promise<InternalToolOutcome>>();
  private readonly now: () => Date;

  constructor(private readonly options: InternalToolServiceOptions) {
    assertDefinitions(options.tools);
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.specs = options.tools.map(({ name, description, parameters, effect, changesView }) =>
      ({ name, description, parameters, effect, ...(changesView ? { changesView } : {}) }));
    this.now = options.now ?? (() => new Date());
  }

  validate(toolName: string, args: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
    const tool = this.tools.get(toolName);
    if (!tool) return { ok: false, reason: `没有名为 ${toolName} 的内部工具，调用没有执行。` };
    return validateInternalToolArguments(toolName, tool.parameters, args);
  }

  async invoke(invocation: CoordinatorInternalToolInvocation, signal: AbortSignal): Promise<InternalToolOutcome> {
    const checked = this.validate(invocation.toolName, invocation.args);
    if (!checked.ok) return checked;
    const tool = this.tools.get(invocation.toolName)!;
    if (signal.aborted) return { ok: false, reason: '本轮已停止，调用没有执行。' };

    const commandId = internalToolCommandId(invocation.assistantSessionId, invocation.toolCallId);
    const turn = this.options.currentTurn(invocation.assistantSessionId);
    const turnCommandId = turn?.commandId ?? null;
    const originWindowId = turn?.windowId ?? null;
    const context: InternalToolCallContext = {
      sessionId: invocation.assistantSessionId,
      toolCallId: invocation.toolCallId,
      commandId,
      turnCommandId,
      originWindowId,
      origin: { windowId: originWindowId, commandId: turnCommandId },
      originView: turn?.view ?? null,
      noteOriginView: (view) => turn?.updateView?.(view),
      services: this.options.services,
      signal,
    };
    if (tool.effect === 'query') return this.execute(tool, checked.value, context);

    // 从这里到登记进行中的调用之间没有 await：同一调用的并发重放一定能看到彼此。
    const running = this.inFlight.get(commandId);
    if (running) return running;
    const fingerprint = internalToolArgumentsFingerprint(checked.value);
    let begun: ReturnType<InternalToolCallRepository['begin']>;
    try {
      begun = this.options.calls.begin({
        commandId,
        sessionId: invocation.assistantSessionId,
        toolCallId: invocation.toolCallId,
        toolName: tool.name,
        effect: tool.effect,
        argumentsFingerprint: fingerprint,
        createdAt: this.now().toISOString(),
      });
    } catch {
      // 账本写不进去就不执行：没有记录的副作用无法在重放时识别。
      return { ok: false, reason: `${assistantToolDisplayName(tool.name)}没有执行：调用记录无法保存，请稍后重试。` };
    }
    if (!begun.inserted) return replayedOutcome(begun.record, tool.name, fingerprint);

    const outcome = this.execute(tool, checked.value, context).then((result) => {
      try {
        this.options.calls.finish(commandId, result, this.now().toISOString());
      } catch {
        // 结果没能写入时记录停在进行中：之后的重放按“结果未知”处理，同样不会重复执行。
      }
      return result;
    }).finally(() => this.inFlight.delete(commandId));
    this.inFlight.set(commandId, outcome);
    return outcome;
  }

  private async execute(
    tool: InternalToolDefinition,
    params: unknown,
    context: InternalToolCallContext,
  ): Promise<InternalToolOutcome> {
    try {
      const success = tool.effect === 'propose'
        ? await tool.execute(params as never, { ...context, propose: (proposal) => this.propose(proposal, context) })
        : await tool.execute(params as never, context);
      return { ok: true, ...success };
    } catch (error) {
      if (error instanceof InternalToolError) return { ok: false, reason: error.reason };
      return { ok: false, reason: `${assistantToolDisplayName(tool.name)}执行失败，没有完成。可以稍后重试，或请用户在界面中操作。` };
    }
  }

  private async propose(
    proposal: InternalToolProposal,
    context: InternalToolCallContext,
  ): Promise<ProposalSubmission> {
    if (!this.options.proposals) {
      throw new InternalToolError('对话内的确认卡尚未实现，这项扩大权限的操作暂时不能在对话中提出，也没有执行。请告诉用户在界面中完成。');
    }
    const { sessionId, toolCallId, commandId, turnCommandId, originWindowId } = context;
    return this.options.proposals.submit(proposal, { sessionId, toolCallId, commandId, turnCommandId, originWindowId });
  }
}

/** 同一调用再次到达：只读账本，不重新执行。 */
function replayedOutcome(record: InternalToolCallRecord, toolName: string, fingerprint: string): InternalToolOutcome {
  const displayName = assistantToolDisplayName(toolName);
  if (record.toolName !== toolName || record.argumentsFingerprint !== fingerprint) {
    return {
      ok: false,
      reason: `这次${displayName}的调用 id 与之前的一次调用相同但内容不同，为避免误判为重放，没有执行。请重新发起调用。`,
    };
  }
  if (record.status !== 'running' && record.outcome) return record.outcome;
  return {
    ok: false,
    reason: `这次${displayName}已在服务重启前开始执行，结果未知；为避免重复执行，没有再次执行。请先查询当前状态，再决定是否需要重新操作。`,
  };
}
