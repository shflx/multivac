import { Type } from 'typebox';
import { SkillDraftSchema } from '@multivac/contracts';
import { defineInternalTool, proposedToolResult } from './internal-tool-service.js';
export const skillTools = [
 defineInternalTool({name:'list_skills',effect:'query',description:'查询当前会话真实 Skill 目录、固定版本和不可用原因。不读取包正文。',parameters:Type.Object({},{additionalProperties:false}),async execute(_input,{services,sessionId}) {
  const items=services.skills?.catalog(services.skills.context(sessionId)).slice(0,50)??[];
  return {content:JSON.stringify(items),result:{summary:`当前范围 ${items.length} 个 Skill`,refs:[]}};
 }}),
 defineInternalTool({name:'propose_skill',effect:'propose',description:'仅在用户明确要求沉淀流程、新建或修改 Skill 时生成标准文本包草案。files 包含完整 SKILL.md 及必要参考、模板或脚本，修改必须保留应保留的附件。不得自动提取凭据或私人资料；包脚本不是执行授权。只生成确认卡，用户确认后登记；模型不能批准。',parameters:SkillDraftSchema,async execute(input,context) {
  return proposedToolResult(await context.propose({kind:'skill.register',payload:input}));
 }}),
];
