import { assistantToolDisplayName, internalToolDisplay } from '@multivac/contracts';
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
import type { WorkspaceSessionService } from '../workspace-session-service.js';

/**
 * 内部工具可以使用的服务端能力。只放按需收窄的接口（Pick 现有服务的方法），与界面操作走同一套服务与校验；
 * 不得放入任何扩大权限的方法（新建项目、挂载 / 卸载目录、设主目录、归入项目、授权决定与记住的授权）——
 * 这些只能由用户在界面的确认卡上确认后经对应接口完成。
 */
export interface InternalToolServices {
  projects: Pick<ProjectService, 'listWorkspaces'>;
  sessions: Pick<WorkspaceSessionService, 'list'>;
}

/** 一次调用的上下文：执行函数从这里拿服务与调用身份。 */
export interface InternalToolCallContext {
  /** 发起调用的会话（全局 Multivac）。 */
  sessionId: string;
  toolCallId: string;
  /**
   * 由会话与 toolCallId 派生的幂等命令 id。有副作用的服务调用以它去重（例如作为新建会话的客户端 id），
   * 同一次调用重放时不重复产生副作用。
   */
  commandId: string;
  /**
   * 发起这次调用的那一轮：全局 Multivac 当前发送命令的 id（与回执、运行轨迹的 commandId 一致）；
   * 不在一轮之中时为 null。需要知道“从哪个窗口发起”的工具经它关联到发送命令。
   */
  turnCommandId: string | null;
  services: InternalToolServices;
  /** 本轮的中止信号；停止本轮时中止，长时间的操作应随之结束。 */
  signal: AbortSignal;
}

/** 提议类工具生成的提议：确认之前不执行任何操作。具体的提议种类与载荷由确认卡机制定义。 */
export interface InternalToolProposal {
  kind: string;
  payload: unknown;
}

/** 提议的去处（对话内确认卡）；未接入时提议类工具明确报告“尚不支持”，不执行任何操作。 */
export interface InternalToolProposalSink {
  submit(
    proposal: InternalToolProposal,
    origin: Pick<InternalToolCallContext, 'sessionId' | 'toolCallId' | 'commandId' | 'turnCommandId'>,
  ): Promise<{ proposalId: string }>;
}

/** 提议类工具的上下文：除只读服务外，只能经 propose 生成提议。 */
export interface InternalToolProposeContext extends InternalToolCallContext {
  propose(proposal: InternalToolProposal): Promise<{ proposalId: string }>;
}

interface InternalToolDefinitionBase<TParams extends TSchema> {
  /** 工具名：小写字母开头，只含小写字母、数字与下划线；展示口径登记在契约 INTERNAL_TOOL_DISPLAY。 */
  name: string;
  /** 给模型的中文说明：能做什么、何时使用、返回什么。 */
  description: string;
  parameters: TParams;
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
  /** 会话当前这一轮的发送命令。 */
  currentTurnCommandId: (sessionId: string) => string | null;
  /** 对话内确认卡；未接入时提议类工具报告尚不支持。 */
  proposals?: InternalToolProposalSink;
  now?: () => Date;
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
    this.specs = options.tools.map(({ name, description, parameters, effect }) =>
      ({ name, description, parameters, effect }));
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
    const context: InternalToolCallContext = {
      sessionId: invocation.assistantSessionId,
      toolCallId: invocation.toolCallId,
      commandId,
      turnCommandId: this.options.currentTurnCommandId(invocation.assistantSessionId),
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
  ): Promise<{ proposalId: string }> {
    if (!this.options.proposals) {
      throw new InternalToolError('对话内的确认卡尚未实现，这项扩大权限的操作暂时不能在对话中提出，也没有执行。请告诉用户在界面中完成。');
    }
    const { sessionId, toolCallId, commandId, turnCommandId } = context;
    return this.options.proposals.submit(proposal, { sessionId, toolCallId, commandId, turnCommandId });
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
