import { CREATE_AGENT_PROPOSAL_KIND, CreateAgentProposalPayloadSchema } from '@multivac/contracts';
import { defineInternalTool, proposedToolResult } from './internal-tool-service.js';
import { PROPOSAL_GUIDE } from './project-tools.js';

/**
 * 智能体相关的内部工具。
 *
 * 对话中只开放“提议新建”：修改与删除智能体在设置 · 智能体中完成。
 */

/** 新建智能体（名称 + 模型 + 推理等级 + 指令）：确认卡上展示完整配置，用户确认后才登记。 */
export const proposeCreateAgentTool = defineInternalTool({
  name: 'propose_create_agent',
  effect: 'propose',
  description: `提议新建一个智能体（命名的执行配置：模型、推理等级与指令），供新建任务时选用。${PROPOSAL_GUIDE}` +
    'name 为智能体名称；modelProfileId 与 thinkingLevel 不给时跟随全局默认模型，指定推理等级时必须同时指定模型；' +
    'instructions 为执行任务时附带的指令。智能体只是执行配置，不扩大目录或工具权限。' +
    '名称重名或模型不可用时卡上写明原因、不能确认。修改或删除智能体请引导用户到设置 · 智能体。',
  parameters: CreateAgentProposalPayloadSchema,
  async execute(params, { propose }) {
    return proposedToolResult(await propose({ kind: CREATE_AGENT_PROPOSAL_KIND, payload: params }));
  },
});
