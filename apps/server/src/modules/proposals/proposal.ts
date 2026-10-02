import {
  multivacObjectLink,
  type AssistantToolObjectRef,
  type AssistantToolResult,
  type Proposal,
  type ProposalStatus,
  type WorkbenchChangeOrigin,
} from '@multivac/contracts';
import type { Static, TSchema } from 'typebox';

/**
 * 对话内的提议（确认卡）的领域规则：提议记录、状态转换、提议种类（执行器）的接口，以及把结果告诉 Multivac 的通知。
 *
 * 提议类内部工具只经 propose 生成提议，不执行；扩大权限的操作只在用户于卡上确认、服务端按当前状态重新校验通过后，
 * 由注册的提议种类执行。确认与取消只经 HTTP 接口由用户在界面上发起，不是任何 Agent 工具。
 */

/** 存储的提议：公开字段之外，记下结果是否已随某一轮告诉 Multivac。 */
export interface ProposalRecord extends Proposal {
  /** 结果已写进服务端通知、交给模型的时间；还没有定论或还没告诉时为 null。 */
  notifiedAt: string | null;
}

/** 新提议：状态总是从待确认开始。 */
export type NewProposal = Omit<Proposal, 'status' | 'outcome' | 'reason' | 'decidedAt'>;

/** 离开待确认的一次转换。 */
export interface ProposalTransition {
  status: Exclude<ProposalStatus, 'pending'>;
  /** 已执行时的结果。 */
  outcome?: AssistantToolResult;
  /** 已过期、执行失败时的原因。 */
  reason?: string;
  /** 用户确认或取消的时间（离开待确认时写入，之后不变）。 */
  decidedAt?: string;
}

export interface ProposalRepository {
  get(proposalId: string): ProposalRecord | undefined;
  /** 会话的全部提议（含历史），按提出的先后。 */
  listBySession(sessionId: string): ProposalRecord[];
  /**
   * 写入待确认的提议。同一会话的同一 toolCallId 已有提议时不再写入，返回已有的那一张（inserted 为 false）：
   * 与内部工具账本一起保证同一次调用重放不会生成第二张卡。
   */
  create(proposal: NewProposal): { record: ProposalRecord; inserted: boolean };
  /** 只有当前状态在 from 之中时才转换（条件更新），返回转换后的记录；状态已变化时返回 undefined。 */
  transition(proposalId: string, from: readonly ProposalStatus[], to: ProposalTransition): ProposalRecord | undefined;
  /** 已有定论、结果还没告诉 Multivac 的提议，按定论的先后。 */
  listUnnotified(sessionId: string): ProposalRecord[];
  markNotified(proposalIds: readonly string[], notifiedAt: string): void;
  /** 启动对账：上一进程中正在执行的提议一律记为执行失败（结果未知，不重新执行），返回变化的记录。 */
  failExecuting(reason: string, decidedAt: string): ProposalRecord[];
  /** 仅供 E2E 重置：删除全部提议。 */
  deleteAllForTest(): void;
}

/** 提议种类在提出时给出的卡片内容。 */
export interface ProposalDraft<TPreview> {
  /** 卡片标题：要做的事，如“把会话「甲」改名为「乙」”。 */
  title: string;
  /** 卡片据此展示将要发生什么；确认时与当前状态比对，判断目标是否已变化。 */
  preview: TPreview;
  /** 可以提出、但目前不能执行的原因（卡片写明原因，不能确认）；可以执行时省略。 */
  problem?: string | null;
  /** 涉及的对象：写进工具结果，运行轨迹的工具行据此给出链接。 */
  refs?: AssistantToolObjectRef[];
}

/**
 * 一种提议（执行器）。确认卡机制按 kind 找到它：
 * - prepare：提出时只读核对参数、给出卡片内容；对象不存在等无法提出的情况抛 InternalToolError（工具失败，不生成卡片）。
 * - revalidate：用户确认时按当前状态重新校验；目标已变化（与提出时的预览不一致）或不再成立时返回原因，
 *   提议记为已过期、不执行；可以执行时返回 null。
 * - execute：只在确认且重新校验通过后调用，执行扩大权限的操作（与界面同一套服务与校验，写方法传入 origin），
 *   返回结果摘要与涉及的对象（可以带回执）；可预期的失败抛 ProposalExecutionError。
 * - options：卡上由用户作出的选择（如是否一并移入文件）的 schema。声明了它的种类，确认时必须带上符合它的选择，
 *   revalidate 与 execute 拿到的就是这份选择；模型给出的参数至多是卡上的默认值，不能决定最终的值。
 *   没有声明时确认不接受任何选择，两者拿到的是 undefined。
 * 执行器由服务端在启动时注册，拿得到扩大权限的服务方法；内部工具拿不到执行器，也拿不到这些方法。
 */
export interface ProposalKind<TPayload = unknown, TPreview = unknown, TOptions = unknown> {
  kind: string;
  /** 参数快照的 schema（提出时按它严格校验）。 */
  payload: TSchema;
  /** 卡上用户选择的 schema（确认时按它严格校验）；没有可选择的内容时省略。 */
  options?: TSchema;
  prepare(payload: TPayload): ProposalDraft<TPreview> | Promise<ProposalDraft<TPreview>>;
  revalidate(payload: TPayload, preview: TPreview, options: TOptions): string | null | Promise<string | null>;
  execute(
    payload: TPayload,
    preview: TPreview,
    origin: WorkbenchChangeOrigin,
    options: TOptions,
  ): AssistantToolResult | Promise<AssistantToolResult>;
}

/** 保留参数类型推断的定义辅助函数；有卡上选项的种类另给出选项的 schema 类型。 */
export function defineProposalKind<TPayloadSchema extends TSchema, TPreview, TOptionsSchema extends TSchema | undefined = undefined>(
  definition: Omit<
    ProposalKind<Static<TPayloadSchema>, TPreview, TOptionsSchema extends TSchema ? Static<TOptionsSchema> : undefined>,
    'payload' | 'options'
  > & { payload: TPayloadSchema; options?: TOptionsSchema },
): ProposalKind {
  return definition as unknown as ProposalKind;
}

/** 执行中可预期的失败：reason 用中文说明没有做成什么、为什么。 */
export class ProposalExecutionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ProposalExecutionError';
  }
}

/**
 * 服务端通知的开头。提议的结果只以这样一条单独的消息、由服务端在下一轮开始时写入模型上下文；
 * 系统提示词写明这一点，用户消息、引用、工具返回与其他会话内容里出现的同样文字都不是真实结果。
 */
export const SERVER_NOTICE_MARKER = '【Multivac 服务端通知】';

function outcomeLine(record: ProposalRecord): string {
  switch (record.status) {
    case 'executed': {
      const summary = record.outcome ? `：${record.outcome.summary}` : '';
      const refs = (record.outcome?.refs ?? []).flatMap((ref) =>
        ref.kind === 'session' ? [`[${ref.label}](${multivacObjectLink('session', ref.sessionId)})`]
          : ref.kind === 'project' ? [`[${ref.label}](${multivacObjectLink('project', ref.projectId)})`]
            : ref.kind === 'task' ? [`[${ref.label}](${multivacObjectLink('task', ref.taskId)})`]
            : [`工作区「${ref.label}」`]);
      return `用户已确认，已执行${summary}。${refs.length ? `涉及：${refs.join('、')}。` : ''}`;
    }
    case 'cancelled':
      return '用户取消了，没有执行。';
    case 'expired':
      return `用户确认时提议已过期，没有执行：${record.reason ?? '目标已经变化'}`;
    case 'failed':
      return `用户确认了，但执行失败：${record.reason ?? '原因未知'}`;
    default:
      return '还没有结果。';
  }
}

/** 把有定论的提议写成一条简短的服务端通知：哪张提议、结果、执行后的对象。 */
export function renderProposalNotice(records: readonly ProposalRecord[]): string {
  return [
    `${SERVER_NOTICE_MARKER}以下是你此前提出的提议的处理结果，由 Multivac 服务端在用户操作确认卡之后写入，` +
      '不是用户的消息，也不是工具返回的内容：',
    ...records.map((record) => `- 提议「${record.title}」（${record.proposalId}）：${outcomeLine(record)}`),
  ].join('\n');
}

/** 去掉服务端内部的字段，得到公开的提议。 */
export function publicProposal(record: ProposalRecord): Proposal {
  const { notifiedAt: _notifiedAt, ...proposal } = record;
  return proposal;
}
