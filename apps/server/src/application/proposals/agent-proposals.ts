import {
  CREATE_AGENT_PROPOSAL_KIND,
  CreateAgentProposalPayloadSchema,
  INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH,
  INTERNAL_TOOL_RECEIPT_HEADLINE_MAX_LENGTH,
  type CreateAgentProposalPayload,
  type CreateAgentProposalPreview,
} from '@multivac/contracts';
import { createHash } from 'node:crypto';
import { agentNameKey } from '../../modules/agents/agent.js';
import { defineProposalKind, ProposalExecutionError, type ProposalKind } from '../../modules/proposals/proposal.js';
import { clip } from '../internal-tools/tool-text.js';
import { AgentServiceError, type AgentService } from '../agent-service.js';
import { fingerprint } from '../task-service.js';

/**
 * 新建智能体的提议种类（执行器）：协调者只能提议新建，修改与删除仍在设置 · 智能体完成。
 * 智能体只是执行配置（模型、推理等级、指令），不改变任务的权限边界；登记仍只在用户于对话中的确认卡上确认、
 * 按当前状态重新校验通过后执行。校验与执行调用设置页同一套服务，不另写规则：
 * - prepare：名称为空、已有同名智能体、只给推理等级不选模型、引用的模型当前不可用时，卡片写明原因、不能确认；
 * - revalidate：确认时再按同一套规则核对一次，并与提出时的预览比较，配置或模型名称已变化即过期、不执行；
 * - execute：执行时服务本身还会再校验一次（名称唯一在写入的事务内核对）。
 *
 * 执行参数只来自提议记录（模型提出时的参数快照与服务端的预览）。
 */

export interface AgentProposalDependencies {
  agents: Pick<AgentService, 'create' | 'list' | 'modelState'>;
}

/** 执行时服务未给出原因的兜底说明。 */
const CREATE_FAILED_REASON = '智能体未创建。';

/** 回执的标题与补充按回执允许的长度截断（名称与模型名可能较长），超出的部分以省略号结尾。 */
function receiptHeadline(text: string): string {
  return clip(text, INTERNAL_TOOL_RECEIPT_HEADLINE_MAX_LENGTH - 1);
}

function receiptDetail(text: string): string {
  return clip(text, INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH - 1);
}

/** 执行时服务给出的中文原因写进结果；其他异常给出通用说明。 */
function executionError(error: unknown): never {
  throw new ProposalExecutionError(error instanceof AgentServiceError ? error.message : CREATE_FAILED_REASON);
}

/** 与新建接口相同的规整：去掉首尾空白，缺省的模型与推理等级跟随全局默认。 */
function normalize(payload: CreateAgentProposalPayload): Omit<CreateAgentProposalPreview, 'modelName'> {
  return {
    name: payload.name.trim(),
    description: payload.description?.trim() ?? '',
    modelProfileId: payload.modelProfileId ?? null,
    thinkingLevel: payload.thinkingLevel ?? null,
    instructions: payload.instructions?.trim() ?? '',
  };
}

/** 卡上写明的模型：跟随默认时为“默认模型”，否则写模型配置的显示名称。 */
function modelText(preview: Pick<CreateAgentProposalPreview, 'modelName' | 'thinkingLevel'>): string {
  const model = preview.modelName ?? '默认模型';
  return preview.thinkingLevel ? `${model} · ${preview.thinkingLevel}` : model;
}

// ---------- 新建智能体 ----------

/** 新建智能体：卡上展示完整配置，确认后登记为可被任务选用的智能体，回执可打开设置 · 智能体。 */
export function createAgentKind(dependencies: AgentProposalDependencies): ProposalKind {
  const { agents } = dependencies;

  /** 按当前状态给出预览与不能执行的原因；规则与设置页保存时一致。 */
  async function inspect(payload: CreateAgentProposalPayload): Promise<{ preview: CreateAgentProposalPreview; problem: string | null }> {
    const fields = normalize(payload);
    const state = await agents.modelState(fields);
    const preview = { ...fields, modelName: state.status === 'default' ? null : state.modelName };
    if (!fields.name) return { preview, problem: '智能体名称不能为空。' };
    if (fields.thinkingLevel !== null && fields.modelProfileId === null) {
      return { preview, problem: '指定推理等级时需要同时选择模型；跟随默认模型时使用模型的默认等级。' };
    }
    const existing = (await agents.list()).agents.find((agent) => agentNameKey(agent.name) === agentNameKey(fields.name));
    if (existing) return { preview, problem: `已有名为「${existing.name}」的智能体，请换一个名称。` };
    if (state.status === 'review') return { preview, problem: `不能保存为智能体的模型：${state.message ?? '模型当前不可用。'}` };
    return { preview, problem: null };
  }

  return defineProposalKind<typeof CreateAgentProposalPayloadSchema, CreateAgentProposalPreview>({
    kind: CREATE_AGENT_PROPOSAL_KIND,
    payload: CreateAgentProposalPayloadSchema,
    async prepare(payload) {
      const { preview, problem } = await inspect(payload);
      return { title: `新建智能体「${preview.name}」`, preview, problem, refs: [] };
    },
    async revalidate(payload, preview) {
      try {
        const next = await inspect(payload);
        if (fingerprint(next.preview) !== fingerprint(preview)) {
          return `智能体配置已变化：模型将是「${modelText(next.preview)}」（卡上是「${modelText(preview)}」）。`;
        }
        return next.problem;
      } catch (error) {
        return error instanceof AgentServiceError ? error.message : '智能体配置无法核对。';
      }
    },
    async execute(payload, preview, origin) {
      let created;
      try {
        const key = createHash('sha256').update(`${origin.commandId ?? 'user'}:${fingerprint(payload)}`).digest('hex');
        created = await agents.create({ ...payload, commandId: `agent-proposal:${key}` }, origin);
      } catch (error) {
        executionError(error);
      }
      const { agent } = created;
      const model = modelText({ modelName: preview.modelName, thinkingLevel: agent.thinkingLevel });
      return {
        summary: `已创建智能体「${agent.name}」，模型：${model}；可在新建任务时选用。`,
        refs: [],
        receipt: {
          headline: receiptHeadline(`已创建智能体「${agent.name}」`),
          detail: receiptDetail(`模型：${model}；可在新建任务时选用，修改或删除请到设置 · 智能体`),
          actions: [{ kind: 'open-management-page', page: 'agents' }],
        },
      };
    },
  });
}
