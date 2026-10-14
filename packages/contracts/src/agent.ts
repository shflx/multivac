import { Type } from 'typebox';
import { COORDINATOR_THINKING_LEVELS } from './coordinator-runtime.js';

/**
 * 智能体是一套命名的执行配置（模型 + 推理等级 + 指令），不是岗位：不授予任何权限，
 * 安全边界仍由工具授权负责。协调者是固定记录，只用于说明，不可修改或删除。
 */

/** 固定的协调者：全局 Multivac 对话本身，模型跟随对话当前的选择。 */
export const COORDINATOR_AGENT_ID = 'coordinator';
/** 预置的默认执行智能体：任务未指定时使用它；可以编辑，不能删除。 */
export const DEFAULT_AGENT_ID = 'general';

export const AGENT_NAME_MAX_LENGTH = 60;
export const AGENT_DESCRIPTION_MAX_LENGTH = 500;
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 8000;

export const AgentIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const CommandId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const ProfileId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const Name = Type.String({ minLength: 1, maxLength: AGENT_NAME_MAX_LENGTH });
const Description = Type.String({ maxLength: AGENT_DESCRIPTION_MAX_LENGTH });
const Instructions = Type.String({ maxLength: AGENT_INSTRUCTIONS_MAX_LENGTH });
/** null 表示跟随全局默认模型。 */
const ModelProfileRef = Type.Union([ProfileId, Type.Null()]);
/** null 表示使用模型配置的默认推理等级；指定等级时必须同时指定模型。 */
const ThinkingLevel = Type.Union([Type.Enum(COORDINATOR_THINKING_LEVELS), Type.Null()]);

export const AgentSchema = Type.Object({
  agentId: AgentIdSchema,
  name: Name,
  description: Description,
  modelProfileId: ModelProfileRef,
  thinkingLevel: ThinkingLevel,
  instructions: Instructions,
  fixed: Type.Boolean(),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
}, { additionalProperties: false });
export type Agent = Type.Static<typeof AgentSchema>;

/** 本轮执行事实由服务端生成；名称与模型显示名冻结，历史不再读取智能体现状。 */
export const AssistantExecutorSchema = Type.Object({
  agentId: AgentIdSchema,
  revision: Type.Integer({ minimum: 1 }),
  name: Name,
  modelProfileId: ModelProfileRef,
  modelName: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  thinkingLevel: Type.Enum(COORDINATOR_THINKING_LEVELS),
}, { additionalProperties: false });
export type AssistantExecutor = Type.Static<typeof AssistantExecutorSchema>;

/**
 * 智能体引用的模型此刻的状态，由服务端按当前模型配置计算：
 * - default：跟随全局默认模型（协调者跟随对话当前的模型）；
 * - ready：引用的模型配置存在且可用，推理等级在其支持范围内；
 * - review：待核对——模型配置已删除、无效、不可用，或推理等级不再受支持。保留引用，不能用于执行。
 */
export const AgentModelStateSchema = Type.Object({
  status: Type.Union([Type.Literal('default'), Type.Literal('ready'), Type.Literal('review')]),
  /** 引用的模型配置的显示名称；跟随默认或配置已删除时为 null。 */
  modelName: Type.Union([Type.String(), Type.Null()]),
  /** 待核对的原因。 */
  message: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type AgentModelState = Type.Static<typeof AgentModelStateSchema>;

export const AgentListSchema = Type.Object({
  agents: Type.Array(AgentSchema),
  modelStates: Type.Record(AgentIdSchema, AgentModelStateSchema),
  /** 协调者当前实际注册的内部工具名（不含 Pi 内置工具），用于协调者详情的只读展示。 */
  coordinatorTools: Type.Array(Type.String()),
}, { additionalProperties: false });
export type AgentList = Type.Static<typeof AgentListSchema>;

const AgentFields = {
  name: Name,
  description: Type.Optional(Description),
  modelProfileId: Type.Optional(ModelProfileRef),
  thinkingLevel: Type.Optional(ThinkingLevel),
  instructions: Type.Optional(Instructions),
};

/** 新建智能体的配置（不含命令 ID）；对话中的创建提议使用同一份字段。 */
export const AgentDraftSchema = Type.Object(AgentFields, { additionalProperties: false });
export type AgentDraft = Type.Static<typeof AgentDraftSchema>;

export const CreateAgentSchema = Type.Object({ commandId: CommandId, ...AgentFields }, { additionalProperties: false });
export type CreateAgent = Type.Static<typeof CreateAgentSchema>;

export const UpdateAgentSchema = Type.Object({
  commandId: CommandId,
  revision: Type.Integer({ minimum: 1 }),
  patch: Type.Partial(Type.Object({
    name: Name, description: Description, modelProfileId: ModelProfileRef, thinkingLevel: ThinkingLevel, instructions: Instructions,
  }), { additionalProperties: false, minProperties: 1 }),
}, { additionalProperties: false });
export type UpdateAgent = Type.Static<typeof UpdateAgentSchema>;

export const DeleteAgentSchema = Type.Object({
  commandId: CommandId,
  revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type DeleteAgent = Type.Static<typeof DeleteAgentSchema>;

export const AgentReceiptSchema = Type.Object({
  commandId: CommandId,
  agent: AgentSchema,
}, { additionalProperties: false });
export type AgentReceipt = Type.Static<typeof AgentReceiptSchema>;

/** 协调者在对话中提议新建智能体：确认后才登记，只能新建，修改与删除仍在设置页完成。 */
export const CREATE_AGENT_PROPOSAL_KIND = 'agent.create';

export const CreateAgentProposalPayloadSchema = AgentDraftSchema;
export type CreateAgentProposalPayload = AgentDraft;

/** 确认卡展示的完整配置：缺省字段已补全，并附上提议时模型配置的显示名称。 */
export const CreateAgentProposalPreviewSchema = Type.Object({
  name: Name,
  description: Description,
  modelProfileId: ModelProfileRef,
  /** 跟随全局默认模型时为 null。 */
  modelName: Type.Union([Type.String(), Type.Null()]),
  thinkingLevel: ThinkingLevel,
  instructions: Instructions,
}, { additionalProperties: false });
export type CreateAgentProposalPreview = Type.Static<typeof CreateAgentProposalPreviewSchema>;
