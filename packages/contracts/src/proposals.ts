import { Type } from 'typebox';
import { AssistantToolResultSchema } from './internal-tools.js';
import { WORKSPACE_SESSION_TITLE_MAX_LENGTH } from './workspace-session.js';

/**
 * 对话内的提议（确认卡）：全局 Multivac 的提议类内部工具不执行扩大权限的操作，只生成一条持久化的提议，
 * 出现在全局 Multivac 的对话里，由用户在卡上确认或取消。确认时服务端按当前状态重新校验再执行，
 * 确认或取消后卡片原地变为回执；结果在下一轮以服务端通知告诉 Multivac。
 *
 * 状态：
 * - pending：待确认；
 * - executing：用户已确认、正在执行（服务在这期间重启时记为执行失败，结果未知，不会重新执行）；
 * - executed：已执行，outcome 写明结果与涉及的对象；
 * - cancelled：用户取消，没有执行；
 * - expired：确认时重新校验发现目标已变化或不再成立，没有执行，reason 写明原因；
 * - failed：执行失败（或执行中服务重启），reason 写明原因。
 */
export const PROPOSAL_STATUSES = ['pending', 'executing', 'executed', 'cancelled', 'expired', 'failed'] as const;
export const ProposalStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('executing'),
  Type.Literal('executed'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
  Type.Literal('failed'),
]);
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** 提议已有定论（不会再变化）的状态。 */
export function proposalSettled(status: ProposalStatus): boolean {
  return status !== 'pending' && status !== 'executing';
}

/** 提议种类的写法：小写字母开头，字母、数字、下划线与点，如 `project.create`。 */
export const PROPOSAL_KIND_PATTERN = '^[a-z][a-z0-9_.]{0,63}$';

export const PROPOSAL_TITLE_MAX_LENGTH = 200;

const Timestamp = Type.String({ minLength: 1 });
const ProposalId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });

/**
 * 一张提议卡。payload 是提出时的参数快照（确认时据此重新校验与执行），preview 是提出时服务端核对得到的
 * 预览（卡片据此展示将要发生什么）；两者的结构由提议种类决定（见各种类的 schema，如
 * `ExampleRenameSessionPayloadSchema`），界面按 kind 选择内容组件渲染。
 */
export const ProposalSchema = Type.Object(
  {
    proposalId: ProposalId,
    /** 提出它的会话（全局 Multivac）。 */
    sessionId: Type.String({ minLength: 1, maxLength: 128 }),
    /** 提出它的那一轮（发送命令）；卡片排在这一轮的运行轨迹之后。不在一轮之中时为 null。 */
    commandId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 提出它的工具调用，与运行轨迹中的工具行对应。 */
    toolCallId: Type.String({ minLength: 1, maxLength: 512 }),
    kind: Type.String({ pattern: PROPOSAL_KIND_PATTERN }),
    /** 卡片标题：要做的事，如“把会话「A」改名为「B」”。 */
    title: Type.String({ minLength: 1, maxLength: PROPOSAL_TITLE_MAX_LENGTH }),
    payload: Type.Unknown(),
    preview: Type.Unknown(),
    /**
     * 提出时核对不通过的原因（例如目录不存在）：卡片写明原因，不能确认，只能取消。
     * 为 null 表示提出时可以执行；确认时仍会按当前状态重新校验。
     */
    problem: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    status: ProposalStatusSchema,
    /** 已执行时的结果摘要与涉及的对象（与内部工具的公开结果同一白名单）；其他状态为 null。 */
    outcome: Type.Union([AssistantToolResultSchema, Type.Null()]),
    /** 已过期、执行失败时的原因；其他状态为 null。 */
    reason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    createdAt: Timestamp,
    /** 用户确认或取消的时间；待确认时为 null。 */
    decidedAt: Type.Union([Timestamp, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Proposal = Type.Static<typeof ProposalSchema>;

/** 全局 Multivac 的提议（含历史），按提出的先后。 */
export const ProposalListResponseSchema = Type.Object(
  { proposals: Type.Array(ProposalSchema) },
  { additionalProperties: false },
);
export type ProposalListResponse = Type.Static<typeof ProposalListResponseSchema>;

/** 用户在卡上的决定：确认（按当前状态重新校验后执行）或取消。 */
export const ProposalDecisionSchema = Type.Union([Type.Literal('confirm'), Type.Literal('cancel')]);
export type ProposalDecision = Type.Static<typeof ProposalDecisionSchema>;

/**
 * 决定。options 是用户在卡上作出的选择（例如归入项目时是否一并移入临时目录里的文件），只随确认提交，
 * 结构由提议种类决定（见各种类的 options schema，如 `MoveSessionToProjectOptionsSchema`）；
 * 有选项的种类确认时必须带上，没有选项的种类不接受。模型给出的参数至多作为卡上选项的默认值，
 * 执行时只采用这里由用户提交的值。
 */
export const DecideProposalSchema = Type.Object(
  {
    decision: ProposalDecisionSchema,
    options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type DecideProposal = Type.Static<typeof DecideProposalSchema>;

export const ProposalDecisionResponseSchema = Type.Object(
  { proposal: ProposalSchema },
  { additionalProperties: false },
);
export type ProposalDecisionResponse = Type.Static<typeof ProposalDecisionResponseSchema>;

/**
 * 示例提议种类：给工作会话改名。只在测试环境（E2E 与测试）注册，用来验证确认卡机制本身，不是产品入口；
 * 改名本身不扩大权限，真正的扩大权限提议（新建项目、挂载目录、归入项目等）按同一机制注册。
 */
export const EXAMPLE_RENAME_SESSION_PROPOSAL_KIND = 'example.rename_session';

export const ExampleRenameSessionPayloadSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: WORKSPACE_SESSION_TITLE_MAX_LENGTH }),
  },
  { additionalProperties: false },
);
export type ExampleRenameSessionPayload = Type.Static<typeof ExampleRenameSessionPayloadSchema>;

/** 提出时会话的名称：确认时名称已被改动（目标已变化）则提议过期。 */
export const ExampleRenameSessionPreviewSchema = Type.Object(
  {
    currentTitle: Type.String({ minLength: 1 }),
    workspaceName: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ExampleRenameSessionPreview = Type.Static<typeof ExampleRenameSessionPreviewSchema>;
